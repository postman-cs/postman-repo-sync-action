import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  extractRoutesFromSource,
  validateRouteManifest,
  type RouteManifest
} from '@postman-cse/automation-core/route-manifest';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const sourceRoot = path.join(repoRoot, 'src');
const manifestPath = path.join(import.meta.dirname, 'route-manifest.json');
const tempDirs: string[] = [];

const EXTRACTION_CONFIG = {
  proxyHelpers: {
    request: {
      files: ['lib/postman/postman-assets-client.ts'],
      service: 'postman-api',
      pathArg: 0,
      initArg: 1
    }
  },
  serviceAliases: {
    'probeSessionIdentity:baseUrl': 'iapub',
    'this.workerBaseUrl': 'catalog-admin',
    'this.apiBaseUrl': 'postman-api'
  },
  allowedPassthroughs: [
    {
      file: 'lib/postman/internal-integration-adapter.ts',
      urlExpression: 'url',
      reason: 'Bifrost carrier whose envelope literals are extracted at each call site.'
    },
    {
      file: 'lib/postman/internal-integration-adapter.ts',
      urlExpression: '`${this.bifrostBaseUrl}/ws/proxy`',
      reason: 'Bifrost carrier whose envelope literal is extracted at this call site.'
    },
    {
      file: 'lib/postman/postman-assets-client.ts',
      urlExpression: 'url',
      reason: 'HTTP transport for the file-scoped request helper; /me is extracted at its caller.'
    }
  ]
} as const;

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
  return validateRouteManifest({ repoRoot, sourceRoot: root, manifest, ...EXTRACTION_CONFIG });
}

describe('contract: HTTP route manifest', () => {
  it('covers every statically extracted source route and binds simulated routes to cassettes', () => {
    const manifest = loadManifest();
    const result = verify(manifest);

    expect(manifest.routes).toHaveLength(36);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.errors).toEqual([]);
    expect(extractRoutesFromSource({ sourceRoot, ...EXTRACTION_CONFIG }).unattributed).toEqual([]);
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
    expect(result.errors.some((error) => /unmanifested route ratchet-proof GET \/throwaway-route/.test(error))).toBe(true);
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
      'stale manifest entry ratchet-proof GET /stale-route has no matching route in src/'
    );

    const missingCassette = loadManifest();
    const simulated = missingCassette.routes.find(
      (route) => route.classification === 'simulated'
    );
    expect(simulated).toBeDefined();
    const simulatedIndex = missingCassette.routes.indexOf(simulated!);
    simulated!.cassettes = ['tests/contract/cassettes/throwaway-missing.json'];
    const cassetteResult = verify(missingCassette);
    expect(cassetteResult.ok).toBe(false);
    expect(cassetteResult.errors).toContain(
      `routes[${simulatedIndex}] simulated cassette not found: tests/contract/cassettes/throwaway-missing.json`
    );
  });
});
