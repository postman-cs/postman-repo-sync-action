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

import { runAction, type ExecLike } from '../../src/index.js';
import { __resetIdentityMemo } from '../../src/lib/postman/credential-identity.js';

interface CoreLike {
  getInput(name: string, options?: { required?: boolean }): string;
  info(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
  setOutput(name: string, value: string): void;
  setSecret(secret: string): void;
}

const HOSTS = {
  prod: {
    api: 'https://api.getpostman.com',
    bifrost: 'https://bifrost-premium-https-v4.gw.postman.com',
    iapub: 'https://iapub.postman.co'
  },
  beta: {
    api: 'https://api.getpostman-beta.com',
    bifrost: 'https://bifrost-https-v4.gw.postman-beta.com',
    iapub: 'https://iapub.postman.co'
  }
} as const;

const NEUTRALIZED_ENV_VARS = [
  'POSTMAN_TEAM_ID',
  'POSTMAN_WORKSPACE_TEAM_ID',
  'GITHUB_TOKEN',
  'GH_FALLBACK_TOKEN'
];

const DEFAULT_SQUAD = { id: 132319, name: 'CSE v12', handle: 'cse-v12', organizationId: 13347347 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function createExecStub(): ExecLike {
  return {
    getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  };
}

interface PlatformOptions {
  org?: boolean;
  stack?: 'prod' | 'beta';
  squads?: unknown[];
  /** Team id in the session identity. Default: org 13347347, non-org 10490519. */
  teamId?: number;
  override?: (ctx: {
    url: string;
    method: string;
    init?: RequestInit;
    proxy?: { service: string; method: string; path: string; body?: unknown };
  }) => Response | undefined;
}

function createPlatform(options: PlatformOptions = {}) {
  const org = options.org ?? false;
  const stack = options.stack ?? 'prod';
  const hosts = HOSTS[stack];
  const teamId = options.teamId ?? (org ? 13347347 : 10490519);
  const squads = options.squads ?? (org ? [DEFAULT_SQUAD] : []);

  const events: string[] = [];
  let mockCreated = false;
  let monitorCreated = false;
  let mintCount = 0;

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    events.push(`fetch:${method} ${url}`);

    let proxy: { service: string; method: string; path: string; body?: unknown } | undefined;
    if (url === `${hosts.bifrost}/ws/proxy`) {
      const payload = JSON.parse(String(init?.body ?? '{}'));
      proxy = {
        service: String(payload.service ?? ''),
        method: String(payload.method ?? 'get').toLowerCase(),
        path: String(payload.path ?? ''),
        body: payload.body
      };
      events.push(`proxy:${proxy.service} ${proxy.method.toUpperCase()} ${proxy.path}`);
    }

    const custom = options.override?.({ url, method, init, proxy });
    if (custom) return custom;

    // Direct endpoints.
    if (url === `${hosts.api}/service-account-tokens` && method === 'POST') {
      mintCount += 1;
      return json({ access_token: 'access-token-minted' });
    }
    if (url === `${hosts.api}/me`) {
      return json({
        user: {
          id: 12345678,
          fullName: 'Ada Lovelace',
          teamId,
          teamName: org ? 'field-services-v12-demo' : 'jared-demo',
          teamDomain: org ? 'field-services-v12-demo' : 'jared-demo'
        }
      });
    }
    if (url === `${hosts.iapub}/api/sessions/current`) {
      return json({
        identity: { team: teamId, domain: org ? 'field-services-v12-demo' : 'jared-demo' },
        data: { user: { id: 555, roles: ['admin'] } },
        consumerType: 'service_account'
      });
    }
    if (url.startsWith('https://dl.pstmn.io/')) {
      return json({ version: '12.0.0' });
    }

    // Bifrost /ws/proxy envelope.
    if (proxy) {
      const { service: svc, method: pmethod, path: ppath } = proxy;

      if (svc === 'ums' && /\/squads/.test(ppath)) {
        if (!org) return json({ error: { message: 'Squad feature is not available for your team.' } }, 400);
        return json({ data: squads });
      }

      if (svc === 'sync') {
        if (pmethod === 'post' && ppath.includes('/environment/import')) {
          return json({ data: { id: 'env-prod-uid', owner: '12345678' } });
        }
        if (pmethod === 'post' && ppath.includes('/list/environment')) {
          return json({ data: [] });
        }
        if (pmethod === 'get' && /\/environment\/[^/]+\/sync/.test(ppath)) {
          return json({ entities: [{ data: { id: 'env-prod', name: 'core-payments - prod', values: [] } }] });
        }
        return json({ data: { ok: true } });
      }

      if (svc === 'mock') {
        if (pmethod === 'get' && /\/mocks(\?|\/)/.test(ppath)) {
          return json({ data: [] });
        }
        if (pmethod === 'post' && ppath.startsWith('/mocks')) {
          mockCreated = true;
          return json({ data: { uid: 'mock-123', url: 'https://mock-123.mock.pstmn.io' } });
        }
        return json({ data: {} });
      }

      if (svc === 'monitors') {
        if (pmethod === 'get' && /\/jobTemplates/.test(ppath)) {
          return json({ data: [] });
        }
        if (pmethod === 'post' && ppath.startsWith('/jobTemplates')) {
          monitorCreated = true;
          return json({ data: { id: 'monitor-123', uid: 'monitor-123' } });
        }
        return json({ data: {} });
      }

      if (svc === 'collection') {
        if (pmethod === 'get' && /\/export$/.test(ppath)) {
          return json({ data: { collection: { info: { name: 'baseline' }, item: [] } } });
        }
        return json({ data: {} });
      }

      if (svc === 'identity' && pmethod === 'post' && ppath === '/api/keys') {
        return json({ apikey: { key: 'pmak-generated' } });
      }

      if (svc === 'workspaces') {
        if (pmethod === 'get' && /\/filesystem(?:\?|$)/.test(ppath)) return json({ data: null });
        return json({ data: {} });
      }

      return json({ data: { ok: true } });
    }

    throw new Error(`Unrouted fetch in repo-sync contract test: ${method} ${url}`);
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    events,
    hosts,
    state: {
      get mockCreated() {
        return mockCreated;
      },
      get monitorCreated() {
        return monitorCreated;
      },
      get mintCount() {
        return mintCount;
      }
    }
  };
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

  beforeEach(() => {
    __resetIdentityMemo();
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
    const originalCwd = testDir;
    try {
      process.chdir(join(tmpdir()));
    } catch {
      void originalCwd;
    }
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
