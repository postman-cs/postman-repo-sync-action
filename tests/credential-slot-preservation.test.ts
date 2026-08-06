import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { ADAPTER_MODULE, createAdapterMockModule } = vi.hoisted(() => {
  const ADAPTER_MODULE = '../src/lib/postman/internal-integration-adapter.js';
  function createAdapterMockModule() {
    return {
      createInternalIntegrationAdapter: vi.fn(() => ({
        createApiKey: vi.fn().mockResolvedValue('pmak-generated-from-mock'),
        associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
        connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
        findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
      }))
    };
  }
  return { ADAPTER_MODULE, createAdapterMockModule };
});

vi.mock('../src/lib/postman/internal-integration-adapter.js', createAdapterMockModule);

type IndexModule = typeof import('../src/index.js');

let runRepoSync: IndexModule['runRepoSync'];

async function reloadRepoSyncModules(): Promise<void> {
  vi.doMock(ADAPTER_MODULE, createAdapterMockModule);
  vi.resetModules();
  ({ runRepoSync } = await import('../src/index.js'));
}

beforeEach(async () => {
  await reloadRepoSyncModules();
});

afterEach(() => {
  vi.doUnmock(ADAPTER_MODULE);
  vi.resetModules();
});

function createInputs(overrides: Record<string, unknown> = {}) {
  return {
    projectName: 'core-payments',
    workspaceId: 'ws-123',
    baselineCollectionId: 'col-baseline',
    smokeCollectionId: 'col-smoke',
    contractCollectionId: 'col-contract',
    onboardingScope: 'full' as const,
    collectionSyncMode: 'refresh' as const,
    specSyncMode: 'update' as const,
    environments: ['prod'],
    repoUrl: '',
    integrationBackend: 'bifrost',
    workspaceLinkEnabled: false,
    environmentSyncEnabled: false,
    systemEnvMap: {},
    environmentUids: {},
    envRuntimeUrls: { prod: 'https://api.example.com' },
    artifactDir: 'postman',
    repoWriteMode: 'none' as const,
    currentRef: 'main',
    githubHeadRef: '',
    githubRefName: 'main',
    committerName: 'Postman',
    committerEmail: 'support@postman.com',
    postmanApiKey: '',
    postmanAccessToken: '',
    credentialPreflight: 'warn' as const,
    branchStrategy: 'legacy' as const,
    previewTtlDays: 30,
    adoToken: '',
    githubToken: '',
    ghFallbackToken: '',
    provider: 'github' as const,
    ciWorkflowBase64: '',
    generateCiWorkflow: false,
    ciRunnerOs: 'linux' as const,
    monitorType: 'cloud',
    ciWorkflowPath: '.github/workflows/ci.yml',
    orgMode: false,
    monitorId: '',
    mockUrl: '',
    mockVisibility: 'public' as const,
    mockEnvironmentEnabled: false,
    monitorCron: '',
    sslClientCert: '',
    sslClientKey: '',
    sslClientPassphrase: '',
    sslExtraCaCerts: '',
    specId: '',
    specContentChanged: true,
    specPath: '',
    teamId: '',
    secretsResolverProvider: 'none' as const,
    repository: 'postman-cs/repo-sync-demo',
    postmanRegion: 'us' as const,
    postmanStack: 'prod' as const,
    postmanApiBase: 'https://api.getpostman.com',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
    postmanFallbackBase: 'https://go.postman.co/_api',
    postmanCliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh',
    postmanIapubBase: 'https://iapub.postman.co',
    ...overrides
  };
}

function makePostman(overrides: Record<string, unknown> = {}) {
  return {
    createEnvironment: vi.fn().mockResolvedValue('env-prod'),
    updateEnvironment: vi.fn().mockResolvedValue(undefined),
    findEnvironmentByName: vi.fn().mockResolvedValue(null),
    getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
    createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
    createMonitor: vi.fn().mockResolvedValue('mon-1'),
    getCollection: vi.fn().mockResolvedValue({
      info: { name: 'core-payments', _postman_id: 'col-baseline' },
      item: []
    }),
    listMonitors: vi.fn().mockResolvedValue([]),
    listMocks: vi.fn().mockResolvedValue([]),
    monitorExists: vi.fn().mockResolvedValue(false),
    mockExists: vi.fn().mockResolvedValue(false),
    findMonitorByCollection: vi.fn().mockResolvedValue(null),
    findMockByCollection: vi.fn().mockResolvedValue(null),
    runMonitor: vi.fn().mockResolvedValue(undefined),
    listEnvironments: vi.fn().mockResolvedValue([]),
    deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    deleteMock: vi.fn().mockResolvedValue(undefined),
    deleteMonitor: vi.fn().mockResolvedValue(undefined),
    configurePrivateMockRuntimeAuth: vi.fn().mockResolvedValue(0),
    ...overrides
  };
}

function makeGithub() {
  return {
    getRepositoryVariable: vi.fn().mockRejectedValue(new Error('not found')),
    setRepositoryVariable: vi.fn().mockResolvedValue(undefined)
  };
}

function makeDeps(postman: ReturnType<typeof makePostman>, github: ReturnType<typeof makeGithub>) {
  return {
    core: {
      getInput: vi.fn(),
      info: vi.fn(),
      setOutput: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn(),
      notice: vi.fn()
    },
    exec: {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    },
    postman,
    github
  };
}

/**
 * Regression: ADO pipeline 155 (Cust-Clean-Harbors-Drum-API) run 2858.
 *
 * A consumer that onboarded before provider-scoped credential slots has a
 * `00 - Resolve Secrets` request baked into an existing collection, and that
 * request reads {{AWS_REGION}}. `updateEnvironment` REPLACES the whole value
 * array, so refreshing with provider 'none' deleted AWS_REGION out from under
 * the collection and the run died with:
 *
 *   POST https://secretsmanager.{{AWS_REGION}}.amazonaws.com [errored]
 *   getaddrinfo ENOTFOUND secretsmanager.{{aws_region}}.amazonaws.com
 *
 * Refresh must never silently drop a credential slot the environment already
 * carried. Fresh creates stay clean; only refresh preserves.
 */
describe('credential slot preservation on environment refresh', () => {
  let originalCwd = '';
  let testDir = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'cred-preserve-test-'));
    process.chdir(testDir);
    process.env.GITHUB_REPOSITORY = 'postman-cs/repo-sync-demo';
    process.env.GITHUB_REF_NAME = 'main';
    delete process.env.GITHUB_HEAD_REF;
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('preserves pre-existing AWS credential slots when refreshing with provider none', async () => {
    const updateEnvironment = vi.fn().mockResolvedValue(undefined);
    const postman = makePostman({
      updateEnvironment,
      findEnvironmentByName: vi.fn().mockResolvedValue({ uid: 'env-existing', name: 'core-payments prod' }),
      getEnvironment: vi.fn().mockResolvedValue({
        values: [
          { key: 'baseUrl', value: 'https://api.example.com', type: 'default' },
          { key: 'AWS_ACCESS_KEY_ID', value: '', type: 'secret' },
          { key: 'AWS_SECRET_ACCESS_KEY', value: '', type: 'secret' },
          { key: 'AWS_REGION', value: 'eu-west-2', type: 'default' },
          { key: 'AWS_SECRET_NAME', value: 'api-credentials-prod', type: 'default' }
        ]
      })
    });
    const inputs = createInputs({
      secretsResolverProvider: 'none',
      environmentUids: { prod: 'env-existing' }
    });

    await runRepoSync(inputs, makeDeps(postman, makeGithub()));

    expect(updateEnvironment).toHaveBeenCalled();
    const values = updateEnvironment.mock.calls[0]?.[2] as Array<{ key: string; value: string; type: string }>;
    const byKey = new Map(values.map((v) => [v.key, v]));

    // The collection still references {{AWS_REGION}}; dropping it breaks the run.
    expect(byKey.get('AWS_REGION')?.value).toBe('eu-west-2');
    expect(byKey.has('AWS_ACCESS_KEY_ID')).toBe(true);
    expect(byKey.has('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(byKey.get('AWS_SECRET_NAME')?.value).toBe('api-credentials-prod');

    // Secret-typed slots must not be downgraded to plain defaults.
    expect(byKey.get('AWS_ACCESS_KEY_ID')?.type).toBe('secret');
  });

  it('does not seed credential slots on a fresh create with provider none', async () => {
    const createEnvironment = vi.fn().mockResolvedValue('env-prod');
    const postman = makePostman({ createEnvironment });
    const inputs = createInputs({ secretsResolverProvider: 'none' });

    await runRepoSync(inputs, makeDeps(postman, makeGithub()));

    const values = createEnvironment.mock.calls[0]?.[2] as Array<{ key: string; value: string; type: string }>;
    const credentialKeys = values
      .map((v) => v.key)
      .filter((key) => key.startsWith('AWS_') || key.startsWith('AZURE_') || key.startsWith('GCP_'));

    expect(credentialKeys).toEqual([]);
  });

  it('lets the selected provider win over a stale preserved slot', async () => {
    const updateEnvironment = vi.fn().mockResolvedValue(undefined);
    const postman = makePostman({
      updateEnvironment,
      findEnvironmentByName: vi.fn().mockResolvedValue({ uid: 'env-existing', name: 'core-payments prod' }),
      getEnvironment: vi.fn().mockResolvedValue({
        values: [{ key: 'AWS_REGION', value: 'eu-west-2', type: 'default' }]
      })
    });
    const inputs = createInputs({
      secretsResolverProvider: 'aws',
      environmentUids: { prod: 'env-existing' }
    });

    await runRepoSync(inputs, makeDeps(postman, makeGithub()));

    const values = updateEnvironment.mock.calls[0]?.[2] as Array<{ key: string; value: string; type: string }>;
    const regions = values.filter((v) => v.key === 'AWS_REGION');

    // Exactly one AWS_REGION: the provider-seeded slot, not a duplicate.
    expect(regions).toHaveLength(1);
    expect(values.filter((v) => v.key === 'AWS_SECRET_NAME')).toHaveLength(1);
  });
});
