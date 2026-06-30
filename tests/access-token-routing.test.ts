import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRepoSyncDependencies,
  type ResolvedInputs
} from '../src/index.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

function createInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    projectName: 'core-payments',
    workspaceId: 'ws-123',
    baselineCollectionId: 'col-baseline',
    smokeCollectionId: 'col-smoke',
    contractCollectionId: 'col-contract',
    collectionSyncMode: 'refresh',
    specSyncMode: 'update',
    releaseLabel: undefined,
    environments: ['prod'],
    repoUrl: 'https://github.com/postman-cs/repo-sync-demo',
    integrationBackend: 'bifrost',
    workspaceLinkEnabled: true,
    environmentSyncEnabled: true,
    systemEnvMap: {},
    environmentUids: {},
    envRuntimeUrls: {},
    artifactDir: 'postman',
    repoWriteMode: 'none',
    currentRef: 'main',
    githubHeadRef: '',
    githubRefName: 'main',
    committerName: 'Postman',
    committerEmail: 'support@postman.com',
    postmanApiKey: 'pmak-test',
    postmanAccessToken: 'access-token-xyz',
    credentialPreflight: 'warn',
    githubToken: '',
    ghFallbackToken: '',
    ciWorkflowBase64: '',
    generateCiWorkflow: false,
    monitorType: 'cloud',
    ciWorkflowPath: '.github/workflows/ci.yml',
    orgMode: false,
    monitorId: '',
    mockUrl: '',
    monitorCron: '',
    sslClientCert: '',
    sslClientKey: '',
    sslClientPassphrase: '',
    sslExtraCaCerts: '',
    specId: '',
    specPath: '',
    teamId: '',
    repository: 'postman-cs/repo-sync-demo',
    postmanRegion: 'us',
    postmanStack: 'prod',
    postmanApiBase: 'https://api.getpostman.com',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
    postmanCliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh',
    postmanIapubBase: 'https://iapub.postman.co',
    ...overrides
  };
}

function factories() {
  const secrets: string[] = [];
  return {
    secrets,
    factory: {
      core: {
        info: vi.fn(),
        setOutput: vi.fn(),
        warning: vi.fn(),
        setSecret: (s: string) => secrets.push(s)
      },
      exec: { getExecOutput: vi.fn() } as never
    }
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('createRepoSyncDependencies access-token-primary routing', () => {
  it('routes mock + monitor asset ops through the gateway when an access token is present', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/ws/proxy')) {
        return jsonResponse({ id: 'mock-uuid', url: 'https://mock-uuid.mock.pstmn.io' });
      }
      return jsonResponse({}, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { factory } = factories();
    const deps = createRepoSyncDependencies(
      createInputs(),
      { apiKey: 'pmak-test', teamId: '10490519' },
      factory
    );

    const result = await deps.postman.createMock('ws-123', 'm', 'col-1', '');
    expect(result.uid).toBe('mock-uuid');

    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('/ws/proxy');
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-access-token']).toBe('access-token-xyz');
    expect(headers['X-Api-Key']).toBeUndefined();
    const env = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
    expect(env.service).toBe('mock');
  });

  it('routes environment create through the gateway sync service when an access token is present', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/ws/proxy')) {
        return jsonResponse({ data: { uid: 'env-1' } });
      }
      return jsonResponse({}, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { factory } = factories();
    const deps = createRepoSyncDependencies(
      createInputs(),
      { apiKey: 'pmak-test', teamId: '10490519' },
      factory
    );

    const uid = await deps.postman.createEnvironment('ws-123', 'prod', []);
    expect(uid).toBe('env-1');

    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('/ws/proxy');
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-access-token']).toBe('access-token-xyz');
    expect(headers['X-Api-Key']).toBeUndefined();
    const proxied = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
    expect(proxied.service).toBe('sync');
    expect(String(proxied.path)).toContain('/environment/import?workspace=ws-123');
  });

  it('hard-errors (no PMAK asset fallback) when no access token is present', () => {
    // C1: PMAK exists only to mint the access token. With no access token there
    // is no asset path at all — repo-sync refuses to route asset ops through PMAK.
    const { factory } = factories();
    expect(() =>
      createRepoSyncDependencies(
        createInputs({ postmanAccessToken: '' }),
        { apiKey: 'pmak-test', teamId: '10490519' },
        factory
      )
    ).toThrow(/postman-access-token is required/);
  });
});
