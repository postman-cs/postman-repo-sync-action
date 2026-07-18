// Mock must be at top of file — vitest hoists vi.mock before all imports
vi.mock('../src/lib/postman/internal-integration-adapter.js', () => ({
  createInternalIntegrationAdapter: vi.fn(() => ({
    createApiKey: vi.fn().mockResolvedValue('pmak-generated-from-mock'),
    associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
    connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
  }))
}));

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { load as loadYaml } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readActionInputs,
  resolvePostmanApiKeyAndTeamId,
  runAction,
  runRepoSync,
  type RepoSyncDependencies,
  type ResolvedInputs
} from '../src/index.js';
import { __resetIdentityMemo } from '../src/lib/postman/credential-identity.js';
import { createInternalIntegrationAdapter } from '../src/lib/postman/internal-integration-adapter.js';

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
    sections: 'off',
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
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_HEAD_REF;
  });

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
      findMockByCollection: vi.fn().mockResolvedValue(null),
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
      connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
    symlinkSync(outsideRoot, '.workflow-link', 'dir');
    const invalidPaths = [
      '../escaped-ci.yml',
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
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
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
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
          connectWorkspaceToRepository: vi.fn().mockRejectedValue(new Error('link denied'))
        },
        repoMutation: makeRepoMutation()
      })).rejects.toThrow('Workspace link failed: link denied');
      expect(postman.tagSpecVersion).not.toHaveBeenCalled();
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
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
          connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
          connectWorkspaceToRepository: vi.fn().mockRejectedValue(new Error('link denied'))
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
          connectWorkspaceToRepository: vi.fn().mockRejectedValue(new Error('link denied'))
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
          connectWorkspaceToRepository: vi.fn().mockRejectedValue(new Error('link denied'))
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
      connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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
    await runRepoSync(createInputs({ environments: ['prod'], generateCiWorkflow: false, monitorId: 'stale-mon' }), makeDeps(postman, github));
    
    expect(postman.createMonitor).toHaveBeenCalled();
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
    await expect(
      runRepoSync(
        createInputs({ environments: ['prod'], generateCiWorkflow: false, monitorCron: '' }),
        makeDeps(postman, github)
      )
    ).resolves.toBeDefined();
  });
});

describe('mock resolution paths', () => {
  function makePostman(overrides: Record<string, unknown> = {}) {
    return {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      findEnvironmentByName: vi.fn().mockResolvedValue(null),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-new', url: 'https://mock-new.pstmn.io' }),
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
      connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
    },
    repoMutation: {
      commitAndPush: vi.fn().mockResolvedValue({ commitSha: '', pushed: false, resolvedCurrentRef: 'main' })
    } as unknown as Parameters<typeof runRepoSync>[1]['repoMutation']
  }; }

  it('reuses explicit mock-url from input', async () => {
    const postman = makePostman();
    const github = makeGithub();
    await runRepoSync(createInputs({ environments: ['prod'], generateCiWorkflow: false, mockUrl: 'https://explicit-mock.pstmn.io' }), makeDeps(postman, github));
    
    expect(postman.createMock).not.toHaveBeenCalled();
  });

  it('discovers existing mock by baseline collection ID', async () => {
    const postman = makePostman({
      findMockByCollection: vi.fn().mockResolvedValue({ uid: 'discovered-mock', mockUrl: 'https://discovered-mock.pstmn.io' })
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

  it('creates a new mock when no existing asset is found', async () => {
    const postman = makePostman({ findMockByCollection: vi.fn().mockResolvedValue(null) });
    const github = makeGithub();
    await runRepoSync(createInputs({ environments: ['prod'], generateCiWorkflow: false }), makeDeps(postman, github));
    
    expect(postman.createMock).toHaveBeenCalledWith(
      'ws-123',
      'core-payments Mock',
      'col-baseline',
      'env-prod'
    );
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

    globalThis.fetch = orgModeFetchRouter({
      meStatus: 401,
      sessionTeam: 10490519,
      squadsStatus: 500,
      squadsBody: { error: { message: 'UnexpectedError' } }
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
    expect(actionCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Org-mode auto-detection via ums squads failed')
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
      connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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

describe('runAction credential preflight', () => {
  let originalCwd = '';
  let testDir = '';
  let savedPostmanTeamId: string | undefined;

  function defaultAdapterStub() {
    return {
      createApiKey: vi.fn().mockResolvedValue('pmak-generated-from-mock'),
      associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
      connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
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

  it('runAction logs PMAK and session identity lines before the first environment call', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', createRunActionFetchRouter({ events }));
    const { core, infos, outputs } = createRunActionCore(baseInputValues(), events);

    await runAction(core, createExecStub());

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

    await runAction(core, createExecStub());

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
      await runAction(core, createExecStub());
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

    await runAction(core, createExecStub());

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

    await expect(runAction(core, createExecStub())).rejects.toThrow(
      /Unsupported credential-preflight/
    );
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

    await runAction(core, createExecStub());

    expect(outputs['environment-sync-status']).toBe('failed');
    const adviceWarning = warnings.find((line) =>
      line.includes('System environment association failed')
    );
    expect(adviceWarning).toBeDefined();
    expect(adviceWarning).toContain('Bifrost rejected the access token (UNAUTHENTICATED)');
    expect(adviceWarning).toContain(
      'POST https://api.getpostman.com/service-account-tokens'
    );
    expect(events.some((entry) => entry.includes('iapub.postman.co'))).toBe(true);
  });
});
