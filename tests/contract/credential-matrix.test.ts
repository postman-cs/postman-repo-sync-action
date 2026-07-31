/**
 * Tier-2 contract tests for repo-sync: drive the REAL runAction against an
 * in-memory platform fake, across the org x credential matrix, with the
 * real internal-integration adapter (no file-level mock) so the Bifrost
 * /ws/proxy envelope + x-entity-team-id org-mode header are exercised
 * end-to-end. Asserts that org-mode detection flips the gateway header,
 * that env/mock/monitor asset ops go through the gateway (never PMAK), and
 * that the token-only credential shape (no PMAK) still completes via
 * identity createApiKey.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createExecStub,
  createPlatform,
  NEUTRALIZED_ENV_VARS
} from './platform-fake.js';

const ADAPTER_MODULE = '../../src/lib/postman/internal-integration-adapter.js';

type RunAction = typeof import('../../src/index.js').runAction;
type ResetIdentityMemo = typeof import('../../src/lib/postman/credential-identity.js').__resetIdentityMemo;

let runAction: RunAction;
let __resetIdentityMemo: ResetIdentityMemo;

interface CoreLike {
  getInput(name: string, options?: { required?: boolean }): string;
  info(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
  setOutput(name: string, value: string): void;
  setSecret(secret: string): void;
}


function createCore(values: Record<string, string>) {
  const outputs: Record<string, string> = {};
  const infos: string[] = [];
  const warnings: string[] = [];
  const core: CoreLike = {
    getInput: (name: string, opts?: { required?: boolean }) => {
      const value = values[name] ?? '';
      if (opts?.required && !value) throw new Error(`Input required and not supplied: ${name}`);
      return value;
    },
    info: (message: string) => {
      infos.push(message);
    },
    warning: (message: string) => {
      warnings.push(message);
    },
    setFailed: () => {},
    setOutput: (name: string, value: string) => {
      outputs[name] = value;
    },
    setSecret: () => {}
  };
  return { core, outputs, infos, warnings };
}

function baseInputs(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'project-name': 'core-payments',
    'workspace-id': 'ws-contract',
    'baseline-collection-id': '12345678-col-baseline',
    'smoke-collection-id': '12345678-col-smoke',
    'postman-api-key': 'pmak-test',
    'postman-access-token': 'access-token-test',
    'environments-json': '["prod"]',
    'env-runtime-urls-json': '{"prod":"https://api.example.com"}',
    'repo-write-mode': 'none',
    'generate-ci-workflow': 'false',
    'workspace-link-enabled': 'false',
    'environment-sync-enabled': 'false',
    ...overrides
  };
}

describe('contract: repo-sync org x credential matrix', () => {
  let testDir: string;
  let originalCwd = '';

  beforeEach(async () => {
    // Under isolate:false, repo-sync-action.test.ts's hoisted vi.mock of the
    // Bifrost adapter can remain registered. Unmock + resetModules so this
    // file always exercises the real createApiKey → identity /api/keys path.
    vi.doUnmock(ADAPTER_MODULE);
    vi.resetModules();
    ({ runAction } = await import('../../src/index.js'));
    ({ __resetIdentityMemo } = await import('../../src/lib/postman/credential-identity.js'));
    __resetIdentityMemo();
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'repo-sync-contract-'));
    process.chdir(testDir);
    for (const name of NEUTRALIZED_ENV_VARS) {
      vi.stubEnv(name, '');
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    __resetIdentityMemo();
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('{both, org} auto-detects org-mode via ums squads and sets x-entity-team-id on gateway calls', async () => {
    const platform = createPlatform({ org: true });
    vi.stubGlobal('fetch', platform.fetch);
    const { core, outputs } = createCore(baseInputs());

    await runAction(core, createExecStub());

    // Org-mode auto-detected.
    expect(platform.events.some((entry) => entry.startsWith('proxy:ums'))).toBe(true);
    // Environment was created through the gateway sync service.
    expect(
      platform.events.some((entry) => entry.startsWith('proxy:sync POST') && entry.includes('/environment/import'))
    ).toBe(true);
    // Mock and monitor created through gateway services.
    expect(platform.state.mockCreated).toBe(true);
    expect(platform.state.monitorCreated).toBe(true);
    expect(outputs['environment-uids-json']).toBeDefined();
  });

  it('{both, non-org} leaves org-mode false (ums 400) and still creates env/mock/monitor', async () => {
    const platform = createPlatform({ org: false });
    vi.stubGlobal('fetch', platform.fetch);
    const { core, outputs } = createCore(baseInputs());

    await runAction(core, createExecStub());

    expect(platform.events.some((entry) => entry.startsWith('proxy:ums'))).toBe(true);
    expect(platform.state.mockCreated).toBe(true);
    expect(platform.state.monitorCreated).toBe(true);
    expect(outputs['environment-uids-json']).toBeDefined();
  });

  it('{token-only, org} generates an API key via identity createApiKey and auto-detects org-mode', async () => {
    const platform = createPlatform({ org: true });
    vi.stubGlobal('fetch', platform.fetch);
    const { core, outputs } = createCore(baseInputs({ 'postman-api-key': '' }));

    await runAction(core, createExecStub());

    // /me was NOT called (no PMAK to validate) — identity createApiKey was.
    expect(platform.events.some((entry) => entry.includes('GET') && entry.includes('/me'))).toBe(false);
    expect(
      platform.events.some((entry) => entry.startsWith('proxy:identity POST /api/keys'))
    ).toBe(true);
    // Org-mode was detected from ums squads.
    expect(platform.events.some((entry) => entry.startsWith('proxy:ums'))).toBe(true);
    expect(outputs['environment-uids-json']).toBeDefined();
  });

  it('{token-only, non-org} generates an API key and proceeds with org-mode false', async () => {
    const platform = createPlatform({ org: false });
    vi.stubGlobal('fetch', platform.fetch);
    const { core, outputs } = createCore(baseInputs({ 'postman-api-key': '' }));

    await runAction(core, createExecStub());

    expect(
      platform.events.some((entry) => entry.startsWith('proxy:identity POST /api/keys'))
    ).toBe(true);
    expect(platform.state.mockCreated).toBe(true);
    expect(outputs['environment-uids-json']).toBeDefined();
  });

  it('rejects with a clear error when neither postman-api-key nor postman-access-token is provided', async () => {
    const platform = createPlatform({ org: false });
    vi.stubGlobal('fetch', platform.fetch);
    const { core } = createCore(
      baseInputs({ 'postman-api-key': '', 'postman-access-token': '' })
    );

    await expect(runAction(core, createExecStub())).rejects.toThrow(
      /postman-api-key is missing or invalid.*no postman-access-token provided/
    );
  });

  it('{PMAK-only, org} eagerly mints an access token before any gateway call, auto-detects org-mode, and completes (7e2ed70-class guard)', async () => {
    const platform = createPlatform({ org: true });
    vi.stubGlobal('fetch', platform.fetch);
    const { core, outputs } = createCore(baseInputs({ 'postman-access-token': '' }));

    await runAction(core, createExecStub());

    // The eager mint happened exactly once, and before the first gateway proxy call.
    expect(platform.state.mintCount).toBe(1);
    const mintIndex = platform.events.findIndex(
      (entry) => entry.includes('POST') && entry.includes('/service-account-tokens')
    );
    const firstProxyIndex = platform.events.findIndex((entry) => entry.startsWith('proxy:'));
    expect(mintIndex).toBeGreaterThanOrEqual(0);
    expect(firstProxyIndex).toBeGreaterThan(mintIndex);

    // Org-mode was detected from ums squads with the minted token, and assets landed.
    expect(platform.events.some((entry) => entry.startsWith('proxy:ums'))).toBe(true);
    expect(platform.state.mockCreated).toBe(true);
    expect(platform.state.monitorCreated).toBe(true);
    expect(outputs['environment-uids-json']).toBeDefined();
  });

  it('{PMAK-only, non-org} eagerly mints and completes with org-mode false', async () => {
    const platform = createPlatform({ org: false });
    vi.stubGlobal('fetch', platform.fetch);
    const { core, outputs } = createCore(baseInputs({ 'postman-access-token': '' }));

    await runAction(core, createExecStub());

    expect(platform.state.mintCount).toBe(1);
    expect(platform.state.mockCreated).toBe(true);
    expect(platform.state.monitorCreated).toBe(true);
    expect(outputs['environment-uids-json']).toBeDefined();
  });

  it('{both, org, beta stack} routes every call to beta hosts', async () => {
    const platform = createPlatform({ org: true, stack: 'beta' });
    vi.stubGlobal('fetch', platform.fetch);
    const { core, outputs } = createCore(baseInputs({ 'postman-stack': 'beta' }));

    await runAction(core, createExecStub());

    const fetches = platform.events.filter((entry) => entry.startsWith('fetch:'));
    expect(fetches.some((entry) => entry.includes('api.getpostman-beta.com'))).toBe(true);
    expect(fetches.some((entry) => entry.includes('gw.postman-beta.com'))).toBe(true);
    const prodHits = fetches.filter(
      (entry) =>
        entry.includes('api.getpostman.com') ||
        entry.includes('bifrost-premium-https-v4.gw.postman.com')
    );
    expect(prodHits).toEqual([]);
    expect(outputs['environment-uids-json']).toBeDefined();
  });
});
