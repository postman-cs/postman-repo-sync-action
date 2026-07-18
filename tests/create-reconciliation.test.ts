import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRepoSync, type ResolvedInputs } from '../src/index.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';

const COLLECTION_UID = '10490519-12345678-abcd-ef01-2345-678901234567';
const ENVIRONMENT_UID = '10490519-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

function envelope(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function buildClient(fetchImpl: typeof fetch): PostmanGatewayAssetsClient {
  const gateway = new AccessTokenGatewayClient({
    tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
    bifrostBaseUrl: 'https://bifrost.example.com',
    fetchImpl,
    maxRetries: 3,
    retryBaseDelayMs: 1,
    sleepImpl: async () => undefined
  });
  return new PostmanGatewayAssetsClient({
    gateway,
    workspaceId: 'ws-1',
    reconcileAttempts: 3,
    reconcileDelayMs: 1,
    sleep: async () => undefined
  });
}

interface LiveAssets {
  environments: Array<{ id: string; name: string; owner: string }>;
  mocks: Array<{ id: string; name: string; collection: string; environment?: string; url: string }>;
  monitors: Array<{ id: string; name: string; collection: string; environment?: string; active: boolean }>;
}

function liveApi(state: LiveAssets, ambiguousCreates = false) {
  const counts = { environment: 0, environmentUpdate: 0, mock: 0, monitor: 0 };
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const request = envelope(init);
    const method = String(request.method ?? '');
    const path = String(request.path ?? '');
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (method === 'post' && path.startsWith('/list/environment')) {
      return jsonResponse({ data: state.environments });
    }
    if (method === 'post' && path.startsWith('/environment/import')) {
      counts.environment += 1;
      const id = String(body.id);
      state.environments.push({ id, name: String(body.name), owner: '10490519' });
      return ambiguousCreates
        ? jsonResponse({ error: { name: 'serverError' } }, { status: 503 })
        : jsonResponse({ data: { id, owner: '10490519' } });
    }
    if (method === 'put' && path.startsWith('/environment/')) {
      counts.environmentUpdate += 1;
      return jsonResponse({ data: body });
    }
    if (method === 'get' && path.startsWith('/mocks?')) {
      return jsonResponse(state.mocks);
    }
    if (method === 'post' && path.startsWith('/mocks?')) {
      counts.mock += 1;
      const mock = {
        id: 'mock-1',
        name: String(body.name),
        collection: String(body.collection),
        ...(body.environment ? { environment: String(body.environment) } : {}),
        url: 'https://mock-1.mock.pstmn.io'
      };
      state.mocks.push(mock);
      return ambiguousCreates
        ? jsonResponse({ error: { name: 'serverError' } }, { status: 503 })
        : jsonResponse(mock);
    }
    if (method === 'get' && path.includes('/jobTemplates')) {
      return jsonResponse({ data: state.monitors });
    }
    if (method === 'post' && path.startsWith('/jobTemplates?')) {
      counts.monitor += 1;
      const monitor = {
        id: 'monitor-1',
        name: String(body.name),
        collection: String(body.collection),
        ...(body.environment ? { environment: String(body.environment) } : {}),
        active: true
      };
      state.monitors.push(monitor);
      return ambiguousCreates
        ? jsonResponse({ error: { name: 'serverError' } }, { status: 503 })
        : jsonResponse({ data: monitor });
    }
    return jsonResponse({});
  });
  return { counts, fetchImpl };
}

function emptyState(): LiveAssets {
  return { environments: [], mocks: [], monitors: [] };
}

describe('accepted write followed by an ambiguous response', () => {
  it('adopts the environment and does not submit a second import', async () => {
    const api = liveApi(emptyState(), true);

    await expect(buildClient(api.fetchImpl).createEnvironment('ws-1', 'Acme - prod', []))
      .resolves.toMatch(/^10490519-/);

    expect(api.counts.environment).toBe(1);
  });

  it('adopts the mock and does not submit a second create', async () => {
    const api = liveApi(emptyState(), true);

    await expect(buildClient(api.fetchImpl).createMock('ws-1', 'Acme Mock', COLLECTION_UID, ENVIRONMENT_UID))
      .resolves.toEqual({ uid: 'mock-1', url: 'https://mock-1.mock.pstmn.io' });

    expect(api.counts.mock).toBe(1);
  });

  it('adopts the monitor and does not submit a second create', async () => {
    const api = liveApi(emptyState(), true);

    await expect(buildClient(api.fetchImpl).createMonitor('ws-1', 'Acme Monitor', COLLECTION_UID, ENVIRONMENT_UID))
      .resolves.toBe('monitor-1');

    expect(api.counts.monitor).toBe(1);
  });

  const ambiguousCases: Array<{
    label: string;
    outcome: () => Response;
  }> = [
    { label: 'statusless TypeError', outcome: () => { throw new TypeError('fetch failed'); } },
    {
      label: 'ECONNRESET socket hang-up',
      outcome: () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }
    },
    {
      label: 'ETIMEDOUT after send',
      outcome: () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); }
    },
    {
      label: 'aborted transport',
      outcome: () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
    },
    ...[408, 429, 500, 502, 504].map((status) => ({
      label: `HTTP ${status}`,
      outcome: () => jsonResponse({ error: { name: 'gatewayError' } }, { status })
    }))
  ];

  it.each(ambiguousCases)('reconciles $label and never submits a second POST', async ({ outcome }) => {
    let created = false;
    let posts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const request = envelope(init);
      const method = String(request.method ?? '');
      const path = String(request.path ?? '');
      if (method === 'get' && path.startsWith('/mocks?')) {
        return jsonResponse(created ? [{
          id: 'mock-adopted',
          name: 'Acme Mock',
          collection: COLLECTION_UID,
          environment: ENVIRONMENT_UID,
          url: 'https://mock-adopted.mock.pstmn.io'
        }] : []);
      }
      if (method === 'post' && path.startsWith('/mocks?')) {
        posts += 1;
        created = true;
        return outcome();
      }
      return jsonResponse({});
    });

    await expect(buildClient(fetchImpl).createMock(
      'ws-1',
      'Acme Mock',
      COLLECTION_UID,
      ENVIRONMENT_UID
    )).resolves.toEqual({
      uid: 'mock-adopted',
      url: 'https://mock-adopted.mock.pstmn.io'
    });
    expect(posts).toBe(1);
  });

  it.each([400, 401, 403, 404])('does not reconcile ordinary HTTP %s create failures', async (status) => {
    let listReads = 0;
    let posts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const request = envelope(init);
      const method = String(request.method ?? '');
      const path = String(request.path ?? '');
      if (method === 'get' && path.startsWith('/mocks?')) {
        listReads += 1;
        return jsonResponse([]);
      }
      if (method === 'post' && path.startsWith('/mocks?')) {
        posts += 1;
        return jsonResponse({ error: { name: 'clientError' } }, { status });
      }
      return jsonResponse({});
    });

    await expect(buildClient(fetchImpl).createMock(
      'ws-1',
      'Acme Mock',
      COLLECTION_UID,
      ENVIRONMENT_UID
    )).rejects.toThrow(String(status));
    expect(posts).toBe(1);
    expect(listReads).toBe(1);
  });

  it('does not submit another POST when ambiguity remains unresolved', async () => {
    let posts = 0;
    let listReads = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const request = envelope(init);
      const method = String(request.method ?? '');
      const path = String(request.path ?? '');
      if (method === 'get' && path.startsWith('/mocks?')) {
        listReads += 1;
        return jsonResponse([]);
      }
      if (method === 'post' && path.startsWith('/mocks?')) {
        posts += 1;
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return jsonResponse({});
    });

    await expect(buildClient(fetchImpl).createMock(
      'ws-1',
      'Acme Mock',
      COLLECTION_UID,
      ENVIRONMENT_UID
    )).rejects.toThrow('socket hang up');
    // Empty discovery reads prove the create absent, so one fallback resend
    // fires; it hits the same failing transport and the original error is
    // rethrown. An inconclusive discovery (read error) would suppress it.
    expect(posts).toBe(2);
    expect(listReads).toBe(4);
  });
});

describe('safe-read retry boundaries', () => {
  const retryableCases: Array<{ label: string; outcome: () => Response }> = [
    { label: 'TypeError', outcome: () => { throw new TypeError('fetch failed'); } },
    {
      label: 'ECONNRESET',
      outcome: () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }
    },
    {
      label: 'ETIMEDOUT',
      outcome: () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); }
    },
    {
      label: 'AbortError',
      outcome: () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
    },
    ...[408, 429, 500, 502, 504].map((status) => ({
      label: `HTTP ${status}`,
      outcome: () => jsonResponse({ error: 'transient' }, { status })
    }))
  ];

  it.each(retryableCases)('retries $label for a safe read', async ({ outcome }) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => outcome())
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const gateway = new AccessTokenGatewayClient({
      tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
      fetchImpl,
      maxRetries: 1,
      sleepImpl: async () => undefined
    });

    await expect(gateway.requestJson({ service: 'mock', method: 'get', path: '/mocks' }))
      .resolves.toEqual({ data: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404])('does not retry ordinary HTTP %s safe-read failures', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: 'client' }, { status })
    );
    const gateway = new AccessTokenGatewayClient({
      tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
      fetchImpl,
      maxRetries: 1,
      sleepImpl: async () => undefined
    });

    await expect(gateway.requestJson({ service: 'mock', method: 'get', path: '/mocks' }))
      .rejects.toThrow(String(status));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fresh-client two-run live discovery', () => {
  it('reuses environments, mocks, and monitors without tracked IDs or process memory', async () => {
    const state = emptyState();
    const api = liveApi(state);
    const firstRun = buildClient(api.fetchImpl);

    const firstEnvironment = await firstRun.createEnvironment('ws-1', 'Acme - prod', []);
    const firstMock = await firstRun.createMock('ws-1', 'Acme Mock', COLLECTION_UID, firstEnvironment);
    const firstMonitor = await firstRun.createMonitor('ws-1', 'Acme Monitor', COLLECTION_UID, firstEnvironment);

    const secondRun = buildClient(api.fetchImpl);
    await expect(secondRun.createEnvironment('ws-1', 'Acme - prod', [])).resolves.toBe(firstEnvironment);
    await expect(secondRun.createMock('ws-1', 'Acme Mock', COLLECTION_UID, firstEnvironment)).resolves.toEqual(firstMock);
    await expect(secondRun.createMonitor('ws-1', 'Acme Monitor', COLLECTION_UID, firstEnvironment)).resolves.toBe(firstMonitor);

    expect(api.counts).toEqual({ environment: 1, environmentUpdate: 1, mock: 1, monitor: 1 });
  });
});

describe('exact live identity and duplicate handling', () => {
  it('fails closed when two environments have the exact workspace-scoped name', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [
      { id: 'env-a', owner: '10490519', name: 'Acme - prod' },
      { id: 'env-b', owner: '10490519', name: 'Acme - prod' }
    ] }));

    await expect(buildClient(fetchImpl).findEnvironmentByName('ws-1', 'Acme - prod'))
      .rejects.toThrow(/multiple environments.*env-a.*env-b/i);
  });

  it('fails closed when two mocks match name, collection, and environment', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([
      { id: 'mock-a', name: 'Acme Mock', collection: COLLECTION_UID, environment: ENVIRONMENT_UID, url: 'https://a.mock' },
      { id: 'mock-b', name: 'Acme Mock', collection: COLLECTION_UID, environment: ENVIRONMENT_UID, url: 'https://b.mock' }
    ]));

    await expect(buildClient(fetchImpl).findMockByCollection(
      COLLECTION_UID,
      ENVIRONMENT_UID,
      'Acme Mock'
    )).rejects.toThrow(/multiple mocks.*mock-a.*mock-b/i);
  });

  it('fails closed when ambiguous-create reconciliation finds two exact mocks', async () => {
    let created = false;
    let posts = 0;
    const duplicates = [
      { id: 'mock-a', name: 'Acme Mock', collection: COLLECTION_UID, environment: ENVIRONMENT_UID, url: 'https://a.mock' },
      { id: 'mock-b', name: 'Acme Mock', collection: COLLECTION_UID, environment: ENVIRONMENT_UID, url: 'https://b.mock' }
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const request = envelope(init);
      const method = String(request.method ?? '');
      const path = String(request.path ?? '');
      if (method === 'get' && path.startsWith('/mocks?')) {
        return jsonResponse(created ? duplicates : []);
      }
      if (method === 'post' && path.startsWith('/mocks?')) {
        posts += 1;
        created = true;
        return jsonResponse({ error: 'ambiguous' }, { status: 503 });
      }
      return jsonResponse({});
    });

    await expect(buildClient(fetchImpl).createMock(
      'ws-1',
      'Acme Mock',
      COLLECTION_UID,
      ENVIRONMENT_UID
    // The duplicate-match discovery read throws inside reconcile, which is
    // inconclusive: the fallback resend stays suppressed and the original 503
    // surfaces instead of adopting either twin.
    )).rejects.toThrow(/503/);
    expect(posts).toBe(1);
  });

  it('fails closed when two monitors match name, collection, and environment', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [
      { id: 'monitor-a', name: 'Acme Monitor', collection: COLLECTION_UID, environment: ENVIRONMENT_UID },
      { id: 'monitor-b', name: 'Acme Monitor', collection: COLLECTION_UID, environment: ENVIRONMENT_UID }
    ] }));

    await expect(buildClient(fetchImpl).findMonitorByCollection(
      COLLECTION_UID,
      ENVIRONMENT_UID,
      'Acme Monitor'
    )).rejects.toThrow(/multiple monitors.*monitor-a.*monitor-b/i);
  });

  it('adopts exactly one full mock identity and ignores wrong name/environment siblings', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([
      { id: 'wrong-name', name: 'Other Mock', collection: COLLECTION_UID, environment: ENVIRONMENT_UID, url: 'https://wrong-name.mock' },
      { id: 'wrong-env', name: 'Acme Mock', collection: COLLECTION_UID, environment: 'env-other', url: 'https://wrong-env.mock' },
      { id: 'mock-exact', name: 'Acme Mock', collection: COLLECTION_UID, environment: ENVIRONMENT_UID, url: 'https://exact.mock' }
    ]));

    await expect(buildClient(fetchImpl).findMockByCollection(
      COLLECTION_UID,
      ENVIRONMENT_UID,
      'Acme Mock'
    )).resolves.toEqual({ uid: 'mock-exact', mockUrl: 'https://exact.mock' });
  });

  it('does not use a monitor fallback when no full identity matches', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [
      { id: 'wrong-env', name: 'Acme Monitor', collection: COLLECTION_UID, environment: 'env-other' }
    ] }));

    await expect(buildClient(fetchImpl).findMonitorByCollection(
      COLLECTION_UID,
      ENVIRONMENT_UID,
      'Acme Monitor'
    )).resolves.toBeNull();
  });

  it('does not adopt a mock with the wrong environment after an ambiguous create', async () => {
    let posts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const request = envelope(init);
      const method = String(request.method ?? '');
      const path = String(request.path ?? '');
      if (method === 'get' && path.startsWith('/mocks?')) {
        return jsonResponse([{
          id: 'wrong-env',
          name: 'Acme Mock',
          collection: COLLECTION_UID,
          environment: 'env-other',
          url: 'https://wrong-env.mock'
        }]);
      }
      if (method === 'post' && path.startsWith('/mocks?')) {
        posts += 1;
        return jsonResponse({ error: 'ambiguous' }, { status: 503 });
      }
      return jsonResponse({});
    });

    await expect(buildClient(fetchImpl).createMock(
      'ws-1',
      'Acme Mock',
      COLLECTION_UID,
      ENVIRONMENT_UID
    // Only a wrong-environment sibling exists, so discovery proves the
    // create conclusively absent: the fallback resend fires once (second 503)
    // and the original error is rethrown. The wrong-env sibling is never adopted.
    )).rejects.toThrow('503');
    expect(posts).toBe(2);
  });
});

describe('environment convergence', () => {
  it('updates an adopted environment to the requested values after an ambiguous import', async () => {
    const state = emptyState();
    const api = liveApi(state, true);
    const values = [{ key: 'baseUrl', value: 'https://api.example.com', enabled: true }];

    await buildClient(api.fetchImpl).createEnvironment('ws-1', 'Acme - prod', values);

    expect(api.counts.environment).toBe(1);
    expect(api.counts.environmentUpdate).toBe(1);
    const update = api.fetchImpl.mock.calls
      .map((call) => envelope(call[1] as RequestInit))
      .find((request) => request.method === 'put');
    expect(update?.body).toMatchObject({ name: 'Acme - prod', values });
  });
});

describe('same-process overlap', () => {
  async function expectOneCreateAcrossClients(
    kind: 'environment' | 'mock' | 'monitor'
  ): Promise<void> {
    const state = emptyState();
    const api = liveApi(state);
    const a = buildClient(api.fetchImpl);
    const b = buildClient(api.fetchImpl);

    if (kind === 'environment') {
      const results = await Promise.all([
        a.createEnvironment('ws-1', 'Acme - prod', []),
        b.createEnvironment('ws-1', 'Acme - prod', [])
      ]);
      expect(results[0]).toBe(results[1]);
    } else if (kind === 'mock') {
      const results = await Promise.all([
        a.createMock('ws-1', 'Acme Mock', COLLECTION_UID, ENVIRONMENT_UID),
        b.createMock('ws-1', 'Acme Mock', COLLECTION_UID, ENVIRONMENT_UID)
      ]);
      expect(results[0]).toEqual(results[1]);
    } else {
      const results = await Promise.all([
        a.createMonitor('ws-1', 'Acme Monitor', COLLECTION_UID, ENVIRONMENT_UID),
        b.createMonitor('ws-1', 'Acme Monitor', COLLECTION_UID, ENVIRONMENT_UID)
      ]);
      expect(results[0]).toBe(results[1]);
    }

    expect(api.counts[kind]).toBe(1);
  }

  it('single-flights environment creation across client instances', () =>
    expectOneCreateAcrossClients('environment'));

  it('single-flights mock creation across client instances', () =>
    expectOneCreateAcrossClients('mock'));

  it('single-flights monitor creation across client instances', () =>
    expectOneCreateAcrossClients('monitor'));

  it('fails instead of collapsing concurrent environment calls with different desired values', async () => {
    let resolveImport: ((response: Response) => void) | undefined;
    let imports = 0;
    const importGate = new Promise<Response>((resolve) => {
      resolveImport = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const request = envelope(init);
      const method = String(request.method ?? '');
      const path = String(request.path ?? '');
      if (method === 'post' && path.startsWith('/list/environment')) {
        return jsonResponse({ data: [] });
      }
      if (method === 'post' && path.startsWith('/environment/import')) {
        imports += 1;
        return importGate;
      }
      return jsonResponse({});
    });
    const a = buildClient(fetchImpl);
    const b = buildClient(fetchImpl);
    const first = a.createEnvironment('ws-1', 'Acme - prod', [{ key: 'baseUrl', value: 'https://one.example' }]);
    const second = b.createEnvironment('ws-1', 'Acme - prod', [{ key: 'baseUrl', value: 'https://two.example' }]);

    await expect(second).rejects.toThrow(/incompatible concurrent environment create/i);
    resolveImport?.(jsonResponse({ data: { id: 'env-one', owner: '10490519' } }));
    await expect(first).resolves.toBe('10490519-env-one');
    expect(imports).toBe(1);
  });
});


describe('fresh-process orchestration live discovery reuse', () => {
  let originalCwd = '';
  let testDir = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'repo-sync-create-orch-'));
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  function baseInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
    return {
      projectName: 'Acme',
      workspaceId: 'ws-1',
      baselineCollectionId: COLLECTION_UID,
      smokeCollectionId: '10490519-smoke-uid-0000-0000-000000000001',
      contractCollectionId: '',
      collectionSyncMode: 'refresh',
      specSyncMode: 'update',
      releaseLabel: undefined,
      environments: ['prod'],
      repoUrl: 'https://github.com/example/demo',
      integrationBackend: 'bifrost',
      workspaceLinkEnabled: false,
      environmentSyncEnabled: false,
      systemEnvMap: {},
      environmentUids: {},
      envRuntimeUrls: {},
      artifactDir: 'postman',
      generateCiWorkflow: false,
      ciWorkflowPath: '',
      ciWorkflowBase64: '',
      repoWriteMode: 'none',
      currentRef: '',
      githubHeadRef: '',
      githubRefName: '',
      committerName: 'Postman',
      committerEmail: 'support@postman.com',
      postmanApiKey: 'PMAK-test',
      postmanAccessToken: 'tok',
      orgMode: false,
      monitorType: 'cloud',
      monitorId: '',
      mockUrl: '',
      monitorCron: '',
      provider: 'github',
      githubToken: '',
      ghFallbackToken: '',
      adoToken: '',
      sslClientCert: '',
      sslClientKey: '',
      sslClientPassphrase: '',
      sslExtraCaCerts: '',
      specId: '',
      specPath: '',
      teamId: '10490519',
      repository: '',
      postmanRegion: 'us',
      postmanStack: 'prod',
      postmanApiBase: 'https://api.getpostman.com',
      postmanBifrostBase: 'https://bifrost.example.com',
      postmanFallbackBase: 'https://fallback.example.com/_api',
      postmanCliInstallUrl: '',
      postmanIapubBase: '',
      credentialPreflight: 'warn',
      branchStrategy: 'legacy',
      sections: 'off',
  previewTtlDays: 30,
      ...overrides
    };
  }

  it('second fresh run reuses assets via explicit-input-then-live-discovery without creates', async () => {
    const envName = 'Acme - prod';
    const smokeUid = '10490519-smoke-uid-0000-0000-000000000001';

    const findEnvironmentByName = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ name: envName, uid: ENVIRONMENT_UID });
    const createEnvironment = vi.fn().mockResolvedValue(ENVIRONMENT_UID);
    const updateEnvironment = vi.fn().mockResolvedValue(undefined);
    const findMockByCollection = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ uid: 'mock-1', mockUrl: 'https://mock-1.mock.pstmn.io' });
    const createMock = vi.fn().mockResolvedValue({
      uid: 'mock-1',
      url: 'https://mock-1.mock.pstmn.io'
    });
    const findMonitorByCollection = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ uid: 'mon-1', name: 'Acme - Smoke Monitor' });
    const createMonitor = vi.fn().mockResolvedValue('mon-1');

    const postman = {
      createEnvironment,
      updateEnvironment,
      findEnvironmentByName,
      createMock,
      createMonitor,
      getCollection: vi.fn().mockResolvedValue({
        info: {
          name: 'Acme',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
        },
        item: []
      }),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
      listMocks: vi.fn().mockResolvedValue([]),
      listMonitors: vi.fn().mockResolvedValue([]),
      monitorExists: vi.fn().mockResolvedValue(false),
      mockExists: vi.fn().mockResolvedValue(false),
      findMockByCollection,
      findMonitorByCollection,
      runMonitor: vi.fn().mockResolvedValue(undefined),
      listEnvironments: vi.fn().mockResolvedValue([]),
      deleteEnvironment: vi.fn().mockResolvedValue(undefined),
      deleteMock: vi.fn().mockResolvedValue(undefined),
      deleteMonitor: vi.fn().mockResolvedValue(undefined)
    };

    const first = await runRepoSync(baseInputs(), {
      core: { info: vi.fn(), warning: vi.fn(), setOutput: vi.fn() },
      postman
    });
    expect(createEnvironment).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMonitor).toHaveBeenCalledTimes(1);
    expect(first['mock-url']).toBe('https://mock-1.mock.pstmn.io');
    expect(first['monitor-id']).toBe('mon-1');
    expect(JSON.parse(first['environment-uids-json'])).toEqual({ prod: ENVIRONMENT_UID });

    const second = await runRepoSync(baseInputs({ environmentUids: {} }), {
      core: { info: vi.fn(), warning: vi.fn(), setOutput: vi.fn() },
      postman
    });

    expect(createEnvironment).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMonitor).toHaveBeenCalledTimes(1);
    expect(findEnvironmentByName).toHaveBeenCalledWith('ws-1', envName);
    expect(findMockByCollection).toHaveBeenCalledWith(COLLECTION_UID, ENVIRONMENT_UID, 'Acme Mock');
    expect(findMonitorByCollection).toHaveBeenCalledWith(
      smokeUid,
      ENVIRONMENT_UID,
      'Acme - Smoke Monitor'
    );
    expect(second['mock-url']).toBe('https://mock-1.mock.pstmn.io');
    expect(second['monitor-id']).toBe('mon-1');
    expect(JSON.parse(second['environment-uids-json'])).toEqual({ prod: ENVIRONMENT_UID });
    expect(updateEnvironment).toHaveBeenCalled();
  });
});

describe('gateway operation-aware retries', () => {
  it('submits an unsafe create once when transient retries are disabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: { name: 'serverError' } }, { status: 503 })
    );
    const sleep = vi.fn(async () => undefined);
    const gateway = new AccessTokenGatewayClient({
      tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
      fetchImpl,
      maxRetries: 3,
      sleepImpl: sleep
    });

    await expect(gateway.requestJson(
      { service: 'mock', method: 'post', path: '/mocks', body: {} },
      { retryTransient: false }
    )).rejects.toThrow('503');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retains transient retries for safe reads', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { name: 'serverError' } }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const sleep = vi.fn(async () => undefined);
    const gateway = new AccessTokenGatewayClient({
      tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
      fetchImpl,
      maxRetries: 3,
      sleepImpl: sleep
    });

    await expect(gateway.requestJson({ service: 'mock', method: 'get', path: '/mocks' }))
      .resolves.toEqual({ data: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
