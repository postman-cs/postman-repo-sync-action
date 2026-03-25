import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { load as loadYaml } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readActionInputs,
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
    collectionSyncMode: 'reuse',
    specSyncMode: 'update',
    releaseLabel: undefined,
    setAsCurrent: true,
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
    committerName: 'Postman CSE',
    committerEmail: 'help@postman.com',
    postmanApiKey: 'pmak-test',
    postmanAccessToken: 'postman-access-token',
    githubToken: 'github-token',
    ghFallbackToken: 'fallback-token',
    githubAuthMode: 'github_token_first',
    ciWorkflowBase64: '',
    generateCiWorkflow: true,
    monitorType: 'cloud',
    ciWorkflowPath: '.github/workflows/ci.yml',
    orgMode: false,
    monitorId: '',
    mockUrl: '',
    monitorCron: '',
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
    expect(secrets).toEqual([
      'pmak-test',
      'postman-access-token',
      'github-token',
      'fallback-token'
    ]);
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

    const result = await runRepoSync(createInputs(), {
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
    expect(github.setRepositoryVariable).toHaveBeenCalledWith(
      'POSTMAN_ENV_UIDS_JSON',
      JSON.stringify({
        prod: 'env-prod',
        stage: 'env-stage'
      })
    );
    expect(outputs['repo-sync-summary-json']).toContain('"pushed":true');
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).toContain(
      'name: CI/CD Pipeline'
    );
    expect(readFileSync('.postman/config.json', 'utf8')).toContain('"schemaVersion"');

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
      cloudResources: {
        collections: {
          '../postman/collections/[Baseline] core-payments': 'col-baseline',
          '../postman/collections/[Smoke] core-payments': 'col-smoke',
          '../postman/collections/[Contract] core-payments': 'col-contract'
        }
      },
      localResources: {
        specs: ['../index.yaml']
      }
    });
  });

  it('exports versioned collection directories and preserves current repo vars when requested', async () => {
    const previousRefName = process.env.GITHUB_REF_NAME;
    process.env.GITHUB_REF_NAME = 'release/v1.1.1';

    try {
      const postman = {
        createEnvironment: vi
          .fn()
          .mockResolvedValueOnce('env-prod')
          .mockResolvedValueOnce('env-stage'),
        updateEnvironment: vi.fn().mockResolvedValue(undefined),
        createMock: vi.fn().mockResolvedValue({
          uid: 'mock-v111',
          url: 'https://mock-v111.pstmn.io'
        }),
        createMonitor: vi.fn().mockResolvedValue('mon-v111'),
        getCollection: vi
          .fn()
          .mockResolvedValueOnce(createCollectionFixture('[Baseline] core-payments release-v1.1.1'))
          .mockResolvedValueOnce(createCollectionFixture('[Smoke] core-payments release-v1.1.1'))
          .mockResolvedValueOnce(createCollectionFixture('[Contract] core-payments release-v1.1.1')),
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

      await runRepoSync(
        createInputs({
          collectionSyncMode: 'version',
          specSyncMode: 'version',
          setAsCurrent: false
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

      expect(
        existsSync('postman/collections/[Baseline] core-payments release-v1.1.1/collection.yaml')
      ).toBe(true);

      const resourcesYaml = loadYaml(
        readFileSync('.postman/resources.yaml', 'utf8')
      ) as Record<string, any>;
      expect(resourcesYaml.cloudResources.collections).toEqual({
        '../postman/collections/[Baseline] core-payments release-v1.1.1': 'col-baseline',
        '../postman/collections/[Smoke] core-payments release-v1.1.1': 'col-smoke',
        '../postman/collections/[Contract] core-payments release-v1.1.1': 'col-contract'
      });

      const currentPointerWrites = github.setRepositoryVariable.mock.calls.filter(([name]) =>
        [
          'POSTMAN_ENV_UIDS_JSON',
          'POSTMAN_ENVIRONMENT_UID',
          'RUNTIME_BASE_URL',
          'ENV_RUNTIME_URLS_JSON',
          'MOCK_URL',
          'SMOKE_MONITOR_UID'
        ].includes(String(name))
      );
      expect(currentPointerWrites).toHaveLength(0);
    } finally {
      if (previousRefName === undefined) delete process.env.GITHUB_REF_NAME;
      else process.env.GITHUB_REF_NAME = previousRefName;
    }
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

  it('reuses cached repo variable monitor when it is still valid', async () => {
    const postman = makePostman({
      monitorExists: vi.fn().mockResolvedValue(true),
      findMonitorByCollection: vi.fn().mockResolvedValue(null)
    });
    const github = makeGithub({ SMOKE_MONITOR_UID: 'cached-mon' });
    const result = await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false }),
      makeDeps(postman, github)
    );
    
    expect(postman.createMonitor).not.toHaveBeenCalled();
    expect(postman.monitorExists).toHaveBeenCalledWith('cached-mon');
  });

  it('skips cached repo variable monitor reuse in version mode', async () => {
    const postman = makePostman({
      monitorExists: vi.fn().mockResolvedValue(true),
      findMonitorByCollection: vi.fn().mockResolvedValue(null)
    });
    const github = makeGithub({ SMOKE_MONITOR_UID: 'cached-mon' });
    await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false, collectionSyncMode: 'version', releaseLabel: 'v1.1.1' }),
      makeDeps(postman, github)
    );

    expect(postman.monitorExists).not.toHaveBeenCalledWith('cached-mon');
  });

  it('falls through stale repo variable monitor and creates a new one', async () => {
    const postman = makePostman({
      monitorExists: vi.fn().mockResolvedValue(false),
      findMonitorByCollection: vi.fn().mockResolvedValue(null)
    });
    const github = makeGithub({ SMOKE_MONITOR_UID: 'stale-cached-mon' });
    const result = await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false }),
      makeDeps(postman, github)
    );
    
    expect(postman.createMonitor).toHaveBeenCalled();
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

  it('reuses cached repo variable mock URL', async () => {
    const postman = makePostman({ findMockByCollection: vi.fn().mockResolvedValue(null) });
    const github = makeGithub({ MOCK_URL: 'https://cached-mock.pstmn.io' });
    const result = await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false }),
      makeDeps(postman, github)
    );
    
    expect(postman.createMock).not.toHaveBeenCalled();
  });

  it('skips cached repo variable mock reuse in version mode', async () => {
    const postman = makePostman({ findMockByCollection: vi.fn().mockResolvedValue(null) });
    const github = makeGithub({ MOCK_URL: 'https://cached-mock.pstmn.io' });
    await runRepoSync(
      createInputs({ environments: ['prod'], generateCiWorkflow: false, collectionSyncMode: 'version', releaseLabel: 'v1.1.1' }),
      makeDeps(postman, github)
    );

    expect(postman.createMock).toHaveBeenCalled();
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
