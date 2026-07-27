import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the adapter module before importing
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

describe('secrets resolver provider environment seeding', () => {
  let originalCwd = '';
  let testDir = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'secrets-resolver-test-'));
    process.chdir(testDir);
    process.env.GITHUB_REPOSITORY = 'postman-cs/repo-sync-demo';
    process.env.GITHUB_REF_NAME = 'main';
    delete process.env.GITHUB_HEAD_REF;
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('seeds no credential variables when provider is none', async () => {
    const createEnvironment = vi.fn().mockResolvedValue('env-prod');
    const postman = makePostman({ createEnvironment });
    const inputs = createInputs({ secretsResolverProvider: 'none' });

    await runRepoSync(inputs, makeDeps(postman, makeGithub()));

    const envValues = createEnvironment.mock.calls[0]?.[2] as Array<{ key: string; value: string; type: string }>;
    const credentialKeys = envValues
      .map((v) => v.key)
      .filter(
        (key) =>
          key.startsWith('AWS_') ||
          key.startsWith('AZURE_') ||
          key.startsWith('GCP_')
      );

    expect(credentialKeys).toEqual([]);
  });

  it('seeds AWS credential variables when provider is aws', async () => {
    const createEnvironment = vi.fn().mockResolvedValue('env-prod');
    const postman = makePostman({ createEnvironment });
    const inputs = createInputs({ secretsResolverProvider: 'aws' });

    await runRepoSync(inputs, makeDeps(postman, makeGithub()));

    const envValues = createEnvironment.mock.calls[0]?.[2] as Array<{ key: string; value: string; type: string }>;
    const keys = envValues.map((v) => v.key);

    expect(keys).toContain('AWS_ACCESS_KEY_ID');
    expect(keys).toContain('AWS_SECRET_ACCESS_KEY');
    expect(keys).toContain('AWS_REGION');
    expect(keys).toContain('AWS_SECRET_NAME');

    // Verify types
    const awsKeyId = envValues.find((v) => v.key === 'AWS_ACCESS_KEY_ID');
    const awsRegion = envValues.find((v) => v.key === 'AWS_REGION');
    expect(awsKeyId?.type).toBe('secret');
    expect(awsRegion?.type).toBe('default');
  });

  it('seeds Azure credential variables when provider is azure', async () => {
    const createEnvironment = vi.fn().mockResolvedValue('env-prod');
    const postman = makePostman({ createEnvironment });
    const inputs = createInputs({ secretsResolverProvider: 'azure' });

    await runRepoSync(inputs, makeDeps(postman, makeGithub()));

    const envValues = createEnvironment.mock.calls[0]?.[2] as Array<{ key: string; value: string; type: string }>;
    const keys = envValues.map((v) => v.key);

    expect(keys).toContain('AZURE_KEY_VAULT_NAME');
    expect(keys).toContain('AZURE_SECRET_NAME');
    expect(keys).toContain('AZURE_ACCESS_TOKEN');

    // Verify types
    const azureToken = envValues.find((v) => v.key === 'AZURE_ACCESS_TOKEN');
    const azureVaultName = envValues.find((v) => v.key === 'AZURE_KEY_VAULT_NAME');
    expect(azureToken?.type).toBe('secret');
    expect(azureVaultName?.type).toBe('default');
  });

  it('seeds GCP credential variables when provider is gcp', async () => {
    const createEnvironment = vi.fn().mockResolvedValue('env-prod');
    const postman = makePostman({ createEnvironment });
    const inputs = createInputs({ secretsResolverProvider: 'gcp' });

    await runRepoSync(inputs, makeDeps(postman, makeGithub()));

    const envValues = createEnvironment.mock.calls[0]?.[2] as Array<{ key: string; value: string; type: string }>;
    const keys = envValues.map((v) => v.key);

    expect(keys).toContain('GCP_PROJECT_ID');
    expect(keys).toContain('GCP_SECRET_NAME');
    expect(keys).toContain('GCP_ACCESS_TOKEN');

    // Verify types
    const gcpToken = envValues.find((v) => v.key === 'GCP_ACCESS_TOKEN');
    const gcpProjectId = envValues.find((v) => v.key === 'GCP_PROJECT_ID');
    expect(gcpToken?.type).toBe('secret');
    expect(gcpProjectId?.type).toBe('default');
  });

  it('does not leak AWS variables to Azure provider', async () => {
    const createEnvironment = vi.fn().mockResolvedValue('env-prod');
    const postman = makePostman({ createEnvironment });
    const inputs = createInputs({ secretsResolverProvider: 'azure' });

    await runRepoSync(inputs, makeDeps(postman, makeGithub()));

    const envValues = createEnvironment.mock.calls[0]?.[2] as Array<{ key: string; value: string; type: string }>;
    const keys = envValues.map((v) => v.key);

    expect(keys.some((key) => key.startsWith('AWS_'))).toBe(false);
  });

  it('does not leak AWS variables to GCP provider', async () => {
    const createEnvironment = vi.fn().mockResolvedValue('env-prod');
    const postman = makePostman({ createEnvironment });
    const inputs = createInputs({ secretsResolverProvider: 'gcp' });

    await runRepoSync(inputs, makeDeps(postman, makeGithub()));

    const envValues = createEnvironment.mock.calls[0]?.[2] as Array<{ key: string; value: string; type: string }>;
    const keys = envValues.map((v) => v.key);

    expect(keys.some((key) => key.startsWith('AWS_'))).toBe(false);
  });
});
