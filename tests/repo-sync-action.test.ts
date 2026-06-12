// Mock must be at top of file — vitest hoists vi.mock before all imports
vi.mock('../src/lib/postman/internal-integration-adapter.js', () => ({
  createInternalIntegrationAdapter: vi.fn(() => ({
    createApiKey: vi.fn().mockResolvedValue('pmak-generated-from-mock'),
    associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
    connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
  }))
}));

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  cloudResources?: {
    collections?: Record<string, string>;
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
    committerName: 'Postman CSE',
    committerEmail: 'help@postman.com',
    postmanApiKey: 'pmak-test',
    postmanAccessToken: 'postman-access-token',
    credentialPreflight: 'warn',
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
    specPath: '',
    teamId: '',
    repository: 'postman-cs/repo-sync-demo',
    postmanStack: 'prod',
    postmanApiBase: 'https://api.getpostman.com',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
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
      createMock: vi.fn().mockResolvedValue({
        uid: 'mock-123',
        url: 'https://mock.pstmn.io'
      }),
      createMonitor: vi.fn().mockResolvedValue('mon-123'),
      getCollection: vi
        .fn()
        .mockResolvedValueOnce(createCollectionFixture('[Baseline] core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Smoke] core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Contract] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
      listMonitors: vi.fn().mockResolvedValue([]),
      listMocks: vi.fn().mockResolvedValue([]),
      monitorExists: vi.fn().mockResolvedValue(false),
      mockExists: vi.fn().mockResolvedValue(false),
      findMonitorByCollection: vi.fn().mockResolvedValue(null),
      findMockByCollection: vi.fn().mockResolvedValue(null),
      runMonitor: vi.fn().mockResolvedValue(undefined)
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

    const baselineCollection = loadYaml(
      readFileSync('postman/collections/[Baseline] core-payments/collection.yaml', 'utf8')
    ) as Record<string, unknown>;
    const folderYaml = loadYaml(
      readFileSync('postman/collections/[Baseline] core-payments/Orders/folder.yaml', 'utf8')
    ) as Record<string, unknown>;
    const nestedRequestYaml = loadYaml(
      readFileSync(
        'postman/collections/[Baseline] core-payments/Orders/Create Order.request.yaml',
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

    expect(baselineCollection.type).toBe('collection');
    expect(baselineCollection.items).toEqual([
      { ref: './List Payments.request.yaml' },
      { ref: './Orders/folder.yaml' }
    ]);
    expect(folderYaml.items).toEqual([{ ref: './Create Order.request.yaml' }]);
    expect(nestedRequestYaml.method).toBe('POST');
    expect(nestedRequestYaml.body).toEqual({
      type: 'json',
      content: '{"status":"created"}'
    });
    expect(resourcesYaml).toEqual({
      workspace: { id: 'ws-123' },
      localResources: {
        collections: [
          '../postman/collections/[Baseline] core-payments',
          '../postman/collections/[Smoke] core-payments',
          '../postman/collections/[Contract] core-payments'
        ],
        environments: [
          '../postman/environments/prod.postman_environment.json',
          '../postman/environments/stage.postman_environment.json'
        ],
        specs: ['../packages/sdk/openapi.json']
      },
      cloudResources: {
        collections: {
          '../postman/collections/[Baseline] core-payments': 'col-baseline',
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
            collection: '../postman/collections/[Baseline] core-payments'
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
      runMonitor: vi.fn().mockResolvedValue(undefined)
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
    expect(postman.updateEnvironment).toHaveBeenCalledTimes(2);
  });

  it('refresh reruns keep the same tracked collection ids in .postman/resources.yaml', async () => {
    const postman = {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi
        .fn()
        .mockResolvedValueOnce(createCollectionFixture('[Baseline] core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Smoke] core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Contract] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
      listMonitors: vi.fn().mockResolvedValue([]),
      listMocks: vi.fn().mockResolvedValue([]),
      monitorExists: vi.fn().mockResolvedValue(false),
      mockExists: vi.fn().mockResolvedValue(false),
      findMonitorByCollection: vi.fn().mockResolvedValue(null),
      findMockByCollection: vi.fn().mockResolvedValue(null),
      runMonitor: vi.fn().mockResolvedValue(undefined)
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

    expect(resourcesYaml.cloudResources?.collections).toEqual({
      '../postman/collections/[Baseline] core-payments': 'col-baseline-existing',
      '../postman/collections/[Smoke] core-payments': 'col-smoke-existing',
      '../postman/collections/[Contract] core-payments': 'col-contract-existing'
    });
  });

  it('skips writing a CI workflow when generation is disabled', async () => {
    const postman = {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
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
      runMonitor: vi.fn().mockResolvedValue(undefined)
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

  it('writes the generated CI workflow to a custom path when configured', async () => {
    const postman = {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
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
      runMonitor: vi.fn().mockResolvedValue(undefined)
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

  it('creates release-labeled collection directories for versioned exports', async () => {
    const postman = {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi
        .fn()
        .mockResolvedValueOnce(createCollectionFixture('[Baseline] core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Smoke] core-payments'))
        .mockResolvedValueOnce(createCollectionFixture('[Contract] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
      listMonitors: vi.fn().mockResolvedValue([]),
      listMocks: vi.fn().mockResolvedValue([]),
      monitorExists: vi.fn().mockResolvedValue(false),
      mockExists: vi.fn().mockResolvedValue(false),
      findMonitorByCollection: vi.fn().mockResolvedValue(null),
      findMockByCollection: vi.fn().mockResolvedValue(null),
      runMonitor: vi.fn().mockResolvedValue(undefined)
    };

    await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        collectionSyncMode: 'version',
        releaseLabel: 'release-2026-03'
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
      existsSync('postman/collections/[Baseline] core-payments release-2026-03/collection.yaml')
    ).toBe(true);
    expect(
      existsSync('postman/collections/[Smoke] core-payments release-2026-03/collection.yaml')
    ).toBe(true);
    expect(
      existsSync('postman/collections/[Contract] core-payments release-2026-03/collection.yaml')
    ).toBe(true);
  });

});

describe('monitor resolution paths', () => {
  function makePostman(overrides: Record<string, unknown> = {}) {
    return {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
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
    expect(postman.findMonitorByCollection).toHaveBeenCalledWith('col-smoke');
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
      runMonitor: vi.fn().mockRejectedValue(new Error('boom'))
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
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-new', url: 'https://mock-new.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi.fn().mockResolvedValue(createCollectionFixture('[Baseline] core-payments')),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] }),
      listMonitors: vi.fn().mockResolvedValue([]),
      listMocks: vi.fn().mockResolvedValue([]),
      monitorExists: vi.fn().mockResolvedValue(false),
      mockExists: vi.fn().mockResolvedValue(false),
      findMonitorByCollection: vi.fn().mockResolvedValue(null),
      findMockByCollection: vi.fn().mockResolvedValue(null),
      runMonitor: vi.fn().mockResolvedValue(undefined),
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
    expect(postman.findMockByCollection).toHaveBeenCalledWith('col-baseline');
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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
      ...init
    });
  }

  it('sets orgMode=true when teams have shared organizationId matching teamId', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const mockFetch = vi.fn<typeof fetch>();
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };
    const createdApiKey = 'pmak-generated-1';

    globalThis.fetch = mockFetch;

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const urlStr = input instanceof Request ? input.url : String(input);

      if (urlStr.includes('bifrost-premium-https-v4.gw.postman.com')) {
        return jsonResponse({ apikey: { key: createdApiKey } });
      }

      if (urlStr.includes('/me')) {
        return jsonResponse({ user: { id: 'u1', name: 'Test', teamId: 99900 } });
      }

      if (urlStr.includes('/teams')) {
        return jsonResponse({
          data: [
            { id: 99901, name: 'Sub Team A', handle: 'sub-a', organizationId: 99900 },
            { id: 99902, name: 'Sub Team B', handle: 'sub-b', organizationId: 99900 },
            { id: 99903, name: 'Sub Team C', handle: 'sub-c', organizationId: 99900 }
          ]
        });
      }

      return new Response('', { status: 404 });
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

    expect(result.teamId).toBe('99900');
    expect(inputs.orgMode).toBe(true);
  });

  it('leaves orgMode=false when getTeams() throws (detection failure is non-fatal)', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };

    const localExecLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };

    const createdApiKey = 'pmak-generated-2';

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const urlStr = String(url);
      fetchCallCount++;

      if (fetchCallCount === 1 && urlStr.includes('/me')) {
        return new Response('', { status: 401 });
      }

      if (urlStr.includes('bifrost-premium-https-v4.gw.postman.com')) {
        return jsonResponse({ apikey: { key: createdApiKey } });
      }

      if (urlStr.includes('/me')) {
        return jsonResponse({ user: { id: 'u1', name: 'Test', teamId: 99901 } });
      }

      if (urlStr.includes('/teams')) {
        throw new Error('Network error fetching teams');
      }

      return new Response('', { status: 404 });
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
      localExecLike,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.teamId).toBe('99901');
    expect(inputs.orgMode).toBe(false);
    expect(actionCore.info).not.toHaveBeenCalledWith(expect.stringContaining('Org-mode auto-detected'));
  });

  it('sets orgMode=true when a service-account PMAK returns exactly one sub-team carrying organizationId', async () => {
    // Real-world service-account key case: GET /teams returns a single team,
    // but that team's organizationId is non-null because the parent account is
    // org-mode. Previously orgMode only flipped when teams.length > 1, so these
    // keys issued Bifrost calls without x-entity-team-id and silently failed.
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const mockFetch = vi.fn<typeof fetch>();
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };
    const createdApiKey = 'pmak-generated-3';

    globalThis.fetch = mockFetch;

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const urlStr = input instanceof Request ? input.url : String(input);

      if (urlStr.includes('bifrost-premium-https-v4.gw.postman.com')) {
        return jsonResponse({ apikey: { key: createdApiKey } });
      }

      if (urlStr.includes('/me')) {
        return jsonResponse({ user: { id: 'u1', name: 'Test', teamId: 83498 } });
      }

      if (urlStr.includes('/teams')) {
        return jsonResponse({
          data: [
            { id: 83498, name: 'jared-service-account-test', handle: 'jaredserviceaccounttest', organizationId: 987442 }
          ]
        });
      }

      return new Response('', { status: 404 });
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

    expect(result.teamId).toBe('83498');
    expect(inputs.orgMode).toBe(true);
    expect(actionCore.info).toHaveBeenCalledWith(expect.stringContaining('Org-mode auto-detected'));
    expect(actionCore.info).toHaveBeenCalledWith(expect.stringContaining('987442'));
  });

  it('sets orgMode=true from teams even when /me does not provide a teamId', async () => {
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const mockFetch = vi.fn<typeof fetch>();
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };

    globalThis.fetch = mockFetch;

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const urlStr = input instanceof Request ? input.url : String(input);

      if (urlStr.includes('/me')) {
        return jsonResponse({ user: { id: 'u1', name: 'Test' } });
      }

      if (urlStr.includes('/teams')) {
        return jsonResponse({
          data: [
            { id: 83498, name: 'jared-service-account-test', handle: 'jaredserviceaccounttest', organizationId: 987442 }
          ]
        });
      }

      return new Response('', { status: 404 });
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

    expect(result.teamId).toBe('');
    expect(inputs.orgMode).toBe(true);
    expect(actionCore.info).toHaveBeenCalledWith(expect.stringContaining('Org-mode auto-detected'));
  });

  it('leaves orgMode=false when the single team has a null organizationId (non-org account)', async () => {
    // Negative case: a solo team whose organizationId is null is authoritatively
    // not org-mode. Auto-detection must not flip orgMode on for these accounts.
    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const mockFetch = vi.fn<typeof fetch>();
    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };
    const createdApiKey = 'pmak-generated-4';

    globalThis.fetch = mockFetch;

    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const urlStr = input instanceof Request ? input.url : String(input);

      if (urlStr.includes('bifrost-premium-https-v4.gw.postman.com')) {
        return jsonResponse({ apikey: { key: createdApiKey } });
      }

      if (urlStr.includes('/me')) {
        return jsonResponse({ user: { id: 'u1', name: 'Test', teamId: 12345 } });
      }

      if (urlStr.includes('/teams')) {
        return jsonResponse({
          data: [
            { id: 12345, name: 'solo-team', handle: 'soloteam', organizationId: null }
          ]
        });
      }

      return new Response('', { status: 404 });
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

    expect(result.teamId).toBe('12345');
    expect(inputs.orgMode).toBe(false);
    expect(actionCore.info).not.toHaveBeenCalledWith(expect.stringContaining('Org-mode auto-detected'));
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
        '    "../postman/collections/[Baseline] core-payments": col-base-file',
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
        .mockResolvedValueOnce(createCollectionFixture('[Baseline] core-payments'))
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
      if (url === 'https://api.getpostman.com/teams') {
        return json({ data: [] });
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
      entry.startsWith('fetch:POST https://api.getpostman.com/environments?workspace=')
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
      events.some((entry) =>
        entry.startsWith('fetch:POST https://api.getpostman.com/environments?workspace=')
      )
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
      events.some((entry) =>
        entry.startsWith('fetch:POST https://api.getpostman.com/environments?workspace=')
      )
    ).toBe(true);
  });

  it('runAction with credential-preflight=off makes no /me/iapub probe', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', createRunActionFetchRouter({ events }));
    const { core, infos, outputs } = createRunActionCore(
      baseInputValues({ 'credential-preflight': 'off' }),
      events
    );

    await runAction(core, createExecStub());

    expect(JSON.parse(outputs['environment-uids-json'])).toEqual({ prod: '123-env-prod-uid' });
    expect(events.some((entry) => entry.includes('iapub.postman.co'))).toBe(false);
    expect(
      events.filter((entry) => entry === 'fetch:GET https://api.getpostman.com/me')
    ).toHaveLength(1);
    expect(infos.some((line) => line.includes('postman: PMAK identity'))).toBe(false);
  });

  it('reactive advice still rewrites a Bifrost UNAUTHENTICATED even when credential-preflight=off', async () => {
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
        'credential-preflight': 'off',
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
    expect(events.some((entry) => entry.includes('iapub.postman.co'))).toBe(false);
  });
});
