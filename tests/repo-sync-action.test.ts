// Mock must be at top of file — vitest hoists vi.mock before all imports
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

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { load as loadYaml } from 'js-yaml';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '@postman-cse/automation-core';

import type {
  RepoSyncDependencies,
  ResolvedInputs
} from '../src/index.js';
import {
  appendArtifactDigestFileStreaming,
  computeArtifactDigest
} from '../src/postman-v3/converter.js';
import { createSecretMasker, REDACTED } from '../src/lib/secrets.js';
import {
  MANAGED_ITEM_AUTH_BLOCKS,
  PRIVATE_MOCK_AUTH_ROOT_MARKER,
  PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
  PRIVATE_MOCK_AUTH_ROOT_TYPE
} from '../src/lib/postman/private-mock-auth-script.js';
import { runWithFakeTimers } from './contract/harness.js';

type IndexModule = typeof import('../src/index.js');
type IdentityModule = typeof import('../src/lib/postman/credential-identity.js');
type AdapterModule = typeof import('../src/lib/postman/internal-integration-adapter.js');

let readActionInputs: IndexModule['readActionInputs'];
let resolvePostmanApiKeyAndTeamId: IndexModule['resolvePostmanApiKeyAndTeamId'];
let runAction: IndexModule['runAction'];
let runRepoSync: IndexModule['runRepoSync'];
let prebuiltDirectoryTraversalIdentity: IndexModule['prebuiltDirectoryTraversalIdentity'];
let __resetIdentityMemo: IdentityModule['__resetIdentityMemo'];
let createInternalIntegrationAdapter: AdapterModule['createInternalIntegrationAdapter'];

async function reloadRepoSyncModules(): Promise<void> {
  // Under isolate:false, earlier suites may have doUnmock'd the adapter or
  // reset the module graph. Reinstall the stub and rebind imports each test.
  vi.doMock(ADAPTER_MODULE, createAdapterMockModule);
  vi.resetModules();
  ({
    readActionInputs,
    resolvePostmanApiKeyAndTeamId,
    runAction,
    runRepoSync,
    prebuiltDirectoryTraversalIdentity
  } = await import('../src/index.js'));
  ({ __resetIdentityMemo } = await import('../src/lib/postman/credential-identity.js'));
  ({ createInternalIntegrationAdapter } = await import(ADAPTER_MODULE));
}

beforeEach(async () => {
  await reloadRepoSyncModules();
});

afterAll(() => {
  // isolate:false shares the process with later suites (e.g. credential-matrix)
  // that need the real Bifrost adapter. Clear the hoisted mock + module cache.
  vi.doUnmock(ADAPTER_MODULE);
  vi.resetModules();
});

type ResourcesYamlShape = {
  workspace?: {
    id?: string;
  };
  canonical?: {
    collections?: Record<string, string>;
    environments?: Record<string, string>;
    specs?: Record<string, string>;
  };
};

function createInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    projectName: 'core-payments',
    workspaceId: 'ws-123',
    baselineCollectionId: 'col-baseline',
    smokeCollectionId: 'col-smoke',
    contractCollectionId: 'col-contract',
    onboardingScope: 'full',
    prebuiltCollectionsJson: '',
    collectionSyncMode: 'refresh',
    specSyncMode: 'update',
    releaseLabel: undefined,
    environments: ['prod', 'stage'],
    repoUrl: 'https://github.com/postman-cs/repo-sync-demo',
    integrationBackend: 'bifrost',
    workspaceLinkEnabled: true,
    environmentSyncEnabled: true,
    systemEnvMap: { prod: 'sys-prod', stage: 'sys-stage' },
    environmentUids: {},
    envRuntimeUrls: {
      prod: 'https://api.example.com',
      stage: 'https://stage-api.example.com'
    },
    artifactDir: 'postman',
    repoWriteMode: 'commit-and-push',
    currentRef: 'feature/repo-sync',
    githubHeadRef: '',
    githubRefName: 'feature/repo-sync',
    committerName: 'Postman',
    committerEmail: 'support@postman.com',
    postmanApiKey: 'pmak-test',
    postmanAccessToken: 'postman-access-token',
    credentialPreflight: 'warn',
    branchStrategy: 'legacy',
  previewTtlDays: 30,
    adoToken: '',
    githubToken: 'github-token',
    ghFallbackToken: 'fallback-token',
    provider: 'github',
    ciWorkflowBase64: '',
    generateCiWorkflow: true,
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
    secretsResolverProvider: 'none',
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

function createCoreStub(values: Record<string, string> = {}) {
  const outputs: Record<string, string> = {};
  const secrets: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];

  return {
    core: {
      getInput: (name: string, options?: { required?: boolean }) => {
        const value = values[name] ?? '';
        if (options?.required && !value) {
          throw new Error(`Input required and not supplied: ${name}`);
        }
        return value;
      },
      info: (message: string) => infos.push(message),
      setFailed: vi.fn(),
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      setSecret: (secret: string) => {
        secrets.push(secret);
      },
      warning: (message: string) => warnings.push(message)
    },
    infos,
    outputs,
    secrets,
    warnings
  };
}

function createCollectionFixture(name: string) {
  return {
    info: {
      name,
      description: 'Collection description',
      _postman_id: 'collection-id'
    },
    item: [
      {
        name: 'List Payments',
        request: {
          method: 'GET',
          url: {
            raw: '{{baseUrl}}/payments?status=active',
            query: [{ key: 'status', value: 'active' }]
          }
        }
      },
      {
        name: 'Orders',
        item: [
          {
            name: 'Create Order',
            request: {
              method: 'POST',
              url: 'https://api.example.com/orders',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: {
                mode: 'raw',
                raw: '{"status":"created"}',
                options: { raw: { language: 'json' } }
              }
            },
            response: [{
              name: 'Created',
              code: 201,
              status: 'Created',
              body: '{"id":"ord_123"}'
            }]
          }
        ]
      }
    ]
  };
}

function createV3CollectionFixture(
  name: string,
  options: {
    rootHook?: boolean;
    itemLegacyBlockIndex?: 0 | 1 | 2;
    itemCustomerScript?: string;
    itemNearMissScript?: string;
  } = {}
) {
  const codeParts: string[] = [];
  if (options.itemLegacyBlockIndex !== undefined) {
    codeParts.push(MANAGED_ITEM_AUTH_BLOCKS[options.itemLegacyBlockIndex]);
  }
  if (options.itemNearMissScript) {
    codeParts.push(options.itemNearMissScript);
  }
  if (options.itemCustomerScript) {
    codeParts.push(options.itemCustomerScript);
  }

  const request: Record<string, unknown> = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: 'List Payments',
    $kind: 'http-request',
    method: 'GET',
    url: 'https://api.example.com/payments'
  };
  if (codeParts.length > 0) {
    request.scripts = [{
      type: 'beforeRequest',
      code: codeParts.join('\n\n'),
      language: 'text/javascript'
    }];
  }

  const collection: Record<string, unknown> = {
    id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    name,
    $kind: 'collection',
    items: [request]
  };
  if (options.rootHook !== false) {
    collection.scripts = [{
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
      language: 'text/javascript'
    }];
  }
  return collection;
}

const PRIVATE_MOCK_LIST_ENTRY = {
  uid: 'explicit-private',
  name: 'Existing Mock',
  collection: 'col-baseline',
  environment: 'env-prod',
  mockUrl: 'https://explicit-private.mock.pstmn.io',
  visibility: 'private' as const
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function artifactTreeDigest(root = '.'): string {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const name of readdirSync(current)) {
      const filePath = join(current, name);
      if (lstatSync(filePath).isDirectory()) pending.push(filePath);
      else files.push(filePath);
    }
  }
  const hash = createHash('sha256');
  for (const filePath of files.sort()) {
    hash.update(filePath.slice(root.length).replaceAll('\\', '/'));
    hash.update(readFileSync(filePath));
  }
  return hash.digest('hex');
}

function writeCanonicalV3Tree(
  collectionPath: string,
  definitionBody = '$kind: collection\nname: Fixture\n'
): { artifactDigest: string; files: Array<{ relative: string; bytes: Buffer }> } {
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
  ].map((relative) => ({ relative, bytes: readFileSync(join(collectionPath, relative)) }));
  return { artifactDigest: computeArtifactDigest(files), files };
}

/** Iterative on-disk digest matching production streaming wire format. */
async function digestTreeOnDisk(collectionPath: string): Promise<string> {
  const absRoot = join(process.cwd(), collectionPath);
  const files: Array<{
    absolute: string;
    relative: string;
    dev: number;
    ino: number | bigint;
    size: number;
  }> = [];
  const pending = [absRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const name of readdirSync(current)) {
      const abs = join(current, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        pending.push(abs);
      } else if (st.isFile()) {
        files.push({
          absolute: abs,
          relative: abs.slice(absRoot.length + 1).split(/[\\/]/).join('/'),
          dev: st.dev,
          ino: st.ino,
          size: st.size
        });
      }
    }
  }
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const hash = createHash('sha256');
  for (const file of files) {
    await appendArtifactDigestFileStreaming(hash, file.relative, file.absolute, {
      dev: file.dev,
      ino: file.ino,
      size: file.size
    });
  }
  return hash.digest('hex');
}

function writeLargeCanonicalRequestYaml(filePath: string, minBytes: number): void {
  const header = Buffer.from('$kind: http-request\nmethod: GET\ndescription: |\n');
  const fd = openSync(filePath, 'w');
  try {
    writeSync(fd, header);
    let written = header.byteLength;
    // Chunked block-scalar body keeps peak fixture memory bounded.
    const chunk = Buffer.alloc(1024 * 1024, 0x78); // 'x'
    chunk[0] = 0x20;
    chunk[1] = 0x20;
    chunk[chunk.length - 1] = 0x0a;
    while (written < minBytes) {
      writeSync(fd, chunk);
      written += chunk.byteLength;
    }
  } finally {
    closeSync(fd);
  }
}

function buildPrebuiltManifest(
  entries: Array<{
    role: 'baseline' | 'smoke' | 'contract';
    collectionPath: string;
    cloudId: string;
    artifactDigest: string;
    payloadDigest?: string;
  }>,
  wrapped = false
): string {
  const collections = entries.map((entry) => {
    const base: Record<string, string> = {
      role: entry.role,
      collectionPath: entry.collectionPath,
      cloudId: entry.cloudId,
      artifactDigest: entry.artifactDigest
    };
    if (entry.payloadDigest !== undefined) {
      base.payloadDigest = entry.payloadDigest;
    }
    return base;
  });
  return wrapped
    ? JSON.stringify({ schemaVersion: 1, collections })
    : JSON.stringify(collections);
}

function createExportPostmanStub() {
  return {
    createEnvironment: vi.fn().mockResolvedValue('env-prod'),
    updateEnvironment: vi.fn().mockResolvedValue(undefined),
    findEnvironmentByName: vi.fn().mockResolvedValue(null),
    createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
    createMonitor: vi.fn().mockResolvedValue('mon-1'),
    getCollection: vi
      .fn()
      .mockResolvedValueOnce(createCollectionFixture('core-payments'))
      .mockResolvedValueOnce(createCollectionFixture('[Smoke] core-payments'))
      .mockResolvedValueOnce(createCollectionFixture('[Contract] core-payments')),
    getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
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
    configurePrivateMockRuntimeAuth: vi.fn().mockResolvedValue(0)
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('repo sync action', () => {
  let originalCwd = '';
  let testDir = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'repo-sync-action-'));
    process.chdir(testDir);
    process.env.GITHUB_REPOSITORY = 'postman-cs/repo-sync-demo';
    process.env.GITHUB_REF_NAME = 'feature/repo-sync';
    delete process.env.GITHUB_HEAD_REF;
    delete process.env.GITHUB_REF;
    delete process.env.GITHUB_EVENT_PATH;
    vi.stubEnv('POSTMAN_API_KEY', '');
    vi.stubEnv('POSTMAN_ACCESS_TOKEN', '');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_HEAD_REF;
    delete process.env.GITHUB_REF;
    delete process.env.GITHUB_EVENT_PATH;
    delete process.env.GITHUB_HEAD_REF;
    vi.unstubAllEnvs();
  }, 120_000);

  it('marks secrets during input resolution', () => {
    const { core, secrets } = createCoreStub({
      'project-name': 'core-payments',
      'postman-api-key': 'pmak-test',
      'postman-access-token': 'postman-access-token',
      'github-token': 'github-token',
      'gh-fallback-token': 'fallback-token',
      'environments-json': '["prod"]',
      'system-env-map-json': '{}',
      'environment-uids-json': '{}',
      'env-runtime-urls-json': '{}'
    });

    const inputs = readActionInputs(core);

    expect(inputs.projectName).toBe('core-payments');
    expect(inputs.collectionSyncMode).toBe('refresh');
    expect(inputs.specSyncMode).toBe('update');
    expect(secrets).toEqual([
      'pmak-test',
      'postman-access-token',
      'github-token',
      'fallback-token'
    ]);
  });

  it('resolves credential-preflight through readActionInputs with a warn default', () => {
    const base = {
      'project-name': 'core-payments',
      'postman-api-key': 'pmak-test'
    };

    const { core: defaultCore } = createCoreStub(base);
    expect(readActionInputs(defaultCore).credentialPreflight).toBe('warn');

    const { core: enforceCore } = createCoreStub({
      ...base,
      'credential-preflight': 'enforce'
    });
    expect(readActionInputs(enforceCore).credentialPreflight).toBe('enforce');
  });

  it('passes postman-region through GitHub Action input resolution and allows token-only auth bootstrap', () => {
    const { core, secrets } = createCoreStub({
      'project-name': 'core-payments',
      'postman-access-token': 'postman-access-token',
      'postman-region': 'eu'
    });

    const inputs = readActionInputs(core);

    expect(inputs.postmanApiKey).toBe('');
    expect(inputs.postmanAccessToken).toBe('postman-access-token');
    expect(inputs.postmanRegion).toBe('eu');
    expect(inputs.postmanApiBase).toBe('https://api.eu.postman.com');
    expect(secrets).toEqual(['postman-access-token']);
  });

  it('requires ssl-client-key when ssl-client-cert is provided', () => {
    const { core } = createCoreStub({
      'project-name': 'core-payments',
      'postman-api-key': 'pmak-test',
      'ssl-client-cert': Buffer.from('dummy-cert').toString('base64'),
      'environments-json': '["prod"]',
      'system-env-map-json': '{}',
      'environment-uids-json': '{}',
      'env-runtime-urls-json': '{}'
    });

    expect(() => readActionInputs(core)).toThrow(
      'ssl-client-key is required when ssl-client-cert is provided'
    );
  });

  it('skips generated-CI SSL validation in spec-only scope', () => {
    const sslClientCert = Buffer.from('stale-cert').toString('base64');
    const { core, secrets } = createCoreStub({
      'project-name': 'core-payments',
      'postman-access-token': 'postman-access-token',
      'onboarding-scope': 'spec-only',
      'ssl-client-cert': sslClientCert,
      'environments-json': '["prod"]',
      'system-env-map-json': '{}',
      'environment-uids-json': '{}',
      'env-runtime-urls-json': '{}'
    });

    const inputs = readActionInputs(core);

    expect(inputs.onboardingScope).toBe('spec-only');
    expect(secrets).toContain(sslClientCert);
  });

  it('materializes repo sync outputs and files', async () => {
    const { core, outputs } = createCoreStub();
    const postman = {
      createEnvironment: vi
        .fn()
        .mockResolvedValueOnce('env-prod')
        .mockResolvedValueOnce('env-stage'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({
        uid: 'mock-123',
        url: 'https://mock.pstmn.io'
      }),
      createMonitor: vi.fn().mockResolvedValue('mon-123'),
      getCollection: vi
        .fn()
        .mockResolvedValueOnce(createCollectionFixture('core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Smoke] core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Contract] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
      listMonitors: vi.fn().mockResolvedValue([]),
      listMocks: vi.fn().mockResolvedValue([]),
      monitorExists: vi.fn().mockResolvedValue(false),
      mockExists: vi.fn().mockResolvedValue(false),
      findMonitorByCollection: vi.fn().mockResolvedValue(null),
      rebindMonitorByName: vi.fn().mockResolvedValue(null),
      findMockByCollection: vi.fn().mockResolvedValue(null),
      configurePrivateMockRuntimeAuth: vi.fn().mockResolvedValue(0),
      runMonitor: vi.fn().mockResolvedValue(undefined),
      listEnvironments: vi.fn().mockResolvedValue([]),
      deleteEnvironment: vi.fn().mockResolvedValue(undefined),
      deleteMock: vi.fn().mockResolvedValue(undefined),
      deleteMonitor: vi.fn().mockResolvedValue(undefined)
    };
    const github = {
      getRepositoryVariable: vi.fn().mockResolvedValue(''),
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined)
    };
    const internalIntegration = {
      associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
      connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
      findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
    };
    const repoMutation = {
      commitAndPush: vi.fn().mockResolvedValue({
        commitSha: 'abc1234',
        pushed: true,
        resolvedCurrentRef: 'feature/repo-sync'
      })
    };
    mkdirSync('packages/sdk', { recursive: true });
    writeFileSync(
      'packages/sdk/openapi.json',
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'SDK API', version: '1.0.0' },
        paths: {}
      })
    );

    const result = await runRepoSync(createInputs({ specId: 'spec-123' }), {
      core,
      postman,
      github,
      internalIntegration,
      repoMutation: repoMutation as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
    });

    expect(result).toMatchObject({
      'workspace-link-status': 'success',
      'environment-sync-status': 'success',
      'mock-url': 'https://mock.pstmn.io',
      'monitor-id': 'mon-123',
      'commit-sha': 'abc1234',
      'resolved-current-ref': 'feature/repo-sync'
    });
    expect(outputs['repo-sync-summary-json']).toContain('"pushed":true');
    const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ciWorkflow).toContain('name: Resolve Postman Resource IDs');
    expect(ciWorkflow).toContain('.postman/resources.yaml');
    expect(ciWorkflow).toContain("require 'yaml'");
    expect(ciWorkflow).not.toContain('vars.POSTMAN_SMOKE_COLLECTION_UID');
    expect(ciWorkflow).not.toContain('vars.POSTMAN_CONTRACT_COLLECTION_UID');
    expect(ciWorkflow).not.toContain('vars.POSTMAN_ENVIRONMENT_UID');
    expect(existsSync('.postman/config.json')).toBe(false);
    expect(existsSync('.postman/releases.yaml')).toBe(false);
    expect(existsSync('postman/flows')).toBe(true);
    expect(existsSync('postman/globals')).toBe(true);
    expect(existsSync('postman/mocks')).toBe(true);
    expect(existsSync('postman/specs')).toBe(true);
    expect(existsSync('postman/globals/workspace.globals.yaml')).toBe(true);

    // Canonical Collection v3 layout (official @postman libs): the collection
    // and folders are `.resources/definition.yaml` ($kind: collection); there is
    // no legacy `collection.yaml`/`folder.yaml`/`type:` dialect.
    const baselineCollection = loadYaml(
      readFileSync('postman/collections/core-payments/.resources/definition.yaml', 'utf8')
    ) as Record<string, unknown>;
    const folderYaml = loadYaml(
      readFileSync(
        'postman/collections/core-payments/Orders/.resources/definition.yaml',
        'utf8'
      )
    ) as Record<string, unknown>;
    const nestedRequestYaml = loadYaml(
      readFileSync(
        'postman/collections/core-payments/Orders/Create Order.request.yaml',
        'utf8'
      )
    ) as Record<string, unknown>;
    const resourcesYaml = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as Record<
      string,
      unknown
    >;
    const workflowsYaml = loadYaml(readFileSync('.postman/workflows.yaml', 'utf8')) as Record<
      string,
      unknown
    >;

    expect(baselineCollection.$kind).toBe('collection');
    expect(baselineCollection.type).toBeUndefined();
    expect(
      existsSync('postman/collections/core-payments/List Payments.request.yaml')
    ).toBe(true);
    expect(folderYaml.$kind).toBe('collection');
    expect(nestedRequestYaml.$kind).toBe('http-request');
    expect(nestedRequestYaml.method).toBe('POST');
    expect(nestedRequestYaml.body).toEqual({
      type: 'json',
      content: '{"status":"created"}'
    });
    expect(resourcesYaml).toEqual({
      version: 2,
      workspace: { id: 'ws-123' },
      canonical: {
        collections: {
          '../postman/collections/core-payments': 'col-baseline',
          '../postman/collections/[Smoke] core-payments': 'col-smoke',
          '../postman/collections/[Contract] core-payments': 'col-contract'
        },
        environments: {
          '../postman/environments/prod.postman_environment.json': 'env-prod',
          '../postman/environments/stage.postman_environment.json': 'env-stage'
        },
        specs: {
          '../packages/sdk/openapi.json': 'spec-123'
        }
      }
    });
    expect(workflowsYaml).toEqual({
      workflows: {
        syncSpecToCollection: [
          {
            spec: '../packages/sdk/openapi.json',
            collection: '../postman/collections/core-payments'
          },
          {
            spec: '../packages/sdk/openapi.json',
            collection: '../postman/collections/[Smoke] core-payments'
          },
          {
            spec: '../packages/sdk/openapi.json',
            collection: '../postman/collections/[Contract] core-payments'
          }
        ]
      }
    });
  });

  describe('prebuiltDirectoryTraversalIdentity', () => {
    it('keeps distinct Win32 paths with the same nonzero dev+ino from colliding', () => {
      const left = prebuiltDirectoryTraversalIdentity(
        'C:\\artifact\\a',
        { dev: 1, ino: 99 },
        {
          platform: 'win32',
          resolveCanonicalPath: (absolutePath) => absolutePath
        }
      );
      const right = prebuiltDirectoryTraversalIdentity(
        'C:\\artifact\\b',
        { dev: 1, ino: 99 },
        {
          platform: 'win32',
          resolveCanonicalPath: (absolutePath) => absolutePath
        }
      );
      expect(left).not.toBe(right);
      expect(left).toBe('c:\\artifact\\a');
      expect(right).toBe('c:\\artifact\\b');
    });

    it('collides Win32 aliases that resolve to the same canonical path', () => {
      const canonical = 'C:\\artifact\\real';
      const viaAlias = prebuiltDirectoryTraversalIdentity(
        'C:\\artifact\\alias',
        { dev: 3, ino: 42n },
        {
          platform: 'win32',
          resolveCanonicalPath: () => canonical
        }
      );
      const viaReal = prebuiltDirectoryTraversalIdentity(
        'C:\\artifact\\real',
        { dev: 3, ino: 42 },
        {
          platform: 'win32',
          resolveCanonicalPath: () => canonical
        }
      );
      expect(viaAlias).toBe(viaReal);
      expect(viaAlias).toBe('c:\\artifact\\real');
    });

    it('uses path-independent POSIX dev+ino identity when inode is nonzero and skips the canonicalizer', () => {
      const left = prebuiltDirectoryTraversalIdentity(
        '/tmp/tree/a',
        { dev: 10, ino: 42 },
        {
          platform: 'linux',
          resolveCanonicalPath: () => {
            throw new Error('canonicalizer must not run for nonzero inode');
          }
        }
      );
      const right = prebuiltDirectoryTraversalIdentity(
        '/tmp/tree/other-name',
        { dev: 10, ino: 42n },
        {
          platform: 'linux',
          resolveCanonicalPath: () => {
            throw new Error('canonicalizer must not run for nonzero inode');
          }
        }
      );
      expect(left).toBe('10:42');
      expect(right).toBe('10:42');
      expect(left).toBe(right);
    });

    it('preserves POSIX zero-inode canonical fallback without case folding', () => {
      const identity = prebuiltDirectoryTraversalIdentity(
        '/tmp/Tree/A',
        { dev: 2, ino: 0 },
        {
          platform: 'darwin',
          resolveCanonicalPath: (absolutePath) => absolutePath
        }
      );
      expect(identity).toBe('/tmp/Tree/A');
    });
  });

  describe('prebuilt-collections-json digest-bound reuse', () => {
    function deps(postman: ReturnType<typeof createExportPostmanStub>) {
      return {
        core: createCoreStub().core,
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
          commitAndPush: vi.fn().mockResolvedValue({
            commitSha: '',
            pushed: false,
            resolvedCurrentRef: 'feature/repo-sync'
          })
        } as unknown as NonNullable<RepoSyncDependencies['repoMutation']>
      };
    }

    it('keeps cloud export behavior when the prebuilt manifest is absent', async () => {
      const postman = createExportPostmanStub();
      await runRepoSync(createInputs({ prebuiltCollectionsJson: '' }), deps(postman));
      expect(postman.getCollection).toHaveBeenCalledTimes(3);
    });

    it('bounds collection acquisition to two, joins before materialization, and preserves role order', async () => {
      const pending = new Map([
        ['col-baseline', deferred<ReturnType<typeof createCollectionFixture>>()],
        ['col-smoke', deferred<ReturnType<typeof createCollectionFixture>>()],
        ['col-contract', deferred<ReturnType<typeof createCollectionFixture>>()]
      ]);
      let active = 0;
      let peak = 0;
      const postman = {
        ...createExportPostmanStub(),
        getCollection: vi.fn((id: string) => {
          active += 1;
          peak = Math.max(peak, active);
          const request = pending.get(id)!;
          return request.promise.finally(() => { active -= 1; });
        })
      };
      const { core, infos } = createCoreStub();
      const sync = runRepoSync(createInputs({ generateCiWorkflow: false }), {
        ...deps(postman), core
      });

      await vi.waitFor(() => expect(postman.getCollection).toHaveBeenCalledTimes(2));
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(2);
      expect(existsSync('postman/collections')).toBe(false);
      pending.get('col-smoke')!.resolve(createCollectionFixture('[Smoke] core-payments'));
      await vi.waitFor(() => expect(postman.getCollection).toHaveBeenCalledTimes(3));
      expect(existsSync('postman/collections')).toBe(false);
      pending.get('col-baseline')!.resolve(createCollectionFixture('core-payments'));
      pending.get('col-contract')!.resolve(createCollectionFixture('[Contract] core-payments'));
      await sync;

      expect(readdirSync('postman/collections').sort()).toEqual([
        '[Contract] core-payments', '[Smoke] core-payments', 'core-payments'
      ].sort());
      const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
      expect(Object.keys(resources.canonical?.collections ?? {})).toEqual([
        '../postman/collections/core-payments',
        '../postman/collections/[Smoke] core-payments',
        '../postman/collections/[Contract] core-payments'
      ]);
      expect(infos.some((line) => /collection-acquisition.*count=3.*width=2.*ms=.*status=success/.test(line))).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('rechecks collection targets after acquisition before conversion can follow a swapped symlink', async () => {
      const pending = new Map([
        ['col-baseline', deferred<ReturnType<typeof createCollectionFixture>>()],
        ['col-smoke', deferred<ReturnType<typeof createCollectionFixture>>()],
        ['col-contract', deferred<ReturnType<typeof createCollectionFixture>>()]
      ]);
      const outside = mkdtempSync(join(tmpdir(), 'repo-sync-collection-swap-'));
      const commitAndPush = vi.fn();
      const postman = {
        ...createExportPostmanStub(),
        getCollection: vi.fn((id: string) => pending.get(id)!.promise)
      };
      const sync = runRepoSync(createInputs({ generateCiWorkflow: false }), {
        ...deps(postman),
        repoMutation: { commitAndPush } as unknown as NonNullable<RepoSyncDependencies['repoMutation']>
      });

      await vi.waitFor(() => expect(postman.getCollection).toHaveBeenCalledTimes(2));
      mkdirSync('postman/collections', { recursive: true });
      symlinkSync(outside, 'postman/collections/core-payments');
      pending.get('col-baseline')!.resolve(createCollectionFixture('core-payments'));
      pending.get('col-smoke')!.resolve(createCollectionFixture('[Smoke] core-payments'));
      await vi.waitFor(() => expect(postman.getCollection).toHaveBeenCalledTimes(3));
      pending.get('col-contract')!.resolve(createCollectionFixture('[Contract] core-payments'));

      await expect(sync).rejects.toThrow(/collection target|artifact-dir|repository root|symlink/i);
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync('.postman/resources.yaml')).toBe(false);
      expect(commitAndPush).not.toHaveBeenCalled();
      rmSync(outside, { recursive: true, force: true });
    });

    it('drains active collection reads after a failure without scheduling later acquisition or materialization', async () => {
      const baseline = deferred<ReturnType<typeof createCollectionFixture>>();
      const smoke = deferred<ReturnType<typeof createCollectionFixture>>();
      const commitAndPush = vi.fn();
      const postman = {
        ...createExportPostmanStub(),
        getCollection: vi.fn((id: string) => id === 'col-baseline' ? baseline.promise : smoke.promise)
      };
      const { core, infos } = createCoreStub();
      const sync = runRepoSync(createInputs({ generateCiWorkflow: false }), {
        ...deps(postman),
        core,
        repoMutation: { commitAndPush } as unknown as NonNullable<RepoSyncDependencies['repoMutation']>
      });
      let rejected = false;
      void sync.catch(() => { rejected = true; });

      await vi.waitFor(() => expect(postman.getCollection).toHaveBeenCalledTimes(2));
      baseline.reject(new Error('baseline export denied'));
      await Promise.resolve();
      expect(rejected).toBe(false);
      expect(postman.getCollection).not.toHaveBeenCalledWith('col-contract');
      expect(existsSync('postman/collections')).toBe(false);
      expect(existsSync('.postman/resources.yaml')).toBe(false);
      expect(existsSync('.postman/workflows.yaml')).toBe(false);
      expect(commitAndPush).not.toHaveBeenCalled();

      smoke.resolve(createCollectionFixture('[Smoke] core-payments'));
      await expect(sync).rejects.toThrow('baseline export denied');
      expect(rejected).toBe(true);
      expect(postman.getCollection).toHaveBeenCalledTimes(2);
      expect(infos.some((line) => /collection-acquisition.*count=3.*width=2.*ms=.*status=failed/.test(line))).toBe(true);
    });

    it('reports the lowest-index collection failure after draining concurrent rejections', async () => {
      const baseline = deferred<ReturnType<typeof createCollectionFixture>>();
      const smoke = deferred<ReturnType<typeof createCollectionFixture>>();
      const commitAndPush = vi.fn();
      const postman = {
        ...createExportPostmanStub(),
        getCollection: vi.fn((id: string) => id === 'col-baseline' ? baseline.promise : smoke.promise)
      };
      const sync = runRepoSync(createInputs({ generateCiWorkflow: false }), {
        ...deps(postman),
        repoMutation: { commitAndPush } as unknown as NonNullable<RepoSyncDependencies['repoMutation']>
      });
      let settled = false;
      const observed = sync.then(
        () => new Error('runRepoSync unexpectedly resolved'),
        (error: unknown) => error
      );
      void observed.then(() => { settled = true; });

      await vi.waitFor(() => expect(postman.getCollection).toHaveBeenCalledTimes(2));
      smoke.reject(new Error('smoke export denied first'));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(postman.getCollection).not.toHaveBeenCalledWith('col-contract');
      expect(existsSync('postman/collections')).toBe(false);
      expect(existsSync('.postman/resources.yaml')).toBe(false);
      expect(existsSync('.postman/workflows.yaml')).toBe(false);
      expect(commitAndPush).not.toHaveBeenCalled();

      baseline.reject(new Error('baseline export denied second'));
      const error = await observed;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('baseline export denied second');
      expect(postman.getCollection).toHaveBeenCalledTimes(2);
      expect(existsSync('postman/collections')).toBe(false);
      expect(existsSync('.postman/resources.yaml')).toBe(false);
      expect(existsSync('.postman/workflows.yaml')).toBe(false);
      expect(commitAndPush).not.toHaveBeenCalled();
    });

    it('drains active environment reads after a failure without scheduling the mock read or writing state', async () => {
      const prod = deferred<{ values: Array<{ key: string; value: string }> }>();
      const stage = deferred<{ values: Array<{ key: string; value: string }> }>();
      const postman = {
        ...createExportPostmanStub(),
        findEnvironmentByName: vi.fn().mockResolvedValue(null),
        createEnvironment: vi.fn((_workspaceId: string, name: string) =>
          Promise.resolve(name.endsWith(' - Mock') ? 'env-mock' : `env-${name.split(' ').at(-1)}`)
        ),
        getEnvironment: vi.fn((id: string) => id === 'env-prod' ? prod.promise : stage.promise)
      };
      const { core, infos } = createCoreStub();
      const sync = runRepoSync(createInputs({
        generateCiWorkflow: false,
        environmentSyncEnabled: false,
        mockEnvironmentEnabled: true,
        repoWriteMode: 'none'
      }), { ...deps(postman), core });
      let rejected = false;
      void sync.catch(() => { rejected = true; });

      await vi.waitFor(() => expect(postman.getEnvironment).toHaveBeenCalledTimes(2));
      expect(postman.getEnvironment.mock.calls.map(([id]) => id)).toEqual(['env-prod', 'env-stage']);
      prod.reject(new Error('prod environment denied'));
      await Promise.resolve();
      expect(rejected).toBe(false);
      expect(postman.getEnvironment).not.toHaveBeenCalledWith('env-mock');
      expect(existsSync('postman/environments/prod.postman_environment.json')).toBe(false);
      expect(existsSync('postman/mocks/manual-validation.postman_environment.json')).toBe(false);
      expect(existsSync('.postman/resources.yaml')).toBe(false);

      stage.resolve({ values: [{ key: 'stage', value: 'two' }] });
      await expect(sync).rejects.toThrow('prod environment denied');
      expect(rejected).toBe(true);
      expect(postman.getEnvironment).toHaveBeenCalledTimes(2);
      expect(infos.some((line) => /environment-artifact-acquisition.*count=3.*width=2.*ms=.*status=failed/.test(line))).toBe(true);
    });

    it('materializes byte-identical artifacts when the same collection payloads complete in opposite orders', async () => {
      async function syncWithCompletionOrder(directory: string, first: 'baseline' | 'smoke') {
        mkdirSync(directory);
        process.chdir(directory);
        const pending = new Map([
          ['col-baseline', deferred<ReturnType<typeof createCollectionFixture>>()],
          ['col-smoke', deferred<ReturnType<typeof createCollectionFixture>>()],
          ['col-contract', deferred<ReturnType<typeof createCollectionFixture>>()]
        ]);
        const postman = {
          ...createExportPostmanStub(),
          getCollection: vi.fn((id: string) => pending.get(id)!.promise)
        };
        const sync = runRepoSync(createInputs({ generateCiWorkflow: false, repoWriteMode: 'none' }), deps(postman));
        await vi.waitFor(() => expect(postman.getCollection).toHaveBeenCalledTimes(2));
        pending.get(first === 'baseline' ? 'col-baseline' : 'col-smoke')!.resolve(
          createCollectionFixture(first === 'baseline' ? 'core-payments' : '[Smoke] core-payments')
        );
        await vi.waitFor(() => expect(postman.getCollection).toHaveBeenCalledTimes(3));
        pending.get('col-contract')!.resolve(createCollectionFixture('[Contract] core-payments'));
        pending.get(first === 'baseline' ? 'col-smoke' : 'col-baseline')!.resolve(
          createCollectionFixture(first === 'baseline' ? '[Smoke] core-payments' : 'core-payments')
        );
        await sync;
        return {
          digest: artifactTreeDigest(),
          resources: readFileSync('.postman/resources.yaml')
        };
      }

      const first = await syncWithCompletionOrder('completion-baseline-first', 'baseline');
      process.chdir(testDir);
      const second = await syncWithCompletionOrder('completion-smoke-first', 'smoke');
      expect(second.digest).toBe(first.digest);
      expect(second.resources).toEqual(first.resources);
    });

    it('joins bounded environment acquisition before writes in finalized serial env spec order despite reverse read completion', async () => {
      const pending = new Map([
        ['env-prod', deferred<{ values: Array<{ key: string; value: string }> }>()],
        ['env-stage', deferred<{ values: Array<{ key: string; value: string }> }>()],
        ['env-mock', deferred<{ values: Array<{ key: string; value: string }> }>()]
      ]);
      let active = 0;
      let peak = 0;
      const postman = {
        ...createExportPostmanStub(),
        createEnvironment: vi.fn((_workspaceId: string, name: string) =>
          Promise.resolve(name.endsWith(' - Mock') ? 'env-mock' : name.endsWith('prod') ? 'env-prod' : 'env-stage')
        ),
        getEnvironment: vi.fn((id: string) => {
          active += 1;
          peak = Math.max(peak, active);
          return pending.get(id)!.promise.finally(() => { active -= 1; });
        })
      };
      const { core, infos } = createCoreStub();
      const sync = runRepoSync(createInputs({
        generateCiWorkflow: false,
        environmentSyncEnabled: false,
        mockEnvironmentEnabled: true,
        repoWriteMode: 'none'
      }), {
        ...deps(postman), core
      });
      await vi.waitFor(() => expect(postman.getEnvironment).toHaveBeenCalledTimes(2));
      // The finalized serial env spec order is prod, stage, mock; reads may complete out of order.
      expect(postman.getEnvironment.mock.calls.map(([id]) => id)).toEqual(['env-prod', 'env-stage']);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(2);
      expect(existsSync('.postman/resources.yaml')).toBe(false);
      pending.get('env-stage')!.resolve({ values: [{ key: 'stage', value: 'two' }] });
      await vi.waitFor(() => expect(postman.getEnvironment).toHaveBeenCalledTimes(3));
      expect(postman.getEnvironment.mock.calls.map(([id]) => id)).toEqual(['env-prod', 'env-stage', 'env-mock']);
      expect(existsSync('postman/environments/prod.postman_environment.json')).toBe(false);
      expect(existsSync('postman/mocks/manual-validation.postman_environment.json')).toBe(false);
      expect(existsSync('.postman/resources.yaml')).toBe(false);
      pending.get('env-prod')!.resolve({ values: [{ key: 'prod', value: 'one' }] });
      pending.get('env-mock')!.resolve({ values: [{ key: 'mock', value: 'three' }] });
      await sync;
      expect(readFileSync('postman/environments/prod.postman_environment.json', 'utf8')).toContain('prod');
      expect(readFileSync('postman/environments/stage.postman_environment.json', 'utf8')).toContain('stage');
      expect(readFileSync('postman/mocks/manual-validation.postman_environment.json', 'utf8')).toContain('mock');
      expect(infos.some((line) => /environment-artifact-acquisition.*count=3.*width=2.*ms=.*status=success/.test(line))).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('rechecks environment targets after acquisition before a swapped symlink can receive a write', async () => {
      const prod = deferred<{ values: Array<{ key: string; value: string }> }>();
      const stage = deferred<{ values: Array<{ key: string; value: string }> }>();
      const outside = mkdtempSync(join(tmpdir(), 'repo-sync-environment-swap-'));
      const commitAndPush = vi.fn();
      const postman = {
        ...createExportPostmanStub(),
        getEnvironment: vi.fn((id: string) => id === 'env-prod' ? prod.promise : stage.promise)
      };
      const sync = runRepoSync(createInputs({ generateCiWorkflow: false }), {
        ...deps(postman),
        repoMutation: { commitAndPush } as unknown as NonNullable<RepoSyncDependencies['repoMutation']>
      });

      await vi.waitFor(() => expect(postman.getEnvironment).toHaveBeenCalledTimes(2));
      mkdirSync('postman/environments', { recursive: true });
      symlinkSync(outside, 'postman/environments/prod.postman_environment.json');
      prod.resolve({ values: [{ key: 'prod', value: 'one' }] });
      stage.resolve({ values: [{ key: 'stage', value: 'two' }] });

      await expect(sync).rejects.toThrow(/environment target|repository root|symlink/i);
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync('.postman/resources.yaml')).toBe(false);
      expect(commitAndPush).not.toHaveBeenCalled();
      rmSync(outside, { recursive: true, force: true });
    });

    it('reuses an exact digest-bound canonical tree without cloud get/export', async () => {
      const baseline = writeCanonicalV3Tree('postman/collections/core-payments');
      const smoke = writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
      const contract = writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
      const postman = createExportPostmanStub();

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([
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
          ])
        }),
        deps(postman)
      );

      expect(postman.getCollection).toHaveBeenCalledTimes(0);
      expect(
        readFileSync('postman/collections/core-payments/.resources/definition.yaml', 'utf8')
      ).toContain('$kind: collection');
      expect(readFileSync('postman/collections/core-payments/Folder/Event.message.yaml', 'utf8')).toContain('$kind: websocket-message');
    });

    it('reuses exact baseline and contract trees while freshly exporting an omitted smoke role', async () => {
      const baselinePath = 'postman/collections/core-payments';
      const smokePath = 'postman/collections/[Smoke] core-payments';
      const contractPath = 'postman/collections/[Contract] core-payments';
      const baseline = writeCanonicalV3Tree(baselinePath);
      const contract = writeCanonicalV3Tree(contractPath);
      writeCanonicalV3Tree(smokePath);
      writeFileSync(join(smokePath, 'StaleSmokeOnly.request.yaml'), '$kind: http-request\nmethod: GET\n', 'utf8');
      const freshSmoke = createCollectionFixture('[Smoke] core-payments');
      freshSmoke.item.push({
        name: 'Fresh Smoke Only',
        request: {
          method: 'GET',
          url: { raw: 'https://api.example.com/fresh-smoke', query: [] }
        }
      });
      const postman = {
        ...createExportPostmanStub(),
        getCollection: vi.fn((id: string) => {
          if (id !== 'col-smoke') throw new Error(`unexpected collection export: ${id}`);
          return Promise.resolve(freshSmoke);
        })
      };
      const baselineBefore = artifactTreeDigest(baselinePath);
      const contractBefore = artifactTreeDigest(contractPath);

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([
            {
              role: 'baseline',
              collectionPath: baselinePath,
              cloudId: 'col-baseline',
              artifactDigest: baseline.artifactDigest
            },
            {
              role: 'contract',
              collectionPath: contractPath,
              cloudId: 'col-contract',
              artifactDigest: contract.artifactDigest
            }
          ])
        }),
        deps(postman)
      );

      expect(postman.getCollection).toHaveBeenCalledTimes(1);
      expect(postman.getCollection).toHaveBeenCalledWith('col-smoke');
      expect(artifactTreeDigest(baselinePath)).toBe(baselineBefore);
      expect(artifactTreeDigest(contractPath)).toBe(contractBefore);
      expect(existsSync(join(smokePath, 'Fresh Smoke Only.request.yaml'))).toBe(true);
      expect(existsSync(join(smokePath, 'StaleSmokeOnly.request.yaml'))).toBe(false);
      const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
      expect(Object.entries(resources.canonical?.collections ?? {})).toEqual([
        ['../postman/collections/core-payments', 'col-baseline'],
        ['../postman/collections/[Smoke] core-payments', 'col-smoke'],
        ['../postman/collections/[Contract] core-payments', 'col-contract']
      ]);
    });

    it.each([
      ['legacy filename', 'collection.yaml', '$kind: collection\n'],
      ['missing kind', 'Broken.request.yaml', 'method: GET\n'],
      ['malformed YAML', 'Broken.request.yaml', '$kind: [unterminated\n'],
      ['wrong kind family', 'Broken.request.yaml', '$kind: http-example\n']
    ])('rejects a present canonical tree with %s before Postman writes', async (_name, relative, body) => {
      const root = 'postman/collections/core-payments';
      const fixture = writeCanonicalV3Tree(root);
      writeFileSync(join(root, relative), body, 'utf8');
      const postman = createExportPostmanStub();
      await expect(runRepoSync(createInputs({
        generateCiWorkflow: false,
        prebuiltCollectionsJson: buildPrebuiltManifest([{
          role: 'baseline', collectionPath: root, cloudId: 'col-baseline', artifactDigest: fixture.artifactDigest
        }])
      }), deps(postman))).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID/);
      expect(postman.createEnvironment).not.toHaveBeenCalled();
      expect(postman.updateEnvironment).not.toHaveBeenCalled();
      expect(postman.createMock).not.toHaveBeenCalled();
      expect(postman.createMonitor).not.toHaveBeenCalled();
      expect(postman.getCollection).not.toHaveBeenCalled();
      expect(existsSync('.postman/resources.yaml')).toBe(false);
    });

    it('rejects a malformed manifest before Postman writes or generated artifacts', async () => {
      const postman = createExportPostmanStub();
      await expect(runRepoSync(
        createInputs({ prebuiltCollectionsJson: '{not-json' }), deps(postman)
      )).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID/);
      expect(postman.createEnvironment).not.toHaveBeenCalled();
      expect(postman.getCollection).not.toHaveBeenCalled();
      expect(existsSync('postman')).toBe(false);
      expect(existsSync('.postman')).toBe(false);
      expect(existsSync('.github/workflows/ci.yml')).toBe(false);
    });

    it('cloud-exports when digest, path, role name, or cloud ID mismatches', async () => {
      const baseline = writeCanonicalV3Tree('postman/collections/core-payments');
      writeFileSync('postman/collections/core-payments/Stale.request.yaml', '$kind: http-request\nmethod: GET\n', 'utf8');
      writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
      writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
      const postman = createExportPostmanStub();

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest(
            [
              {
                role: 'baseline',
                collectionPath: 'postman/collections/core-payments',
                cloudId: 'col-baseline',
                artifactDigest: sha256Hex('wrong-digest')
              },
              {
                role: 'smoke',
                collectionPath: 'postman/collections/wrong-smoke-name',
                cloudId: 'col-smoke',
                artifactDigest: baseline.artifactDigest
              },
              {
                role: 'contract',
                collectionPath: 'postman/collections/[Contract] core-payments',
                cloudId: 'col-other',
                artifactDigest: baseline.artifactDigest
              }
            ],
            true
          )
        }),
        deps(postman)
      );

      expect(postman.getCollection).toHaveBeenCalledTimes(3);
      expect(postman.getCollection).toHaveBeenCalledWith('col-baseline');
      expect(postman.getCollection).toHaveBeenCalledWith('col-smoke');
      expect(postman.getCollection).toHaveBeenCalledWith('col-contract');
      expect(existsSync('postman/collections/core-payments/Stale.request.yaml')).toBe(false);
      expect(readFileSync('postman/collections/core-payments/.resources/definition.yaml', 'utf8')).toContain('$kind: collection');
    });

    it.each([
      ['invalid role', { role: 'admin' }],
      ['unknown role', { role: 'unknown-role' }],
      ['empty role', { role: '' }],
      ['malformed payload digest', { payloadDigest: 'not-a-digest' }],
      ['malformed artifact digest', { artifactDigest: 'ABC' }],
      ['uppercase artifact digest', { artifactDigest: 'A'.repeat(64) }],
      ['invalid cloudId', { cloudId: 'bad cloud id' }]
    ])('rejects %s in a prebuilt manifest', async (_name, override) => {
      const entry = {
        role: 'baseline',
        collectionPath: 'postman/collections/core-payments',
        cloudId: 'col-baseline',
        payloadDigest: sha256Hex('payload'),
        artifactDigest: sha256Hex('artifact'),
        ...override
      };

      await expect(
        runRepoSync(
          createInputs({ prebuiltCollectionsJson: JSON.stringify([entry]) }),
          deps(createExportPostmanStub())
        )
      ).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID/);
    });

    it.each([
      ['unsupported schemaVersion', JSON.stringify({ schemaVersion: 2, collections: [] })],
      ['non-array collections', JSON.stringify({ schemaVersion: 1, collections: 'not-array' })],
      ['non-object item in array', JSON.stringify([123])],
      ['boolean top-level payload', 'true'],
      ['number top-level payload', '123']
    ])('rejects %s in prebuilt manifest schema', async (_name, prebuiltCollectionsJson) => {
      await expect(
        runRepoSync(
          createInputs({ prebuiltCollectionsJson }),
          deps(createExportPostmanStub())
        )
      ).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID/);
    });

    it('accepts an omitted payloadDigest and reuses on exact artifactDigest match', async () => {
      const root = 'postman/collections/core-payments';
      const fixture = writeCanonicalV3Tree(root);
      writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
      writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
      const postman = createExportPostmanStub();

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([
            {
              role: 'baseline',
              collectionPath: root,
              cloudId: 'col-baseline',
              artifactDigest: fixture.artifactDigest
            }
          ])
        }),
        deps(postman)
      );

      expect(postman.getCollection).toHaveBeenCalledTimes(2);
      expect(postman.getCollection).not.toHaveBeenCalledWith('col-baseline');
    });

    it('accepts a long safe-character cloudId without an arbitrary length cap', async () => {
      const root = 'postman/collections/core-payments';
      const fixture = writeCanonicalV3Tree(root);
      writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
      writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
      const longCloudId = `c${'x'.repeat(256)}`;
      const postman = createExportPostmanStub();

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          baselineCollectionId: longCloudId,
          prebuiltCollectionsJson: buildPrebuiltManifest([
            {
              role: 'baseline',
              collectionPath: root,
              cloudId: longCloudId,
              artifactDigest: fixture.artifactDigest
            }
          ])
        }),
        deps(postman)
      );

      expect(postman.getCollection).not.toHaveBeenCalledWith(longCloudId);
      expect(postman.getCollection).toHaveBeenCalledTimes(2);
    });

    it('accepts a >512-character confined collectionPath without an invented path-length cap', async () => {
      // Host NAME_MAX is typically 255; build a multi-segment confined path >512 chars.
      const segments = ['postman', 'collections'];
      while (segments.join('/').length < 520) {
        segments.push('p'.repeat(80));
      }
      const root = segments.join('/');
      expect(root.length).toBeGreaterThan(512);
      try {
        const fixture = writeCanonicalV3Tree(root);
        writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
        writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
        const postman = createExportPostmanStub();

        // Manifest parsing + confined tree validation must accept the long path.
        // Role export still uses the canonical project path, so a path mismatch
        // falls through to cloud export rather than inventing a length rejection.
        await runRepoSync(
          createInputs({
            environments: ['prod'],
            generateCiWorkflow: false,
            prebuiltCollectionsJson: buildPrebuiltManifest([
              {
                role: 'baseline',
                collectionPath: root,
                cloudId: 'col-baseline',
                artifactDigest: fixture.artifactDigest
              }
            ])
          }),
          deps(postman)
        );

        expect(postman.createEnvironment).toHaveBeenCalled();
        expect(postman.getCollection).toHaveBeenCalled();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENAMETOOLONG' || code === 'ENOENT') {
          return;
        }
        throw error;
      }
    }, 60_000);

    it('rejects file mutation during digest read (TOCTOU before/after identity)', async () => {
      const root = 'postman/collections/core-payments';
      writeCanonicalV3Tree(root);
      const relative = 'List.request.yaml';
      const absolute = join(root, relative);
      const before = lstatSync(absolute);
      const hash = createHash('sha256');
      await expect(
        appendArtifactDigestFileStreaming(hash, relative, absolute, {
          dev: before.dev,
          ino: before.ino,
          size: before.size + 1
        })
      ).rejects.toThrow(/changed or became unsupported|changed while reading/);
    });

    it.each([
      ['./postman/collections/core-payments', 'leading ./'],
      ['postman/collections/core-payments/', 'trailing separator']
    ])('reuses when collectionPath uses %s form', async (collectionPath) => {
      const root = 'postman/collections/core-payments';
      const fixture = writeCanonicalV3Tree(root);
      writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
      writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
      const postman = createExportPostmanStub();

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([
            {
              role: 'baseline',
              collectionPath,
              cloudId: 'col-baseline',
              artifactDigest: fixture.artifactDigest
            }
          ])
        }),
        deps(postman)
      );

      expect(postman.getCollection).not.toHaveBeenCalledWith('col-baseline');
      expect(postman.getCollection).toHaveBeenCalledTimes(2);
    });

    it.each(['./postman', 'postman/'])(
      'reuses prebuilt trees when artifact-dir is %s',
      async (artifactDir) => {
        const root = 'postman/collections/core-payments';
        const fixture = writeCanonicalV3Tree(root);
        writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
        writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
        const postman = createExportPostmanStub();

        await runRepoSync(
          createInputs({
            artifactDir,
            environments: ['prod'],
            generateCiWorkflow: false,
            prebuiltCollectionsJson: buildPrebuiltManifest([
              {
                role: 'baseline',
                collectionPath: root,
                cloudId: 'col-baseline',
                artifactDigest: fixture.artifactDigest
              }
            ])
          }),
          deps(postman)
        );

        expect(postman.getCollection).not.toHaveBeenCalledWith('col-baseline');
        expect(postman.getCollection).toHaveBeenCalledTimes(2);
      }
    );

    it('accepts >2000 valid canonical YAML files with exact digest reuse and no whole-tree buffering', async () => {
      const root = 'postman/collections/core-payments';
      writeCanonicalV3Tree(root);
      writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
      writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
      const body = '$kind: http-request\nmethod: GET\n';
      for (let index = 0; index < 2001; index += 1) {
        writeFileSync(join(root, `extra-${index}.request.yaml`), body, 'utf8');
      }
      const artifactDigest = await digestTreeOnDisk(root);
      const postman = createExportPostmanStub();
      const beforeHeap = process.memoryUsage().heapUsed;

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([
            {
              role: 'baseline',
              collectionPath: root,
              cloudId: 'col-baseline',
              artifactDigest
            }
          ])
        }),
        deps(postman)
      );

      const heapDelta = process.memoryUsage().heapUsed - beforeHeap;
      expect(postman.getCollection).not.toHaveBeenCalledWith('col-baseline');
      // Streaming validation should not retain the whole tree (2000+ small files).
      expect(heapDelta).toBeLessThan(32 * 1024 * 1024);
    }, 120_000);

    it('accepts >512 directories in a confined prebuilt tree', async () => {
      const root = 'postman/collections/core-payments';
      const fixture = writeCanonicalV3Tree(root);
      writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
      writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
      for (let index = 0; index < 520; index += 1) {
        mkdirSync(join(root, `dir-${index}`));
      }
      // Empty dirs prove directory-count acceptance without changing the file digest.
      const postman = createExportPostmanStub();

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([
            {
              role: 'baseline',
              collectionPath: root,
              cloudId: 'col-baseline',
              artifactDigest: fixture.artifactDigest
            }
          ])
        }),
        deps(postman)
      );

      expect(postman.getCollection).not.toHaveBeenCalledWith('col-baseline');
    }, 60_000);

    it('rejects prebuilt trees over the 10,000 directory-and-file traversal-entry budget before cloud export', async () => {
      const root = 'postman/collections/core-payments';
      const fixture = writeCanonicalV3Tree(root);
      for (let index = 0; index < 10_000; index += 1) {
        mkdirSync(join(root, `entry-${index}`));
      }
      const postman = createExportPostmanStub();

      await expect(runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([{
            role: 'baseline',
            collectionPath: root,
            cloudId: 'col-baseline',
            artifactDigest: fixture.artifactDigest
          }])
        }),
        deps(postman)
      )).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID:.*10000.*traversal-entry/i);

      expect(postman.getCollection).not.toHaveBeenCalled();
      expect(existsSync('.postman/resources.yaml')).toBe(false);
    }, 120_000);

    it('reuses an exact prebuilt baseline with 70 nested directories and no baseline GET', async () => {
      const root = 'postman/collections/core-payments';
      const fixture = writeCanonicalV3Tree(root);
      writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
      writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
      let current = root;
      try {
        for (let depth = 0; depth < 70; depth += 1) {
          current = join(current, 'n');
          mkdirSync(current);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENAMETOOLONG' || code === 'ENOENT') {
          return;
        }
        throw error;
      }
      const postman = createExportPostmanStub();

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([
            {
              role: 'baseline',
              collectionPath: root,
              cloudId: 'col-baseline',
              artifactDigest: fixture.artifactDigest
            }
          ])
        }),
        deps(postman)
      );

      expect(postman.getCollection).not.toHaveBeenCalledWith('col-baseline');
      expect(postman.getCollection).toHaveBeenCalledTimes(2);
    }, 60_000);

    it('reuses a 25 MiB+1 KiB valid request YAML by streaming its digest without whole-tree buffering', async () => {
      const root = 'postman/collections/core-payments';
      writeCanonicalV3Tree(root);
      writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
      writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
      writeLargeCanonicalRequestYaml(join(root, 'Huge.request.yaml'), 25 * 1024 * 1024 + 1024);
      const artifactDigest = await digestTreeOnDisk(root);
      const postman = createExportPostmanStub();
      const beforeHeap = process.memoryUsage().heapUsed;

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([
            {
              role: 'baseline',
              collectionPath: root,
              cloudId: 'col-baseline',
              artifactDigest
            }
          ])
        }),
        deps(postman)
      );

      const heapDelta = process.memoryUsage().heapUsed - beforeHeap;
      expect(postman.getCollection).not.toHaveBeenCalledWith('col-baseline');
      expect(heapDelta).toBeLessThan(32 * 1024 * 1024);
    }, 180_000);

    it('rejects prebuilt trees deeper than 128 before cloud export or artifact mutation', async () => {
      const root = 'postman/collections/core-payments';
      const fixture = writeCanonicalV3Tree(root);
      let current = root;
      try {
        for (let depth = 0; depth < 129; depth += 1) {
          current = join(current, 'n');
          mkdirSync(current);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENAMETOOLONG' || code === 'ENOENT') {
          return;
        }
        throw error;
      }
      const postman = createExportPostmanStub();

      await expect(runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([{
            role: 'baseline',
            collectionPath: root,
            cloudId: 'col-baseline',
            artifactDigest: fixture.artifactDigest
          }])
        }),
        deps(postman)
      )).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID:.*128.*depth/i);

      expect(postman.getCollection).not.toHaveBeenCalled();
      expect(existsSync('.postman/resources.yaml')).toBe(false);
    }, 60_000);

    it('rejects an individual prebuilt file over 32 MiB before cloud export or artifact mutation', async () => {
      const root = 'postman/collections/core-payments';
      writeCanonicalV3Tree(root);
      writeLargeCanonicalRequestYaml(join(root, 'Huge.request.yaml'), 32 * 1024 * 1024 + 1024);
      const postman = createExportPostmanStub();

      await expect(runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([
            {
              role: 'baseline',
              collectionPath: root,
              cloudId: 'col-baseline',
              artifactDigest: sha256Hex('oversized-file')
            }
          ])
        }),
        deps(postman)
      )).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID:.*32 MiB/i);

      expect(postman.getCollection).not.toHaveBeenCalled();
      expect(existsSync('.postman/resources.yaml')).toBe(false);
    }, 180_000);

    it('rejects prebuilt trees over the 100 MiB aggregate budget before reading their sparse files', async () => {
      const root = 'postman/collections/core-payments';
      const fixture = writeCanonicalV3Tree(root);
      const sparseFileBytes = Math.floor(9.5 * 1024 * 1024);
      for (let index = 0; index < 11; index += 1) {
        const file = join(root, `aggregate-${index}.request.yaml`);
        const fd = openSync(file, 'w');
        writeSync(fd, Buffer.from('x'), 0, 1, sparseFileBytes - 1);
        closeSync(fd);
      }
      const postman = createExportPostmanStub();

      await expect(runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: buildPrebuiltManifest([{
            role: 'baseline',
            collectionPath: root,
            cloudId: 'col-baseline',
            artifactDigest: fixture.artifactDigest
          }])
        }),
        deps(postman)
      )).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID:.*100 MiB.*total-byte/i);

      expect(postman.getCollection).not.toHaveBeenCalled();
      expect(existsSync('.postman/resources.yaml')).toBe(false);
    });

    it('accepts a >64 KiB semantically valid prebuilt manifest', async () => {
      const root = 'postman/collections/core-payments';
      const fixture = writeCanonicalV3Tree(root);
      writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
      writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
      const collections = [
        {
          role: 'baseline',
          collectionPath: root,
          cloudId: 'col-baseline',
          artifactDigest: fixture.artifactDigest,
          padding: 'x'.repeat(70 * 1024)
        }
      ];
      const manifest = JSON.stringify({ schemaVersion: 1, collections });
      expect(Buffer.byteLength(manifest, 'utf8')).toBeGreaterThan(64 * 1024);
      const postman = createExportPostmanStub();

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          prebuiltCollectionsJson: manifest
        }),
        deps(postman)
      );

      expect(postman.getCollection).not.toHaveBeenCalledWith('col-baseline');
    });

    it.skipIf(process.platform === 'win32')('rejects a nested symlink in a prebuilt tree', async () => {
      const root = 'postman/collections/core-payments';
      const fixture = writeCanonicalV3Tree(root);
      const outside = mkdtempSync(join(tmpdir(), 'prebuilt-nested-link-'));
      symlinkSync(outside, join(root, 'nested-link'));

      await expect(
        runRepoSync(
          createInputs({
            prebuiltCollectionsJson: buildPrebuiltManifest([{
              role: 'baseline',
              collectionPath: root,
              cloudId: 'col-baseline',
              artifactDigest: fixture.artifactDigest
            }])
          }),
          deps(createExportPostmanStub())
        )
      ).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID:.*symlinks/);
      rmSync(outside, { recursive: true, force: true });
    });

    it('fails closed on malformed, traversal, and symlink manifests', async () => {
      const postman = createExportPostmanStub();

      await expect(
        runRepoSync(
          createInputs({ prebuiltCollectionsJson: '{not-json' }),
          deps(postman)
        )
      ).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID/);

      await expect(
        runRepoSync(
          createInputs({
            prebuiltCollectionsJson: buildPrebuiltManifest([
              {
                role: 'baseline',
                collectionPath: '../escape',
                cloudId: 'col-baseline',
                artifactDigest: sha256Hex('x')
              }
            ])
          }),
          deps(postman)
        )
      ).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID|repository root|artifact-dir/);

      await expect(
        runRepoSync(
          createInputs({
            prebuiltCollectionsJson: buildPrebuiltManifest([
              {
                role: 'baseline',
                collectionPath: 'postman/collections/core-payments',
                cloudId: 'col-baseline',
                artifactDigest: sha256Hex('a')
              },
              {
                role: 'baseline',
                collectionPath: 'postman/collections/other',
                cloudId: 'col-other',
                artifactDigest: sha256Hex('b')
              }
            ])
          }),
          deps(postman)
        )
      ).rejects.toThrow(/duplicate role/);

      mkdirSync('postman/collections', { recursive: true });
      const outside = mkdtempSync(join(tmpdir(), 'prebuilt-escape-'));
      writeCanonicalV3Tree(outside);
      symlinkSync(outside, 'postman/collections/core-payments');
      await expect(
        runRepoSync(
          createInputs({
            environments: ['prod'],
            generateCiWorkflow: false,
            prebuiltCollectionsJson: buildPrebuiltManifest([
              {
                role: 'baseline',
                collectionPath: 'postman/collections/core-payments',
                cloudId: 'col-baseline',
                artifactDigest: sha256Hex('symlink-tree')
              }
            ])
          }),
          deps(postman)
        )
      ).rejects.toThrow(/CONTRACT_PREBUILT_COLLECTIONS_INVALID|symlink|repository root|artifact-dir/);
      rmSync('postman/collections/core-payments', { force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    it('leaves prior workflows.yaml unchanged on zero-collection env-only runs', async () => {
      mkdirSync('.postman', { recursive: true });
      mkdirSync('packages/sdk', { recursive: true });
      writeFileSync(
        'packages/sdk/openapi.json',
        JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {} })
      );
      const prior = [
        'workflows:',
        '  syncSpecToCollection:',
        '    - spec: ../packages/sdk/openapi.json',
        '      collection: ../postman/collections/prior-only',
        '      keep: true'
      ].join('\n');
      writeFileSync('.postman/workflows.yaml', prior, 'utf8');

      const postman = createExportPostmanStub();
      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          baselineCollectionId: '',
          smokeCollectionId: '',
          contractCollectionId: '',
          specId: 'spec-123',
          specPath: 'packages/sdk/openapi.json'
        }),
        deps(postman)
      );

      expect(readFileSync('.postman/workflows.yaml', 'utf8')).toBe(prior);
      expect(postman.getCollection).not.toHaveBeenCalled();
    });

    it('reconciles current-spec pairs by composite identity and stays idempotent and ID-free', async () => {
      mkdirSync('.postman', { recursive: true });
      mkdirSync('packages/sdk', { recursive: true });
      writeFileSync(
        'packages/sdk/openapi.json',
        JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {} })
      );
      writeFileSync(
        '.postman/workflows.yaml',
        [
          'generation:',
          '  mode: keep-me',
          'sync:',
          '  option: preserved',
          'workflows:',
          '  customKeep: true',
          '  syncSpecToCollection:',
          '    - spec: ../other.yaml',
          '      collection: ../postman/collections/core-payments',
          '      otherField: keep-other',
          '    - spec: ../packages/sdk/openapi.json',
          '      collection: ../postman/collections/stale-current',
          '      stale: remove-me',
          '    - spec: ../packages/sdk/openapi.json',
          '      collection: ../postman/collections/core-payments',
          '      extra: keep-extra'
        ].join('\n'),
        'utf8'
      );

      const postman = createExportPostmanStub();
      const inputs = createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          specId: 'spec-123',
          specPath: 'packages/sdk/openapi.json'
        });
      await runRepoSync(inputs, deps(postman));

      const workflowsYaml = loadYaml(readFileSync('.postman/workflows.yaml', 'utf8')) as Record<
        string,
        unknown
      >;
      expect(workflowsYaml.generation).toEqual({ mode: 'keep-me' });
      expect(workflowsYaml.sync).toEqual({ option: 'preserved' });
      expect(workflowsYaml.workflows).toMatchObject({
        customKeep: true,
        syncSpecToCollection: expect.arrayContaining([
          {
            spec: '../other.yaml',
            collection: '../postman/collections/core-payments',
            otherField: 'keep-other'
          },
          {
            spec: '../packages/sdk/openapi.json',
            collection: '../postman/collections/core-payments',
            extra: 'keep-extra'
          },
          {
            spec: '../packages/sdk/openapi.json',
            collection: '../postman/collections/[Smoke] core-payments'
          },
          {
            spec: '../packages/sdk/openapi.json',
            collection: '../postman/collections/[Contract] core-payments'
          }
        ])
      });
      expect(JSON.stringify(workflowsYaml)).not.toContain('stale-current');
      const serialized = readFileSync('.postman/workflows.yaml', 'utf8');
      expect(serialized).not.toMatch(/\bid\s*:/);
      expect(serialized).not.toMatch(/collectionId|cloudId|uid:/i);
      await runRepoSync(inputs, deps(createExportPostmanStub()));
      expect(readFileSync('.postman/workflows.yaml', 'utf8')).toBe(serialized);
    });
  });

  describe('local spec discovery', () => {
    const maxCandidateBytes = 512 * 1024;

    function deps(postman: ReturnType<typeof createExportPostmanStub>) {
      return {
        core: createCoreStub().core,
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
          commitAndPush: vi.fn().mockResolvedValue({
            commitSha: '',
            pushed: false,
            resolvedCurrentRef: 'feature/repo-sync'
          })
        } as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
      };
    }

    function writeSparseOversizeFile(filePath: string, logicalSize: number): void {
      const slash = filePath.lastIndexOf('/');
      if (slash >= 0) {
        mkdirSync(filePath.slice(0, slash), { recursive: true });
      }
      const fd = openSync(filePath, 'w');
      try {
        if (logicalSize > 0) {
          writeSync(fd, Buffer.from('x'), 0, 1, logicalSize - 1);
        }
      } finally {
        closeSync(fd);
      }
    }

    function seedCandidateJsonFiles(count: number, dir = 'discovery-noise'): void {
      mkdirSync(dir, { recursive: true });
      for (let index = 0; index < count; index += 1) {
        writeFileSync(
          join(dir, `candidate-${String(index).padStart(4, '0')}.json`),
          JSON.stringify({ not: 'openapi' })
        );
      }
    }

    function seedOpenApiSpec(relativePath: string): void {
      const slash = relativePath.lastIndexOf('/');
      if (slash >= 0) {
        mkdirSync(relativePath.slice(0, slash), { recursive: true });
      }
      writeFileSync(
        relativePath,
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'Payments', version: '1.0.0' },
          paths: {}
        })
      );
    }

    function seedNonCandidateFiles(count: number, dir = 'wide-tree'): void {
      mkdirSync(dir, { recursive: true });
      for (let index = 0; index < count; index += 1) {
        writeFileSync(
          join(dir, `note-${String(index).padStart(4, '0')}.txt`),
          'plain text'
        );
      }
    }

    function seedDeepDirectoryChain(depth: number): string {
      let current = '';
      for (let index = 0; index < depth; index += 1) {
        current = join(current, `level-${index}`);
        mkdirSync(current, { recursive: true });
      }
      return current;
    }

    it('discovers an ordinary OpenAPI file during automatic discovery', async () => {
      seedOpenApiSpec('openapi.yaml');

      await runRepoSync(
        createInputs({ specId: 'spec-auto', generateCiWorkflow: false }),
        deps(createExportPostmanStub())
      );

      const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
      expect(resources.canonical?.specs?.['../openapi.yaml']).toBe('spec-auto');
    });

    it('discovers OpenAPI after scanning more than 200 non-candidate entries', async () => {
      seedNonCandidateFiles(250);
      seedOpenApiSpec('openapi.yaml');

      await runRepoSync(
        createInputs({ specId: 'spec-wide-tree', generateCiWorkflow: false }),
        deps(createExportPostmanStub())
      );

      const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
      expect(resources.canonical?.specs?.['../openapi.yaml']).toBe('spec-wide-tree');
    });

    it('uses explicit spec-path without scanning unrelated oversized trees', async () => {
      seedOpenApiSpec('packages/sdk/openapi.json');
      writeSparseOversizeFile('generated/huge.openapi.json', maxCandidateBytes + 1);
      seedCandidateJsonFiles(250);

      await runRepoSync(
        createInputs({
          specId: 'spec-explicit',
          specPath: 'packages/sdk/openapi.json',
          generateCiWorkflow: false
        }),
        deps(createExportPostmanStub())
      );

      const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
      expect(resources.canonical?.specs?.['../packages/sdk/openapi.json']).toBe('spec-explicit');
    });

    it('skips deep vendor trees while discovering a repository OpenAPI file', async () => {
      let current = 'vendor';
      for (let index = 0; index < 10; index += 1) {
        current = join(current, `dependency-${index}`);
        mkdirSync(current, { recursive: true });
      }
      seedOpenApiSpec('openapi.yaml');

      await runRepoSync(
        createInputs({ specId: 'spec-vendor-tree', generateCiWorkflow: false }),
        deps(createExportPostmanStub())
      );

      const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
      expect(resources.canonical?.specs?.['../openapi.yaml']).toBe('spec-vendor-tree');
    });

    it('fails closed when local spec discovery exceeds the candidate-file budget', async () => {
      seedCandidateJsonFiles(201);

      await expect(
        runRepoSync(
          createInputs({ specId: 'spec-limit', generateCiWorkflow: false }),
          deps(createExportPostmanStub())
        )
      ).rejects.toThrow(
        /CONTRACT_LOCAL_SPEC_DISCOVERY_LIMIT:.*candidate-file budget.*spec-path/
      );
    });

    it('preserves legacy tracked collection ids in full scope without workspace state', async () => {
      mkdirSync('.postman', { recursive: true });
      writeFileSync(
        '.postman/resources.yaml',
        [
          'version: 2',
          'canonical:',
          '  collections:',
          '    ../postman/collections/core-payments: col-baseline-tracked',
          '    ../postman/collections/[Smoke] core-payments: col-smoke-tracked',
          '    ../postman/collections/[Contract] core-payments: col-contract-tracked',
          ''
        ].join('\n')
      );
      const postman = createExportPostmanStub();

      await runRepoSync(
        createInputs({
          baselineCollectionId: '',
          smokeCollectionId: '',
          contractCollectionId: '',
          onboardingScope: 'full',
          environments: [],
          environmentSyncEnabled: false,
          workspaceLinkEnabled: false,
          generateCiWorkflow: false,
          repoWriteMode: 'none'
        }),
        deps(postman)
      );

      expect(postman.getCollection).toHaveBeenCalledTimes(3);
      expect(postman.getCollection).toHaveBeenCalledWith('col-baseline-tracked');
      expect(postman.getCollection).toHaveBeenCalledWith('col-smoke-tracked');
      expect(postman.getCollection).toHaveBeenCalledWith('col-contract-tracked');
    });

    it('skips local spec discovery for workspace-only runs in spec-only scope', async () => {
      seedCandidateJsonFiles(201);

      await expect(
        runRepoSync(
          createInputs({
            specId: '',
            specPath: '',
            onboardingScope: 'spec-only',
            generateCiWorkflow: false
          }),
          deps(createExportPostmanStub())
        )
      ).resolves.toBeDefined();

      const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
      expect(resources.workspace).toEqual({ id: 'ws-123' });
      expect(resources.canonical?.specs).toBeUndefined();
    });

    it('does not preserve generated resource ids when spec-only sync targets a different workspace', async () => {
      mkdirSync('.postman', { recursive: true });
      writeFileSync(
        '.postman/resources.yaml',
        [
          'version: 2',
          'workspace:',
          '  id: ws-old',
          'canonical:',
          '  collections:',
          '    ../postman/collections/old: col-old',
          '  environments:',
          '    ../postman/environments/prod.postman_environment.json: env-old',
          '  specs:',
          '    ../old.yaml: spec-old',
          ''
        ].join('\n')
      );
      seedOpenApiSpec('openapi.yaml');

      await runRepoSync(
        createInputs({
          workspaceId: 'ws-new',
          specId: 'spec-new',
          specPath: 'openapi.yaml',
          onboardingScope: 'spec-only',
          generateCiWorkflow: false
        }),
        deps(createExportPostmanStub())
      );

      const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
      expect(resources).toEqual({
        version: 2,
        workspace: { id: 'ws-new' },
        canonical: { specs: { '../openapi.yaml': 'spec-new' } }
      });
    });

    it('does not attach legacy generated mappings to a new workspace when state has no workspace id', async () => {
      mkdirSync('.postman', { recursive: true });
      writeFileSync(
        '.postman/resources.yaml',
        [
          'version: 2',
          'canonical:',
          '  collections:',
          '    ../postman/collections/old: col-old',
          '  environments:',
          '    ../postman/environments/prod.postman_environment.json: env-old',
          '  specs:',
          '    ../old.yaml: spec-old',
          ''
        ].join('\n')
      );
      seedOpenApiSpec('openapi.yaml');

      await runRepoSync(
        createInputs({
          workspaceId: 'ws-new',
          specId: 'spec-new',
          specPath: 'openapi.yaml',
          onboardingScope: 'spec-only',
          generateCiWorkflow: false
        }),
        deps(createExportPostmanStub())
      );

      const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
      expect(resources).toEqual({
        version: 2,
        workspace: { id: 'ws-new' },
        canonical: {
          specs: {
            '../openapi.yaml': 'spec-new'
          }
        }
      });
    });

    it('does not rewrite canonical resources during a spec-only preview run', async () => {
      mkdirSync('.postman', { recursive: true });
      const originalResources = [
        'version: 2',
        'workspace:',
        '  id: ws-123',
        'canonical:',
        '  collections:',
        '    ../postman/collections/existing: col-existing',
        '  environments:',
        '    ../postman/environments/prod.postman_environment.json: env-existing',
        '  specs:',
        '    ../openapi.yaml: spec-existing',
        ''
      ].join('\n');
      writeFileSync('.postman/resources.yaml', originalResources);
      seedOpenApiSpec('openapi.yaml');

      await runRepoSync(
        createInputs({
          branchStrategy: 'preview',
          canonicalBranch: 'main',
          currentRef: 'refs/heads/feature/spec-only',
          githubRefName: 'feature/spec-only',
          specId: 'spec-preview',
          specPath: 'openapi.yaml',
          onboardingScope: 'spec-only',
          generateCiWorkflow: false
        }),
        deps(createExportPostmanStub())
      );

      expect(readFileSync('.postman/resources.yaml', 'utf8')).toBe(originalResources);
    });

    it('stages only the resources state file during spec-only sync', async () => {
      seedOpenApiSpec('openapi.yaml');
      const dependencies = deps(createExportPostmanStub());
      const commitAndPush = vi.fn().mockResolvedValue({
        commitSha: 'commit-spec-only',
        pushed: false,
        resolvedCurrentRef: 'feature/repo-sync'
      });
      dependencies.repoMutation = {
        commitAndPush
      } as unknown as NonNullable<RepoSyncDependencies['repoMutation']>;

      await runRepoSync(
        createInputs({
          specId: 'spec-new',
          specPath: 'openapi.yaml',
          onboardingScope: 'spec-only',
          generateCiWorkflow: false,
          repoWriteMode: 'commit-only'
        }),
        dependencies
      );

      expect(commitAndPush).toHaveBeenCalledWith(
        expect.objectContaining({
          removePaths: [],
          stagePaths: ['.postman/resources.yaml']
        })
      );
    });

    it('fails closed when local spec discovery exceeds the directory-depth budget', async () => {
      const deepDir = seedDeepDirectoryChain(7);
      seedOpenApiSpec(join(deepDir, 'openapi.json'));

      await expect(
        runRepoSync(
          createInputs({ specId: 'spec-depth', generateCiWorkflow: false }),
          deps(createExportPostmanStub())
        )
      ).rejects.toThrow(
        /CONTRACT_LOCAL_SPEC_DISCOVERY_LIMIT:.*directory-depth budget.*spec-path/
      );
    });

    it('fails closed before reading an oversized spec candidate file', async () => {
      writeSparseOversizeFile('oversized-spec.json', maxCandidateBytes + 1);

      await expect(
        runRepoSync(
          createInputs({ specId: 'spec-oversized', generateCiWorkflow: false }),
          deps(createExportPostmanStub())
        )
      ).rejects.toThrow(
        /CONTRACT_LOCAL_SPEC_DISCOVERY_LIMIT:.*exceeds 524288 bytes.*spec-path/
      );
    });
  });

  describe.sequential('private-mock export artifact reconciliation', () => {
    function snapshotRepoArtifactFiles(): Map<string, Buffer> {
      const snapshot = new Map<string, Buffer>();
      const roots = ['postman', '.postman', '.github'];
      for (const root of roots) {
        if (!existsSync(root)) {
          continue;
        }
        const stack = [root];
        while (stack.length > 0) {
          const current = stack.pop()!;
          for (const entry of readdirSync(current, { withFileTypes: true })) {
            const rel = join(current, entry.name);
            if (entry.isDirectory()) {
              stack.push(rel);
            } else if (entry.isFile()) {
              snapshot.set(rel, readFileSync(rel));
            }
          }
        }
      }
      return snapshot;
    }

    function assertRepoArtifactSnapshotUnchanged(before: Map<string, Buffer>): void {
      const after = snapshotRepoArtifactFiles();
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [filePath, bytes] of before) {
        expect(after.get(filePath)).toEqual(bytes);
      }
    }

    function privateMockDeps(
      postman: ReturnType<typeof createExportPostmanStub>,
      options: {
        commitAndPush?: ReturnType<typeof vi.fn>;
        secretMasker?: ReturnType<typeof createSecretMasker>;
      } = {}
    ) {
      const commitAndPush = options.commitAndPush ?? vi.fn().mockResolvedValue({
        commitSha: '',
        pushed: false,
        resolvedCurrentRef: 'feature/repo-sync'
      });
      return {
        core: createCoreStub().core,
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
        } as unknown as NonNullable<RepoSyncDependencies['repoMutation']>,
        ...(options.secretMasker ? { secretMasker: options.secretMasker } : {})
      };
    }

    function buildAllPrebuiltManifest() {
      const baseline = writeCanonicalV3Tree('postman/collections/core-payments');
      const smoke = writeCanonicalV3Tree('postman/collections/[Smoke] core-payments');
      const contract = writeCanonicalV3Tree('postman/collections/[Contract] core-payments');
      return {
        baseline,
        smoke,
        contract,
        manifest: buildPrebuiltManifest([
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
        ])
      };
    }

    it('exports collection-only runs without requiring private-mock auth hooks', async () => {
      const postman = {
        ...createExportPostmanStub(),
        getCollection: vi.fn(async (uid: string) =>
          uid === 'col-smoke'
            ? createCollectionFixture('[Smoke] core-payments')
            : createCollectionFixture('[Contract] core-payments')
        )
      };

      const result = await runRepoSync(
        createInputs({
          baselineCollectionId: '',
          environments: [],
          generateCiWorkflow: true,
          mockVisibility: 'private'
        }),
        privateMockDeps(postman)
      );

      expect(result['mock-auth-required']).toBe('false');
      expect(postman.configurePrivateMockRuntimeAuth).not.toHaveBeenCalled();
      expect(postman.getCollection).toHaveBeenCalledWith('col-smoke');
      expect(postman.getCollection).toHaveBeenCalledWith('col-contract');
      expect(readFileSync('.github/workflows/ci.yml', 'utf8')).not.toContain(
        'postmanPrivateMockApiKey'
      );
    });

    it('forces every collection through verified cloud export for a private mock', async () => {
      const { manifest } = buildAllPrebuiltManifest();
      const postman = {
        ...createExportPostmanStub(),
        listMocks: vi.fn().mockResolvedValue([PRIVATE_MOCK_LIST_ENTRY]),
        getCollection: vi.fn(async (uid: string) => {
          if (uid === 'col-baseline') return createV3CollectionFixture('core-payments');
          if (uid === 'col-smoke') {
            return createV3CollectionFixture('[Smoke] core-payments', {
              itemLegacyBlockIndex: 2,
              itemCustomerScript: "console.log('customer-owned');"
            });
          }
          return createV3CollectionFixture('[Contract] core-payments');
        })
      };

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          mockVisibility: 'private',
          mockUrl: PRIVATE_MOCK_LIST_ENTRY.mockUrl,
          prebuiltCollectionsJson: manifest
        }),
        privateMockDeps(postman)
      );

      expect(postman.getCollection).toHaveBeenCalledTimes(3);
      expect(postman.getCollection).toHaveBeenCalledWith('col-baseline');
      expect(postman.getCollection).toHaveBeenCalledWith('col-smoke');
      expect(postman.getCollection).toHaveBeenCalledWith('col-contract');
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-baseline');
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-smoke');
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-contract');

      const baselineDefinition = readFileSync(
        'postman/collections/core-payments/.resources/definition.yaml',
        'utf8'
      );
      expect(baselineDefinition).toContain(PRIVATE_MOCK_AUTH_ROOT_MARKER);

      const smokeDefinition = readFileSync(
        'postman/collections/[Smoke] core-payments/.resources/definition.yaml',
        'utf8'
      );
      expect(smokeDefinition).toContain('type: http:beforeRequest');
      expect(smokeDefinition).toContain(PRIVATE_MOCK_AUTH_ROOT_MARKER);

      const smokeRequest = readFileSync(
        'postman/collections/[Smoke] core-payments/List Payments.request.yaml',
        'utf8'
      );
      expect(smokeRequest).not.toContain('private-mock-auth-v3');
      expect(smokeRequest).toContain("console.log('customer-owned');");
    });

    it('keeps public-mock prebuilt reuse at zero extra cloud reads', async () => {
      const { manifest } = buildAllPrebuiltManifest();
      const postman = {
        ...createExportPostmanStub(),
        listMocks: vi.fn().mockResolvedValue([{
          ...PRIVATE_MOCK_LIST_ENTRY,
          visibility: 'public' as const,
          mockUrl: 'https://explicit-public.mock.pstmn.io'
        }])
      };

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          mockVisibility: 'public',
          mockUrl: 'https://explicit-public.mock.pstmn.io',
          prebuiltCollectionsJson: manifest
        }),
        privateMockDeps(postman)
      );

      expect(postman.getCollection).toHaveBeenCalledTimes(0);
      expect(postman.configurePrivateMockRuntimeAuth).not.toHaveBeenCalled();
    });

    it('fails before repo mutation when the managed root hook is missing from smoke export', async () => {
      const { manifest } = buildAllPrebuiltManifest();
      const artifactSnapshotBefore = snapshotRepoArtifactFiles();
      const commitAndPush = vi.fn().mockResolvedValue({
        commitSha: '',
        pushed: false,
        resolvedCurrentRef: 'feature/repo-sync'
      });
      const postman = {
        ...createExportPostmanStub(),
        listMocks: vi.fn().mockResolvedValue([PRIVATE_MOCK_LIST_ENTRY]),
        getCollection: vi.fn(async (uid: string) =>
          uid === 'col-smoke'
            ? createV3CollectionFixture('[Smoke] core-payments', { rootHook: false })
            : createV3CollectionFixture('core-payments')
        )
      };

      await expect(
        runRepoSync(
          createInputs({
            environments: ['prod'],
            generateCiWorkflow: false,
            mockVisibility: 'private',
            mockUrl: PRIVATE_MOCK_LIST_ENTRY.mockUrl,
            prebuiltCollectionsJson: manifest
          }),
          privateMockDeps(postman, { commitAndPush })
        )
      ).rejects.toThrow(/PRIVATE_MOCK_AUTH_ROOT_UNVERIFIED.*smoke.*col-smoke/);

      assertRepoArtifactSnapshotUnchanged(artifactSnapshotBefore);
      expect(postman.getCollection).toHaveBeenCalledTimes(3);
      expect(postman.getCollection).toHaveBeenCalledWith('col-baseline');
      expect(postman.getCollection).toHaveBeenCalledWith('col-smoke');
      expect(postman.getCollection).toHaveBeenCalledWith('col-contract');
      expect(commitAndPush).not.toHaveBeenCalled();
      expect(existsSync('.postman/resources.yaml')).toBe(false);
      expect(existsSync('postman/globals/workspace.globals.yaml')).toBe(false);
      expect(existsSync('.postman/workflows.yaml')).toBe(false);
    });

    it('fails before repo mutation when contract root hook is missing after smoke validates', async () => {
      const { manifest } = buildAllPrebuiltManifest();
      const artifactSnapshotBefore = snapshotRepoArtifactFiles();
      const commitAndPush = vi.fn().mockResolvedValue({
        commitSha: '',
        pushed: false,
        resolvedCurrentRef: 'feature/repo-sync'
      });
      const postman = {
        ...createExportPostmanStub(),
        listMocks: vi.fn().mockResolvedValue([PRIVATE_MOCK_LIST_ENTRY]),
        getCollection: vi.fn(async (uid: string) => {
          if (uid === 'col-contract') {
            return createV3CollectionFixture('[Contract] core-payments', { rootHook: false });
          }
          return createV3CollectionFixture(
            uid === 'col-smoke' ? '[Smoke] core-payments' : 'core-payments'
          );
        })
      };

      await expect(
        runRepoSync(
          createInputs({
            environments: ['prod'],
            generateCiWorkflow: false,
            mockVisibility: 'private',
            mockUrl: PRIVATE_MOCK_LIST_ENTRY.mockUrl,
            prebuiltCollectionsJson: manifest
          }),
          privateMockDeps(postman, { commitAndPush })
        )
      ).rejects.toThrow(/PRIVATE_MOCK_AUTH_ROOT_UNVERIFIED.*contract.*col-contract/);

      assertRepoArtifactSnapshotUnchanged(artifactSnapshotBefore);
      expect(postman.getCollection).toHaveBeenCalledTimes(3);
      expect(postman.getCollection).toHaveBeenCalledWith('col-baseline');
      expect(postman.getCollection).toHaveBeenCalledWith('col-smoke');
      expect(postman.getCollection).toHaveBeenCalledWith('col-contract');
      expect(commitAndPush).not.toHaveBeenCalled();
      expect(existsSync('.postman/resources.yaml')).toBe(false);
      expect(existsSync('postman/globals/workspace.globals.yaml')).toBe(false);
      expect(existsSync('.postman/workflows.yaml')).toBe(false);
    });

    it('stops before cloud export or repo mutation when the root auth PATCH fails hard', async () => {
      const { manifest } = buildAllPrebuiltManifest();
      const artifactSnapshotBefore = snapshotRepoArtifactFiles();
      const commitAndPush = vi.fn().mockResolvedValue({
        commitSha: '',
        pushed: false,
        resolvedCurrentRef: 'feature/repo-sync'
      });
      const secret = 'test-private-mock-token';
      const postman = {
        ...createExportPostmanStub(),
        listMocks: vi.fn().mockResolvedValue([PRIVATE_MOCK_LIST_ENTRY]),
        configurePrivateMockRuntimeAuth: vi.fn(async (uid: string) => {
          if (uid === 'col-smoke') {
            throw new Error(`gateway PATCH 403 forbidden: ${secret}`);
          }
          return 1;
        })
      };

      const error = await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          mockVisibility: 'private',
          mockUrl: PRIVATE_MOCK_LIST_ENTRY.mockUrl,
          prebuiltCollectionsJson: manifest
        }),
        privateMockDeps(postman, {
          commitAndPush,
          secretMasker: createSecretMasker([secret])
        })
      ).then(
        () => undefined,
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('PRIVATE_MOCK_AUTH_ROOT_PATCH');
      expect(message).toContain('smoke collection col-smoke');
      expect(message).toContain('gateway PATCH 403 forbidden');
      expect(message).not.toContain(secret);

      assertRepoArtifactSnapshotUnchanged(artifactSnapshotBefore);
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-baseline');
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-smoke');
      expect(postman.configurePrivateMockRuntimeAuth).not.toHaveBeenCalledWith('col-contract');
      expect(postman.getCollection).not.toHaveBeenCalled();
      expect(commitAndPush).not.toHaveBeenCalled();
      expect(existsSync('.postman/resources.yaml')).toBe(false);
      expect(existsSync('postman/globals/workspace.globals.yaml')).toBe(false);
    });

    it('retains legacy item blocks when cleanup kill switch is off but still exports the root hook', async () => {
      vi.stubEnv('POSTMAN_PRIVATE_MOCK_LEGACY_EXPORT_CLEANUP', 'off');
      const { manifest } = buildAllPrebuiltManifest();
      const postman = {
        ...createExportPostmanStub(),
        listMocks: vi.fn().mockResolvedValue([PRIVATE_MOCK_LIST_ENTRY]),
        getCollection: vi.fn(async (uid: string) => {
          if (uid === 'col-smoke') {
            return createV3CollectionFixture('[Smoke] core-payments', {
              itemLegacyBlockIndex: 2
            });
          }
          return createV3CollectionFixture(
            uid === 'col-contract' ? '[Contract] core-payments' : 'core-payments'
          );
        })
      };

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          mockVisibility: 'private',
          mockUrl: PRIVATE_MOCK_LIST_ENTRY.mockUrl,
          prebuiltCollectionsJson: manifest
        }),
        privateMockDeps(postman)
      );

      const smokeRequest = readFileSync(
        'postman/collections/[Smoke] core-payments/List Payments.request.yaml',
        'utf8'
      );
      expect(smokeRequest).toContain('private-mock-auth-v3');
      expect(readFileSync(
        'postman/collections/[Smoke] core-payments/.resources/definition.yaml',
        'utf8'
      )).toContain(PRIVATE_MOCK_AUTH_ROOT_MARKER);
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-baseline');
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-smoke');
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-contract');
      expect(postman.getCollection).toHaveBeenCalledTimes(3);
      expect(postman.getCollection).toHaveBeenCalledWith('col-baseline');
      vi.unstubAllEnvs();
    });

    it('leaves a customer-edited near-miss item block untouched in exported YAML', async () => {
      const nearMiss = MANAGED_ITEM_AUTH_BLOCKS[2].replace(
        'private-mock-auth-v3',
        'private-mock-auth-v3-customer-edit'
      );
      const { manifest } = buildAllPrebuiltManifest();
      const postman = {
        ...createExportPostmanStub(),
        listMocks: vi.fn().mockResolvedValue([PRIVATE_MOCK_LIST_ENTRY]),
        getCollection: vi.fn(async (uid: string) => {
          if (uid === 'col-smoke') {
            return createV3CollectionFixture('[Smoke] core-payments', {
              itemNearMissScript: nearMiss
            });
          }
          return createV3CollectionFixture(
            uid === 'col-contract' ? '[Contract] core-payments' : 'core-payments'
          );
        })
      };

      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          mockVisibility: 'private',
          mockUrl: PRIVATE_MOCK_LIST_ENTRY.mockUrl,
          prebuiltCollectionsJson: manifest
        }),
        privateMockDeps(postman)
      );

      const smokeRequest = readFileSync(
        'postman/collections/[Smoke] core-payments/List Payments.request.yaml',
        'utf8'
      );
      expect(smokeRequest).toContain('private-mock-auth-v3-customer-edit');
    });

    it('emits byte-identical smoke YAML on a second private-mock sync', async () => {
      const { manifest } = buildAllPrebuiltManifest();
      const smokeV3 = createV3CollectionFixture('[Smoke] core-payments', {
        itemLegacyBlockIndex: 1,
        itemCustomerScript: "console.log('stable');"
      });
      const contractV3 = createV3CollectionFixture('[Contract] core-payments');
      const baselineV3 = createV3CollectionFixture('core-payments');
      const postman = {
        ...createExportPostmanStub(),
        listMocks: vi.fn().mockResolvedValue([PRIVATE_MOCK_LIST_ENTRY]),
        getCollection: vi.fn(async (uid: string) =>
          structuredClone(
            uid === 'col-baseline' ? baselineV3 : uid === 'col-smoke' ? smokeV3 : contractV3
          )
        )
      };
      const inputs = createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        mockVisibility: 'private',
        mockUrl: PRIVATE_MOCK_LIST_ENTRY.mockUrl,
        prebuiltCollectionsJson: manifest
      });
      const deps = privateMockDeps(postman);

      await runRepoSync(inputs, deps);
      const firstDigest = await digestTreeOnDisk('postman/collections/[Smoke] core-payments');

      await runRepoSync(inputs, deps);
      const secondDigest = await digestTreeOnDisk('postman/collections/[Smoke] core-payments');

      expect(firstDigest).toBe(secondDigest);
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenCalledTimes(6);
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenNthCalledWith(4, 'col-baseline');
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenNthCalledWith(5, 'col-smoke');
      expect(postman.configurePrivateMockRuntimeAuth).toHaveBeenNthCalledWith(6, 'col-contract');
    });
  });

  it('updates existing environments on reruns instead of creating duplicates', async () => {
    const postman = {
      createEnvironment: vi.fn(),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi.fn().mockResolvedValue(createCollectionFixture('[Smoke] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
      listMonitors: vi.fn().mockResolvedValue([]),
      listMocks: vi.fn().mockResolvedValue([]),
      monitorExists: vi.fn().mockResolvedValue(false),
      mockExists: vi.fn().mockResolvedValue(false),
      findMonitorByCollection: vi.fn().mockResolvedValue(null),
      rebindMonitorByName: vi.fn().mockResolvedValue(null),
      findMockByCollection: vi.fn().mockResolvedValue(null),
      runMonitor: vi.fn().mockResolvedValue(undefined),
      listEnvironments: vi.fn().mockResolvedValue([]),
      deleteEnvironment: vi.fn().mockResolvedValue(undefined),
      deleteMock: vi.fn().mockResolvedValue(undefined),
      deleteMonitor: vi.fn().mockResolvedValue(undefined)
    };
    const github = {
      getRepositoryVariable: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ prod: 'env-prod', stage: 'env-stage' })),
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined)
    };

    await runRepoSync(
      createInputs({
        environmentUids: { prod: 'env-prod', stage: 'env-stage' }
      }),
      {
        core: createCoreStub().core,
        postman,
        github,
        internalIntegration: {
          associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: {
          commitAndPush: vi.fn().mockResolvedValue({
            commitSha: '',
            pushed: false,
            resolvedCurrentRef: 'feature/repo-sync'
          })
        } as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
      }
    );

    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.findEnvironmentByName).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).toHaveBeenCalledTimes(2);
  });

  it('supports workspace and spec sync without generated assets or cloud monitors', async () => {
    mkdirSync('.github/workflows', { recursive: true });
    writeFileSync('.github/workflows/provision.yml', 'name: Existing Provision\n');
    mkdirSync('.postman', { recursive: true });
    writeFileSync(
      '.postman/resources.yaml',
      [
        'version: 2',
        'workspace:',
        '  id: ws-123',
        'canonical:',
        '  collections:',
        '    ../postman/collections/existing: col-existing',
        '  environments:',
        '    ../postman/environments/prod.postman_environment.json: env-existing',
        '  specs:',
        '    ../existing.yaml: spec-existing',
        ''
      ].join('\n')
    );
    writeFileSync(
      'openapi.yaml',
      'openapi: 3.1.0\ninfo:\n  title: Specs Only\n  version: 1.0.0\npaths: {}\n'
    );

    const postman = {
      createEnvironment: vi.fn(),
      updateEnvironment: vi.fn(),
      findEnvironmentByName: vi.fn(),
      createMock: vi.fn(),
      findMockByCollection: vi.fn(),
      createMonitor: vi.fn(),
      findMonitorByCollection: vi.fn(),
      runMonitor: vi.fn(),
      getCollection: vi.fn(),
      getEnvironment: vi.fn()
    } as unknown as RepoSyncDependencies['postman'];
    const internalIntegration = {
      associateSystemEnvironments: vi.fn(),
      connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
      findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
    };
    const repoMutation = {
      commitAndPush: vi.fn().mockResolvedValue({
        commitSha: 'spec-only-commit',
        pushed: false,
        resolvedCurrentRef: 'feature/repo-sync'
      })
    };

    const result = await runRepoSync(
      createInputs({
        specId: 'spec-new',
        specPath: 'openapi.yaml',
        onboardingScope: 'spec-only'
      }),
      {
        core: createCoreStub().core,
        postman,
        internalIntegration,
        repoMutation: repoMutation as unknown as RepoSyncDependencies['repoMutation']
      }
    );

    expect(result).toMatchObject({
      'workspace-link-status': 'success',
      'environment-sync-status': 'skipped',
      'environment-uids-json': '{}',
      'mock-url': '',
      'monitor-id': ''
    });
    expect(internalIntegration.connectWorkspaceToRepository).toHaveBeenCalledWith(
      'ws-123',
      'https://github.com/postman-cs/repo-sync-demo',
      { preflightWasFree: true }
    );
    expect(internalIntegration.associateSystemEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(postman.findEnvironmentByName).not.toHaveBeenCalled();
    expect(postman.createMock).not.toHaveBeenCalled();
    expect(postman.findMockByCollection).not.toHaveBeenCalled();
    expect(postman.createMonitor).not.toHaveBeenCalled();
    expect(postman.findMonitorByCollection).not.toHaveBeenCalled();
    expect(postman.runMonitor).not.toHaveBeenCalled();
    expect(postman.getCollection).not.toHaveBeenCalled();
    expect(postman.getEnvironment).not.toHaveBeenCalled();
    expect(existsSync('postman')).toBe(false);
    expect(existsSync('.github/workflows/ci.yml')).toBe(false);
    expect(readFileSync('.github/workflows/provision.yml', 'utf8')).toBe('name: Existing Provision\n');

    const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
    expect(resources).toEqual({
      version: 2,
      workspace: { id: 'ws-123' },
      canonical: {
        collections: { '../postman/collections/existing': 'col-existing' },
        environments: {
          '../postman/environments/prod.postman_environment.json': 'env-existing'
        },
        specs: {
          '../existing.yaml': 'spec-existing',
          '../openapi.yaml': 'spec-new'
        }
      }
    });
    expect(repoMutation.commitAndPush).toHaveBeenCalledWith(
      expect.objectContaining({ stagePaths: ['.postman/resources.yaml'], removePaths: [] })
    );
  });

  it('refresh reruns keep the same tracked collection ids in .postman/resources.yaml', async () => {
    const postman = {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi
        .fn()
        .mockResolvedValueOnce(createCollectionFixture('core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Smoke] core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Contract] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
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
      deleteMonitor: vi.fn().mockResolvedValue(undefined)
    };

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        collectionSyncMode: 'refresh',
        baselineCollectionId: 'col-baseline-existing',
        smokeCollectionId: 'col-smoke-existing',
        contractCollectionId: 'col-contract-existing'
      }),
      {
        core: createCoreStub().core,
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
          commitAndPush: vi.fn().mockResolvedValue({
            commitSha: '',
            pushed: false,
            resolvedCurrentRef: 'feature/repo-sync'
          })
        } as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
      }
    );

    const resourcesYaml = loadYaml(
      readFileSync('.postman/resources.yaml', 'utf8')
    ) as ResourcesYamlShape;

    expect(resourcesYaml.canonical?.collections).toEqual({
      '../postman/collections/core-payments': 'col-baseline-existing',
      '../postman/collections/[Smoke] core-payments': 'col-smoke-existing',
      '../postman/collections/[Contract] core-payments': 'col-contract-existing'
    });
  });

  it('skips writing a CI workflow when generation is disabled', async () => {
    const postman = {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi.fn().mockResolvedValue(createCollectionFixture('[Smoke] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
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
      deleteMonitor: vi.fn().mockResolvedValue(undefined)
    };
    const repoMutation = {
      commitAndPush: vi.fn().mockResolvedValue({
        commitSha: '',
        pushed: false,
        resolvedCurrentRef: 'feature/repo-sync'
      })
    };

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        ciWorkflowPath: '.github/workflows/postman-sync.yml'
      }),
      {
        core: createCoreStub().core,
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
        repoMutation: repoMutation as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
      }
    );

    expect(existsSync('.github/workflows/ci.yml')).toBe(false);
    expect(existsSync('.github/workflows/postman-sync.yml')).toBe(false);
    expect(repoMutation.commitAndPush).toHaveBeenCalledWith(
      expect.objectContaining({
        stagePaths: expect.arrayContaining(['postman', '.postman'])
      })
    );

    const callArgs = repoMutation.commitAndPush.mock.calls[0][0];
    expect(callArgs.stagePaths).not.toContain('.github/workflows');
    expect(callArgs.stagePaths).not.toContain('.github/workflows/provision.yml');
  });

  it('skips repo mutation instead of falling back to staging the repository root when no generated paths exist', async () => {
    const { core, infos } = createCoreStub();
    const repoMutation = {
      commitAndPush: vi.fn()
    };

    const result = await runRepoSync(
      createInputs({
        workspaceId: '',
        baselineCollectionId: '',
        smokeCollectionId: '',
        contractCollectionId: '',
        environments: [],
        workspaceLinkEnabled: false,
        environmentSyncEnabled: false,
        generateCiWorkflow: false
      }),
      {
        core,
        postman: {} as unknown as RepoSyncDependencies['postman'],
        repoMutation: repoMutation as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
      }
    );

    expect(repoMutation.commitAndPush).not.toHaveBeenCalled();
    expect(infos).toContain('No generated repository paths were found; skipping repo mutation.');
    expect(result).toMatchObject({
      'commit-sha': '',
      'resolved-current-ref': 'feature/repo-sync'
    });
  });

  it('delegates provision workflow removal without deleting it before repo mutation preflight', async () => {
    mkdirSync('.github/workflows', { recursive: true });
    writeFileSync('.github/workflows/provision.yml', 'name: Provision\n');
    const repoMutation = {
      commitAndPush: vi.fn(async (options: { removePaths?: string[] }) => {
        expect(existsSync('.github/workflows/provision.yml')).toBe(true);
        expect(options.removePaths).toEqual(['.github/workflows/provision.yml']);
        throw new Error('No push token configured for repo-write-mode=commit-and-push');
      })
    };

    await expect(
      runRepoSync(
        createInputs({
          workspaceId: '',
          baselineCollectionId: '',
          smokeCollectionId: '',
          contractCollectionId: '',
          environments: [],
          workspaceLinkEnabled: false,
          environmentSyncEnabled: false,
          generateCiWorkflow: false,
          githubToken: '',
          ghFallbackToken: ''
        }),
        {
          core: createCoreStub().core,
          postman: {} as RepoSyncDependencies['postman'],
          repoMutation: repoMutation as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
        }
      )
    ).rejects.toThrow(/No push token configured/);

    expect(existsSync('.github/workflows/provision.yml')).toBe(true);
  });

  it('writes the requested CI workflow for repo-write-mode=none without calling repo mutation', async () => {
    const postman = {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi.fn().mockResolvedValue(createCollectionFixture('[Smoke] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
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
      deleteMonitor: vi.fn().mockResolvedValue(undefined)
    };
    const repoMutation = {
      commitAndPush: vi.fn()
    };

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        repoWriteMode: 'none',
        generateCiWorkflow: true,
        ciWorkflowPath: '.github/workflows/ci.yml'
      }),
      {
        core: createCoreStub().core,
        postman: postman as unknown as RepoSyncDependencies['postman'],
        github: {
          getRepositoryVariable: vi.fn().mockResolvedValue(''),
          setRepositoryVariable: vi.fn().mockResolvedValue(undefined)
        },
        internalIntegration: {
          associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: repoMutation as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
      }
    );

    expect(existsSync('.github/workflows/ci.yml')).toBe(true);
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).toContain('name: Resolve Postman Resource IDs');
    expect(repoMutation.commitAndPush).not.toHaveBeenCalled();
  });

  it('rejects unsafe CI workflow paths in repo-write-mode=none before writing', async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), 'repo-sync-ci-outside-'));
    const missingOutsideParentName = `repo-sync-ci-missing-parent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const missingOutsideParent = join(tmpdir(), missingOutsideParentName);
    const missingOutsideFile = join(missingOutsideParent, 'nested', 'escaped-ci.yml');
    symlinkSync(outsideRoot, '.workflow-link', 'dir');
    const invalidPaths = [
      '../escaped-ci.yml',
      `../${missingOutsideParentName}/nested/escaped-ci.yml`,
      join(outsideRoot, 'absolute-ci.yml'),
      '.workflow-link/symlink-ci.yml'
    ];

    try {
      for (const ciWorkflowPath of invalidPaths) {
        await expect(
          runRepoSync(
            createInputs({
              workspaceId: '',
              baselineCollectionId: '',
              smokeCollectionId: '',
              contractCollectionId: '',
              environments: [],
              workspaceLinkEnabled: false,
              environmentSyncEnabled: false,
              repoWriteMode: 'none',
              generateCiWorkflow: true,
              ciWorkflowPath
            }),
            {
              core: createCoreStub().core,
              postman: {} as RepoSyncDependencies['postman']
            }
          )
        ).rejects.toThrow(/ci-workflow-path must stay within the repository root/);
      }

      expect(existsSync(join(outsideRoot, 'absolute-ci.yml'))).toBe(false);
      expect(existsSync(join(outsideRoot, 'symlink-ci.yml'))).toBe(false);
      expect(existsSync(missingOutsideParent)).toBe(false);
      expect(existsSync(missingOutsideFile)).toBe(false);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
      rmSync(missingOutsideParent, { recursive: true, force: true });
    }
  });

  it('writes the generated CI workflow to a custom path when configured', async () => {
    const postman = {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi.fn().mockResolvedValue(createCollectionFixture('[Smoke] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
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
      deleteMonitor: vi.fn().mockResolvedValue(undefined)
    };

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        ciWorkflowPath: '.github/workflows/postman-sync.yml'
      }),
      {
        core: createCoreStub().core,
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
          commitAndPush: vi.fn().mockResolvedValue({
            commitSha: '',
            pushed: false,
            resolvedCurrentRef: 'feature/repo-sync'
          })
        } as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
      }
    );

    expect(existsSync('.github/workflows/ci.yml')).toBe(false);
    expect(readFileSync('.github/workflows/postman-sync.yml', 'utf8')).toContain(
      'name: CI/CD Pipeline'
    );
  });

  it('derives release-labeled collection directories from full branch refs', async () => {
    const postman = {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi
        .fn()
        .mockResolvedValueOnce(createCollectionFixture('core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Smoke] core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Contract] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
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
      deleteMonitor: vi.fn().mockResolvedValue(undefined)
    };

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        collectionSyncMode: 'version',
        currentRef: 'refs/heads/release/customer-onboarding',
        githubRefName: 'customer-onboarding'
      }),
      {
        core: createCoreStub().core,
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
          commitAndPush: vi.fn().mockResolvedValue({
            commitSha: '',
            pushed: false,
            resolvedCurrentRef: 'feature/repo-sync'
          })
        } as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
      }
    );

    expect(
      existsSync(
        'postman/collections/core-payments release-customer-onboarding/.resources/definition.yaml'
      )
    ).toBe(true);
    expect(
      existsSync(
        'postman/collections/[Smoke] core-payments release-customer-onboarding/.resources/definition.yaml'
      )
    ).toBe(true);
    expect(
      existsSync(
        'postman/collections/[Contract] core-payments release-customer-onboarding/.resources/definition.yaml'
      )
    ).toBe(true);
  });

});

describe('state ownership persistence', () => {
  let originalCwd = '';
  let testDir = '';

  function makePostman() {
    return {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi
        .fn()
        .mockResolvedValueOnce(createCollectionFixture('core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Smoke] core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Contract] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
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
      deleteMonitor: vi.fn().mockResolvedValue(undefined)
    };
  }

  function makeRepoMutation() {
    return {
      commitAndPush: vi.fn().mockResolvedValue({
        commitSha: '',
        pushed: false,
        resolvedCurrentRef: 'feature/repo-sync'
      })
    } as unknown as Parameters<typeof runRepoSync>[1]['repoMutation'];
  }

  function seedLocalSpec(relativePath = 'openapi.yaml'): void {
    writeFileSync(
      relativePath,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Payments', version: '1.0.0' },
        paths: {}
      })
    );
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'repo-sync-state-ownership-'));
    process.chdir(testDir);
    process.env.GITHUB_REPOSITORY = 'postman-cs/repo-sync-demo';
    process.env.GITHUB_REF_NAME = 'feature/repo-sync';
    delete process.env.GITHUB_HEAD_REF;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_HEAD_REF;
  });

  it('writes workspace.id when workspace linking succeeds', async () => {
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false
      }),
      {
        core: createCoreStub().core,
        postman: makePostman(),
        internalIntegration: {
          associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      }
    );

    const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
    expect(result['workspace-link-status']).toBe('success');
    expect(resources.workspace?.id).toBe('ws-123');
  });

  it('tags the canonical spec only after successful repo-link finalization', async () => {
    const postman = { ...makePostman(), tagSpecVersion: vi.fn().mockResolvedValue({ id: 'tag-1', name: 'abc1234' }) };
    process.env.POSTMAN_BRANCH_DECISION = JSON.stringify({
      tier: 'canonical', strategy: 'publish-gate', canonicalBranch: 'main', reason: 'test',
      identity: { provider: 'github', headBranch: 'main', headSha: 'abc123456789', refKind: 'default-branch', isPrContext: false, isForkPr: false }
    });
    try {
      const result = await runRepoSync(createInputs({
        branchStrategy: 'publish-gate', specId: 'spec-1', environments: [], generateCiWorkflow: false
      }), {
        core: createCoreStub().core,
        postman,
        internalIntegration: {
          associateSystemEnvironments: vi.fn(),
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      });
      expect(postman.tagSpecVersion).toHaveBeenCalledWith('spec-1', 'abc1234');
      expect(result['spec-version-tag']).toBe('abc1234');
    } finally {
      delete process.env.POSTMAN_BRANCH_DECISION;
    }
  });

  it('skips canonical tagging when spec content did not change', async () => {
    const postman = { ...makePostman(), tagSpecVersion: vi.fn() };
    process.env.POSTMAN_BRANCH_DECISION = JSON.stringify({
      tier: 'canonical', strategy: 'publish-gate', canonicalBranch: 'main', reason: 'test',
      identity: { provider: 'github', headBranch: 'main', headSha: 'abc123456789', refKind: 'default-branch', isPrContext: false, isForkPr: false }
    });
    try {
      await runRepoSync(createInputs({
        branchStrategy: 'publish-gate', specId: 'spec-1', specContentChanged: false,
        environments: [], generateCiWorkflow: false
      }), {
        core: createCoreStub().core,
        postman,
        internalIntegration: {
          associateSystemEnvironments: vi.fn(),
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      });
      expect(postman.tagSpecVersion).not.toHaveBeenCalled();
    } finally {
      delete process.env.POSTMAN_BRANCH_DECISION;
    }
  });

  it('does not tag canonical spec when repo-link finalization fails', async () => {
    const postman = { ...makePostman(), tagSpecVersion: vi.fn() };
    process.env.POSTMAN_BRANCH_DECISION = JSON.stringify({
      tier: 'canonical', strategy: 'publish-gate', canonicalBranch: 'main', reason: 'test',
      identity: { provider: 'github', headBranch: 'main', headSha: 'abc123456789', refKind: 'default-branch', isPrContext: false, isForkPr: false }
    });
    try {
      await expect(runRepoSync(createInputs({
        branchStrategy: 'publish-gate', specId: 'spec-1', environments: [], generateCiWorkflow: false
      }), {
        core: createCoreStub().core,
        postman,
        internalIntegration: {
          associateSystemEnvironments: vi.fn(),
          connectWorkspaceToRepository: vi.fn().mockRejectedValue(new Error('link denied')),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      })).rejects.toThrow('Workspace link failed: link denied');
      expect(postman.tagSpecVersion).not.toHaveBeenCalled();
    } finally {
      delete process.env.POSTMAN_BRANCH_DECISION;
    }
  });

  it('warns on Spec Hub tag 409 confirmed nonmatching/hand-applied tag without failing the run', async () => {
    const conflict = Object.assign(new Error('tag already exists'), { status: 409 });
    const postman = {
      ...makePostman(),
      tagSpecVersion: vi.fn().mockRejectedValue(conflict),
      listSpecVersionTags: vi.fn().mockResolvedValue([{ id: 'hand-1', name: 'manual-tag' }])
    };
    process.env.POSTMAN_BRANCH_DECISION = JSON.stringify({
      tier: 'canonical', strategy: 'publish-gate', canonicalBranch: 'main', reason: 'test',
      identity: { provider: 'github', headBranch: 'main', headSha: 'abc123456789', refKind: 'default-branch', isPrContext: false, isForkPr: false }
    });
    const { core, warnings } = createCoreStub();
    try {
      const result = await runRepoSync(createInputs({
        branchStrategy: 'publish-gate', specId: 'spec-1', environments: [], generateCiWorkflow: false
      }), {
        core,
        postman,
        internalIntegration: {
          associateSystemEnvironments: vi.fn(),
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      });
      expect(result['spec-version-tag']).toBe('');
      expect(result['spec-version-url']).toBe('');
      const conflictWarning = warnings.find((line) => line.includes('Spec Hub tagging conflict'));
      expect(conflictWarning).toBeDefined();
      expect(conflictWarning).toContain('spec spec-1');
      expect(conflictWarning).toContain('tag "abc1234"');
      expect(conflictWarning).toContain('workspace ws-123');
      expect(conflictWarning).toContain('tag already exists');
      expect(conflictWarning).toContain('hand-applied or nonmatching tag');
      expect(conflictWarning).toContain('inspect existing tags/access and rerun');
      expect(conflictWarning).not.toContain('listSpecVersionTags=');
    } finally {
      delete process.env.POSTMAN_BRANCH_DECISION;
    }
  });

  it('warns on Spec Hub 409 when listSpecVersionTags fails and preserves create plus lookup causes', async () => {
    const conflict = Object.assign(new Error('tag already exists'), { status: 409 });
    const postman = {
      ...makePostman(),
      tagSpecVersion: vi.fn().mockRejectedValue(conflict),
      listSpecVersionTags: vi.fn().mockRejectedValue(new Error('list tags denied'))
    };
    process.env.POSTMAN_BRANCH_DECISION = JSON.stringify({
      tier: 'canonical', strategy: 'publish-gate', canonicalBranch: 'main', reason: 'test',
      identity: { provider: 'github', headBranch: 'main', headSha: 'abc123456789', refKind: 'default-branch', isPrContext: false, isForkPr: false }
    });
    const { core, warnings } = createCoreStub();
    try {
      const result = await runRepoSync(createInputs({
        branchStrategy: 'publish-gate', specId: 'spec-1', environments: [], generateCiWorkflow: false
      }), {
        core,
        postman,
        internalIntegration: {
          associateSystemEnvironments: vi.fn(),
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      });
      expect(result['spec-version-tag']).toBe('');
      expect(result['spec-version-url']).toBe('');
      const conflictWarning = warnings.find((line) => line.includes('Spec Hub tagging conflict'));
      expect(conflictWarning).toBeDefined();
      expect(conflictWarning).toContain('spec spec-1');
      expect(conflictWarning).toContain('tag "abc1234"');
      expect(conflictWarning).toContain('workspace ws-123');
      expect(conflictWarning).toContain('create=tag already exists');
      expect(conflictWarning).toContain('listSpecVersionTags=list tags denied');
      expect(conflictWarning).toContain('could not list existing tags to confirm adoption');
      expect(conflictWarning).toContain('inspect existing tags/access and rerun');
      expect(conflictWarning).not.toContain('hand-applied');
    } finally {
      delete process.env.POSTMAN_BRANCH_DECISION;
    }
  });

  it('warns on Spec Hub non-409 tagging failure without failing the run', async () => {
    const postman = {
      ...makePostman(),
      tagSpecVersion: vi.fn().mockRejectedValue(new Error('tagging denied'))
    };
    process.env.POSTMAN_BRANCH_DECISION = JSON.stringify({
      tier: 'canonical', strategy: 'publish-gate', canonicalBranch: 'main', reason: 'test',
      identity: { provider: 'github', headBranch: 'main', headSha: 'abc123456789', refKind: 'default-branch', isPrContext: false, isForkPr: false }
    });
    const { core, warnings } = createCoreStub();
    try {
      const result = await runRepoSync(createInputs({
        branchStrategy: 'publish-gate', specId: 'spec-1', environments: [], generateCiWorkflow: false
      }), {
        core,
        postman,
        internalIntegration: {
          associateSystemEnvironments: vi.fn(),
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      });
      expect(result['workspace-link-status']).toBe('success');
      expect(result['spec-version-tag']).toBe('');
      const failureWarning = warnings.find((line) => line.includes('Spec version tagging'));
      expect(failureWarning).toBeDefined();
      expect(failureWarning).toContain('spec spec-1');
      expect(failureWarning).toContain('tag "abc1234"');
      expect(failureWarning).toContain('workspace ws-123');
      expect(failureWarning).toContain('tagging denied');
      expect(failureWarning).toContain('non-fatal');
      expect(failureWarning).toContain('inspect existing tags/access and rerun');
    } finally {
      delete process.env.POSTMAN_BRANCH_DECISION;
    }
  });

  it('warns when system-env-map-json is empty so Catalog filters do not look like a missing link', async () => {
    const { core, warnings, infos } = createCoreStub();
    const associateSystemEnvironments = vi.fn().mockResolvedValue(undefined);
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: true,
        systemEnvMap: {}
      }),
      {
        core,
        postman: makePostman(),
        internalIntegration: {
          associateSystemEnvironments,
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      }
    );

    expect(result['environment-sync-status']).toBe('skipped');
    expect(result['workspace-link-status']).toBe('success');
    expect(associateSystemEnvironments).not.toHaveBeenCalled();
    expect(warnings.some((message) => message.includes('system-env-map-json is empty'))).toBe(
      true
    );
    expect(
      warnings.some((message) => message.includes('Catalog system-environment filters'))
    ).toBe(true);
    expect(
      infos.some((message) =>
        message.includes('workspace-link-status=success workspace-id=ws-123')
      )
    ).toBe(true);
  });

  it('warns when system-env-map-json keys do not match synced environments', async () => {
    const { core, warnings } = createCoreStub();
    const associateSystemEnvironments = vi.fn().mockResolvedValue(undefined);
    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: true,
        systemEnvMap: { staging: 'sys-staging' }
      }),
      {
        core,
        postman: makePostman(),
        internalIntegration: {
          associateSystemEnvironments,
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      }
    );

    expect(associateSystemEnvironments).not.toHaveBeenCalled();
    expect(
      warnings.some(
        (message) =>
          message.includes('system-env-map-json keys (staging)') &&
          message.includes('did not match any synced environment (prod)')
      )
    ).toBe(true);
  });

  it('surfaces environment create failure with operation, entity, cause, and remediation', async () => {
    const postman = {
      ...makePostman(),
      createEnvironment: vi.fn().mockRejectedValue(new Error('env create denied'))
    };
    await expect(
      runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          environmentSyncEnabled: false,
          workspaceLinkEnabled: false
        }),
        {
          core: createCoreStub().core,
          postman,
          repoMutation: makeRepoMutation()
        }
      )
    ).rejects.toThrow(
      /Environment create failed for workspace ws-123 environment "core-payments - prod": env create denied\. verify access-token\/team\/workspace permissions then rerun/
    );
    expect(postman.createEnvironment).toHaveBeenCalled();
  });

  it('publishes each successful environment UID before a later create fails', async () => {
    const { core, outputs } = createCoreStub();
    const postman = {
      ...makePostman(),
      createEnvironment: vi.fn().mockResolvedValueOnce('env-prod-owned').mockRejectedValueOnce(new Error('stage create denied'))
    };
    await expect(runRepoSync(createInputs({
      environments: ['prod', 'stage'],
      generateCiWorkflow: false,
      environmentSyncEnabled: false,
      workspaceLinkEnabled: false
    }), { core, postman, repoMutation: makeRepoMutation() })).rejects.toThrow(/stage create denied/);
    expect(JSON.parse(outputs['environment-uids-json'] ?? '{}')).toEqual({ prod: 'env-prod-owned' });
  });

  it('publishes a successfully updated environment UID before a later create fails', async () => {
    const { core, outputs } = createCoreStub();
    const postman = {
      ...makePostman(),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      createEnvironment: vi.fn().mockRejectedValue(new Error('stage create denied'))
    };
    await expect(runRepoSync(createInputs({
      environments: ['prod', 'stage'],
      environmentUids: { prod: 'env-prod-existing' },
      generateCiWorkflow: false,
      environmentSyncEnabled: false,
      workspaceLinkEnabled: false
    }), { core, postman, repoMutation: makeRepoMutation() })).rejects.toThrow(/stage create denied/);
    expect(postman.updateEnvironment).toHaveBeenCalledWith('env-prod-existing', 'core-payments - prod', expect.any(Array));
    expect(JSON.parse(outputs['environment-uids-json'] ?? '{}')).toEqual({ prod: 'env-prod-existing' });
  });

  it('surfaces environment discovery failure with operation, entity, cause, and remediation', async () => {
    const postman = {
      ...makePostman(),
      findEnvironmentByName: vi.fn().mockRejectedValue(new Error('env discovery denied')),
      createEnvironment: vi.fn(),
      updateEnvironment: vi.fn()
    };
    await expect(
      runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          environmentSyncEnabled: false,
          workspaceLinkEnabled: false
        }),
        {
          core: createCoreStub().core,
          postman,
          repoMutation: makeRepoMutation()
        }
      )
    ).rejects.toThrow(
      /Environment discovery failed for workspace ws-123 environment "core-payments - prod": env discovery denied\. verify access-token\/team\/workspace permissions then rerun/
    );
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
  });

  it('surfaces environment update failure with operation, entity, cause, and remediation', async () => {
    const postman = {
      ...makePostman(),
      updateEnvironment: vi.fn().mockRejectedValue(new Error('env update denied')),
      createEnvironment: vi.fn()
    };
    await expect(
      runRepoSync(
        createInputs({
          environments: ['prod'],
          environmentUids: { prod: 'env-existing' },
          generateCiWorkflow: false,
          environmentSyncEnabled: false,
          workspaceLinkEnabled: false
        }),
        {
          core: createCoreStub().core,
          postman,
          repoMutation: makeRepoMutation()
        }
      )
    ).rejects.toThrow(
      /Environment update failed for workspace ws-123 environment "core-payments - prod" \(uid env-existing\): env update denied\. verify access-token\/team\/workspace permissions then rerun/
    );
    expect(postman.updateEnvironment).toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
  });

  it('keeps association failure non-fatal with workspace/association context and failed sync status', async () => {
    const { core, warnings } = createCoreStub();
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: true,
        systemEnvMap: { prod: 'sys-prod' }
      }),
      {
        core,
        postman: makePostman(),
        internalIntegration: {
          associateSystemEnvironments: vi.fn().mockRejectedValue(new Error('assoc denied')),
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      }
    );

    expect(result['environment-sync-status']).toBe('failed');
    expect(result['workspace-link-status']).toBe('success');
    const associationWarning = warnings.find((line) =>
      line.includes('System environment association failed')
    );
    expect(associationWarning).toBeDefined();
    expect(associationWarning).toContain('workspace ws-123');
    expect(associationWarning).toContain('env-prod->sys-prod');
    expect(associationWarning).toContain('assoc denied');
    expect(associationWarning).toContain('verify access-token/team/system-env mapping then rerun');
  });

  it('masks synthetic secrets from injected secretMasker in orchestration failures', async () => {
    const secret = 'super-secret-token-xyz';
    const postman = {
      ...makePostman(),
      createEnvironment: vi.fn().mockRejectedValue(new Error(`denied with ${secret}`))
    };
    await expect(
      runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          environmentSyncEnabled: false,
          workspaceLinkEnabled: false
        }),
        {
          core: createCoreStub().core,
          postman,
          repoMutation: makeRepoMutation(),
          secretMasker: createSecretMasker([secret])
        }
      )
    ).rejects.toThrow(
      new RegExp(
        `Environment create failed for workspace ws-123 environment "core-payments - prod": denied with ${REDACTED.replace(/[[\]]/g, '\\$&')}\\. verify access-token/team/workspace permissions then rerun`
      )
    );
  });

  it('keeps throw-path orchestration diagnostics one-line under CR/LF-bearing entity and cause with secrets', async () => {
    const secret = 'crlf-throw-secret-xyz';
    const postman = {
      ...makePostman(),
      createEnvironment: vi
        .fn()
        .mockRejectedValue(new Error(`denied\r\nwith ${secret}\nand forged log line`))
    };
    let thrown: unknown;
    try {
      await runRepoSync(
        createInputs({
          workspaceId: 'ws-123\r\ninjected',
          projectName: 'core\npayments',
          environments: ['prod'],
          generateCiWorkflow: false,
          environmentSyncEnabled: false,
          workspaceLinkEnabled: false
        }),
        {
          core: createCoreStub().core,
          postman,
          repoMutation: makeRepoMutation(),
          secretMasker: createSecretMasker([secret])
        }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('Environment create failed');
    expect(message).toContain('ws-123 injected');
    expect(message).toContain('core payments - prod');
    expect(message).toContain('denied with');
    expect(message).toContain('forged log line');
    expect(message).toContain('verify access-token/team/workspace permissions then rerun');
    expect(message).toContain(REDACTED);
    expect(message).not.toContain(secret);
    expect(message).not.toContain('\n');
    expect(message).not.toContain('\r');
    expect(postman.createEnvironment).toHaveBeenCalled();
  });

  it('keeps non-fatal association diagnostics one-line under CR/LF-bearing cause with secrets', async () => {
    const secret = 'crlf-warn-secret-xyz';
    const { core, warnings } = createCoreStub();
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: true,
        systemEnvMap: { prod: 'sys-prod' }
      }),
      {
        core,
        postman: makePostman(),
        internalIntegration: {
          associateSystemEnvironments: vi
            .fn()
            .mockRejectedValue(new Error(`assoc\r\ndenied ${secret}\nnext-line`)),
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation(),
        secretMasker: createSecretMasker([secret])
      }
    );

    expect(result['environment-sync-status']).toBe('failed');
    expect(result['workspace-link-status']).toBe('success');
    const associationWarning = warnings.find((line) =>
      line.includes('System environment association failed')
    );
    expect(associationWarning).toBeDefined();
    expect(associationWarning).toContain('workspace ws-123');
    expect(associationWarning).toContain('assoc denied');
    expect(associationWarning).toContain('next-line');
    expect(associationWarning).toContain('verify access-token/team/system-env mapping then rerun');
    expect(associationWarning).toContain(REDACTED);
    expect(associationWarning).not.toContain(secret);
    expect(associationWarning).not.toContain('\n');
    expect(associationWarning).not.toContain('\r');
  });

  it('omits workspace.id on failed link with no prior durable id while still writing artifact maps', async () => {
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false
      }),
      {
        core: createCoreStub().core,
        postman: makePostman(),
        internalIntegration: {
          associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
          connectWorkspaceToRepository: vi.fn().mockRejectedValue(new Error('link denied')),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      }
    );

    const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
    expect(result['workspace-link-status']).toBe('failed');
    expect(resources.workspace?.id).toBeUndefined();
    expect(resources.canonical?.collections).toMatchObject({
      '../postman/collections/core-payments': 'col-baseline',
      '../postman/collections/[Smoke] core-payments': 'col-smoke',
      '../postman/collections/[Contract] core-payments': 'col-contract'
    });
    expect(resources.canonical?.environments).toMatchObject({
      '../postman/environments/prod.postman_environment.json': 'env-prod'
    });
  });

  it('omits a new workspace.id when linking is enabled but cannot run', async () => {
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false
      }),
      {
        core: createCoreStub().core,
        postman: makePostman(),
        repoMutation: makeRepoMutation()
      }
    );

    const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
    expect(result['workspace-link-status']).toBe('skipped');
    expect(resources.workspace?.id).toBeUndefined();
  });

  it('preserves the same prior durable workspace.id when linking fails', async () => {
    mkdirSync('.postman', { recursive: true });
    writeFileSync(
      '.postman/resources.yaml',
      `workspace:\n  id: ws-123\ncloudResources:\n  collections:\n    ../postman/collections/core-payments: col-baseline\n`
    );

    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false
      }),
      {
        core: createCoreStub().core,
        postman: makePostman(),
        internalIntegration: {
          associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
          connectWorkspaceToRepository: vi.fn().mockRejectedValue(new Error('link denied')),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      }
    );

    const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
    expect(result['workspace-link-status']).toBe('failed');
    expect(resources.workspace?.id).toBe('ws-123');
  });

  it('does not pair a different prior workspace.id with candidate resource mappings after link failure', async () => {
    mkdirSync('.postman', { recursive: true });
    writeFileSync('.postman/resources.yaml', 'workspace:\n  id: ws-prior\n');

    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false
      }),
      {
        core: createCoreStub().core,
        postman: makePostman(),
        internalIntegration: {
          associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
          connectWorkspaceToRepository: vi.fn().mockRejectedValue(new Error('link denied')),
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      }
    );

    const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
    expect(result['workspace-link-status']).toBe('failed');
    expect(resources.workspace?.id).toBeUndefined();
    expect(resources.canonical?.collections).toMatchObject({
      '../postman/collections/core-payments': 'col-baseline'
    });
  });

  it('persists workspace.id when workspace linking is explicitly disabled', async () => {
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false,
        workspaceLinkEnabled: false
      }),
      {
        core: createCoreStub().core,
        postman: makePostman(),
        repoMutation: makeRepoMutation()
      }
    );

    const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
    expect(result['workspace-link-status']).toBe('skipped');
    expect(resources.workspace?.id).toBe('ws-123');
  });

  it('preserves an existing versioned spec map entry across export', async () => {
    seedLocalSpec();
    mkdirSync('.postman', { recursive: true });
    writeFileSync(
      '.postman/resources.yaml',
      `workspace:\n  id: ws-123\ncloudResources:\n  specs:\n    ../openapi.yaml#release=v1: spec-v1\n`
    );

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false,
        workspaceLinkEnabled: false,
        specId: ''
      }),
      {
        core: createCoreStub().core,
        postman: makePostman(),
        repoMutation: makeRepoMutation()
      }
    );

    const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
    expect(resources.canonical?.specs).toMatchObject({
      '../openapi.yaml#release=v1': 'spec-v1'
    });
  });

  it('writes a release-scoped mapped spec key in version mode and a bare key in update mode', async () => {
    seedLocalSpec();

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false,
        workspaceLinkEnabled: false,
        specSyncMode: 'version',
        releaseLabel: 'v2',
        specId: 'spec-v2'
      }),
      {
        core: createCoreStub().core,
        postman: makePostman(),
        repoMutation: makeRepoMutation()
      }
    );

    let resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
    expect(resources.canonical?.specs).toMatchObject({
      '../openapi.yaml#release=v2': 'spec-v2'
    });
    expect(resources.canonical?.specs?.['../openapi.yaml']).toBeUndefined();

    rmSync('postman', { recursive: true, force: true });
    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false,
        workspaceLinkEnabled: false,
        specSyncMode: 'update',
        specId: 'spec-update'
      }),
      {
        core: createCoreStub().core,
        postman: makePostman(),
        repoMutation: makeRepoMutation()
      }
    );

    resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
    expect(resources.canonical?.specs).toMatchObject({
      '../openapi.yaml': 'spec-update'
    });
  });

  it('does not discard different source/spec entries when adding a mapped spec', async () => {
    seedLocalSpec();
    mkdirSync('.postman', { recursive: true });
    writeFileSync(
      '.postman/resources.yaml',
      `workspace:\n  id: ws-123\ncloudResources:\n  specs:\n    ../other.yaml: spec-other\n    ../openapi.yaml#release=v1: spec-v1\n`
    );

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false,
        workspaceLinkEnabled: false,
        specSyncMode: 'update',
        specId: 'spec-current'
      }),
      {
        core: createCoreStub().core,
        postman: makePostman(),
        repoMutation: makeRepoMutation()
      }
    );

    const resources = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesYamlShape;
    expect(resources.canonical?.specs).toEqual({
      '../other.yaml': 'spec-other',
      '../openapi.yaml#release=v1': 'spec-v1',
      '../openapi.yaml': 'spec-current'
    });
  });
});

describe('monitor resolution paths', () => {
  let originalCwd = '';
  let testDir = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'repo-sync-monitor-'));
    process.chdir(testDir);
    process.env.GITHUB_REPOSITORY = 'postman-cs/repo-sync-demo';
    process.env.GITHUB_REF_NAME = 'feature/repo-sync';
    delete process.env.GITHUB_HEAD_REF;
    __resetIdentityMemo();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_HEAD_REF;
    __resetIdentityMemo();
  });

  function makePostman(overrides: Record<string, unknown> = {}) {
    return {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-new'),
      getCollection: vi.fn().mockResolvedValue(createCollectionFixture('[Smoke] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
      listMonitors: vi.fn().mockResolvedValue([]),
      listMocks: vi.fn().mockResolvedValue([]),
      monitorExists: vi.fn().mockResolvedValue(false),
      mockExists: vi.fn().mockResolvedValue(false),
      findMonitorByCollection: vi.fn().mockResolvedValue(null),
      rebindMonitorByName: vi.fn().mockResolvedValue(null),
      findMockByCollection: vi.fn().mockResolvedValue(null),
      configurePrivateMockRuntimeAuth: vi.fn().mockResolvedValue(0),
      runMonitor: vi.fn().mockResolvedValue(undefined),
      listEnvironments: vi.fn().mockResolvedValue([]),
      deleteEnvironment: vi.fn().mockResolvedValue(undefined),
      deleteMock: vi.fn().mockResolvedValue(undefined),
      deleteMonitor: vi.fn().mockResolvedValue(undefined),
      ...overrides
    };
  }

  function makeGithub(vars: Record<string, string> = {}) {
    return {
      getRepositoryVariable: vi.fn().mockImplementation((name: string) =>
        Promise.resolve(vars[name] ?? '')
      ),
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined)
    };
  }

  function makeDeps(postman: RepoSyncDependencies['postman'], github: NonNullable<RepoSyncDependencies['github']>): RepoSyncDependencies { return {
    core: createCoreStub().core,
    postman,
    github,
    internalIntegration: {
      associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
      connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
      findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
    },
    repoMutation: {
      commitAndPush: vi.fn().mockResolvedValue({ commitSha: '', pushed: false, resolvedCurrentRef: 'main' })
    } as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
  }; }

  it('reuses explicit monitor-id when it exists in Postman', async () => {
    const postman = makePostman({ monitorExists: vi.fn().mockResolvedValue(true) });
    const github = makeGithub();
    await runRepoSync(createInputs({ environments: ['prod'], generateCiWorkflow: false, monitorId: 'explicit-mon' }), makeDeps(postman, github));
    
    expect(postman.createMonitor).not.toHaveBeenCalled();
    expect(postman.monitorExists).toHaveBeenCalledWith('explicit-mon');
  });

  it('falls through explicit monitor-id when it is stale (deleted)', async () => {
    const postman = makePostman({
      monitorExists: vi.fn().mockResolvedValue(false),
      findMonitorByCollection: vi.fn().mockResolvedValue(null)
    });
    const github = makeGithub();
    const { core, warnings } = createCoreStub();
    await runRepoSync(createInputs({ environments: ['prod'], generateCiWorkflow: false, monitorId: 'stale-mon' }), {
      ...makeDeps(postman, github),
      core
    });

    expect(postman.createMonitor).toHaveBeenCalled();
    const absent = warnings.find((line) => line.includes('Explicit monitor-id lookup'));
    expect(absent).toBeDefined();
    expect(absent).toContain('monitor-id stale-mon');
    expect(absent).toContain('workspace ws-123');
    expect(absent).toContain('collection col-smoke');
    expect(absent).toContain('environment env-prod');
    expect(absent).toContain('not found in Postman');
    expect(absent).toContain('falling through to discovery');
    expect(absent).toContain('verify monitor IDs/access or set monitor-cron then rerun');
  });

  it.each([
    new HttpError({
      method: 'GET', url: 'https://bifrost.example.com/ws/proxy', status: 403,
      statusText: 'Forbidden', responseBody: '{"error":{"message":"forbidden"}}'
    }),
    new HttpError({
      method: 'GET', url: 'https://bifrost.example.com/ws/proxy', status: 500,
      statusText: 'Internal Server Error', responseBody: '{"error":{"message":"server error"}}'
    })
  ])('stops before discovery, rebind, or creation when explicit monitor-id lookup is untrusted', async (error) => {
    const postman = makePostman({ monitorExists: vi.fn().mockRejectedValue(error) });
    const github = makeGithub();

    await expect(
      runRepoSync(
        createInputs({ environments: ['prod'], generateCiWorkflow: false, monitorId: 'explicit-mon' }),
        makeDeps(postman, github)
      )
    ).rejects.toBe(error);

    expect(postman.findMonitorByCollection).not.toHaveBeenCalled();
    expect(postman.rebindMonitorByName).not.toHaveBeenCalled();
    expect(postman.createMonitor).not.toHaveBeenCalled();
  });

  it('discovers existing monitor by smoke collection ID', async () => {
    const postman = makePostman({
      findMonitorByCollection: vi.fn().mockResolvedValue({ uid: 'discovered-mon', name: 'Smoke Monitor' })
    });
    const github = makeGithub();
    await runRepoSync(createInputs({ environments: ['prod'], generateCiWorkflow: false }), makeDeps(postman, github));
    
    expect(postman.createMonitor).not.toHaveBeenCalled();
    expect(postman.findMonitorByCollection).toHaveBeenCalledWith(
      'col-smoke',
      'env-prod',
      'core-payments - Smoke Monitor'
    );
  });

  it('rebinds a name-matched monitor after collection discovery misses', async () => {
    const postman = makePostman({
      findMonitorByCollection: vi.fn().mockResolvedValue(null),
      rebindMonitorByName: vi.fn().mockResolvedValue({
        uid: 'mon-replacement',
        previousUid: 'mon-existing',
        previousCollectionUid: 'col-old'
      })
    });
    const github = makeGithub();
    const { core, outputs } = createCoreStub();
    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        monitorType: 'cloud',
        monitorCron: ''
      }),
      { ...makeDeps(postman, github), core }
    );

    expect(postman.findMonitorByCollection).toHaveBeenCalledWith(
      'col-smoke',
      'env-prod',
      'core-payments - Smoke Monitor'
    );
    expect(postman.rebindMonitorByName).toHaveBeenCalledTimes(1);
    expect(postman.rebindMonitorByName).toHaveBeenCalledWith(
      'core-payments - Smoke Monitor',
      'col-smoke',
      'env-prod',
      undefined
    );
    expect(postman.createMonitor).not.toHaveBeenCalled();
    expect(outputs['monitor-id']).toBe('mon-replacement');
    expect(postman.runMonitor).toHaveBeenCalledTimes(1);
    expect(postman.runMonitor).toHaveBeenCalledWith('mon-replacement');
  });

  it('fails closed when replacement rebind fails', async () => {
    const postman = makePostman({
      findMonitorByCollection: vi.fn().mockResolvedValue(null),
      rebindMonitorByName: vi.fn().mockRejectedValue(new Error('parameterNotAllowedError'))
    });
    const github = makeGithub();
    await expect(
      runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          monitorType: 'cloud',
          monitorCron: ''
        }),
        makeDeps(postman, github)
      )
    ).rejects.toThrow(/Monitor rebind failed.*parameterNotAllowedError/);

    expect(postman.rebindMonitorByName).toHaveBeenCalledTimes(1);
    expect(postman.createMonitor).not.toHaveBeenCalled();
  });

  it('fails closed when the monitor rebind attempt is ambiguous', async () => {
    const { AmbiguousMonitorRebindError } = await import('../src/lib/postman/postman-gateway-assets-client.js');
    const postman = makePostman({
      findMonitorByCollection: vi.fn().mockResolvedValue(null),
      rebindMonitorByName: vi.fn().mockRejectedValue(new AmbiguousMonitorRebindError('ambiguous monitor rebind')),
      createMonitor: vi.fn()
    });
    const github = makeGithub();
    await expect(
      runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          monitorType: 'cloud',
          monitorCron: ''
        }),
        makeDeps(postman, github)
      )
    ).rejects.toThrow(
      /Monitor rebind failed for monitor "core-payments - Smoke Monitor" workspace ws-123 collection col-smoke environment env-prod: ambiguous monitor rebind\. verify monitor IDs\/access or set monitor-cron then rerun/
    );
    expect(postman.rebindMonitorByName).toHaveBeenCalledTimes(1);
    expect(postman.createMonitor).not.toHaveBeenCalled();
  });

  it('creates a new monitor when no existing asset is found', async () => {
    const postman = makePostman();
    const github = makeGithub();
    await runRepoSync(createInputs({ environments: ['prod'], generateCiWorkflow: false }), makeDeps(postman, github));
    
    expect(postman.createMonitor).toHaveBeenCalledWith(
      'ws-123',
      'core-payments - Smoke Monitor',
      'col-smoke',
      'env-prod',
      undefined
    );
  });

  it('triggers a one-time monitor run when monitor-cron is empty', async () => {
    const postman = makePostman();
    const github = makeGithub();
    await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false, monitorCron: '' }),
      makeDeps(postman, github)
    );

    expect(postman.runMonitor).toHaveBeenCalledTimes(1);
    expect(postman.runMonitor).toHaveBeenCalledWith('mon-new');
  });

  it('does not trigger a one-time monitor run when monitor-cron is provided', async () => {
    const postman = makePostman();
    const github = makeGithub();
    await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false, monitorCron: '0 */6 * * *' }),
      makeDeps(postman, github)
    );

    expect(postman.runMonitor).not.toHaveBeenCalled();
  });

  it('triggers a one-time run on a reused explicit monitor when cron is empty', async () => {
    const postman = makePostman({ monitorExists: vi.fn().mockResolvedValue(true) });
    const github = makeGithub();
    await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false, monitorId: 'explicit-mon', monitorCron: '' }),
      makeDeps(postman, github)
    );

    expect(postman.createMonitor).not.toHaveBeenCalled();
    expect(postman.runMonitor).toHaveBeenCalledWith('explicit-mon');
  });

  it('swallows runMonitor failures with a warning', async () => {
    const postman = makePostman({
      runMonitor: vi.fn().mockRejectedValue(new Error('boom')),
      listEnvironments: vi.fn().mockResolvedValue([]),
      deleteEnvironment: vi.fn().mockResolvedValue(undefined),
      deleteMock: vi.fn().mockResolvedValue(undefined),
      deleteMonitor: vi.fn().mockResolvedValue(undefined)
    });
    const github = makeGithub();
    const { core, warnings } = createCoreStub();
    await expect(
      runRepoSync(
        createInputs({ environments: ['prod'], generateCiWorkflow: false, monitorCron: '' }),
        { ...makeDeps(postman, github), core }
      )
    ).resolves.toBeDefined();
    const runWarning = warnings.find((line) => line.includes('Monitor one-time run'));
    expect(runWarning).toBeDefined();
    expect(runWarning).toContain('monitor mon-new');
    expect(runWarning).toContain('workspace ws-123');
    expect(runWarning).toContain('collection col-smoke');
    expect(runWarning).toContain('environment env-prod');
    expect(runWarning).toContain('boom');
    expect(runWarning).toContain('verify monitor IDs/access or set monitor-cron then rerun');
  });

  it('surfaces monitor create failure with operation, entity, cause, and remediation', async () => {
    const postman = makePostman({
      createMonitor: vi.fn().mockRejectedValue(new Error('monitor denied')),
      findMonitorByCollection: vi.fn().mockResolvedValue(null)
    });
    const github = makeGithub();
    const { core, outputs } = createCoreStub();
    await expect(
      runRepoSync(
        createInputs({ environments: ['prod'], generateCiWorkflow: false }),
        { ...makeDeps(postman, github), core }
      )
    ).rejects.toThrow(
      /Monitor create failed for monitor "core-payments - Smoke Monitor" workspace ws-123 collection col-smoke environment env-prod: monitor denied\. verify monitor IDs\/access or set monitor-cron then rerun/
    );
    expect(JSON.parse(outputs['environment-uids-json'] ?? '{}')).toEqual({ prod: 'env-prod' });
    expect(outputs['mock-url']).toBe('https://mock.pstmn.io');
  });

  it('surfaces monitor discovery failure with operation, entity, cause, and remediation', async () => {
    const postman = makePostman({
      findMonitorByCollection: vi.fn().mockRejectedValue(new Error('monitor discovery denied')),
      createMonitor: vi.fn()
    });
    const github = makeGithub();
    await expect(
      runRepoSync(
        createInputs({ environments: ['prod'], generateCiWorkflow: false }),
        makeDeps(postman, github)
      )
    ).rejects.toThrow(
      /Monitor discovery failed for monitor "core-payments - Smoke Monitor" workspace ws-123 collection col-smoke environment env-prod: monitor discovery denied\. verify monitor IDs\/access or set monitor-cron then rerun/
    );
    expect(postman.createMonitor).not.toHaveBeenCalled();
  });
});

describe('mock resolution paths', () => {
  let originalCwd = '';
  let testDir = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'repo-sync-mock-'));
    process.chdir(testDir);
    process.env.GITHUB_REPOSITORY = 'postman-cs/repo-sync-demo';
    process.env.GITHUB_REF_NAME = 'feature/repo-sync';
    delete process.env.GITHUB_HEAD_REF;
    __resetIdentityMemo();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_HEAD_REF;
    __resetIdentityMemo();
  });

  function makePostman(overrides: Record<string, unknown> = {}) {
    return {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-new', url: 'https://mock-new.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi.fn().mockImplementation((uid: string) => {
        if (uid === 'col-baseline') {
          return Promise.resolve(createV3CollectionFixture('core-payments'));
        }
        if (uid === 'col-smoke') {
          return Promise.resolve(createV3CollectionFixture('[Smoke] core-payments'));
        }
        if (uid === 'col-contract') {
          return Promise.resolve(createV3CollectionFixture('[Contract] core-payments'));
        }
        return Promise.resolve(createCollectionFixture('core-payments'));
      }),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
      listMonitors: vi.fn().mockResolvedValue([]),
      listMocks: vi.fn().mockResolvedValue([]),
      monitorExists: vi.fn().mockResolvedValue(false),
      mockExists: vi.fn().mockResolvedValue(false),
      findMonitorByCollection: vi.fn().mockResolvedValue(null),
      findMockByCollection: vi.fn().mockResolvedValue(null),
      configurePrivateMockRuntimeAuth: vi.fn().mockResolvedValue(0),
      runMonitor: vi.fn().mockResolvedValue(undefined),
      listEnvironments: vi.fn().mockResolvedValue([]),
      deleteEnvironment: vi.fn().mockResolvedValue(undefined),
      deleteMock: vi.fn().mockResolvedValue(undefined),
      deleteMonitor: vi.fn().mockResolvedValue(undefined),
      ...overrides
    };
  }

  function makeGithub(vars: Record<string, string> = {}) {
    return {
      getRepositoryVariable: vi.fn().mockImplementation((name: string) =>
        Promise.resolve(vars[name] ?? '')
      ),
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined)
    };
  }

  function makeDeps(postman: RepoSyncDependencies['postman'], github: NonNullable<RepoSyncDependencies['github']>): RepoSyncDependencies { return {
    core: createCoreStub().core,
    postman,
    github,
    internalIntegration: {
      associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
      connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
      findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
    },
    repoMutation: {
      commitAndPush: vi.fn().mockResolvedValue({ commitSha: '', pushed: false, resolvedCurrentRef: 'main' })
    } as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
  }; }

  it('reuses explicit mock-url from input', async () => {
    const postman = makePostman({
      listMocks: vi.fn().mockResolvedValue([{
        uid: 'explicit-mock',
        name: 'Existing Mock',
        collection: 'col-baseline',
        environment: 'env-prod',
        mockUrl: 'https://explicit-mock.pstmn.io/',
        visibility: 'public'
      }])
    });
    const github = makeGithub();
    await runRepoSync(createInputs({ environments: ['prod'], generateCiWorkflow: false, mockUrl: 'https://explicit-mock.pstmn.io' }), makeDeps(postman, github));

    expect(postman.createMock).not.toHaveBeenCalled();
    expect(postman.findMockByCollection).not.toHaveBeenCalled();
  });

  it('fails closed for private, unknown, stale, and unrelated explicit mocks', async () => {
    const base = {
      uid: 'explicit-mock',
      name: 'Existing Mock',
      collection: 'col-baseline',
      environment: 'env-prod',
      mockUrl: 'https://explicit-mock.pstmn.io'
    };
    for (const [label, listMocks, message] of [
      ['private', [{ ...base, visibility: 'private' }], /MOCK_NOT_PUBLIC.*explicit-mock/],
      ['unknown', [{ ...base, visibility: 'unknown' }], /MOCK_VISIBILITY_UNKNOWN.*explicit-mock/],
      ['stale', [], /EXPLICIT_MOCK_URL_NOT_FOUND/],
      ['wrong collection', [{ ...base, collection: 'other-col', visibility: 'public' }], /EXPLICIT_MOCK_IDENTITY_MISMATCH.*collection/],
      ['wrong environment', [{ ...base, environment: 'other-env', visibility: 'public' }], /EXPLICIT_MOCK_IDENTITY_MISMATCH.*environment/]
    ] as const) {
      const postman = makePostman({ listMocks: vi.fn().mockResolvedValue(listMocks) });
      await expect(
        runRepoSync(
          createInputs({ environments: ['prod'], generateCiWorkflow: false, mockUrl: base.mockUrl }),
          makeDeps(postman, makeGithub())
        ),
        label
      ).rejects.toThrow(message);
      expect(postman.createMock, label).not.toHaveBeenCalled();
    }
  });

  it('reuses a private mock only under explicit private policy and emits runtime auth metadata', async () => {
    const configurePrivateMockRuntimeAuth = vi.fn().mockResolvedValue(3);
    const postman = makePostman({
      configurePrivateMockRuntimeAuth,
      listMocks: vi.fn().mockResolvedValue([{
        uid: 'explicit-private',
        name: 'Existing Mock',
        collection: 'col-baseline',
        environment: 'env-prod',
        mockUrl: 'https://explicit-private.mock.pstmn.io',
        visibility: 'private'
      }])
    });

    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        mockUrl: 'https://explicit-private.mock.pstmn.io',
        mockVisibility: 'private'
      }),
      makeDeps(postman, makeGithub())
    );

    expect(result['mock-visibility']).toBe('private');
    expect(result['mock-auth-required']).toBe('true');
    expect(configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-smoke');
    expect(configurePrivateMockRuntimeAuth).toHaveBeenCalledWith('col-contract');
    expect(postman.createMock).not.toHaveBeenCalled();
  });

  it('discovers existing mock by baseline collection ID', async () => {
    const postman = makePostman({
      findMockByCollection: vi.fn().mockResolvedValue({
        uid: 'discovered-mock',
        name: 'core-payments Mock',
        collection: 'col-baseline',
        environment: 'env-prod',
        mockUrl: 'https://discovered-mock.pstmn.io',
        visibility: 'public'
      })
    });
    const github = makeGithub();
    await runRepoSync(createInputs({ environments: ['prod'], generateCiWorkflow: false }), makeDeps(postman, github));
    
    expect(postman.createMock).not.toHaveBeenCalled();
    expect(postman.findMockByCollection).toHaveBeenCalledWith(
      'col-baseline',
      'env-prod',
      'core-payments Mock'
    );
  });

  it('fails closed instead of reusing a discovered private or unknown mock', async () => {
    for (const [visibility, message] of [
      ['private', /MOCK_NOT_PUBLIC.*discovered-mock/],
      ['unknown', /MOCK_VISIBILITY_UNKNOWN.*discovered-mock/]
    ] as const) {
      const postman = makePostman({
        findMockByCollection: vi.fn().mockResolvedValue({
          uid: 'discovered-mock',
          name: 'core-payments Mock',
          collection: 'col-baseline',
          environment: 'env-prod',
          mockUrl: 'https://discovered-mock.pstmn.io',
          visibility
        })
      });
      await expect(
        runRepoSync(
          createInputs({ environments: ['prod'], generateCiWorkflow: false }),
          makeDeps(postman, makeGithub())
        )
      ).rejects.toThrow(message);
      expect(postman.createMock).not.toHaveBeenCalled();
    }
  });

  it('creates a new mock when no existing asset is found', async () => {
    const postman = makePostman({ findMockByCollection: vi.fn().mockResolvedValue(null) });
    const github = makeGithub();
    await runRepoSync(createInputs({ environments: ['prod'], generateCiWorkflow: false }), makeDeps(postman, github));
    
    expect(postman.createMock).toHaveBeenCalledWith(
      'ws-123',
      'core-payments Mock',
      'col-baseline',
      'env-prod',
      'public'
    );
  });

  it('creates an opt-in mock environment without adding it to runtime environment state', async () => {
    const createEnvironment = vi.fn().mockImplementation(
      (_workspaceId: string, name: string) => Promise.resolve(
        name.endsWith(' - Mock') ? 'env-mock' : 'env-prod'
      )
    );
    const postman = makePostman({
      createEnvironment,
      getEnvironment: vi.fn().mockImplementation((uid: string) => Promise.resolve({
        id: uid,
        values: uid === 'env-mock' ? [{ key: 'baseUrl', value: 'https://mock-new.pstmn.io' }] : []
      }))
    });
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        mockEnvironmentEnabled: true,
        repoWriteMode: 'none'
      }),
      makeDeps(postman, makeGithub())
    );

    expect(createEnvironment.mock.calls).toContainEqual([
      'ws-123',
      'core-payments - Mock',
      expect.arrayContaining([{ key: 'baseUrl', value: 'https://mock-new.pstmn.io', type: 'default' }])
    ]);
    expect(result['mock-environment-uid']).toBe('env-mock');
    expect(JSON.parse(result['environment-uids-json'])).toEqual({ prod: 'env-prod' });
    expect(JSON.parse(result['repo-sync-summary-json'])).toMatchObject({
      mockEnvironmentUid: 'env-mock',
      mockEnvironmentStatus: 'success'
    });
    expect(existsSync('postman/mocks/manual-validation.postman_environment.json')).toBe(true);
    expect(readFileSync('.postman/resources.yaml', 'utf8')).not.toContain('env-mock');
  });

  it('carries an empty secret slot for the caller key when the mock is private', async () => {
    const createEnvironment = vi.fn().mockImplementation((_workspaceId: string, name: string) =>
      Promise.resolve(name.endsWith(' - Mock') ? 'env-mock' : 'env-prod')
    );
    const notice = vi.fn();
    const postman = makePostman({
      createEnvironment,
      createMock: vi.fn().mockResolvedValue({
        uid: 'mock-1',
        url: 'https://mock-new.pstmn.io',
        visibility: 'private'
      }),
      findMockByCollection: vi.fn().mockResolvedValue(null),
      configurePrivateMockRuntimeAuth: vi.fn().mockResolvedValue(1)
    });
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        mockEnvironmentEnabled: true,
        mockVisibility: 'private',
        repoWriteMode: 'none'
      }),
      { ...makeDeps(postman, makeGithub()), core: { ...makeDeps(postman, makeGithub()).core, notice } }
    );

    const mockEnvCall = createEnvironment.mock.calls.find(([, name]) => name === 'core-payments - Mock');
    const values = mockEnvCall?.[2] as Array<{ key: string; value: string; type: string }>;
    const slot = values.find((value) => value.key === 'postmanPrivateMockApiKey');

    // Named so the developer knows what to paste, secret-typed so the app masks it,
    // and empty because repo-sync must never persist a credential.
    expect(slot).toEqual({ key: 'postmanPrivateMockApiKey', value: '', type: 'secret' });
    expect(result['mock-auth-required']).toBe('true');
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('postmanPrivateMockApiKey'));
  });

  it('adds the private-key slot when an existing mock environment only matches the URL', async () => {
    const updateEnvironment = vi.fn().mockResolvedValue(undefined);
    const postman = makePostman({
      updateEnvironment,
      createMock: vi.fn().mockResolvedValue({
        uid: 'mock-1',
        url: 'https://mock-new.pstmn.io',
        visibility: 'private'
      }),
      findMockByCollection: vi.fn().mockResolvedValue(null),
      configurePrivateMockRuntimeAuth: vi.fn().mockResolvedValue(1),
      findEnvironmentByName: vi.fn().mockImplementation((_workspaceId: string, name: string) =>
        Promise.resolve(name.endsWith(' - Mock') ? { uid: 'env-mock', name } : null)
      ),
      getEnvironment: vi.fn().mockImplementation((uid: string) => Promise.resolve({
        id: uid,
        values: uid === 'env-mock'
          ? [{ key: 'baseUrl', value: 'https://mock-new.pstmn.io', type: 'default' }]
          : []
      }))
    });

    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        environmentUids: { prod: 'env-prod' },
        generateCiWorkflow: false,
        mockEnvironmentEnabled: true,
        mockVisibility: 'private',
        repoWriteMode: 'none'
      }),
      makeDeps(postman, makeGithub())
    );

    expect(result['mock-environment-uid']).toBe('env-mock');
    expect(updateEnvironment).toHaveBeenCalledWith(
      'env-mock',
      'core-payments - Mock',
      expect.arrayContaining([
        { key: 'postmanPrivateMockApiKey', value: '', type: 'secret' }
      ])
    );
  });

  it('re-enables a disabled private-key slot in an existing mock environment', async () => {
    const updateEnvironment = vi.fn().mockResolvedValue(undefined);
    const postman = makePostman({
      updateEnvironment,
      createMock: vi.fn().mockResolvedValue({
        uid: 'mock-1',
        url: 'https://mock-new.pstmn.io',
        visibility: 'private'
      }),
      findMockByCollection: vi.fn().mockResolvedValue(null),
      configurePrivateMockRuntimeAuth: vi.fn().mockResolvedValue(1),
      findEnvironmentByName: vi.fn().mockImplementation((_workspaceId: string, name: string) =>
        Promise.resolve(name.endsWith(' - Mock') ? { uid: 'env-mock', name } : null)
      ),
      getEnvironment: vi.fn().mockImplementation((uid: string) => Promise.resolve({
        id: uid,
        values: uid === 'env-mock'
          ? [
              { key: 'baseUrl', value: 'https://mock-new.pstmn.io', type: 'default' },
              { key: 'postmanPrivateMockApiKey', value: '', type: 'secret', enabled: false },
              { key: 'AWS_REGION', value: 'us-east-2', type: 'default' },
              { key: 'AWS_SECRET_ACCESS_KEY', value: 'preserved-secret', type: 'secret', enabled: false }
            ]
          : []
      }))
    });

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        environmentUids: { prod: 'env-prod' },
        generateCiWorkflow: false,
        mockEnvironmentEnabled: true,
        mockVisibility: 'private',
        repoWriteMode: 'none'
      }),
      makeDeps(postman, makeGithub())
    );

    expect(updateEnvironment).toHaveBeenCalledWith(
      'env-mock',
      'core-payments - Mock',
      expect.arrayContaining([
        { key: 'postmanPrivateMockApiKey', value: '', type: 'secret' },
        { key: 'AWS_REGION', value: 'us-east-2', type: 'default' },
        { key: 'AWS_SECRET_ACCESS_KEY', value: '', type: 'secret', enabled: false }
      ])
    );
    const exported = JSON.parse(
      readFileSync('postman/mocks/manual-validation.postman_environment.json', 'utf8')
    ) as { values: Array<{ key: string; value: string }> };
    expect(exported.values.find((value) => value.key === 'AWS_REGION')?.value).toBe('us-east-2');
    expect(exported.values.find((value) => value.key === 'AWS_SECRET_ACCESS_KEY')?.value).toBe('');
    expect(JSON.stringify(exported)).not.toContain('preserved-secret');
  });

  it('omits the private-mock secret slot for a public mock', async () => {
    const createEnvironment = vi.fn().mockImplementation((_workspaceId: string, name: string) =>
      Promise.resolve(name.endsWith(' - Mock') ? 'env-mock' : 'env-prod')
    );
    const postman = makePostman({
      createEnvironment,
      findMockByCollection: vi.fn().mockResolvedValue(null)
    });
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        mockEnvironmentEnabled: true,
        repoWriteMode: 'none'
      }),
      makeDeps(postman, makeGithub())
    );

    const mockEnvCall = createEnvironment.mock.calls.find(([, name]) => name === 'core-payments - Mock');
    const values = mockEnvCall?.[2] as Array<{ key: string }>;

    expect(values.some((value) => value.key === 'postmanPrivateMockApiKey')).toBe(false);
    expect(result['mock-auth-required']).toBe('false');
  });

  it('reuses an unchanged mock environment without mutating runtime selection', async () => {
    const updateEnvironment = vi.fn().mockResolvedValue(undefined);
    const postman = makePostman({
      updateEnvironment,
      findEnvironmentByName: vi.fn().mockImplementation((_workspaceId: string, name: string) =>
        Promise.resolve(name.endsWith(' - Mock') ? { uid: 'env-mock', name } : null)
      ),
      getEnvironment: vi.fn().mockImplementation((uid: string) => Promise.resolve({
        id: uid,
        values: uid === 'env-mock'
          ? [
              { key: 'baseUrl', value: 'https://mock-new.pstmn.io', type: 'default' },
              { key: 'postmanPrivateMockApiKey', value: '', type: 'secret' }
            ]
          : []
      }))
    });
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        environmentUids: { prod: 'env-prod' },
        generateCiWorkflow: false,
        mockEnvironmentEnabled: true,
        mockVisibility: 'private',
        repoWriteMode: 'none'
      }),
      makeDeps(postman, makeGithub())
    );

    expect(result['mock-environment-uid']).toBe('env-mock');
    expect(updateEnvironment.mock.calls.some(([, name]) => name === 'core-payments - Mock')).toBe(false);
    expect(JSON.parse(result['environment-uids-json'])).toEqual({ prod: 'env-prod' });
    const exported = JSON.parse(
      readFileSync('postman/mocks/manual-validation.postman_environment.json', 'utf8')
    ) as { values: Array<{ key: string; value: string }> };
    expect(exported.values.find((value) => value.key === 'postmanPrivateMockApiKey')?.value).toBe('');
    expect(JSON.stringify(exported)).not.toContain('pmak-user-filled');
  });

  it('reports an observable non-fatal mock environment failure', async () => {
    const createEnvironment = vi.fn().mockImplementation(
      (_workspaceId: string, name: string) => name.endsWith(' - Mock')
        ? Promise.reject(new Error('mock environment denied'))
        : Promise.resolve('env-prod')
    );
    const { core, warnings } = createCoreStub();
    const postman = makePostman({ createEnvironment });
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        mockEnvironmentEnabled: true,
        repoWriteMode: 'none'
      }),
      { ...makeDeps(postman, makeGithub()), core }
    );

    expect(result['mock-environment-uid']).toBe('');
    expect(JSON.parse(result['repo-sync-summary-json'])).toMatchObject({
      mockEnvironmentUid: '',
      mockEnvironmentStatus: 'failed'
    });
    expect(warnings).toContainEqual(expect.stringMatching(/Mock environment upsert failed.*mock environment denied/));
  });

  it('skips mock environments for preview runs so retention cleanup owns every branch asset', async () => {
    const originalCwd = process.cwd();
    const isolatedDir = mkdtempSync(join(tmpdir(), 'repo-sync-preview-mock-env-'));
    try {
      process.chdir(isolatedDir);
      vi.stubEnv('POSTMAN_BRANCH_ASSET_IDS', 'owned');
      vi.stubEnv('POSTMAN_BRANCH_DECISION', '');
      vi.stubEnv('GITHUB_HEAD_REF', '');
      vi.stubEnv('GITHUB_REF_NAME', 'feature/mock-environment');
      vi.stubEnv('GITHUB_REF', 'refs/heads/feature/mock-environment');
      const createEnvironment = vi.fn().mockResolvedValue('env-preview');
      const { core, warnings } = createCoreStub();
      const postman = makePostman({ createEnvironment });
      const result = await runRepoSync(
        createInputs({
          branchStrategy: 'preview',
          canonicalBranch: 'main',
          environments: ['prod'],
          generateCiWorkflow: false,
          mockEnvironmentEnabled: true,
          repoWriteMode: 'none'
        }),
        { ...makeDeps(postman, makeGithub()), core }
      );

      expect(result['mock-environment-status']).toBe('skipped');
      expect(createEnvironment.mock.calls.some(([, name]) => String(name).endsWith(' - Mock'))).toBe(false);
      expect(warnings).toContainEqual(expect.stringMatching(/skipped for preview and channel runs/));
    } finally {
      process.chdir(originalCwd);
      rmSync(isolatedDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it('warns with mock retry context and preserves 3-attempt final failure semantics', async () => {
    vi.useFakeTimers();
    try {
      const postman = makePostman({
        findMockByCollection: vi.fn().mockResolvedValue(null),
        createMock: vi.fn().mockRejectedValue(new Error('ESOCKETTIMEDOUT'))
      });
      const github = makeGithub();
      const { core, warnings } = createCoreStub();
      const run = runRepoSync(
        createInputs({ environments: ['prod'], generateCiWorkflow: false, smokeCollectionId: '' }),
        { ...makeDeps(postman, github), core }
      );
      const expectation = expect(run).rejects.toThrow(
        /Mock create failed for mock "core-payments Mock" workspace ws-123 collection col-baseline environment env-prod: ESOCKETTIMEDOUT\. verify collection\/environment access then rerun/
      );
      await vi.runAllTimersAsync();
      await expectation;
      expect(postman.createMock).toHaveBeenCalledTimes(3);
      const retryWarning = warnings.find((line) => line.includes('Mock create attempt 1/3'));
      expect(retryWarning).toBeDefined();
      expect(retryWarning).toContain('mock "core-payments Mock"');
      expect(retryWarning).toContain('workspace ws-123');
      expect(retryWarning).toContain('collection col-baseline');
      expect(retryWarning).toContain('environment env-prod');
      expect(retryWarning).toContain('ESOCKETTIMEDOUT');
      expect(retryWarning).toContain('retrying');
      expect(retryWarning).toContain('verify collection/environment access then rerun');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces mock discovery failure with operation, entity, cause, and remediation', async () => {
    const postman = makePostman({
      findMockByCollection: vi.fn().mockRejectedValue(new Error('mock discovery denied')),
      createMock: vi.fn()
    });
    const github = makeGithub();
    await expect(
      runRepoSync(
        createInputs({ environments: ['prod'], generateCiWorkflow: false, smokeCollectionId: '' }),
        makeDeps(postman, github)
      )
    ).rejects.toThrow(
      /Mock discovery failed for mock "core-payments Mock" workspace ws-123 collection col-baseline environment env-prod: mock discovery denied\. verify collection\/environment access then rerun/
    );
    expect(postman.createMock).not.toHaveBeenCalled();
  });
});

describe('org-mode auto-detection', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    __resetIdentityMemo();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetIdentityMemo();
  });

  function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
      ...init
    });
  }

  function orgModeFetchRouter(opts: {
    meStatus?: number;
    meBody?: unknown;
    sessionTeam?: number | string;
    sessionDomain?: string;
    squadsStatus?: number;
    squadsBody?: unknown;
  }): typeof fetch {
    const json = (body: unknown, status = 200) => jsonResponse(body, { status });
    return vi.fn<typeof fetch>().mockImplementation(async (input: string | URL | Request) => {
      const urlStr = input instanceof Request ? input.url : String(input);

      // ums squads gateway envelope. createApiKey is stubbed at the file level,
      // so the only /ws/proxy caller in these tests is the squads probe.
      if (urlStr === 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy') {
        return json(opts.squadsBody ?? { data: [] }, opts.squadsStatus ?? 200);
      }

      if (urlStr === 'https://api.getpostman.com/me') {
        if (opts.meStatus && opts.meStatus !== 200) {
          return json({ error: { name: 'AuthenticationError' } }, opts.meStatus);
        }
        return jsonResponse(opts.meBody ?? { user: { id: 'u1', name: 'Test' } });
      }

      if (urlStr === 'https://iapub.postman.co/api/sessions/current') {
        return jsonResponse({
          identity: {
            team: opts.sessionTeam ?? 10490519,
            ...(opts.sessionDomain ? { domain: opts.sessionDomain } : {})
          },
          consumerType: 'service_account'
        });
      }

      return new Response('', { status: 404 });
    });
  }

  it('does not create or persist a Postman API key in spec-only scope', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };
    const masker = createSecretMasker(['postman-access-token']);
    const inputs = createInputs({
      postmanApiKey: '',
      postmanAccessToken: 'postman-access-token',
      teamId: '10490519',
      orgMode: true
    });
    vi.mocked(createInternalIntegrationAdapter).mockClear();

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      {
        allowApiKeyCreation: false,
        persistGeneratedApiKeySecret: false,
        env: {}
      }
    );

    expect(result).toEqual({ apiKey: '', teamId: '10490519' });
    expect(createInternalIntegrationAdapter).not.toHaveBeenCalled();
    expect(execLike.getExecOutput).not.toHaveBeenCalled();
    expect(actionCore.setSecret).not.toHaveBeenCalled();
  });

  it('sets orgMode=true when ums squads returns a non-empty squad list (org-mode team)', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };

    globalThis.fetch = orgModeFetchRouter({
      meBody: { user: { id: 'u1', name: 'Test', teamId: 13347347 } },
      sessionTeam: 13347347,
      sessionDomain: 'field-services-v12-demo',
      squadsBody: {
        data: [
          { id: 's1', name: 'Squad A', organizationId: '13347347' },
          { id: 's2', name: 'Squad B', organizationId: '13347347' },
          { id: 's3', name: 'Squad C', organizationId: '13347347' }
        ]
      }
    });

    const { createSecretMasker } = await import('../src/lib/secrets.js');
    const masker = createSecretMasker(['pmak-test']);

    const inputs = createInputs({
      postmanApiKey: 'pmak-valid',
      postmanAccessToken: 'postman-access-token',
      teamId: '',
      orgMode: false,
      githubToken: 'github-token',
      ghFallbackToken: ''
    });

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.teamId).toBe('13347347');
    expect(inputs.orgMode).toBe(true);
    expect(actionCore.info).toHaveBeenCalledWith(expect.stringContaining('Org-mode auto-detected via ums squads'));
  });

  it('leaves orgMode=false when ums squads returns 400 "Squad feature is not available" (non-org team)', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };

    globalThis.fetch = orgModeFetchRouter({
      meStatus: 401,
      sessionTeam: 10490519,
      squadsStatus: 400,
      squadsBody: { error: { message: 'Squad feature is not available for your team.' } }
    });

    const { createSecretMasker } = await import('../src/lib/secrets.js');
    const masker = createSecretMasker(['pmak-test']);

    const inputs = createInputs({
      postmanApiKey: 'pmak-invalid',
      postmanAccessToken: 'postman-access-token',
      teamId: '',
      orgMode: false,
      githubToken: 'github-token',
      ghFallbackToken: ''
    });

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.teamId).toBe('10490519');
    expect(inputs.orgMode).toBe(false);
    expect(actionCore.info).not.toHaveBeenCalledWith(expect.stringContaining('Org-mode auto-detected'));
    // The expected non-org 400 must not surface as a detection-failure warning.
    expect(actionCore.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('Org-mode auto-detection via ums squads failed')
    );
  });

  it('sets orgMode=true when ums squads returns a single squad (org-mode service account)', async () => {
    // Real-world service-account case: the parent account is org-mode, so ums
    // squads returns a non-empty list (here one squad). A 200 with any squads
    // means org-mode; the legacy per-team organizationId check is gone.
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };

    globalThis.fetch = orgModeFetchRouter({
      meBody: { user: { id: 'u1', name: 'Test', teamId: 83498 } },
      sessionTeam: 83498,
      squadsBody: {
        data: [{ id: 's1', name: 'jared-service-account-test', organizationId: '987442' }]
      }
    });

    const { createSecretMasker } = await import('../src/lib/secrets.js');
    const masker = createSecretMasker(['pmak-test']);

    const inputs = createInputs({
      postmanApiKey: 'pmak-valid',
      postmanAccessToken: 'postman-access-token',
      teamId: '',
      orgMode: false,
      githubToken: 'github-token',
      ghFallbackToken: ''
    });

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.teamId).toBe('83498');
    expect(inputs.orgMode).toBe(true);
    expect(actionCore.info).toHaveBeenCalledWith(expect.stringContaining('Org-mode auto-detected via ums squads'));
    expect(actionCore.info).toHaveBeenCalledWith(expect.stringContaining('83498'));
  });

  it('sets orgMode=true from ums squads even when /me does not provide a teamId (teamId from session identity)', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };

    globalThis.fetch = orgModeFetchRouter({
      meBody: { user: { id: 'u1', name: 'Test' } },
      sessionTeam: 83498,
      sessionDomain: 'demo',
      squadsBody: { data: [{ id: 's1', name: 'squad-1', organizationId: '987442' }] }
    });

    const { createSecretMasker } = await import('../src/lib/secrets.js');
    const masker = createSecretMasker(['pmak-test']);

    const inputs = createInputs({
      postmanApiKey: 'pmak-valid-without-team',
      postmanAccessToken: 'postman-access-token',
      teamId: '',
      orgMode: false,
      githubToken: '',
      ghFallbackToken: ''
    });

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      { persistGeneratedApiKeySecret: false, env: {} }
    );

    expect(result.teamId).toBe('83498');
    expect(inputs.orgMode).toBe(true);
    expect(actionCore.info).toHaveBeenCalledWith(expect.stringContaining('Org-mode auto-detected via ums squads'));
  });

  it('leaves orgMode=false when ums squads returns a non-400 error (detection failure is non-fatal)', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };
    const leak = 'squad-secret-leak-xyz';

    globalThis.fetch = orgModeFetchRouter({
      meStatus: 401,
      sessionTeam: 10490519,
      squadsStatus: 500,
      squadsBody: { error: { message: `UnexpectedError ${leak}` } }
    });

    const masker = createSecretMasker(['pmak-test', leak]);

    const inputs = createInputs({
      postmanApiKey: 'pmak-invalid',
      postmanAccessToken: 'postman-access-token',
      teamId: '',
      orgMode: false,
      githubToken: 'github-token',
      ghFallbackToken: ''
    });

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.teamId).toBe('10490519');
    expect(result.apiKey).toBe('pmak-generated-from-mock');
    expect(inputs.orgMode).toBe(false);
    expect(actionCore.info).not.toHaveBeenCalledWith(expect.stringContaining('Org-mode auto-detected'));
    const squadWarning = actionCore.warning.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('Org-mode auto-detection via ums squads failed'));
    expect(squadWarning).toBeDefined();
    expect(squadWarning).toContain('team 10490519');
    expect(squadWarning).toContain('set org-mode and team-id explicitly then rerun');
    expect(squadWarning).toContain(REDACTED);
    expect(squadWarning).not.toContain(leak);
  });

  it('warns on PMAK GET /me 401/403 with status, masked cause, and remediation', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };
    const leak = 'pmak-body-secret-abc';
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
      });
    globalThis.fetch = vi.fn<typeof fetch>().mockImplementation(async (input: string | URL | Request) => {
      const urlStr = input instanceof Request ? input.url : String(input);
      if (urlStr === 'https://api.getpostman.com/me') {
        return json({ error: { name: 'AuthenticationError', detail: leak } }, 401);
      }
      if (urlStr === 'https://iapub.postman.co/api/sessions/current') {
        return json({
          identity: { team: 10490519 },
          consumerType: 'service_account'
        });
      }
      return new Response('', { status: 404 });
    });

    const masker = createSecretMasker(['pmak-invalid', leak]);
    const inputs = createInputs({
      postmanApiKey: 'pmak-invalid',
      postmanAccessToken: 'postman-access-token',
      teamId: '10490519',
      orgMode: true,
      githubToken: 'github-token',
      ghFallbackToken: ''
    });

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      { persistGeneratedApiKeySecret: false, env: {} }
    );

    expect(result.apiKey).toBe('pmak-generated-from-mock');
    expect(result.teamId).toBe('10490519');
    const meWarning = actionCore.warning.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('PMAK GET /me validation failed'));
    expect(meWarning).toBeDefined();
    expect(meWarning).toContain('status 401');
    expect(meWarning).toContain('replace postman-api-key or provide a valid postman-access-token then rerun');
    expect(meWarning).toContain(REDACTED);
    expect(meWarning).not.toContain(leak);
  });

  it('keeps GitHub secret persistence warnings one-line when the REST write fails', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const leak = 'gh-crlf-secret-xyz';
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({
        exitCode: 1,
        stderr: `permission\r\ndenied ${leak}\nforged`,
        stdout: ''
      })
    };
    globalThis.fetch = orgModeFetchRouter({
      meStatus: 401,
      sessionTeam: 10490519,
      squadsBody: { data: [] }
    });
    const masker = createSecretMasker(['pmak-invalid', leak]);
    const inputs = createInputs({
      postmanApiKey: 'pmak-invalid',
      postmanAccessToken: 'postman-access-token',
      teamId: '10490519',
      orgMode: true,
      repository: 'postman-cs/repo-sync-demo',
      githubToken: 'github-token',
      ghFallbackToken: ''
    });

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.apiKey).toBe('pmak-generated-from-mock');
    const persistWarning = actionCore.warning.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('GitHub Actions secret persistence for POSTMAN_API_KEY failed'));
    expect(persistWarning).toBeDefined();
    expect(persistWarning).toContain('repository postman-cs/repo-sync-demo');
    expect(persistWarning).toContain('GitHub API request failed (HTTP 404)');
    expect(persistWarning).toContain(
      'grant Actions secrets write permission or set POSTMAN_API_KEY manually then rerun'
    );
    expect(persistWarning).not.toContain(leak);
    expect(persistWarning).not.toContain('\n');
    expect(persistWarning).not.toContain('\r');
  });

  it('warns when the GitHub secret REST write returns non-success', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const leak = 'gh-stderr-secret-xyz';
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({
        exitCode: 1,
        stderr: `permission denied ${leak}`,
        stdout: ''
      })
    };
    globalThis.fetch = orgModeFetchRouter({
      meStatus: 401,
      sessionTeam: 10490519,
      squadsBody: { data: [] }
    });
    const masker = createSecretMasker(['pmak-invalid', leak]);
    const inputs = createInputs({
      postmanApiKey: 'pmak-invalid',
      postmanAccessToken: 'postman-access-token',
      teamId: '10490519',
      orgMode: true,
      repository: 'postman-cs/repo-sync-demo',
      githubToken: 'github-token',
      ghFallbackToken: ''
    });

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.apiKey).toBe('pmak-generated-from-mock');
    expect(result.teamId).toBe('10490519');
    const persistWarning = actionCore.warning.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('GitHub Actions secret persistence for POSTMAN_API_KEY failed'));
    expect(persistWarning).toBeDefined();
    expect(persistWarning).toContain('repository postman-cs/repo-sync-demo');
    expect(persistWarning).toContain('grant Actions secrets write permission or set POSTMAN_API_KEY manually then rerun');
    expect(persistWarning).toContain('GitHub API request failed (HTTP 404)');
    expect(persistWarning).not.toContain(leak);
  });

  it('warns when GitHub secret REST persistence fails before writing', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const leak = 'gh-throw-secret-xyz';
    const execLike = {
      getExecOutput: vi.fn().mockRejectedValue(new Error(`spawn gh failed ${leak}`))
    };
    globalThis.fetch = orgModeFetchRouter({
      meStatus: 401,
      sessionTeam: 10490519,
      squadsBody: { data: [] }
    });
    const masker = createSecretMasker(['pmak-invalid', leak]);
    const inputs = createInputs({
      postmanApiKey: 'pmak-invalid',
      postmanAccessToken: 'postman-access-token',
      teamId: '10490519',
      orgMode: true,
      repository: 'postman-cs/repo-sync-demo',
      githubToken: 'github-token',
      ghFallbackToken: ''
    });

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.apiKey).toBe('pmak-generated-from-mock');
    const persistWarning = actionCore.warning.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('GitHub Actions secret persistence for POSTMAN_API_KEY failed'));
    expect(persistWarning).toBeDefined();
    expect(persistWarning).toContain('repository postman-cs/repo-sync-demo');
    expect(persistWarning).toContain('grant Actions secrets write permission or set POSTMAN_API_KEY manually then rerun');
    expect(persistWarning).toContain('GitHub API request failed (HTTP 404)');
    expect(persistWarning).not.toContain(leak);
  });

  it('warns when GitHub token is present but repository context is empty', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const execLike = {
      getExecOutput: vi.fn()
    };
    globalThis.fetch = orgModeFetchRouter({
      meStatus: 401,
      sessionTeam: 10490519,
      squadsBody: { data: [] }
    });
    const masker = createSecretMasker(['pmak-invalid']);
    const inputs = createInputs({
      postmanApiKey: 'pmak-invalid',
      postmanAccessToken: 'postman-access-token',
      teamId: '10490519',
      orgMode: true,
      repository: '',
      githubToken: 'github-token',
      ghFallbackToken: ''
    });

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.apiKey).toBe('pmak-generated-from-mock');
    expect(execLike.getExecOutput).not.toHaveBeenCalled();
    const missingRepoWarning = actionCore.warning.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('repository (missing)'));
    expect(missingRepoWarning).toBeDefined();
    expect(missingRepoWarning).toContain('GitHub Actions secret persistence for POSTMAN_API_KEY failed');
    expect(missingRepoWarning).toContain('repository context is empty');
    expect(missingRepoWarning).toContain(
      'set repository context or persist POSTMAN_API_KEY manually then rerun'
    );
  });

  it('warns when no GitHub token is provided and names repository when known', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const execLike = {
      getExecOutput: vi.fn()
    };
    globalThis.fetch = orgModeFetchRouter({
      meStatus: 401,
      sessionTeam: 10490519,
      squadsBody: { data: [] }
    });
    const masker = createSecretMasker(['pmak-invalid']);
    const inputs = createInputs({
      postmanApiKey: 'pmak-invalid',
      postmanAccessToken: 'postman-access-token',
      teamId: '10490519',
      orgMode: true,
      repository: 'postman-cs/repo-sync-demo',
      githubToken: '',
      ghFallbackToken: ''
    });

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      execLike,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.apiKey).toBe('pmak-generated-from-mock');
    expect(execLike.getExecOutput).not.toHaveBeenCalled();
    const noTokenWarning = actionCore.warning.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('no GitHub token provided'));
    expect(noTokenWarning).toBeDefined();
    expect(noTokenWarning).toContain('GitHub Actions secret persistence for POSTMAN_API_KEY failed');
    expect(noTokenWarning).toContain('repository postman-cs/repo-sync-demo');
    expect(noTokenWarning).toContain(
      'provide github-token/gh-fallback-token or set POSTMAN_API_KEY manually then rerun'
    );
  });
});

describe('repo-variable fallback resolution', () => {
  let originalCwd = '';
  let testDir = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'repo-sync-fallback-'));
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  function makePostman(overrides: Record<string, unknown> = {}) {
    return {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi.fn().mockResolvedValue(createCollectionFixture('[Smoke] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
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
      ...overrides
    };
  }

  function makeGithub(vars: Record<string, string> = {}) {
    return {
      getRepositoryVariable: vi.fn().mockImplementation((name: string) =>
        Promise.resolve(vars[name] ?? '')
      ),
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined)
    };
  }

  function makeDeps(postman: RepoSyncDependencies['postman'], github: NonNullable<RepoSyncDependencies['github']>): RepoSyncDependencies { return {
    core: createCoreStub().core,
    postman,
    github,
    internalIntegration: {
      associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
      connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
      findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
    },
    repoMutation: {
      commitAndPush: vi.fn().mockResolvedValue({ commitSha: '', pushed: false, resolvedCurrentRef: 'main' })
    } as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
  }; }

  it('resolves workspace and collection ids from .postman/resources.yaml when inputs are empty', async () => {
    const postman = makePostman();
    const github = makeGithub();
    mkdirSync('.postman', { recursive: true });
    writeFileSync(
      '.postman/resources.yaml',
      [
        'workspace:',
        '  id: ws-from-file',
        'cloudResources:',
        '  collections:',
        '    "../postman/collections/core-payments": col-base-file',
        '    "../postman/collections/[Smoke] core-payments": col-smoke-file',
        '    "../postman/collections/[Contract] core-payments": col-contract-file',
        ''
      ].join('\n')
    );
    await runRepoSync(createInputs({
      environments: ['prod'],
      generateCiWorkflow: false,
      workspaceId: '',
      baselineCollectionId: '',
      smokeCollectionId: '',
      contractCollectionId: ''
    }), makeDeps(postman, github));

    expect(postman.getCollection).toHaveBeenCalledWith('col-base-file');
    expect(postman.getCollection).toHaveBeenCalledWith('col-smoke-file');
    expect(postman.getCollection).toHaveBeenCalledWith('col-contract-file');
    expect(postman.createEnvironment).toHaveBeenCalledWith('ws-from-file', expect.any(String), expect.any(Array));
  });

  it('resolves legacy baseline collection ids from .postman/resources.yaml', async () => {
    const postman = makePostman();
    const github = makeGithub();
    mkdirSync('.postman', { recursive: true });
    writeFileSync(
      '.postman/resources.yaml',
      [
        'workspace:',
        '  id: ws-from-file',
        'cloudResources:',
        '  collections:',
        '    "../postman/collections/[Baseline] core-payments": col-base-legacy',
        '    "../postman/collections/[Smoke] core-payments": col-smoke-file',
        '    "../postman/collections/[Contract] core-payments": col-contract-file',
        ''
      ].join('\n')
    );

    await runRepoSync(createInputs({
      environments: ['prod'],
      generateCiWorkflow: false,
      workspaceId: '',
      baselineCollectionId: '',
      smokeCollectionId: '',
      contractCollectionId: ''
    }), makeDeps(postman, github));

    expect(postman.getCollection).toHaveBeenCalledWith('col-base-legacy');
  });

  it('resolves environment ids from .postman/resources.yaml when input map is empty', async () => {
    const postman = makePostman();
    const github = makeGithub();
    mkdirSync('.postman', { recursive: true });
    writeFileSync(
      '.postman/resources.yaml',
      [
        'workspace:',
        '  id: ws-123',
        'cloudResources:',
        '  environments:',
        '    "../postman/environments/prod.postman_environment.json": env-prod-file',
        '    "../postman/environments/stage.postman_environment.json": env-stage-file',
        ''
      ].join('\n')
    );
    await runRepoSync(createInputs({
      environments: ['prod', 'stage'],
      generateCiWorkflow: false,
      workspaceId: 'ws-123',
      baselineCollectionId: 'col-baseline',
      smokeCollectionId: 'col-smoke',
      contractCollectionId: 'col-contract',
      environmentUids: {}
    }), makeDeps(postman, github));

    expect(postman.updateEnvironment).toHaveBeenCalledWith(
      'env-prod-file',
      'core-payments - prod',
      expect.any(Array)
    );
    expect(postman.updateEnvironment).toHaveBeenCalledWith(
      'env-stage-file',
      'core-payments - stage',
      expect.any(Array)
    );
    expect(postman.createEnvironment).not.toHaveBeenCalled();
  });

  it('does not resolve asset ids from repository variables when .postman/resources.yaml is absent', async () => {
    const postman = makePostman({
      getCollection: vi
        .fn()
        .mockResolvedValueOnce(createCollectionFixture('core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Smoke] core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Contract] core-payments'))
    });
    const github = makeGithub({
      'POSTMAN_CORE_PAYMENTS_WORKSPACE_ID': 'ws-repo-all',
      'POSTMAN_CORE_PAYMENTS_BASELINE_COLLECTION_UID': 'col-base-repo-all',
      'POSTMAN_CORE_PAYMENTS_SMOKE_COLLECTION_UID': 'col-smoke-repo-all',
      'POSTMAN_CORE_PAYMENTS_CONTRACT_COLLECTION_UID': 'col-contract-repo-all'
    });
    await runRepoSync(createInputs({
      environments: ['prod'],
      generateCiWorkflow: false,
      workspaceId: '',
      baselineCollectionId: '',
      smokeCollectionId: '',
      contractCollectionId: ''
    }), makeDeps(postman, github));

    expect(postman.getCollection).not.toHaveBeenCalledWith('col-base-repo-all');
    expect(postman.getCollection).not.toHaveBeenCalledWith('col-smoke-repo-all');
    expect(postman.getCollection).not.toHaveBeenCalledWith('col-contract-repo-all');
    expect(postman.createEnvironment).not.toHaveBeenCalledWith('ws-repo-all', expect.any(String), expect.any(Array));
    expect(github.getRepositoryVariable).not.toHaveBeenCalledWith('POSTMAN_CORE_PAYMENTS_WORKSPACE_ID');
    expect(github.getRepositoryVariable).not.toHaveBeenCalledWith('POSTMAN_CORE_PAYMENTS_BASELINE_COLLECTION_UID');
    expect(github.getRepositoryVariable).not.toHaveBeenCalledWith('POSTMAN_CORE_PAYMENTS_SMOKE_COLLECTION_UID');
    expect(github.getRepositoryVariable).not.toHaveBeenCalledWith('POSTMAN_CORE_PAYMENTS_CONTRACT_COLLECTION_UID');
  });
});

describe('repo-link admission guard', () => {
  let originalCwd = '';
  let testDir = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'repo-sync-admission-'));
    process.chdir(testDir);
    process.env.GITHUB_REPOSITORY = 'postman-cs/repo-sync-demo';
    process.env.GITHUB_REF_NAME = 'feature/repo-sync';
    delete process.env.GITHUB_HEAD_REF;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REF_NAME;
  });

  function makePostman() {
    return {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi.fn().mockResolvedValue(createCollectionFixture('core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
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
      deleteMonitor: vi.fn().mockResolvedValue(undefined)
    };
  }

  function makeRepoMutation() {
    return {
      commitAndPush: vi.fn().mockResolvedValue({
        commitSha: '',
        pushed: false,
        resolvedCurrentRef: 'feature/repo-sync'
      })
    } as unknown as Parameters<typeof runRepoSync>[1]['repoMutation'];
  }

  it('fails before env/mock/monitor writes on linked-visible conflict with another workspace', async () => {
    const postman = makePostman();
    const associateSystemEnvironments = vi.fn().mockResolvedValue(undefined);
    const connectWorkspaceToRepository = vi.fn().mockResolvedValue(undefined);
    const findWorkspaceForRepo = vi.fn().mockResolvedValue({
      state: 'linked-visible',
      workspace: { id: 'ws-other', name: 'Payments Service' }
    });
    const commitAndPush = vi.fn().mockResolvedValue({
      commitSha: '',
      pushed: false,
      resolvedCurrentRef: 'feature/repo-sync'
    });
    const expectedMessage =
      'REPOSITORY_LINK_CONFLICT_VISIBLE: Repository https://github.com/postman-cs/repo-sync-demo at path / is already linked to workspace ws-other ("Payments Service"). No Postman assets were changed. Reuse that workspace or disconnect it in Workspace Settings, then rerun.';

    let caught: unknown;
    try {
      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          environmentSyncEnabled: true
        }),
        {
          core: createCoreStub().core,
          postman,
          internalIntegration: {
            associateSystemEnvironments,
            connectWorkspaceToRepository,
            findWorkspaceForRepo
          },
          repoMutation: { commitAndPush } as unknown as Parameters<
            typeof runRepoSync
          >[1]['repoMutation']
        }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(expectedMessage);

    expect(findWorkspaceForRepo).toHaveBeenCalledWith(
      'https://github.com/postman-cs/repo-sync-demo',
      '/'
    );
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(associateSystemEnvironments).not.toHaveBeenCalled();
    expect(postman.createMock).not.toHaveBeenCalled();
    expect(postman.createMonitor).not.toHaveBeenCalled();
    expect(postman.runMonitor).not.toHaveBeenCalled();
    expect(connectWorkspaceToRepository).not.toHaveBeenCalled();
    expect(postman.getCollection).not.toHaveBeenCalled();
    expect(postman.getEnvironment).not.toHaveBeenCalled();
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(existsSync('.postman/resources.yaml')).toBe(false);
  });

  it('fails before writes on linked-invisible conflict', async () => {
    const postman = makePostman();
    const associateSystemEnvironments = vi.fn().mockResolvedValue(undefined);
    const connectWorkspaceToRepository = vi.fn().mockResolvedValue(undefined);
    const commitAndPush = vi.fn().mockResolvedValue({
      commitSha: '',
      pushed: false,
      resolvedCurrentRef: 'feature/repo-sync'
    });
    const expectedMessage =
      'REPOSITORY_LINK_CONFLICT_INVISIBLE: Repository https://github.com/postman-cs/repo-sync-demo at path / is linked to workspace ws-hidden, but these credentials cannot view it. No Postman assets were changed. Ask its owner or a team admin to disconnect it.';

    let caught: unknown;
    try {
      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          environmentSyncEnabled: true
        }),
        {
          core: createCoreStub().core,
          postman,
          internalIntegration: {
            associateSystemEnvironments,
            connectWorkspaceToRepository,
            findWorkspaceForRepo: vi.fn().mockResolvedValue({
              state: 'linked-invisible',
              workspaceId: 'ws-hidden'
            })
          },
          repoMutation: { commitAndPush } as unknown as Parameters<
            typeof runRepoSync
          >[1]['repoMutation']
        }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(expectedMessage);

    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(associateSystemEnvironments).not.toHaveBeenCalled();
    expect(postman.createMock).not.toHaveBeenCalled();
    expect(postman.createMonitor).not.toHaveBeenCalled();
    expect(postman.runMonitor).not.toHaveBeenCalled();
    expect(connectWorkspaceToRepository).not.toHaveBeenCalled();
    expect(postman.getCollection).not.toHaveBeenCalled();
    expect(postman.getEnvironment).not.toHaveBeenCalled();
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(existsSync('.postman/resources.yaml')).toBe(false);
  });

  it('appends org-mode remediation on linked-invisible conflicts', async () => {
    const postman = makePostman();
    const associateSystemEnvironments = vi.fn().mockResolvedValue(undefined);
    const connectWorkspaceToRepository = vi.fn().mockResolvedValue(undefined);
    const commitAndPush = vi.fn().mockResolvedValue({
      commitSha: '',
      pushed: false,
      resolvedCurrentRef: 'feature/repo-sync'
    });
    const expectedMessage =
      "REPOSITORY_LINK_CONFLICT_INVISIBLE: Repository https://github.com/postman-cs/repo-sync-demo at path / is linked to workspace ws-hidden, but these credentials cannot view it. No Postman assets were changed. Ask its owner or a team admin to disconnect it. Verify workspace-team-id; if the owner is in another sub-team, ask that sub-team's admin to disconnect it.";

    let caught: unknown;
    try {
      await runRepoSync(
        createInputs({
          environments: ['prod'],
          generateCiWorkflow: false,
          environmentSyncEnabled: true,
          orgMode: true
        }),
        {
          core: createCoreStub().core,
          postman,
          internalIntegration: {
            associateSystemEnvironments,
            connectWorkspaceToRepository,
            findWorkspaceForRepo: vi.fn().mockResolvedValue({
              state: 'linked-invisible',
              workspaceId: 'ws-hidden'
            })
          },
          repoMutation: { commitAndPush } as unknown as Parameters<
            typeof runRepoSync
          >[1]['repoMutation']
        }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(expectedMessage);

    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(associateSystemEnvironments).not.toHaveBeenCalled();
    expect(postman.createMock).not.toHaveBeenCalled();
    expect(postman.createMonitor).not.toHaveBeenCalled();
    expect(postman.runMonitor).not.toHaveBeenCalled();
    expect(connectWorkspaceToRepository).not.toHaveBeenCalled();
    expect(postman.getCollection).not.toHaveBeenCalled();
    expect(postman.getEnvironment).not.toHaveBeenCalled();
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(existsSync('.postman/resources.yaml')).toBe(false);
  });

  it('skips the duplicate link POST when the repo is already linked to the target workspace', async () => {
    const { core, infos } = createCoreStub();
    const connectWorkspaceToRepository = vi.fn().mockResolvedValue(undefined);
    const findWorkspaceForRepo = vi.fn().mockResolvedValue({
      state: 'linked-visible',
      workspace: { id: 'ws-123', name: 'Target Workspace' }
    });

    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false
      }),
      {
        core,
        postman: makePostman(),
        internalIntegration: {
          associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
          connectWorkspaceToRepository,
          findWorkspaceForRepo
        },
        repoMutation: makeRepoMutation()
      }
    );

    expect(result['workspace-link-status']).toBe('success');
    expect(connectWorkspaceToRepository).not.toHaveBeenCalled();
    expect(infos).toContain(
      'REPOSITORY_LINK_ALREADY_TARGET: Repository https://github.com/postman-cs/repo-sync-demo at path / is already linked to target workspace ws-123; continuing.'
    );
  });

  it('passes preflightWasFree to connect so a free->conflict race surfaces UNRESOLVED', async () => {
    const connectWorkspaceToRepository = vi.fn().mockResolvedValue(undefined);

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false
      }),
      {
        core: createCoreStub().core,
        postman: makePostman(),
        internalIntegration: {
          associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
          connectWorkspaceToRepository,
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
        },
        repoMutation: makeRepoMutation()
      }
    );

    expect(connectWorkspaceToRepository).toHaveBeenCalledWith(
      'ws-123',
      'https://github.com/postman-cs/repo-sync-demo',
      { preflightWasFree: true }
    );
  });

  it('surfaces the exact REPOSITORY_LINK_CONFLICT_UNRESOLVED message through the canonical boundary', async () => {
    const unresolvedMessage =
      'REPOSITORY_LINK_CONFLICT_UNRESOLVED: Preflight found no active owner, but link creation reported workspace ws-race. Stop and contact Postman support; do not alter the repository URL.';
    process.env.POSTMAN_BRANCH_DECISION = JSON.stringify({
      tier: 'canonical',
      strategy: 'publish-gate',
      canonicalBranch: 'main',
      reason: 'test',
      identity: {
        provider: 'github',
        headBranch: 'main',
        headSha: 'abc123456789',
        refKind: 'default-branch',
        isPrContext: false,
        isForkPr: false
      }
    });
    try {
      let caught: unknown;
      try {
        await runRepoSync(
          createInputs({
            branchStrategy: 'publish-gate',
            environments: ['prod'],
            generateCiWorkflow: false,
            environmentSyncEnabled: false
          }),
          {
            core: createCoreStub().core,
            postman: makePostman(),
            internalIntegration: {
              associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
              connectWorkspaceToRepository: vi
                .fn()
                .mockRejectedValue(new Error(unresolvedMessage)),
              findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
            },
            repoMutation: makeRepoMutation()
          }
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(unresolvedMessage);
    } finally {
      delete process.env.POSTMAN_BRANCH_DECISION;
    }
  });

  it('warns but proceeds when the repository-link preflight is unknown', async () => {
    const { core, warnings } = createCoreStub();
    const connectWorkspaceToRepository = vi.fn().mockResolvedValue(undefined);

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        environmentSyncEnabled: false
      }),
      {
        core,
        postman: makePostman(),
        internalIntegration: {
          associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
          connectWorkspaceToRepository,
          findWorkspaceForRepo: vi.fn().mockResolvedValue({
            state: 'unknown',
            reason: 'filesystem lookup returned HTTP 500'
          })
        },
        repoMutation: makeRepoMutation()
      }
    );

    expect(warnings).toContain(
      'REPOSITORY_LINK_PREFLIGHT_UNKNOWN: Unable to determine the existing repository link (filesystem lookup returned HTTP 500); continuing and relying on link creation conflict handling.'
    );
    expect(connectWorkspaceToRepository).toHaveBeenCalledWith(
      'ws-123',
      'https://github.com/postman-cs/repo-sync-demo',
      undefined
    );
  });
});

describe('runAction credential preflight', () => {
  let originalCwd = '';
  let testDir = '';
  let savedPostmanTeamId: string | undefined;

  function defaultAdapterStub() {
    return {
      createApiKey: vi.fn().mockResolvedValue('pmak-generated-from-mock'),
      associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
      connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
      findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
    };
  }

  beforeEach(async () => {
    __resetIdentityMemo();
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'repo-sync-preflight-'));
    process.chdir(testDir);
    process.env.GITHUB_REPOSITORY = 'postman-cs/repo-sync-demo';
    process.env.GITHUB_REF_NAME = 'feature/repo-sync';
    delete process.env.GITHUB_HEAD_REF;
    savedPostmanTeamId = process.env.POSTMAN_TEAM_ID;
    delete process.env.POSTMAN_TEAM_ID;

    // These cases exercise the real Bifrost adapter (reactive advice included),
    // so the file-level adapter mock is routed to the actual implementation.
    const actualAdapter = await vi.importActual<
      typeof import('../src/lib/postman/internal-integration-adapter.js')
    >('../src/lib/postman/internal-integration-adapter.js');
    vi.mocked(createInternalIntegrationAdapter).mockImplementation(
      actualAdapter.createInternalIntegrationAdapter
    );
  });

  afterEach(() => {
    vi.mocked(createInternalIntegrationAdapter).mockImplementation(defaultAdapterStub);
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REF_NAME;
    if (savedPostmanTeamId !== undefined) {
      process.env.POSTMAN_TEAM_ID = savedPostmanTeamId;
    }
  });

  function baseInputValues(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      'project-name': 'core-payments',
      'workspace-id': 'ws-preflight',
      'postman-api-key': 'pmak-test',
      'postman-access-token': 'access-token-test',
      'environments-json': '["prod"]',
      'env-runtime-urls-json': '{"prod":"https://api.example.com"}',
      'repo-write-mode': 'none',
      'generate-ci-workflow': 'false',
      ...overrides
    };
  }

  function createRunActionCore(values: Record<string, string>, events: string[]) {
    const infos: string[] = [];
    const warnings: string[] = [];
    const outputs: Record<string, string> = {};
    const core = {
      getInput: (name: string, options?: { required?: boolean }) => {
        const value = values[name] ?? '';
        if (options?.required && !value) {
          throw new Error(`Input required and not supplied: ${name}`);
        }
        return value;
      },
      info: (message: string) => {
        infos.push(message);
        events.push(`info:${message}`);
      },
      setFailed: () => {},
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      setSecret: () => {},
      warning: (message: string) => {
        warnings.push(message);
        events.push(`warning:${message}`);
      }
    };
    return { core, infos, outputs, warnings };
  }

  function createExecStub() {
    return {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    };
  }

  interface RunActionRouterOptions {
    events: string[];
    meFirstCallStatus?: number;
    meUser?: Record<string, unknown>;
    sessionStatus?: number;
    sessionBody?: Record<string, unknown>;
    associateResponse?: () => Response | undefined;
  }

  function createRunActionFetchRouter(options: RunActionRouterOptions): typeof fetch {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    let meCalls = 0;
    const router = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const url = String(input);
      const method = String(init?.method || 'GET').toUpperCase();
      options.events.push(`fetch:${method} ${url}`);

      if (url === 'https://api.getpostman.com/me') {
        meCalls += 1;
        // The preflight probe is always the first /me call in runAction; the
        // second is the action's own key validation.
        if (options.meFirstCallStatus && options.meFirstCallStatus !== 200 && meCalls === 1) {
          return json({ error: { name: 'AuthenticationError' } }, options.meFirstCallStatus);
        }
        return json({
          user: options.meUser ?? {
            id: 12345678,
            fullName: 'Ada Lovelace',
            teamId: 10490519,
            teamName: 'jared-demo',
            teamDomain: 'jared-demo'
          }
        });
      }
      if (url === 'https://iapub.postman.co/api/sessions/current') {
        if (options.sessionStatus && options.sessionStatus !== 200) {
          return json({ error: 'denied' }, options.sessionStatus);
        }
        return json(
          options.sessionBody ?? {
            identity: { team: 10490519, domain: 'jared-demo' },
            data: { user: { id: 555, roles: ['admin'] } },
            consumerType: 'service_account'
          }
        );
      }
      if (url === 'https://api.getpostman.com/service-account-tokens' && method === 'POST') {
        return json({ access_token: 'refreshed-access-token' });
      }
      if (
        url.startsWith('https://api.getpostman.com/environments?workspace=') &&
        method === 'POST'
      ) {
        return json({ environment: { uid: '123-env-prod-uid' } });
      }
      if (url.startsWith('https://api.getpostman.com/environments/')) {
        return json({
          environment: { id: 'env-prod', name: 'core-payments - prod', values: [] }
        });
      }
      if (
        url ===
        'https://catalog-admin.postman-account2009.workers.dev/api/internal/system-envs/associate'
      ) {
        const custom = options.associateResponse?.();
        return custom ?? json({ ok: true });
      }
      if (url === 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy') {
        // Gateway proxy envelope: {service, method, path, body?}. Env/mock/monitor
        // asset ops are access-token gateway-only (PMAK is never used for data),
        // so branch on the proxied service+path to return the right uid shapes.
        let proxied: { service?: string; path?: string } = {};
        try {
          proxied = JSON.parse(String(init?.body ?? '{}'));
        } catch {
          /* ignore */
        }
        const service = String(proxied.service ?? '');
        const proxyPath = String(proxied.path ?? '');
        if (service === 'api-catalog' && proxyPath === '/api/system-envs/associations') {
          const custom = options.associateResponse?.();
          return custom ?? json({ success: true });
        }
        // All gateway ops share the /ws/proxy URL; record service+path so
        // ordering/negative assertions can target a specific asset op.
        options.events.push(`proxy:${method} ${service} ${proxyPath}`);
        if (service === 'ums') {
          // Org-mode auto-detection probe. These preflight-focused tests use
          // the non-org sandbox team (10490519), so ums squads answers with
          // the expected non-org 400 — orgMode stays false, matching the
          // prior PMAK /teams empty-data behavior.
          return json(
            { error: { message: 'Squad feature is not available for your team.' } },
            400
          );
        }
        if (service === 'sync') {
          if (proxyPath.includes('/environment/import')) {
            return json({ data: { uid: '123-env-prod-uid' } });
          }
          if (/\/environment\/[^/]+\/sync/.test(proxyPath)) {
            return json({
              entities: [{ data: { id: 'env-prod', name: 'core-payments - prod', values: [] } }]
            });
          }
          if (proxyPath.includes('/list/environment')) {
            return json({ data: [] });
          }
          // PUT /environment/:id (update) and any other sync op.
          return json({ data: { ok: true } });
        }
        if (service === 'mock') {
          return json({ data: { uid: 'mock-123', url: 'https://mock-123.mock.pstmn.io' } });
        }
        if (service === 'monitorsV2') {
          return json({ data: { id: 'monitor-123', uid: 'monitor-123' } });
        }
        return json({ data: { ok: true } });
      }
      throw new Error(`Unrouted fetch in runAction test: ${method} ${url}`);
    };
    return router as typeof fetch;
  }

  it('gates an empty-payload GitHub fork PR before credential or API work', async () => {
    const events: string[] = [];
    const eventPath = join(testDir, 'empty-pull-request-event.json');
    writeFileSync(eventPath, '{}');
    process.env.GITHUB_HEAD_REF = 'release/attacker';
    process.env.GITHUB_REF = 'refs/pull/42/merge';
    process.env.GITHUB_EVENT_PATH = eventPath;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { core, outputs } = createRunActionCore(
      baseInputValues({
        'branch-strategy': 'preview',
        'canonical-branch': 'main'
      }),
      events
    );

    await runWithFakeTimers(() => runAction(core, createExecStub()));

    expect(outputs['sync-status']).toBe('skipped-branch-gate');
    const branchDecision = JSON.parse(outputs['branch-decision']);
    expect(branchDecision.tier).toBe('gated');
    expect(branchDecision.identity.isForkPr).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runAction logs PMAK and session identity lines before the first environment call', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', createRunActionFetchRouter({ events }));
    const { core, infos, outputs } = createRunActionCore(baseInputValues(), events);

    await runWithFakeTimers(() => runAction(core, createExecStub()));

    expect(JSON.parse(outputs['environment-uids-json'])).toEqual({ prod: '123-env-prod-uid' });
    const pmakLineIndex = events.findIndex((entry) =>
      entry.startsWith('info:postman: PMAK identity')
    );
    const sessionLineIndex = events.findIndex((entry) =>
      entry.startsWith('info:postman: access-token session identity')
    );
    const createEnvironmentIndex = events.findIndex((entry) =>
      entry.startsWith('proxy:POST sync /environment/import')
    );
    expect(pmakLineIndex).toBeGreaterThanOrEqual(0);
    expect(sessionLineIndex).toBeGreaterThan(pmakLineIndex);
    expect(createEnvironmentIndex).toBeGreaterThan(sessionLineIndex);
    expect(infos.some((line) => line.includes('credential preflight OK'))).toBe(true);
  });

  it('runAction completes when the /me probe and iapub both 404 (preflight non-fatal)', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({ events, meFirstCallStatus: 404, sessionStatus: 404 })
    );
    const { core, warnings, outputs } = createRunActionCore(baseInputValues(), events);

    await runWithFakeTimers(() => runAction(core, createExecStub()));

    expect(JSON.parse(outputs['environment-uids-json'])).toEqual({ prod: '123-env-prod-uid' });
    expect(
      warnings.some((line) => line.includes('could not resolve PMAK identity'))
    ).toBe(true);
    expect(
      warnings.some((line) =>
        line.includes('could not resolve the access-token session identity')
      )
    ).toBe(true);
  });

  it('runAction under credential-preflight=enforce FAILS fast with both parent-org ids named when injected /me teamId differs from iapub identity.team', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({
        events,
        meUser: { id: 1, fullName: 'Ada Lovelace', teamId: 10490519, teamName: 'jared-demo' },
        sessionBody: {
          identity: { team: 13347347, domain: 'field-services-v12-demo' },
          data: { user: { id: 2, roles: ['admin'] } },
          consumerType: 'service_account'
        }
      })
    );
    const { core } = createRunActionCore(
      baseInputValues({ 'credential-preflight': 'enforce' }),
      events
    );

    let thrown: unknown;
    try {
      await runWithFakeTimers(() => runAction(core, createExecStub()));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain('credential preflight FAILED');
    expect(message).toContain('10490519');
    expect(message).toContain('13347347');
    expect(
      events.some((entry) => entry.startsWith('proxy:POST sync /environment/import'))
    ).toBe(false);
  });

  it('runAction under the default (warn) logs a NOTE and continues on that same mismatch (does not fail)', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({
        events,
        meUser: { id: 1, fullName: 'Ada Lovelace', teamId: 10490519, teamName: 'jared-demo' },
        sessionBody: {
          identity: { team: 13347347, domain: 'field-services-v12-demo' },
          data: { user: { id: 2, roles: ['admin'] } },
          consumerType: 'service_account'
        }
      })
    );
    const { core, warnings, outputs } = createRunActionCore(baseInputValues(), events);

    await runWithFakeTimers(() => runAction(core, createExecStub()));

    expect(JSON.parse(outputs['environment-uids-json'])).toEqual({ prod: '123-env-prod-uid' });
    const note = warnings.find((line) => line.includes('credential preflight note'));
    expect(note).toBeDefined();
    expect(note).toContain('10490519');
    expect(note).toContain('13347347');
    expect(
      events.some((entry) => entry.startsWith('proxy:POST sync /environment/import'))
    ).toBe(true);
  });

  it('runAction rejects credential-preflight=off instead of skipping identity checks', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', createRunActionFetchRouter({ events }));
    const { core } = createRunActionCore(
      baseInputValues({ 'credential-preflight': 'off' }),
      events
    );

    await expect(
      runWithFakeTimers(() => runAction(core, createExecStub()))
    ).rejects.toThrow(/Unsupported credential-preflight/);
    expect(events).toHaveLength(0);
  });

  it('reactive advice still rewrites a Bifrost UNAUTHENTICATED with default preflight enabled', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({
        events,
        associateResponse: () =>
          new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), {
            status: 401,
            statusText: 'Unauthorized'
          })
      })
    );
    const { core, warnings, outputs } = createRunActionCore(
      baseInputValues({
        'system-env-map-json': '{"prod":"sys-prod"}'
      }),
      events
    );

    await runWithFakeTimers(() => runAction(core, createExecStub()));

    expect(outputs['environment-sync-status']).toBe('failed');
    const adviceWarning = warnings.find((line) =>
      line.includes('System environment association failed')
    );
    expect(adviceWarning).toBeDefined();
    expect(adviceWarning).toContain('workspace');
    expect(adviceWarning).toContain('->');
    expect(adviceWarning).toContain('Bifrost rejected the access token (UNAUTHENTICATED)');
    expect(adviceWarning).toContain(
      'POST https://api.getpostman.com/service-account-tokens'
    );
    expect(adviceWarning).toContain('verify access-token/team/system-env mapping then rerun');
    expect(events.some((entry) => entry.includes('iapub.postman.co'))).toBe(true);
  });
});
