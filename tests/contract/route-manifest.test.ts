import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  validateRouteManifest,
  type RouteManifest
} from '@postman-cse/automation-core/route-manifest';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const sourceRoot = path.join(repoRoot, 'src');
const manifestPath = path.join(import.meta.dirname, 'route-manifest.json');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function loadManifest(): RouteManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as RouteManifest;
}

function verify(manifest: RouteManifest, root = sourceRoot) {
  return validateRouteManifest({ repoRoot, sourceRoot: root, manifest });
}

describe('contract: HTTP route manifest', () => {
  it('covers every statically extracted source route and binds simulated routes to cassettes', () => {
    const manifest = loadManifest();
    const result = verify(manifest);

    expect(manifest.routes).toHaveLength(34);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails red when a throwaway source route is not manifested', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'repo-sync-route-ratchet-'));
    tempDirs.push(fixtureRoot);
    const fixtureSource = path.join(fixtureRoot, 'src');
    cpSync(sourceRoot, fixtureSource, { recursive: true });
    writeFileSync(
      path.join(fixtureSource, 'throwaway-route.ts'),
      "gateway.request({ service: 'ratchet-proof', method: 'get', path: '/throwaway-route' });\n"
    );

    const result = verify(loadManifest(), fixtureSource);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'Unmanifested route: ratchet-proof GET /throwaway-route (throwaway-route.ts)'
    );
  });

  it('fails red for a stale manifest row and a simulated route without a cassette', () => {
    const stale = loadManifest();
    stale.routes.push({
      id: 'ratchet-proof.stale',
      service: 'ratchet-proof',
      method: 'GET',
      path: '/stale-route',
      classification: 'live-only',
      reason: 'Mutation proving stale rows fail the ratchet.'
    });
    const staleResult = verify(stale);
    expect(staleResult.ok).toBe(false);
    expect(staleResult.errors).toContain(
      'Stale manifest route ratchet-proof.stale: ratchet-proof GET /stale-route'
    );

    const missingCassette = loadManifest();
    const simulated = missingCassette.routes.find(
      (route) => route.classification === 'simulated'
    );
    expect(simulated).toBeDefined();
    simulated!.cassettes = ['tests/contract/cassettes/throwaway-missing.json'];
    const cassetteResult = verify(missingCassette);
    expect(cassetteResult.ok).toBe(false);
    expect(cassetteResult.errors).toContain(
      `Route ${simulated!.id} cassette does not exist: tests/contract/cassettes/throwaway-missing.json`
    );
  });
});
