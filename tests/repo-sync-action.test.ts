import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    committerName: 'Postman FDE',
    committerEmail: 'fde@postman.com',
    postmanApiKey: 'pmak-test',
    postmanAccessToken: 'postman-access-token',
    githubToken: 'github-token',
    ghFallbackToken: 'fallback-token',
    githubAuthMode: 'github_token_first',
    ciWorkflowBase64: '',
    generateCiWorkflow: true,
    ciWorkflowPath: '.github/workflows/ci.yml',
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
      getCollection: vi.fn().mockResolvedValue({ info: { name: 'demo' } }),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] })
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
  });

  it('updates existing environments on reruns instead of creating duplicates', async () => {
    const postman = {
      createEnvironment: vi.fn(),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi.fn().mockResolvedValue({ info: { name: 'demo' } }),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] })
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
      getCollection: vi.fn().mockResolvedValue({ info: { name: 'demo' } }),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] })
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
        stagePaths: expect.arrayContaining(['postman', '.postman', '.github/workflows'])
      })
    );
  });

  it('writes the generated CI workflow to a custom path when configured', async () => {
    const postman = {
      createEnvironment: vi.fn().mockResolvedValue('env-prod'),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      createMock: vi.fn().mockResolvedValue({ uid: 'mock-1', url: 'https://mock.pstmn.io' }),
      createMonitor: vi.fn().mockResolvedValue('mon-1'),
      getCollection: vi.fn().mockResolvedValue({ info: { name: 'demo' } }),
      getEnvironment: vi.fn().mockResolvedValue({ values: [] })
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
