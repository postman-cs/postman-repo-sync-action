const { createAdapterMockModule } = vi.hoisted(() => {
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
  return { createAdapterMockModule };
});

vi.mock('../src/lib/postman/internal-integration-adapter.js', createAdapterMockModule);

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RepoSyncDependencies, ResolvedInputs } from '../src/index.js';
import { runRepoSync } from '../src/index.js';
import {
  PRIVATE_MOCK_AUTH_ROOT_MARKER,
  PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
  PRIVATE_MOCK_AUTH_ROOT_TYPE
} from '../src/lib/postman/private-mock-auth-script.js';
import { computeArtifactDigest } from '../src/postman-v3/converter.js';

const packageRoot = resolve(import.meta.dirname, '..');
const indexPath = resolve(packageRoot, 'src/index.ts');
const indexSource = readFileSync(indexPath, 'utf8');

function exportCollectionArtifactSource(): string {
  const match = indexSource.match(
    /async function exportCollectionArtifact\([\s\S]*?\n\}(?=\n\n(?:async )?function |\nexport )/
  );
  expect(match?.[0], 'exportCollectionArtifact must exist in src/index.ts').toBeTruthy();
  return match![0];
}

describe('private-mock export cleanup wiring contract', () => {
  it('documents that this package has no dead-export / unused-module CI gate', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    const eslintConfig = readFileSync(resolve(packageRoot, 'eslint.config.js'), 'utf8');
    // The workspace CI doc only exists in the coordinating workspace checkout;
    // a standalone clone of this repository (CI, action consumers) has no
    // ../../docs and the workspace-level assertion is vacuous there.
    const workspaceCiPath = resolve(packageRoot, '../../docs/CI.md');
    const workspaceCi = existsSync(workspaceCiPath)
      ? readFileSync(workspaceCiPath, 'utf8')
      : '';

    expect(packageJson.scripts.lint).toBe('eslint .');
    expect(packageJson.scripts).not.toHaveProperty('knip');
    expect(packageJson.scripts).not.toHaveProperty('ts-prune');
    expect(eslintConfig).not.toMatch(/no-unused-modules|knip|ts-prune|dead-code/i);
    expect(workspaceCi).not.toMatch(/knip|ts-prune|unused.?export|dead.?code/i);
  });

  it('imports applyPrivateMockExportCleanup from private-mock-export-cleanup', () => {
    expect(indexSource).toMatch(
      /from\s+['"]\.\/lib\/postman\/private-mock-export-cleanup\.js['"]/
    );
    expect(indexSource).toMatch(
      /import\s*\{[^}]*\bapplyPrivateMockExportCleanup\b[^}]*\}\s*from\s+['"]\.\/lib\/postman\/private-mock-export-cleanup\.js['"]/
    );
  });

  it('threads privateMockAuth into exportCollectionArtifact from orchestration', () => {
    expect(exportCollectionArtifactSource()).toMatch(/\bprivateMockAuth\b/);
    expect(indexSource).toMatch(/exportCollectionArtifact\(\{[\s\S]*?\bprivateMockAuth\b/);
  });

  it('invokes applyPrivateMockExportCleanup on the cloud export path before YAML conversion', () => {
    const exportFn = exportCollectionArtifactSource();
    expect(exportFn).toMatch(
      /applyPrivateMockExportCleanup[\s\S]*await convertAndSplitAnyCollection/
    );
    expect(indexSource).toMatch(
      /async function preparePrivateMockCloudCollection[\s\S]*applyPrivateMockExportCleanup/
    );
  });

  it('forces smoke/contract cloud export when private-mock auth is active', () => {
    const exportFn = exportCollectionArtifactSource();
    expect(exportFn).toMatch(/\bprivateMockAuth\b/);
    expect(exportFn).toMatch(/['"]smoke['"]/);
    expect(exportFn).toMatch(/['"]contract['"]/);
    expect(exportFn).toContain('tryReusePrebuiltCollection');
    expect(exportFn).toMatch(
      /privateMockAuth[\s\S]{0,500}(?:smoke|contract)|(?:smoke|contract)[\s\S]{0,500}privateMockAuth/
    );
  });

  it('fails before repo mutation when the managed root hook is absent from export IR', () => {
    const exportFn = exportCollectionArtifactSource();
    expect(exportFn).toMatch(/verifyPrivateMockRootHook/);
    expect(indexSource).toContain('PRIVATE_MOCK_AUTH_ROOT_UNVERIFIED');
    expect(indexSource).toMatch(
      /async function preparePrivateMockCloudCollection[\s\S]*verifyPrivateMockRootHook/
    );
  });
});

const PRIVATE_MOCK_LIST_ENTRY = {
  uid: 'explicit-private',
  name: 'Existing Mock',
  collection: 'col-baseline',
  environment: 'env-prod',
  mockUrl: 'https://explicit-private.mock.pstmn.io',
  visibility: 'private' as const
};

function createInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    projectName: 'core-payments',
    workspaceId: 'ws-123',
    baselineCollectionId: 'col-baseline',
    smokeCollectionId: 'col-smoke',
    contractCollectionId: 'col-contract',
    prebuiltCollectionsJson: '',
    collectionSyncMode: 'refresh',
    specSyncMode: 'update',
    releaseLabel: undefined,
    environments: ['prod'],
    repoUrl: 'https://github.com/postman-cs/repo-sync-demo',
    integrationBackend: 'bifrost',
    workspaceLinkEnabled: true,
    environmentSyncEnabled: true,
    systemEnvMap: { prod: 'sys-prod' },
    environmentUids: {},
    envRuntimeUrls: { prod: 'https://api.example.com' },
    artifactDir: 'postman',
    repoWriteMode: 'commit-and-push',
    currentRef: 'feature/repo-sync',
    githubHeadRef: '',
    githubRefName: 'feature/repo-sync',
    committerName: 'Postman',
    committerEmail: 'support@postman.com',
    postmanApiKey: 'pmak-test-input-key',
    postmanAccessToken: 'postman-access-token',
    credentialPreflight: 'warn',
    branchStrategy: 'legacy',
    previewTtlDays: 30,
    adoToken: '',
    githubToken: 'github-token',
    ghFallbackToken: 'fallback-token',
    provider: 'github',
    ciWorkflowBase64: '',
    generateCiWorkflow: false,
    monitorType: 'cloud',
    ciWorkflowPath: '.github/workflows/ci.yml',
    orgMode: false,
    monitorId: '',
    mockUrl: '',
    mockVisibility: 'public',
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
    repository: 'postman-cs/repo-sync-demo',
    postmanRegion: 'us',
    postmanStack: 'prod',
    postmanApiBase: 'https://api.getpostman.com',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
    postmanFallbackBase: 'https://go.postman.co/_api',
    postmanCliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh',
    postmanIapubBase: 'https://iapub.postman.co',
    ...overrides
  };
}

function createCoreStub() {
  const outputs: Record<string, string> = {};
  return {
    core: {
      getInput: vi.fn(),
      info: vi.fn(),
      notice: vi.fn(),
      setFailed: vi.fn(),
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      setSecret: vi.fn(),
      warning: vi.fn()
    },
    outputs
  };
}

function writeCanonicalV3Tree(
  collectionPath: string,
  definitionBody = '$kind: collection\nname: Fixture\n'
): { artifactDigest: string } {
  mkdirSync(join(collectionPath, '.resources'), { recursive: true });
  mkdirSync(join(collectionPath, 'Folder', '.resources'), { recursive: true });
  writeFileSync(join(collectionPath, '.resources', 'definition.yaml'), definitionBody, 'utf8');
  writeFileSync(join(collectionPath, 'List.request.yaml'), '$kind: http-request\nmethod: GET\n', 'utf8');
  writeFileSync(join(collectionPath, 'Folder', '.resources', 'definition.yaml'), '$kind: collection\nname: Folder\n', 'utf8');
  writeFileSync(join(collectionPath, 'Folder', 'Created.example.yaml'), '$kind: http-example\n', 'utf8');
  writeFileSync(join(collectionPath, 'Folder', 'Event.message.yaml'), '$kind: websocket-message\n', 'utf8');
  const files = [
    '.resources/definition.yaml',
    'List.request.yaml',
    'Folder/.resources/definition.yaml',
    'Folder/Created.example.yaml',
    'Folder/Event.message.yaml'
  ].map((relative) => ({
    relative,
    bytes: readFileSync(join(collectionPath, relative))
  }));
  return { artifactDigest: computeArtifactDigest(files) };
}

function buildPrebuiltManifest(
  entries: Array<{
    role: 'baseline' | 'smoke' | 'contract';
    collectionPath: string;
    cloudId: string;
    artifactDigest: string;
  }>
): string {
  return JSON.stringify(
    entries.map((entry) => ({
      role: entry.role,
      collectionPath: entry.collectionPath,
      cloudId: entry.cloudId,
      artifactDigest: entry.artifactDigest
    }))
  );
}

function buildAllPrebuiltManifest(): string {
  const baseline = writeCanonicalV3Tree('postman/collections/core-payments');
  const smoke = writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
  const contract = writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
  return buildPrebuiltManifest([
    {
      role: 'baseline',
      collectionPath: 'postman/collections/core-payments',
      cloudId: 'col-baseline',
      artifactDigest: baseline.artifactDigest
    },
    {
      role: 'smoke',
      collectionPath: 'postman/collections/[Smoke] core-payments',
      cloudId: 'col-smoke',
      artifactDigest: smoke.artifactDigest
    },
    {
      role: 'contract',
      collectionPath: 'postman/collections/[Contract] core-payments',
      cloudId: 'col-contract',
      artifactDigest: contract.artifactDigest
    }
  ]);
}

function createCloudCollectionState(
  name: string,
  customerListenerScript: string
): Record<string, unknown> {
  return {
    id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    name,
    $kind: 'collection',
    items: [
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        name: 'List Payments',
        $kind: 'http-request',
        method: 'GET',
        url: 'https://api.example.com/payments',
        scripts: [
          {
            type: 'beforeRequest',
            code: customerListenerScript,
            language: 'text/javascript'
          }
        ]
      }
    ]
  };
}

function installManagedRootHook(collection: Record<string, unknown>): void {
  const existingScripts = Array.isArray(collection.scripts)
    ? [...(collection.scripts as unknown[])]
    : [];
  existingScripts.push({
    type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
    code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
    language: 'text/javascript'
  });
  collection.scripts = existingScripts;
}

function createStatefulPrivateMockPostman(
  cloudCollections: Map<string, Record<string, unknown>>,
  events: string[]
) {
  return {
    createEnvironment: vi.fn().mockResolvedValue('env-prod'),
    updateEnvironment: vi.fn().mockResolvedValue(undefined),
    findEnvironmentByName: vi.fn().mockResolvedValue(null),
    createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
    createMonitor: vi.fn().mockResolvedValue('mon-1'),
    getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
    listMonitors: vi.fn().mockResolvedValue([]),
    listMocks: vi.fn().mockResolvedValue([PRIVATE_MOCK_LIST_ENTRY]),
    monitorExists: vi.fn().mockResolvedValue(false),
    mockExists: vi.fn().mockResolvedValue(false),
    findMonitorByCollection: vi.fn().mockResolvedValue(null),
    findMockByCollection: vi.fn().mockResolvedValue(null),
    runMonitor: vi.fn().mockResolvedValue(undefined),
    listEnvironments: vi.fn().mockResolvedValue([]),
    deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    deleteMock: vi.fn().mockResolvedValue(undefined),
    deleteMonitor: vi.fn().mockResolvedValue(undefined),
    configurePrivateMockRuntimeAuth: vi.fn(async (collectionUid: string) => {
      events.push(`configure:${collectionUid}`);
      const state = cloudCollections.get(collectionUid);
      if (!state) {
        throw new Error(`missing cloud collection ${collectionUid}`);
      }
      installManagedRootHook(state);
      return 1;
    }),
    getCollection: vi.fn(async (collectionUid: string) => {
      events.push(`export:${collectionUid}`);
      const state = cloudCollections.get(collectionUid);
      if (!state) {
        throw new Error(`missing cloud collection ${collectionUid}`);
      }
      return structuredClone(state);
    })
  };
}

describe('private-mock behavioral ordering regression (C6)', () => {
  let originalCwd = '';
  let testDir = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'private-mock-wiring-contract-'));
    process.chdir(testDir);
    process.env.GITHUB_REPOSITORY = 'postman-cs/repo-sync-demo';
    process.env.GITHUB_REF_NAME = 'feature/repo-sync';
    delete process.env.GITHUB_HEAD_REF;
    vi.stubEnv('POSTMAN_API_KEY', '');
    vi.stubEnv('POSTMAN_ACCESS_TOKEN', '');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_HEAD_REF;
    vi.unstubAllEnvs();
  });

  it('exports smoke and contract only after configure patches the managed root hook into cloud state', async () => {
    const events: string[] = [];
    const cloudCollections = new Map<string, Record<string, unknown>>([
      [
        'col-smoke',
        createCloudCollectionState(
          '[Smoke] core-payments',
          "console.log('smoke-customer-listener');"
        )
      ],
      [
        'col-contract',
        createCloudCollectionState(
          '[Contract] core-payments',
          "console.log('contract-customer-listener');"
        )
      ]
    ]);

    const commitAndPush = vi.fn(async () => {
      events.push('commit');
      return {
        commitSha: createHash('sha256').update('commit-marker').digest('hex'),
        pushed: false,
        resolvedCurrentRef: 'feature/repo-sync'
      };
    });

    const postman = createStatefulPrivateMockPostman(cloudCollections, events);
    const { core } = createCoreStub();
    const dependencies = {
      core,
      postman,
      github: {
        getRepositoryVariable: vi.fn().mockResolvedValue(''),
        setRepositoryVariable: vi.fn().mockResolvedValue(undefined)
      },
      internalIntegration: {
        associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
        connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
        findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
      },
      repoMutation: {
        commitAndPush
      } as unknown as NonNullable<RepoSyncDependencies['repoMutation']>
    };

    await runRepoSync(
      createInputs({
        mockVisibility: 'private',
        mockUrl: PRIVATE_MOCK_LIST_ENTRY.mockUrl,
        prebuiltCollectionsJson: buildAllPrebuiltManifest()
      }),
      dependencies
    );

    const configureSmoke = events.indexOf('configure:col-smoke');
    const configureContract = events.indexOf('configure:col-contract');
    const exportSmoke = events.indexOf('export:col-smoke');
    const exportContract = events.indexOf('export:col-contract');
    const commitIndex = events.indexOf('commit');

    expect(configureSmoke).toBeGreaterThanOrEqual(0);
    expect(configureContract).toBeGreaterThanOrEqual(0);
    expect(exportSmoke).toBeGreaterThan(configureSmoke);
    expect(exportContract).toBeGreaterThan(configureContract);
    expect(commitIndex).toBeGreaterThan(exportSmoke);
    expect(commitIndex).toBeGreaterThan(exportContract);
    expect(commitAndPush).toHaveBeenCalledTimes(1);

    const smokeDefinition = readFileSync(
      'postman/collections/[Smoke] core-payments/.resources/definition.yaml',
      'utf8'
    );
    const contractDefinition = readFileSync(
      'postman/collections/[Contract] core-payments/.resources/definition.yaml',
      'utf8'
    );
    const smokeRequest = readFileSync(
      'postman/collections/[Smoke] core-payments/List Payments.request.yaml',
      'utf8'
    );
    const contractRequest = readFileSync(
      'postman/collections/[Contract] core-payments/List Payments.request.yaml',
      'utf8'
    );

    expect(smokeDefinition).toContain(`type: ${PRIVATE_MOCK_AUTH_ROOT_TYPE}`);
    expect(smokeDefinition).toContain(PRIVATE_MOCK_AUTH_ROOT_MARKER);
    expect(contractDefinition).toContain(`type: ${PRIVATE_MOCK_AUTH_ROOT_TYPE}`);
    expect(contractDefinition).toContain(PRIVATE_MOCK_AUTH_ROOT_MARKER);

    expect(smokeRequest).toContain("console.log('smoke-customer-listener');");
    expect(contractRequest).toContain("console.log('contract-customer-listener');");

    const exportedArtifact = [
      smokeDefinition,
      contractDefinition,
      smokeRequest,
      contractRequest
    ].join('\n');
    expect(exportedArtifact).not.toContain('pmak-test-input-key');
    expect(exportedArtifact).not.toMatch(/pmak-[a-z0-9]+/i);
    expect(exportedArtifact).not.toMatch(/['"][a-f0-9]{32,}['"]/i);

    expect(existsSync('postman/collections/core-payments/.resources/definition.yaml')).toBe(true);
    expect(postman.getCollection).toHaveBeenCalledTimes(2);
    expect(postman.getCollection).not.toHaveBeenCalledWith('col-baseline');
    expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-smoke');
    expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-contract');
  });
});
