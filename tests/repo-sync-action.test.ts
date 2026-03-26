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
  runRepoSync,
  type ResolvedInputs
} from '../src/index.js';

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
    githubToken: 'github-token',
    ghFallbackToken: 'fallback-token',
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
      findMockByCollection: vi.fn().mockResolvedValue(null)
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
      repoMutation: repoMutation as any
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
    ) as Record<string, any>;
    const folderYaml = loadYaml(
      readFileSync('postman/collections/[Baseline] core-payments/Orders/folder.yaml', 'utf8')
    ) as Record<string, any>;
    const nestedRequestYaml = loadYaml(
      readFileSync(
        'postman/collections/[Baseline] core-payments/Orders/Create Order.request.yaml',
        'utf8'
      )
    ) as Record<string, any>;
    const resourcesYaml = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as Record<
      string,
      any
    >;
    const workflowsYaml = loadYaml(readFileSync('.postman/workflows.yaml', 'utf8')) as Record<
      string,
      any
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
      findMockByCollection: vi.fn().mockResolvedValue(null)
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
        } as any
      }
    );

    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).toHaveBeenCalledTimes(2);
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
      findMockByCollection: vi.fn().mockResolvedValue(null)
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
        repoMutation: repoMutation as any
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
      findMockByCollection: vi.fn().mockResolvedValue(null)
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
        } as any
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
      findMockByCollection: vi.fn().mockResolvedValue(null)
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
        } as any
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
  function makePostman(overrides: Record<string, any> = {}) {
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

  function makeDeps(postman: any, github: any) {
    return {
      core: createCoreStub().core,
      postman,
      github,
      internalIntegration: {
        associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
        connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
      },
      repoMutation: {
        commitAndPush: vi.fn().mockResolvedValue({ commitSha: '', pushed: false, resolvedCurrentRef: 'main' })
      } as any
    };
  }

  it('reuses explicit monitor-id when it exists in Postman', async () => {
    const postman = makePostman({ monitorExists: vi.fn().mockResolvedValue(true) });
    const github = makeGithub();
    const result = await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false, monitorId: 'explicit-mon' }),
      makeDeps(postman, github)
    );
    
    expect(postman.createMonitor).not.toHaveBeenCalled();
    expect(postman.monitorExists).toHaveBeenCalledWith('explicit-mon');
  });

  it('falls through explicit monitor-id when it is stale (deleted)', async () => {
    const postman = makePostman({
      monitorExists: vi.fn().mockResolvedValue(false),
      findMonitorByCollection: vi.fn().mockResolvedValue(null)
    });
    const github = makeGithub();
    const result = await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false, monitorId: 'stale-mon' }),
      makeDeps(postman, github)
    );
    
    expect(postman.createMonitor).toHaveBeenCalled();
  });

  it('discovers existing monitor by smoke collection ID', async () => {
    const postman = makePostman({
      findMonitorByCollection: vi.fn().mockResolvedValue({ uid: 'discovered-mon', name: 'Smoke Monitor' })
    });
    const github = makeGithub();
    const result = await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false }),
      makeDeps(postman, github)
    );
    
    expect(postman.createMonitor).not.toHaveBeenCalled();
    expect(postman.findMonitorByCollection).toHaveBeenCalledWith('col-smoke');
  });

  it('creates a new monitor when no existing asset is found', async () => {
    const postman = makePostman();
    const github = makeGithub();
    const result = await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false }),
      makeDeps(postman, github)
    );
    
    expect(postman.createMonitor).toHaveBeenCalledWith(
      'ws-123',
      'core-payments - Smoke Monitor',
      'col-smoke',
      'env-prod',
      undefined
    );
  });
});

describe('mock resolution paths', () => {
  function makePostman(overrides: Record<string, any> = {}) {
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

  function makeDeps(postman: any, github: any) {
    return {
      core: createCoreStub().core,
      postman,
      github,
      internalIntegration: {
        associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
        connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
      },
      repoMutation: {
        commitAndPush: vi.fn().mockResolvedValue({ commitSha: '', pushed: false, resolvedCurrentRef: 'main' })
      } as any
    };
  }

  it('reuses explicit mock-url from input', async () => {
    const postman = makePostman();
    const github = makeGithub();
    const result = await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false, mockUrl: 'https://explicit-mock.pstmn.io' }),
      makeDeps(postman, github)
    );
    
    expect(postman.createMock).not.toHaveBeenCalled();
  });

  it('discovers existing mock by baseline collection ID', async () => {
    const postman = makePostman({
      findMockByCollection: vi.fn().mockResolvedValue({ uid: 'discovered-mock', mockUrl: 'https://discovered-mock.pstmn.io' })
    });
    const github = makeGithub();
    const result = await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false }),
      makeDeps(postman, github)
    );
    
    expect(postman.createMock).not.toHaveBeenCalled();
    expect(postman.findMockByCollection).toHaveBeenCalledWith('col-baseline');
  });

  it('creates a new mock when no existing asset is found', async () => {
    const postman = makePostman({ findMockByCollection: vi.fn().mockResolvedValue(null) });
    const github = makeGithub();
    const result = await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false }),
      makeDeps(postman, github)
    );
    
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
      execLike as any,
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
      localExecLike as any,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.teamId).toBe('99901');
    expect(inputs.orgMode).toBe(false);
    expect(actionCore.info).not.toHaveBeenCalledWith(expect.stringContaining('Org-mode auto-detected'));
  });

  it('does not set orgMode when teams have no shared organizationId', async () => {
    globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response('', { status: 401 })
    );

    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };

    const execLike = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' })
    };

    const createdApiKey = 'pmak-generated-3';

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
        return jsonResponse({ user: { id: 'u1', name: 'Test', teamId: 88801 } });
      }

      if (urlStr.includes('/teams')) {
        return jsonResponse({
          data: [
            { id: 88801, name: 'Team A', handle: 'team-a', organizationId: 88800 },
            { id: 88802, name: 'Team B', handle: 'team-b', organizationId: 99900 }
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
      execLike as any,
      masker,
      { persistGeneratedApiKeySecret: true, env: {} }
    );

    expect(result.teamId).toBe('88801');
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

  function makePostman(overrides: Record<string, any> = {}) {
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

  function makeDeps(postman: any, github: any) {
    return {
      core: createCoreStub().core,
      postman,
      github,
      internalIntegration: {
        associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
        connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined)
      },
      repoMutation: {
        commitAndPush: vi.fn().mockResolvedValue({ commitSha: '', pushed: false, resolvedCurrentRef: 'main' })
      } as any
    };
  }

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
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        workspaceId: '',
        baselineCollectionId: '',
        smokeCollectionId: '',
        contractCollectionId: ''
      }),
      makeDeps(postman, github)
    );

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
    const result = await runRepoSync(
      createInputs({
        environments: ['prod', 'stage'],
        generateCiWorkflow: false,
        workspaceId: 'ws-123',
        baselineCollectionId: 'col-baseline',
        smokeCollectionId: 'col-smoke',
        contractCollectionId: 'col-contract',
        environmentUids: {}
      }),
      makeDeps(postman, github)
    );

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
    const result = await runRepoSync(
      createInputs({
        environments: ['prod'],
        generateCiWorkflow: false,
        workspaceId: '',
        baselineCollectionId: '',
        smokeCollectionId: '',
        contractCollectionId: ''
      }),
      makeDeps(postman, github)
    );

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
