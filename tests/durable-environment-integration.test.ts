import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { load as loadYaml } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveInputs, runRepoSync, type RepoSyncDependencies } from '../src/index.js';
import { RepoMutationPreCommitError } from '../src/lib/github/repo-mutation.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';

const DEFINITION_DIGEST = `env-definition-v1:sha256:${'a'.repeat(64)}`;

type DefinitionInput = {
  slug: string;
  values: Array<{
    key: string;
    value?: string;
    type?: 'default' | 'secret';
    enabled?: boolean;
  }>;
};

type GatewayEnvironmentValue = {
  key: string;
  value: string;
  type: string;
  enabled: boolean;
};

type GatewayEnvironment = {
  id: string;
  owner: string;
  name: string;
  values: GatewayEnvironmentValue[];
};

type GatewayRequest = {
  service: string;
  method: string;
  path: string;
  body?: unknown;
  fallback?: string;
};

const FULL_ENVIRONMENT_DEFINITIONS: DefinitionInput[] = [
  {
    slug: 'dev',
    values: [
      { key: 'baseUrl', value: 'https://dev.example.com' },
      { key: 'apiVersion', value: '2026-08-23' },
      { key: 'featureEnabled', value: 'true', enabled: false },
      { key: 'jwtToken', type: 'secret' }
    ]
  },
  {
    slug: 'dev-refresh',
    values: [
      { key: 'baseUrl', value: 'https://dev-refresh.example.com' },
      { key: 'tenantId', value: 'tenant-refresh' },
      { key: 'optionalValue' },
      { key: 'jwtToken', type: 'secret' }
    ]
  },
  {
    slug: 'test',
    values: [
      { key: 'baseUrl', value: 'https://test.example.com' },
      { key: 'variable1', value: 'value1' },
      { key: 'variable2', value: 'value2', enabled: false },
      { key: 'jwtToken', type: 'secret' }
    ]
  }
];

function normalizedValues(definition: DefinitionInput): GatewayEnvironmentValue[] {
  return definition.values.map((value) => ({
    key: value.key,
    value: value.value ?? '',
    type: value.type ?? 'default',
    enabled: value.enabled ?? true
  }));
}

function fullEnvironmentInputs(options: {
  policy?: 'create-only' | 'refresh';
  definitions?: DefinitionInput[];
  explicitUids?: Record<string, string>;
} = {}) {
  return resolveInputs({
    INPUT_PROJECT_NAME: 'Payments API',
    INPUT_WORKSPACE_ID: 'ws-123',
    INPUT_DURABLE_ENVIRONMENTS_JSON: JSON.stringify(
      options.definitions ?? FULL_ENVIRONMENT_DEFINITIONS
    ),
    INPUT_DURABLE_ENVIRONMENT_OPERATION: 'apply',
    INPUT_DURABLE_ENVIRONMENT_POLICY: options.policy ?? 'create-only',
    INPUT_DURABLE_ENVIRONMENT_UIDS_JSON: JSON.stringify(options.explicitUids ?? {}),
    INPUT_DURABLE_PROJECT_KEY: 'payments',
    INPUT_DURABLE_STATE_REF: 'develop',
    INPUT_CURRENT_REF: 'refs/heads/develop',
    INPUT_REPO_WRITE_MODE: 'commit-and-push',
    INPUT_GIT_PROVIDER: 'azure-devops',
    INPUT_GENERATE_CI_WORKFLOW: 'false'
  });
}

function statefulGatewayDependencies() {
  const owner = '10490519';
  const environments = new Map<string, GatewayEnvironment>();
  const remainingImportFailures = new Map<string, number>();
  const outputs = new Map<string, string>();

  const requestJson = vi.fn(async (request: GatewayRequest) => {
    if (request.service !== 'sync') {
      throw new Error(`Unexpected gateway service ${request.service}`);
    }

    if (request.method === 'post' && request.path.startsWith('/list/environment')) {
      return {
        data: [...environments.values()].map(({ id, name, owner: environmentOwner }) => ({
          id,
          name,
          owner: environmentOwner
        }))
      };
    }

    if (request.method === 'post' && request.path.startsWith('/environment/import')) {
      const body = request.body as {
        id: string;
        name: string;
        values: GatewayEnvironmentValue[];
      };
      const failures = remainingImportFailures.get(body.name) ?? 0;
      if (failures > 0) {
        remainingImportFailures.set(body.name, failures - 1);
        throw new Error('synthetic provider create failure');
      }
      environments.set(body.id, {
        id: body.id,
        owner,
        name: body.name,
        values: structuredClone(body.values)
      });
      return { data: { id: body.id, owner } };
    }

    const getMatch = request.path.match(/^\/environment\/([^/]+)\/sync\?since_id=0$/u);
    if (request.method === 'get' && getMatch) {
      const environment = environments.get(getMatch[1]);
      return environment
        ? { entities: [{ data: structuredClone(environment) }] }
        : { entities: [] };
    }

    const updateMatch = request.path.match(/^\/environment\/([^/]+)$/u);
    if (request.method === 'put' && updateMatch) {
      const body = request.body as {
        id: string;
        name: string;
        values: GatewayEnvironmentValue[];
      };
      const prior = environments.get(updateMatch[1]);
      if (!prior) {
        throw new Error('synthetic update target missing');
      }
      environments.set(updateMatch[1], {
        ...prior,
        name: body.name,
        values: structuredClone(body.values)
      });
      return { data: structuredClone(body) };
    }

    throw new Error(`Unexpected gateway request ${request.method} ${request.path}`);
  });

  const postman = new PostmanGatewayAssetsClient({
    gateway: { requestJson } as never,
    workspaceId: 'ws-123',
    reconcileAttempts: 1,
    reconcileDelayMs: 0,
    sleep: async () => undefined
  });
  const commitAndPush = vi.fn().mockResolvedValue({
    commitSha: 'commit-123',
    pushed: true,
    resolvedCurrentRef: 'develop'
  });
  const dependencies = {
    core: {
      info: vi.fn(),
      warning: vi.fn(),
      notice: vi.fn(),
      setOutput: (name: string, value: string) => outputs.set(name, value)
    },
    postman,
    repoMutation: {
      preflightPush: vi.fn().mockResolvedValue({ resolvedCurrentRef: 'develop' }),
      commitAndPush
    }
  } as unknown as RepoSyncDependencies;

  return {
    dependencies,
    environments,
    outputs,
    requestJson,
    commitAndPush,
    failNextImports(name: string, attempts = 2) {
      remainingImportFailures.set(name, attempts);
    },
    environmentBySlug(slug: string): GatewayEnvironment {
      const name = `Payments API - ${slug}`;
      const environment = [...environments.values()].find((candidate) => candidate.name === name);
      if (!environment) throw new Error(`Missing synthetic environment ${name}`);
      return environment;
    },
    publicUid(slug: string): string {
      const environment = this.environmentBySlug(slug);
      return `${environment.owner}-${environment.id}`;
    }
  };
}

function durableApplyInputs(options: {
  slug?: string;
  policy?: 'create-only' | 'refresh';
  explicitUid?: string;
} = {}) {
  const slug = options.slug ?? 'dev';
  return resolveInputs({
    INPUT_PROJECT_NAME: 'Payments API',
    INPUT_WORKSPACE_ID: 'ws-123',
    INPUT_DURABLE_ENVIRONMENTS_JSON: JSON.stringify([{
      slug,
      values: [{ key: 'baseUrl', value: 'https://dev.example.com' }]
    }]),
    INPUT_DURABLE_ENVIRONMENT_OPERATION: 'apply',
    INPUT_DURABLE_ENVIRONMENT_POLICY: options.policy ?? 'create-only',
    INPUT_DURABLE_ENVIRONMENT_UIDS_JSON: options.explicitUid
      ? JSON.stringify({ [slug]: options.explicitUid })
      : '{}',
    INPUT_DURABLE_PROJECT_KEY: 'payments',
    INPUT_DURABLE_STATE_REF: 'develop',
    INPUT_CURRENT_REF: 'refs/heads/develop',
    INPUT_REPO_WRITE_MODE: 'commit-and-push',
    INPUT_GIT_PROVIDER: 'azure-devops',
    INPUT_GENERATE_CI_WORKFLOW: 'false'
  });
}

function durableDependencies(options: {
  live?: Array<{ name: string; uid: string }>;
  payload?: unknown;
} = {}) {
  const postman = {
    listEnvironments: vi.fn().mockResolvedValue(options.live ?? []),
    createEnvironment: vi.fn().mockResolvedValue('uid-created'),
    updateEnvironment: vi.fn().mockResolvedValue(undefined),
    getEnvironment: vi.fn().mockResolvedValue(options.payload ?? { values: [] })
  };
  const dependencies = {
    core: {
      info: vi.fn(),
      warning: vi.fn(),
      notice: vi.fn(),
      setOutput: vi.fn()
    },
    postman,
    repoMutation: {
      preflightPush: vi.fn().mockResolvedValue({ resolvedCurrentRef: 'develop' }),
      commitAndPush: vi.fn().mockResolvedValue({
        commitSha: 'commit-123',
        pushed: true,
        resolvedCurrentRef: 'develop'
      })
    }
  } as unknown as RepoSyncDependencies;
  return { dependencies, postman };
}

function durablePublicationFailureDependencies(error: Error) {
  const createdLive = [{ name: 'Payments API - dev', uid: 'uid-created' }];
  const { dependencies, postman } = durableDependencies({
    payload: {
      name: 'Payments API - dev',
      values: [{
        key: 'baseUrl',
        value: 'https://dev.example.com',
        type: 'default',
        enabled: true
      }]
    }
  });
  postman.listEnvironments
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValue(createdLive);
  const commitAndPush = vi.fn().mockRejectedValue(error);
  if (!dependencies.repoMutation) throw new Error('test setup failed');
  dependencies.repoMutation.commitAndPush = commitAndPush;
  return { dependencies, commitAndPush };
}

function writeResourcesState(lines: string[]): void {
  mkdirSync('.postman', { recursive: true });
  writeFileSync('.postman/resources.yaml', `${lines.join('\n')}\n`);
}

describe('durable environment repo-sync integration', () => {
  let priorCwd: string;
  let worktree: string;

  beforeEach(() => {
    // Direct runRepoSync tests model their own branch decision. Do not let the
    // hosting CI provider turn every synthetic apply into a pull-request run.
    vi.stubEnv('GITHUB_EVENT_NAME', '');
    vi.stubEnv('GITHUB_HEAD_REF', '');
    priorCwd = process.cwd();
    worktree = mkdtempSync(path.join(tmpdir(), 'durable-environment-integration-'));
    process.chdir(worktree);
  });

  afterEach(() => {
    process.chdir(priorCwd);
    rmSync(worktree, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('applies a new durable environment, redacts its secret slot, and publishes state v3', async () => {
    const definition = JSON.stringify([{
      slug: 'dev',
      values: [
        { key: 'baseUrl', value: 'https://dev.example.com' },
        { key: 'jwtToken', type: 'secret' }
      ]
    }]);
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Payments API',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_DURABLE_ENVIRONMENTS_JSON: definition,
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'apply',
      INPUT_DURABLE_ENVIRONMENT_POLICY: 'create-only',
      INPUT_DURABLE_PROJECT_KEY: 'payments',
      INPUT_DURABLE_STATE_REF: 'develop',
      INPUT_CURRENT_REF: 'refs/heads/develop',
      INPUT_REPO_WRITE_MODE: 'commit-and-push',
      INPUT_GIT_PROVIDER: 'github',
      INPUT_GITHUB_TOKEN: 'github-token',
      INPUT_GENERATE_CI_WORKFLOW: 'false'
    });
    mkdirSync('.github/workflows', { recursive: true });
    writeFileSync('.github/workflows/provision.yml', 'name: Existing Provision\n');

    const values = [
      { key: 'baseUrl', value: 'https://dev.example.com', type: 'default', enabled: true },
      { key: 'jwtToken', value: '', type: 'secret', enabled: true }
    ];
    const createdLive = [{ name: 'Payments API - dev', uid: 'owner-env-dev' }];
    const listEnvironments = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue(createdLive);
    const createEnvironment = vi.fn().mockResolvedValue('owner-env-dev');
    const updateEnvironment = vi.fn();
    const getEnvironment = vi.fn().mockResolvedValue({
      id: 'owner-env-dev',
      name: 'Payments API - dev',
      values
    });
    const outputs = new Map<string, string>();
    const commitAndPush = vi.fn().mockResolvedValue({
      commitSha: 'commit-123',
      pushed: true,
      resolvedCurrentRef: 'develop'
    });
    const dependencies = {
      core: {
        info: vi.fn(),
        warning: vi.fn(),
        notice: vi.fn(),
        setOutput: (name: string, value: string) => outputs.set(name, value)
      },
      postman: {
        listEnvironments,
        createEnvironment,
        updateEnvironment,
        getEnvironment
      },
      repoMutation: {
        preflightPush: vi.fn().mockResolvedValue({ resolvedCurrentRef: 'develop' }),
        commitAndPush
      }
    } as unknown as RepoSyncDependencies;

    const result = await runRepoSync(inputs, dependencies);

    expect(dependencies.repoMutation?.preflightPush).toHaveBeenCalledWith(
      expect.objectContaining({
        authorityPaths: ['.postman/resources.yaml'],
        currentRef: 'develop'
      })
    );
    expect(createEnvironment).toHaveBeenCalledWith(
      'ws-123',
      'Payments API - dev',
      values,
      { onExisting: 'error' }
    );
    expect(updateEnvironment).not.toHaveBeenCalled();
    expect(commitAndPush).toHaveBeenCalledTimes(1);
    expect(commitAndPush).toHaveBeenCalledWith(expect.objectContaining({
      currentRef: 'develop',
      forceStagePaths: [
        '.postman/resources.yaml',
        'postman/environments/Payments API - dev.environment.yaml'
      ],
      removePaths: [],
      stagePaths: [
        '.postman/resources.yaml',
        'postman/environments/Payments API - dev.environment.yaml'
      ]
    }));
    expect(readFileSync('.github/workflows/provision.yml', 'utf8'))
      .toBe('name: Existing Provision\n');
    expect(result['sync-status']).toBe('durable-applied');
    expect(result['durable-environment-uids-json']).toBe('{"dev":"owner-env-dev"}');

    const state = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as {
      version: number;
      canonical: { environments: Record<string, string> };
      environmentProvisioning: {
        projects: {
          payments: {
            environments: {
              dev: { artifact: string; displayName: string; definitionDigest: string };
            };
          };
        };
      };
    };
    expect(state.version).toBe(3);
    const metadata = state.environmentProvisioning.projects.payments.environments.dev;
    expect(state.canonical.environments[metadata.artifact]).toBe('owner-env-dev');
    expect(metadata.displayName).toBe('Payments API - dev');
    expect(metadata.definitionDigest).toMatch(/^env-definition-v1:sha256:[0-9a-f]{64}$/u);

    const artifact = readFileSync('postman/environments/Payments API - dev.environment.yaml', 'utf8');
    expect(artifact).toContain('jwtToken');
    expect(artifact).toContain('secret: true');
    expect(artifact).not.toContain('value: owner-env-dev');
    expect(outputs.get('durable-environment-result-json')).toContain('"statePublished":true');
  });

  it('provisions complete dev, dev-refresh, and test definitions through exact gateway envelopes and converges across lifecycle recovery', async () => {
    const harness = statefulGatewayDependencies();
    const createOnlyInputs = fullEnvironmentInputs();

    const first = await runRepoSync(createOnlyInputs, harness.dependencies);

    expect(first['sync-status']).toBe('durable-applied');
    expect(harness.environments).toHaveLength(3);
    const firstImports = harness.requestJson.mock.calls
      .map(([request]) => request as GatewayRequest)
      .filter((request) =>
        request.method === 'post' && request.path.startsWith('/environment/import')
      );
    expect(firstImports).toHaveLength(3);
    for (const definition of FULL_ENVIRONMENT_DEFINITIONS) {
      expect(firstImports.find((request) =>
        (request.body as { name?: string }).name === `Payments API - ${definition.slug}`
      )).toEqual({
        service: 'sync',
        method: 'post',
        path: '/environment/import?workspace=ws-123',
        body: {
          id: expect.any(String),
          name: `Payments API - ${definition.slug}`,
          values: normalizedValues(definition)
        }
      });

      const artifact = loadYaml(readFileSync(
        `postman/environments/Payments API - ${definition.slug}.environment.yaml`,
        'utf8'
      )) as { values: Array<Record<string, unknown>> };
      const jwtSlot = artifact.values.find((value) => value.key === 'jwtToken');
      expect(jwtSlot).toMatchObject({ key: 'jwtToken', secret: true });
      expect(jwtSlot).not.toHaveProperty('value');
    }

    const dev = harness.environmentBySlug('dev');
    dev.values = [
      ...normalizedValues(FULL_ENVIRONMENT_DEFINITIONS[0]).map((value) =>
        value.key === 'baseUrl'
          ? { ...value, value: 'https://operator-managed.example.com' }
          : value
      ),
      { key: 'operatorOnly', value: 'preserve-me', type: 'default', enabled: true }
    ];
    const writeCountBeforeRepeat = harness.requestJson.mock.calls
      .map(([request]) => request as GatewayRequest)
      .filter((request) => request.method === 'post' || request.method === 'put')
      .filter((request) => !request.path.startsWith('/list/environment')).length;

    const repeated = await runRepoSync(createOnlyInputs, harness.dependencies);

    expect(repeated['sync-status']).toBe('durable-applied');
    const writeCountAfterRepeat = harness.requestJson.mock.calls
      .map(([request]) => request as GatewayRequest)
      .filter((request) => request.method === 'post' || request.method === 'put')
      .filter((request) => !request.path.startsWith('/list/environment')).length;
    expect(writeCountAfterRepeat).toBe(writeCountBeforeRepeat);
    expect(harness.environmentBySlug('dev').values).toContainEqual({
      key: 'operatorOnly',
      value: 'preserve-me',
      type: 'default',
      enabled: true
    });

    const refreshStart = harness.requestJson.mock.calls.length;
    const refreshed = await runRepoSync(
      fullEnvironmentInputs({ policy: 'refresh' }),
      harness.dependencies
    );

    expect(refreshed['sync-status']).toBe('durable-applied');
    const refreshUpdates = harness.requestJson.mock.calls
      .slice(refreshStart)
      .map(([request]) => request as GatewayRequest)
      .filter((request) => request.method === 'put');
    expect(refreshUpdates).toHaveLength(3);
    for (const definition of FULL_ENVIRONMENT_DEFINITIONS) {
      const environment = harness.environmentBySlug(definition.slug);
      expect(refreshUpdates.find((request) =>
        (request.body as { name?: string }).name === environment.name
      )).toEqual({
        service: 'sync',
        method: 'put',
        path: `/environment/${environment.id}`,
        body: {
          id: environment.id,
          name: environment.name,
          values: normalizedValues(definition)
        }
      });
      expect(environment.values).toEqual(normalizedValues(definition));
    }
    expect(harness.environmentBySlug('dev').values).not.toContainEqual(
      expect.objectContaining({ key: 'operatorOnly' })
    );

    const recoveryDefinitions: DefinitionInput[] = [
      ...FULL_ENVIRONMENT_DEFINITIONS,
      {
        slug: 'stage',
        values: [
          { key: 'baseUrl', value: 'https://stage.example.com' },
          { key: 'region', value: 'us-east' },
          { key: 'jwtToken', type: 'secret' }
        ]
      },
      {
        slug: 'qa',
        values: [
          { key: 'baseUrl', value: 'https://qa.example.com' },
          { key: 'suite', value: 'contract' },
          { key: 'jwtToken', type: 'secret' }
        ]
      }
    ];
    harness.failNextImports('Payments API - qa');

    await expect(runRepoSync(
      fullEnvironmentInputs({ definitions: recoveryDefinitions }),
      harness.dependencies
    )).rejects.toMatchObject({
      code: 'DURABLE_ENVIRONMENT_PARTIAL_APPLY_FAILED',
      failedSlug: 'qa'
    });

    const partial = JSON.parse(
      harness.outputs.get('durable-environment-result-json') ?? '{}'
    ) as {
      status?: string;
      entries?: Array<{ slug?: string; uid?: string; statePublished?: boolean }>;
    };
    const stageUid = harness.publicUid('stage');
    expect(partial.status).toBe('partial-failure');
    expect(partial.entries).toContainEqual(expect.objectContaining({
      slug: 'stage',
      uid: stageUid,
      statePublished: false
    }));
    expect([...harness.environments.values()].filter((environment) =>
      environment.name === 'Payments API - stage'
    )).toHaveLength(1);
    expect([...harness.environments.values()].some((environment) =>
      environment.name === 'Payments API - qa'
    )).toBe(false);

    const recovered = await runRepoSync(
      fullEnvironmentInputs({
        definitions: recoveryDefinitions,
        explicitUids: { stage: stageUid }
      }),
      harness.dependencies
    );

    expect(recovered['sync-status']).toBe('durable-applied');
    expect(harness.environments).toHaveLength(5);
    expect([...harness.environments.values()].filter((environment) =>
      environment.name === 'Payments API - stage'
    )).toHaveLength(1);
    const importNames = harness.requestJson.mock.calls
      .map(([request]) => request as GatewayRequest)
      .filter((request) =>
        request.method === 'post' && request.path.startsWith('/environment/import')
      )
      .map((request) => (request.body as { name: string }).name);
    expect(importNames.filter((name) => name === 'Payments API - stage')).toHaveLength(1);
    expect(importNames.filter((name) => name === 'Payments API - qa')).toHaveLength(3);
    expect(JSON.parse(recovered['durable-environment-uids-json'])).toEqual({
      dev: harness.publicUid('dev'),
      'dev-refresh': harness.publicUid('dev-refresh'),
      test: harness.publicUid('test'),
      stage: stageUid,
      qa: harness.publicUid('qa')
    });
    expect(harness.commitAndPush).toHaveBeenCalledTimes(4);
  });

  it('repeats unchanged with a stable UID, no duplicate write, and a verified up-to-date push', async () => {
    const inputs = durableApplyInputs();
    const values = [
      { key: 'baseUrl', value: 'https://dev.example.com', type: 'default', enabled: true }
    ];
    let created = false;
    const live = [{ name: 'Payments API - dev', uid: 'uid-stable' }];
    const listEnvironments = vi.fn(async () => created ? live : []);
    const createEnvironment = vi.fn(async () => {
      created = true;
      return 'uid-stable';
    });
    const outputs = new Map<string, string>();
    const commitAndPush = vi.fn()
      .mockResolvedValueOnce({
        commitSha: 'commit-created',
        pushed: true,
        resolvedCurrentRef: 'develop'
      })
      .mockResolvedValueOnce({
        commitSha: 'commit-created',
        pushed: true,
        resolvedCurrentRef: 'develop'
      });
    const dependencies = {
      core: {
        info: vi.fn(),
        warning: vi.fn(),
        notice: vi.fn(),
        setOutput: (name: string, value: string) => outputs.set(name, value)
      },
      postman: {
        listEnvironments,
        createEnvironment,
        updateEnvironment: vi.fn(),
        getEnvironment: vi.fn().mockResolvedValue({
          id: 'uid-stable',
          name: 'Payments API - dev',
          values
        })
      },
      repoMutation: {
        preflightPush: vi.fn().mockResolvedValue({ resolvedCurrentRef: 'develop' }),
        commitAndPush
      }
    } as unknown as RepoSyncDependencies;

    await runRepoSync(inputs, dependencies);
    const repeated = await runRepoSync(inputs, dependencies);

    expect(createEnvironment).toHaveBeenCalledOnce();
    expect(dependencies.postman.updateEnvironment).not.toHaveBeenCalled();
    expect(commitAndPush).toHaveBeenCalledTimes(2);
    expect(repeated['durable-environment-uids-json']).toBe('{"dev":"uid-stable"}');
    expect(JSON.parse(repeated['durable-environment-result-json'])).toMatchObject({
      entries: [{
        action: 'reused-preserved',
        uid: 'uid-stable',
        cloudApplied: true,
        statePublished: true
      }]
    });
  });

  it('rejects commit-only before the first durable environment write', async () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Payments API',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_DURABLE_ENVIRONMENTS_JSON: JSON.stringify([{
        slug: 'dev',
        values: [{ key: 'baseUrl', value: 'https://dev.example.com' }]
      }]),
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'apply',
      INPUT_DURABLE_PROJECT_KEY: 'payments',
      INPUT_DURABLE_STATE_REF: 'develop',
      INPUT_CURRENT_REF: 'develop',
      INPUT_REPO_WRITE_MODE: 'commit-only',
      INPUT_GIT_PROVIDER: 'azure-devops'
    });
    const createEnvironment = vi.fn();
    const updateEnvironment = vi.fn();
    const commitAndPush = vi.fn();
    const dependencies = {
      core: { info: vi.fn(), warning: vi.fn(), notice: vi.fn(), setOutput: vi.fn() },
      postman: {
        listEnvironments: vi.fn().mockResolvedValue([]),
        createEnvironment,
        updateEnvironment,
        getEnvironment: vi.fn()
      },
      repoMutation: {
        preflightPush: vi.fn().mockResolvedValue({ resolvedCurrentRef: 'develop' }),
        commitAndPush
      }
    } as unknown as RepoSyncDependencies;

    await expect(runRepoSync(inputs, dependencies)).rejects.toThrow(
      /requires repo-write-mode=commit-and-push/
    );
    expect(createEnvironment).not.toHaveBeenCalled();
    expect(updateEnvironment).not.toHaveBeenCalled();
    expect(commitAndPush).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'unsupported git provider',
      overrides: { provider: 'bitbucket' as const },
      error: /cannot publish state with git provider "bitbucket"/
    },
    {
      name: 'missing non-ADO push token',
      overrides: {
        provider: 'github' as const,
        githubToken: '',
        ghFallbackToken: ''
      },
      error: /requires a push token for git provider "github"/
    },
    {
      name: 'unresolved state ref checkout',
      overrides: {
        currentRef: '',
        githubHeadRef: '',
        githubRefName: ''
      },
      error: /resolved current ref: "unknown"/
    }
  ])('rejects $name before Postman discovery or mutation', async ({ overrides, error }) => {
    const { dependencies, postman } = durableDependencies();
    const inputs = { ...durableApplyInputs(), ...overrides };

    await expect(runRepoSync(inputs, dependencies)).rejects.toThrow(error);

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
  });

  it('rejects an authenticated publication preflight failure before Postman discovery', async () => {
    const { dependencies, postman } = durableDependencies();
    dependencies.repoMutation!.preflightPush = vi.fn().mockRejectedValue(
      new Error('REPO_PUSH_PREFLIGHT_FAILED')
    );

    await expect(runRepoSync(durableApplyInputs(), dependencies)).rejects.toThrow(
      /REPO_PUSH_PREFLIGHT_FAILED/
    );

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
  });

  it('emits sanitized completed-entry recovery outputs before a partial apply failure', async () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Payments API',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_DURABLE_ENVIRONMENTS_JSON: JSON.stringify([
        { slug: 'dev', values: [{ key: 'baseUrl', value: 'https://dev.example.com' }] },
        { slug: 'qa', values: [{ key: 'baseUrl', value: 'https://qa.example.com' }] }
      ]),
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'apply',
      INPUT_DURABLE_PROJECT_KEY: 'payments',
      INPUT_DURABLE_STATE_REF: 'develop',
      INPUT_CURRENT_REF: 'develop',
      INPUT_REPO_WRITE_MODE: 'commit-and-push',
      INPUT_GIT_PROVIDER: 'azure-devops'
    });
    const outputs = new Map<string, string>();
    const createEnvironment = vi.fn()
      .mockResolvedValueOnce('owner-env-dev')
      .mockRejectedValueOnce(new Error('provider detail must not enter recovery output'));
    const devLive = [{ name: 'Payments API - dev', uid: 'owner-env-dev' }];
    const dependencies = {
      core: {
        info: vi.fn(),
        warning: vi.fn(),
        notice: vi.fn(),
        setOutput: (name: string, value: string) => outputs.set(name, value)
      },
      postman: {
        listEnvironments: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce(devLive)
          .mockResolvedValueOnce(devLive),
        createEnvironment,
        updateEnvironment: vi.fn(),
        getEnvironment: vi.fn().mockResolvedValue({
          values: [{ key: 'baseUrl', value: 'https://dev.example.com', type: 'default', enabled: true }]
        })
      },
      repoMutation: {
        preflightPush: vi.fn().mockResolvedValue({ resolvedCurrentRef: 'develop' }),
        commitAndPush: vi.fn()
      }
    } as unknown as RepoSyncDependencies;

    await expect(runRepoSync(inputs, dependencies)).rejects.toMatchObject({
      code: 'DURABLE_ENVIRONMENT_PARTIAL_APPLY_FAILED',
      failedSlug: 'qa'
    });

    const recoveryRaw = outputs.get('durable-environment-result-json') ?? '';
    expect(JSON.parse(recoveryRaw)).toMatchObject({
      operation: 'apply',
      status: 'partial-failure',
      entries: [{
        slug: 'dev',
        uid: 'owner-env-dev',
        action: 'create',
        cloudApplied: true,
        statePublished: false
      }],
      failure: { slug: 'qa', category: 'apply-failed' }
    });
    expect(outputs.get('durable-environment-uids-json')).toBe('{"dev":"owner-env-dev"}');
    expect(outputs.get('sync-status')).toBe('durable-partial-failure');
    expect(recoveryRaw).not.toContain('provider detail');
    expect(recoveryRaw).not.toContain('https://dev.example.com');
  });

  it('does not claim state publication when commit-and-push reports no push', async () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Payments API',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_DURABLE_ENVIRONMENTS_JSON: JSON.stringify([{
        slug: 'dev',
        values: [{ key: 'baseUrl', value: 'https://dev.example.com' }]
      }]),
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'apply',
      INPUT_DURABLE_PROJECT_KEY: 'payments',
      INPUT_DURABLE_STATE_REF: 'develop',
      INPUT_CURRENT_REF: 'develop',
      INPUT_REPO_WRITE_MODE: 'commit-and-push',
      INPUT_GIT_PROVIDER: 'azure-devops'
    });
    const outputs = new Map<string, string>();
    const createdLive = [{ name: 'Payments API - dev', uid: 'owner-env-dev' }];
    const dependencies = {
      core: {
        info: vi.fn(),
        warning: vi.fn(),
        notice: vi.fn(),
        setOutput: (name: string, value: string) => outputs.set(name, value)
      },
      postman: {
        listEnvironments: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValue(createdLive),
        createEnvironment: vi.fn().mockResolvedValue('owner-env-dev'),
        updateEnvironment: vi.fn(),
        getEnvironment: vi.fn().mockResolvedValue({
          name: 'Payments API - dev',
          values: [{ key: 'baseUrl', value: 'https://dev.example.com', type: 'default', enabled: true }]
        })
      },
      repoMutation: {
        preflightPush: vi.fn().mockResolvedValue({ resolvedCurrentRef: 'develop' }),
        commitAndPush: vi.fn().mockResolvedValue({
          commitSha: '',
          pushed: false,
          resolvedCurrentRef: 'develop'
        })
      }
    } as unknown as RepoSyncDependencies;

    await expect(runRepoSync(inputs, dependencies)).rejects.toThrow(/did not push/);
    const recoveryRaw = outputs.get('durable-environment-result-json') ?? '';
    expect(recoveryRaw).toContain('"statePublished":false');
    expect(recoveryRaw).not.toContain('"statePublished":true');
    expect(outputs.get('sync-status')).toBe('durable-state-not-published');
  });

  it('restores promoted state and artifacts when publication fails before commit', async () => {
    const priorState = [
      'version: 2',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  collections:',
      '    ../postman/collections/baseline.collection.yaml: collection-uid',
      ''
    ].join('\n');
    writeResourcesState(priorState.trimEnd().split('\n'));
    const artifactPath = 'postman/environments/Payments API - dev.environment.yaml';
    const { dependencies, commitAndPush } = durablePublicationFailureDependencies(
      new RepoMutationPreCommitError('commit-msg hook rejected publication')
    );
    commitAndPush.mockImplementation(async () => {
      expect(readFileSync('.postman/resources.yaml', 'utf8')).not.toBe(priorState);
      expect(readFileSync(artifactPath, 'utf8')).toContain('Payments API - dev');
      throw new RepoMutationPreCommitError('commit-msg hook rejected publication');
    });

    await expect(runRepoSync(durableApplyInputs(), dependencies))
      .rejects.toBeInstanceOf(RepoMutationPreCommitError);

    expect(commitAndPush).toHaveBeenCalledTimes(1);
    expect(readFileSync('.postman/resources.yaml', 'utf8')).toBe(priorState);
    expect(() => readFileSync(artifactPath, 'utf8')).toThrow();
  });

  it('does not restore working files when pre-commit index cleanup is incomplete', async () => {
    const priorState = 'version: 2\nworkspace:\n  id: ws-123\n';
    writeResourcesState(priorState.trimEnd().split('\n'));
    const artifactPath = 'postman/environments/Payments API - dev.environment.yaml';
    const { dependencies } = durablePublicationFailureDependencies(
      new RepoMutationPreCommitError('index cleanup failed', false)
    );

    await expect(runRepoSync(durableApplyInputs(), dependencies))
      .rejects.toMatchObject({ indexRestored: false });

    expect(readFileSync('.postman/resources.yaml', 'utf8')).not.toBe(priorState);
    expect(readFileSync(artifactPath, 'utf8')).toContain('Payments API - dev');
  });

  it('preserves promoted files when publication fails after a commit may exist', async () => {
    const priorState = [
      'version: 2',
      'workspace:',
      '  id: ws-123',
      ''
    ].join('\n');
    writeResourcesState(priorState.trimEnd().split('\n'));
    const artifactPath = 'postman/environments/Payments API - dev.environment.yaml';
    const { dependencies } = durablePublicationFailureDependencies(
      new Error('push failed after generated commit')
    );

    await expect(runRepoSync(durableApplyInputs(), dependencies))
      .rejects.toThrow('push failed after generated commit');

    expect(readFileSync('.postman/resources.yaml', 'utf8')).not.toBe(priorState);
    expect(readFileSync(artifactPath, 'utf8')).toContain('Payments API - dev');
  });

  it('revalidates final value metadata before publishing durable YAML or state', async () => {
    let created = false;
    const live = [{ name: 'Payments API - dev', uid: 'uid-created' }];
    const goodPayload = {
      name: 'Payments API - dev',
      values: [{
        key: 'baseUrl',
        value: 'https://dev.example.com',
        type: 'default',
        enabled: true
      }]
    };
    const postman = {
      listEnvironments: vi.fn(async () => created ? live : []),
      createEnvironment: vi.fn(async () => {
        created = true;
        return 'uid-created';
      }),
      updateEnvironment: vi.fn(),
      getEnvironment: vi.fn()
        .mockResolvedValueOnce(goodPayload)
        .mockResolvedValueOnce({
          ...goodPayload,
          values: [{ ...goodPayload.values[0], value: 'https://drifted.example.com' }]
        })
    };
    const { dependencies } = durableDependencies();
    dependencies.postman = postman as unknown as RepoSyncDependencies['postman'];

    await expect(runRepoSync(durableApplyInputs(), dependencies)).rejects.toThrow(
      /value metadata changed before state publication/
    );

    expect(dependencies.repoMutation?.commitAndPush).not.toHaveBeenCalled();
    expect(() => readFileSync(
      'postman/environments/Payments API - dev.environment.yaml',
      'utf8'
    )).toThrow();
    expect(() => readFileSync('.postman/resources.yaml', 'utf8')).toThrow();
  });

  it('revalidates the final live UID/name binding before publishing durable state', async () => {
    const live = [{ name: 'Payments API - dev', uid: 'uid-created' }];
    const listEnvironments = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce([{ name: 'Renamed elsewhere', uid: 'uid-created' }]);
    const { dependencies, postman } = durableDependencies({
      payload: {
        name: 'Payments API - dev',
        values: [{
          key: 'baseUrl',
          value: 'https://dev.example.com',
          type: 'default',
          enabled: true
        }]
      }
    });
    postman.listEnvironments = listEnvironments;

    await expect(runRepoSync(durableApplyInputs(), dependencies)).rejects.toThrow(
      /UID\/name binding changed before state publication/
    );

    expect(postman.getEnvironment).toHaveBeenCalledOnce();
    expect(dependencies.repoMutation?.commitAndPush).not.toHaveBeenCalled();
    expect(() => readFileSync('.postman/resources.yaml', 'utf8')).toThrow();
  });

  it('prepares every durable YAML payload before promoting the first artifact', async () => {
    const definitions = [
      { slug: 'dev', values: [{ key: 'baseUrl', value: 'https://dev.example.com' }] },
      { slug: 'qa', values: [{ key: 'baseUrl', value: 'https://qa.example.com' }] }
    ];
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Payments API',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_DURABLE_ENVIRONMENTS_JSON: JSON.stringify(definitions),
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'apply',
      INPUT_DURABLE_ENVIRONMENT_POLICY: 'create-only',
      INPUT_DURABLE_ENVIRONMENT_UIDS_JSON: '{"dev":"uid-dev","qa":"uid-qa"}',
      INPUT_DURABLE_PROJECT_KEY: 'payments',
      INPUT_DURABLE_STATE_REF: 'develop',
      INPUT_CURRENT_REF: 'develop',
      INPUT_REPO_WRITE_MODE: 'commit-and-push',
      INPUT_GIT_PROVIDER: 'azure-devops',
      INPUT_GENERATE_CI_WORKFLOW: 'false'
    });
    const live = [
      { name: 'Payments API - dev', uid: 'uid-dev' },
      { name: 'Payments API - qa', uid: 'uid-qa' }
    ];
    const readsByUid = new Map<string, number>();
    const getEnvironment = vi.fn(async (uid: string) => {
      const read = (readsByUid.get(uid) ?? 0) + 1;
      readsByUid.set(uid, read);
      if (uid === 'uid-qa' && read === 3) {
        return { name: 'Payments API - qa' };
      }
      const slug = uid === 'uid-dev' ? 'dev' : 'qa';
      return {
        name: `Payments API - ${slug}`,
        values: [{
          key: 'baseUrl',
          value: `https://${slug}.example.com`,
          type: 'default',
          enabled: true
        }]
      };
    });
    const { dependencies, postman } = durableDependencies({ live });
    postman.getEnvironment = getEnvironment;

    await expect(runRepoSync(inputs, dependencies)).rejects.toThrow(
      /incomplete payload without values/
    );

    expect(readsByUid).toEqual(new Map([['uid-dev', 3], ['uid-qa', 3]]));
    expect(dependencies.repoMutation?.commitAndPush).not.toHaveBeenCalled();
    expect(() => readFileSync(
      'postman/environments/Payments API - dev.environment.yaml',
      'utf8'
    )).toThrow();
    expect(() => readFileSync('.postman/resources.yaml', 'utf8')).toThrow();
  });

  it('rejects a noncanonical v2 environment ref before Postman discovery or mutation', async () => {
    writeResourcesState([
      'version: 2',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  environments:',
      '    ../postman/environments/./Payments API - dev.environment.yaml: uid-dev'
    ]);
    const { dependencies, postman } = durableDependencies({
      live: [{ name: 'Payments API - dev', uid: 'uid-dev' }]
    });

    await expect(runRepoSync(
      durableApplyInputs({ policy: 'refresh', explicitUid: 'uid-dev' }),
      dependencies
    )).rejects.toThrow(/canonical repository-relative manifest reference/);

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.getEnvironment).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(dependencies.repoMutation?.commitAndPush).not.toHaveBeenCalled();
  });

  it('rejects a noncanonical legacy environment ref before Postman discovery or mutation', async () => {
    writeResourcesState([
      'version: 2',
      'workspace:',
      '  id: ws-123',
      'cloudResources:',
      '  environments:',
      '    ../postman/environments/./Payments API - dev.environment.yaml: uid-dev'
    ]);
    const { dependencies, postman } = durableDependencies({
      live: [{ name: 'Payments API - dev', uid: 'uid-dev' }]
    });

    await expect(runRepoSync(
      durableApplyInputs({ policy: 'refresh', explicitUid: 'uid-dev' }),
      dependencies
    )).rejects.toThrow(/canonical repository-relative manifest reference/);

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.getEnvironment).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(dependencies.repoMutation?.commitAndPush).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'state v1',
      state: ['version: 1', 'workspace:', '  id: ws-123'],
      error: /requires resources state v2 or v3/
    },
    {
      name: 'a different tracked workspace',
      state: ['version: 2', 'workspace:', '  id: ws-other', 'canonical: {}'],
      error: /tracked workspace ws-other does not match durable workspace ws-123/
    },
    {
      name: 'a non-string canonical environment UID',
      state: [
        'version: 2',
        'workspace:',
        '  id: ws-123',
        'canonical:',
        '  environments:',
        '    ../postman/environments/Other API - qa.environment.yaml: 123'
      ],
      error: /must be a non-empty string without surrounding whitespace/
    }
  ])('rejects $name with zero cloud writes', async ({ state, error }) => {
    writeResourcesState(state);
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(durableApplyInputs(), dependencies)).rejects.toThrow(error);

    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(postman.listEnvironments).not.toHaveBeenCalled();
  });

  it('rejects canonical same-ref/different-UID ownership before create', async () => {
    writeResourcesState([
      'version: 2',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  environments:',
      '    ../postman/environments/Payments API - dev.environment.yaml: uid-prior'
    ]);
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(durableApplyInputs(), dependencies))
      .rejects.toThrow(/resolve to the same artifact filename/);

    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(postman.listEnvironments).not.toHaveBeenCalled();
  });

  it('rejects unsafe and unowned durable artifact targets before discovery', async () => {
    const unsafe = durableDependencies();
    const unsafeInputs = durableApplyInputs();
    unsafeInputs.artifactDir = '../outside';

    await expect(runRepoSync(unsafeInputs, unsafe.dependencies)).rejects.toThrow(
      /repository root|durable environment directory/
    );
    expect(unsafe.postman.listEnvironments).not.toHaveBeenCalled();
    expect(unsafe.postman.createEnvironment).not.toHaveBeenCalled();

    mkdirSync('postman/environments', { recursive: true });
    writeFileSync(
      'postman/environments/Payments API - dev.environment.yaml',
      'name: Unowned environment\nvalues: []\n'
    );
    const unowned = durableDependencies();

    await expect(runRepoSync(durableApplyInputs(), unowned.dependencies)).rejects.toThrow(
      /exists but is not tracked/
    );
    expect(unowned.postman.listEnvironments).not.toHaveBeenCalled();
    expect(unowned.postman.createEnvironment).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects an in-repository symlinked durable output directory before discovery',
    async () => {
      mkdirSync('durable-output/environments', { recursive: true });
      symlinkSync(path.resolve('durable-output'), 'postman', 'dir');
      const { dependencies, postman } = durableDependencies();

      await expect(runRepoSync(durableApplyInputs(), dependencies)).rejects.toThrow(
        /symbolic link/
      );

      expect(postman.listEnvironments).not.toHaveBeenCalled();
      expect(postman.createEnvironment).not.toHaveBeenCalled();
      expect(postman.updateEnvironment).not.toHaveBeenCalled();
    }
  );

  it.each([
    'postman/environments',
    '.postman'
  ])('rejects a non-directory output path at %s before cloud mutation', async (blockedPath) => {
    const parent = path.dirname(blockedPath);
    if (parent !== '.') {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(blockedPath, 'not a directory\n');
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(durableApplyInputs(), dependencies)).rejects.toThrow(
      /cannot be created because .* is not a directory/
    );

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
  });

  it('rejects dirty durable authority before reading it or calling Postman', async () => {
    writeResourcesState(['not: [valid']);
    const { dependencies, postman } = durableDependencies();
    vi.mocked(dependencies.repoMutation!.preflightPush).mockRejectedValue(
      new Error('DURABLE_STATE_DIRTY: local durable state differs from HEAD')
    );

    await expect(runRepoSync(durableApplyInputs(), dependencies)).rejects.toThrow(
      'DURABLE_STATE_DIRTY'
    );

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
  });

  it('rejects portable filename collisions from truncation before discovery', async () => {
    const common = 'environment-with-a-shared-prefix-'.repeat(3);
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Payments API',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_DURABLE_ENVIRONMENTS_JSON: JSON.stringify([
        { slug: `${common}one`, values: [] },
        { slug: `${common}two`, values: [] }
      ]),
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'apply',
      INPUT_DURABLE_PROJECT_KEY: 'payments',
      INPUT_DURABLE_STATE_REF: 'develop',
      INPUT_CURRENT_REF: 'develop',
      INPUT_REPO_WRITE_MODE: 'commit-and-push',
      INPUT_GIT_PROVIDER: 'azure-devops'
    });
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(inputs, dependencies)).rejects.toThrow(
      /resolve to the same artifact filename/
    );
    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
  });

  it('rejects case-folded collisions with preserved canonical artifacts before discovery', async () => {
    writeResourcesState([
      'version: 2',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  environments:',
      '    ../postman/environments/PAYMENTS API - DEV.environment.yaml: uid-branch'
    ]);
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(durableApplyInputs(), dependencies)).rejects.toThrow(
      /resolve to the same artifact filename/
    );
    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
  });

  it('rejects case-folded collisions with untracked sibling artifacts before discovery', async () => {
    const siblingPath = 'postman/environments/PAYMENTS API - DEV.environment.yaml';
    mkdirSync(path.dirname(siblingPath), { recursive: true });
    writeFileSync(siblingPath, 'untracked sibling canary\n');
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(durableApplyInputs(), dependencies)).rejects.toThrow(
      /resolve to the same artifact filename/
    );

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.getEnvironment).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(dependencies.repoMutation?.commitAndPush).not.toHaveBeenCalled();
    expect(readFileSync(siblingPath, 'utf8')).toBe('untracked sibling canary\n');
  });

  it('rejects a canonical cross-resource-class artifact claim before create', async () => {
    writeResourcesState([
      'version: 2',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  collections:',
      '    ../postman/environments/Payments API - dev.environment.yaml: collection-uid'
    ]);
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(durableApplyInputs(), dependencies))
      .rejects.toThrow(/resolve to the same artifact filename/);

    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(postman.listEnvironments).not.toHaveBeenCalled();
  });

  it('adopts an explicitly reviewed v2 same-ref and same-UID mapping into v3 metadata', async () => {
    writeResourcesState([
      'version: 2',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  environments:',
      '    ../postman/environments/Payments API - dev.environment.yaml: uid-dev'
    ]);
    mkdirSync('postman/environments', { recursive: true });
    writeFileSync(
      'postman/environments/Payments API - dev.environment.yaml',
      'name: Payments API - dev\nvalues: []\n'
    );
    const { dependencies, postman } = durableDependencies({
      live: [{ name: 'Payments API - dev', uid: 'uid-dev' }],
      payload: {
        name: 'Payments API - dev',
        values: [{
          key: 'baseUrl',
          value: 'https://dev.example.com',
          type: 'default',
          enabled: true
        }]
      }
    });

    const result = await runRepoSync(
      durableApplyInputs({ explicitUid: 'uid-dev' }),
      dependencies
    );

    expect(result['durable-environment-uids-json']).toBe('{"dev":"uid-dev"}');
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    const state = loadYaml(readFileSync('.postman/resources.yaml', 'utf8')) as {
      version: number;
      environmentProvisioning?: { projects?: { payments?: { environments?: { dev?: unknown } } } };
    };
    expect(state.version).toBe(3);
    expect(state.environmentProvisioning?.projects?.payments?.environments?.dev).toBeDefined();
  });

  it('rejects canonical same-UID/different-ref ownership before refresh', async () => {
    writeResourcesState([
      'version: 2',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  environments:',
      '    ../postman/environments/Other API - qa.environment.yaml: uid-dev'
    ]);
    const { dependencies, postman } = durableDependencies({
      live: [{ name: 'Payments API - dev', uid: 'uid-dev' }]
    });

    await expect(runRepoSync(
      durableApplyInputs({ policy: 'refresh', explicitUid: 'uid-dev' }),
      dependencies
    )).rejects.toThrow(/UID is claimed by another canonical resource/);

    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(postman.listEnvironments).not.toHaveBeenCalled();
  });

  it('rejects another durable project UID ownership before refresh', async () => {
    writeResourcesState([
      'version: 3',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  environments:',
      '    ../postman/environments/Orders API - qa.environment.yaml: uid-dev',
      'environmentProvisioning:',
      '  projects:',
      '    orders:',
      '      environments:',
      '        qa:',
      '          artifact: ../postman/environments/Orders API - qa.environment.yaml',
      '          displayName: Orders API - qa',
      '          policy: create-only',
      `          definitionDigest: ${DEFINITION_DIGEST}`
    ]);
    const { dependencies, postman } = durableDependencies({
      live: [{ name: 'Payments API - dev', uid: 'uid-dev' }]
    });

    await expect(runRepoSync(
      durableApplyInputs({ policy: 'refresh', explicitUid: 'uid-dev' }),
      dependencies
    )).rejects.toThrow(/claimed by another canonical resource|conflicts with tracked durable/);

    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
    expect(postman.listEnvironments).not.toHaveBeenCalled();
  });

  it('rejects recognizable Mock and branch-marker ownership before mutation', async () => {
    const mock = durableDependencies();
    await expect(runRepoSync(
      durableApplyInputs({ slug: 'mock' }),
      mock.dependencies
    )).rejects.toThrow(/resolve to the same artifact filename/);
    expect(mock.postman.createEnvironment).not.toHaveBeenCalled();

    const marked = durableDependencies({
      live: [{ name: 'Payments API - dev', uid: 'uid-dev' }],
      payload: {
        values: [{ key: 'x-pm-onboarding', value: '{}', type: 'default' }]
      }
    });
    await expect(runRepoSync(
      durableApplyInputs({ policy: 'refresh', explicitUid: 'uid-dev' }),
      marked.dependencies
    )).rejects.toThrow(/owned by the branch asset lifecycle/);
    expect(marked.postman.updateEnvironment).not.toHaveBeenCalled();
  });

  it('rejects same-repository PR preview apply before discovery or mutation', async () => {
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(durableApplyInputs(), dependencies, {
      branchDecision: {
        tier: 'preview',
        strategy: 'preview',
        identity: {
          provider: 'github',
          headBranch: 'feature/environment-change',
          rawRef: 'refs/pull/42/merge',
          defaultBranch: 'main',
          refKind: 'branch',
          isPrContext: true,
          isForkPr: false
        },
        canonicalBranch: 'main',
        reason: 'same-repository pull request'
      }
    })).rejects.toThrow(/not authorized for pull-request or preview execution/);

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
  });

  it('rejects a pull request even when its head is classified as canonical', async () => {
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(durableApplyInputs(), dependencies, {
      branchDecision: {
        tier: 'canonical',
        strategy: 'preview',
        identity: {
          provider: 'github',
          headBranch: 'develop',
          rawRef: 'refs/pull/44/merge',
          defaultBranch: 'develop',
          refKind: 'default-branch',
          isPrContext: true,
          isForkPr: false
        },
        canonicalBranch: 'develop',
        reason: 'head branch equals canonical branch develop'
      }
    })).rejects.toThrow(/not authorized for pull-request or canonical execution/);

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
  });

  it.each([
    ['GitHub', 'GITHUB_EVENT_NAME', 'schedule'],
    ['Bitbucket', 'BITBUCKET_PIPELINE_TRIGGER_TYPE', 'schedule']
  ])('rejects %s scheduled durable apply before repository preflight or Postman discovery', async (
    _provider,
    environmentKey,
    environmentValue
  ) => {
    vi.stubEnv(environmentKey, environmentValue);
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(durableApplyInputs(), dependencies)).rejects.toThrow(
      /not authorized for scheduled execution/
    );

    expect(dependencies.repoMutation?.preflightPush).not.toHaveBeenCalled();
    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.getEnvironment).not.toHaveBeenCalled();
  });

  it('rejects spec-only durable apply before any cloud or repository mutation', async () => {
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(
      { ...durableApplyInputs(), onboardingScope: 'spec-only' },
      dependencies
    )).rejects.toThrow(/requires onboarding-scope=full/);

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(dependencies.repoMutation?.preflightPush).not.toHaveBeenCalled();
    expect(dependencies.repoMutation?.commitAndPush).not.toHaveBeenCalled();
  });

  it('does not report an unvalidated explicit UID from an offline plan', async () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Payments API',
      INPUT_DURABLE_ENVIRONMENTS_JSON: JSON.stringify([{
        slug: 'dev',
        values: [{ key: 'baseUrl', value: 'https://dev.example.com' }]
      }]),
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'plan',
      INPUT_DURABLE_ENVIRONMENT_UIDS_JSON: '{"dev":"uid-unvalidated"}',
      INPUT_DURABLE_PROJECT_KEY: 'payments'
    });
    const { dependencies, postman } = durableDependencies();

    const result = await runRepoSync(inputs, dependencies);

    expect(result['sync-status']).toBe('durable-plan');
    expect(result['durable-environment-uids-json']).toBe('{}');
    expect(JSON.parse(result['durable-environment-result-json']).entries[0])
      .not.toHaveProperty('uid');
    expect(postman.listEnvironments).not.toHaveBeenCalled();
  });

  it('reports a tracked UID only after a live plan validates its workspace binding', async () => {
    writeResourcesState([
      'version: 3',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  environments:',
      '    ../postman/environments/Payments API - dev.environment.yaml: uid-dev',
      'environmentProvisioning:',
      '  projects:',
      '    payments:',
      '      environments:',
      '        dev:',
      '          artifact: ../postman/environments/Payments API - dev.environment.yaml',
      '          displayName: Payments API - dev',
      '          policy: create-only',
      `          definitionDigest: ${DEFINITION_DIGEST}`
    ]);
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Payments API',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_DURABLE_ENVIRONMENTS_JSON: JSON.stringify([{
        slug: 'dev',
        values: [{ key: 'baseUrl', value: 'https://dev.example.com' }]
      }]),
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'plan',
      INPUT_DURABLE_PROJECT_KEY: 'payments'
    });
    const { dependencies } = durableDependencies({
      live: [{ name: 'Payments API - dev', uid: 'uid-dev' }]
    });

    const result = await runRepoSync(inputs, dependencies);

    expect(result['sync-status']).toBe('durable-plan');
    expect(result['durable-environment-uids-json']).toBe('{"dev":"uid-dev"}');
  });

  it('rejects conflicting canonical ownership before a live plan publishes its UID', async () => {
    writeResourcesState([
      'version: 2',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  environments:',
      '    ../postman/environments/Other API - dev.environment.yaml: uid-dev'
    ]);
    const inputs = {
      ...durableApplyInputs({ explicitUid: 'uid-dev' }),
      durableEnvironmentOperation: 'plan' as const
    };
    const { dependencies, postman } = durableDependencies({
      live: [{ name: 'Payments API - dev', uid: 'uid-dev' }]
    });

    await expect(runRepoSync(inputs, dependencies)).rejects.toThrow(
      /UID is claimed by another canonical resource/
    );

    expect(postman.getEnvironment).not.toHaveBeenCalled();
    expect(dependencies.core.setOutput).not.toHaveBeenCalled();
  });

  it('checks action ownership before a live plan publishes its UID', async () => {
    const inputs = {
      ...durableApplyInputs({ explicitUid: 'uid-dev' }),
      durableEnvironmentOperation: 'plan' as const
    };
    const { dependencies } = durableDependencies({
      live: [{ name: 'Payments API - dev', uid: 'uid-dev' }],
      payload: {
        name: 'Payments API - dev',
        values: [{
          key: 'x-pm-onboarding',
          value: '{}',
          type: 'default',
          enabled: true
        }]
      }
    });

    await expect(runRepoSync(inputs, dependencies)).rejects.toThrow(
      /owned by the branch asset lifecycle/
    );

    expect(dependencies.core.setOutput).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'missing values',
      payload: { id: 'uid-dev', name: 'Payments API - dev' },
      error: /incomplete payload without values/
    },
    {
      label: 'malformed value row',
      payload: { name: 'Payments API - dev', values: [null] },
      error: /values\[0\] must be an object/
    }
  ])('fails closed when ownership inspection returns $label', async ({ payload, error }) => {
    const inputs = {
      ...durableApplyInputs({ explicitUid: 'uid-dev' }),
      durableEnvironmentOperation: 'plan' as const
    };
    const { dependencies } = durableDependencies({
      live: [{ name: 'Payments API - dev', uid: 'uid-dev' }],
      payload
    });

    await expect(runRepoSync(inputs, dependencies)).rejects.toThrow(error);

    expect(dependencies.core.setOutput).not.toHaveBeenCalled();
  });

  it('reports an untracked live candidate without treating its UID as validated', async () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Payments API',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_DURABLE_ENVIRONMENTS_JSON: JSON.stringify([{
        slug: 'dev',
        values: [{ key: 'baseUrl', value: 'https://dev.example.com' }]
      }]),
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'plan',
      INPUT_DURABLE_PROJECT_KEY: 'payments'
    });
    const { dependencies, postman } = durableDependencies({
      live: [{ name: 'Payments API - dev', uid: 'uid-review-me' }]
    });

    const result = await runRepoSync(inputs, dependencies);

    expect(result['durable-environment-uids-json']).toBe('{}');
    expect(JSON.parse(result['durable-environment-result-json']).entries[0]).toMatchObject({
      slug: 'dev',
      action: 'review-required',
      uid: 'uid-review-me'
    });
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'artifact',
      environment: 'prod',
      explicitUids: '{}'
    },
    {
      label: 'UID',
      environment: 'qa',
      explicitUids: '{"qa":"uid-prod"}'
    }
  ])('rejects legacy $label overlap with durable ownership before cloud mutation', async ({
    environment,
    explicitUids
  }) => {
    writeResourcesState([
      'version: 3',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  environments:',
      '    ../postman/environments/Payments API - prod.environment.yaml: uid-prod',
      'environmentProvisioning:',
      '  projects:',
      '    payments:',
      '      environments:',
      '        prod:',
      '          artifact: ../postman/environments/Payments API - prod.environment.yaml',
      '          displayName: Payments API - prod',
      '          policy: create-only',
      `          definitionDigest: ${DEFINITION_DIGEST}`
    ]);
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Payments API',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_ENVIRONMENTS_JSON: JSON.stringify([environment]),
      INPUT_ENVIRONMENT_UIDS_JSON: explicitUids,
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'off',
      INPUT_REPO_WRITE_MODE: 'none',
      INPUT_GENERATE_CI_WORKFLOW: 'false'
    });
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(inputs, dependencies))
      .rejects.toThrow(/Legacy environment sync overlaps durable environment payments\/prod/);

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
  });

  it('rejects a legacy workspace change that would orphan durable v3 bindings', async () => {
    writeResourcesState([
      'version: 3',
      'workspace:',
      '  id: ws-original',
      'canonical:',
      '  environments:',
      '    ../postman/environments/Payments API - prod.environment.yaml: uid-prod',
      'environmentProvisioning:',
      '  projects:',
      '    payments:',
      '      environments:',
      '        prod:',
      '          artifact: ../postman/environments/Payments API - prod.environment.yaml',
      '          displayName: Payments API - prod',
      '          policy: create-only',
      `          definitionDigest: ${DEFINITION_DIGEST}`
    ]);
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Another API',
      INPUT_WORKSPACE_ID: 'ws-replacement',
      INPUT_ENVIRONMENTS_JSON: '["qa"]',
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'off',
      INPUT_ONBOARDING_SCOPE: 'spec-only',
      INPUT_REPO_WRITE_MODE: 'none'
    });
    const { dependencies, postman } = durableDependencies();

    await expect(runRepoSync(inputs, dependencies))
      .rejects.toThrow(/cannot change the workspace owned by durable environment state/);

    expect(postman.listEnvironments).not.toHaveBeenCalled();
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
  });

  it('reports an omitted tracked durable environment as retained without deleting it', async () => {
    writeResourcesState([
      'version: 3',
      'workspace:',
      '  id: ws-123',
      'canonical:',
      '  environments:',
      '    ../postman/environments/Payments API - retired.environment.yaml: uid-retired',
      'environmentProvisioning:',
      '  projects:',
      '    payments:',
      '      environments:',
      '        retired:',
      '          artifact: ../postman/environments/Payments API - retired.environment.yaml',
      '          displayName: Payments API - retired',
      '          policy: create-only',
      `          definitionDigest: ${DEFINITION_DIGEST}`
    ]);
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'Payments API',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_DURABLE_ENVIRONMENTS_JSON: '[]',
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'plan',
      INPUT_DURABLE_PROJECT_KEY: 'payments'
    });
    const outputs = new Map<string, string>();
    const { dependencies, postman } = durableDependencies({
      live: [{ name: 'Payments API - retired', uid: 'uid-retired' }]
    });
    dependencies.core.setOutput = (name: string, value: string) => outputs.set(name, value);

    await runRepoSync(inputs, dependencies);

    expect(JSON.parse(outputs.get('durable-environment-result-json') ?? '{}')).toMatchObject({
      operation: 'plan',
      entries: [],
      orphans: [{
        slug: 'retired',
        displayName: 'Payments API - retired',
        uid: 'uid-retired',
        action: 'retained'
      }]
    });
    expect(postman.createEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).not.toHaveBeenCalled();
  });
});
