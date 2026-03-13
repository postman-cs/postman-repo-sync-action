import * as core from '@actions/core';
import * as exec from '@actions/exec';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dump as dumpYaml } from 'js-yaml';

import { convertAndSplitCollection } from './postman-v3/converter.js';
import { CI_WORKFLOW_TEMPLATE } from './lib/ci-workflow-template.js';
import { GitHubApiClient } from './lib/github/github-api-client.js';
import { RepoMutationService, resolveCurrentRef } from './lib/github/repo-mutation.js';
import {
  createInternalIntegrationAdapter,
  type InternalIntegrationAdapter
} from './lib/postman/internal-integration-adapter.js';
import { PostmanAssetsClient } from './lib/postman/postman-assets-client.js';
import { createSecretMasker } from './lib/secrets.js';

type EnvironmentValues = {
  key: string;
  value: string;
  type: string;
}[];

type Status = 'success' | 'skipped' | 'failed';

export interface ResolvedInputs {
  projectName: string;
  workspaceId: string;
  baselineCollectionId: string;
  smokeCollectionId: string;
  contractCollectionId: string;
  monitorId: string;
  mockUrl: string;
  monitorCron: string;
  environments: string[];
  repoUrl: string;
  integrationBackend: string;
  workspaceLinkEnabled: boolean;
  environmentSyncEnabled: boolean;
  systemEnvMap: Record<string, string>;
  environmentUids: Record<string, string>;
  envRuntimeUrls: Record<string, string>;
  artifactDir: string;
  repoWriteMode: 'none' | 'commit-only' | 'commit-and-push';
  currentRef: string;
  committerName: string;
  committerEmail: string;
  postmanApiKey: string;
  postmanAccessToken: string;
  githubToken: string;
  ghFallbackToken: string;
  githubAuthMode: 'github_token_first' | 'fallback_pat_first' | 'app_token';
  ciWorkflowBase64: string;
  generateCiWorkflow: boolean;
  ciWorkflowPath: string;
}

interface RepoSyncOutputs {
  'integration-backend': string;
  'resolved-current-ref': string;
  'workspace-link-status': Status;
  'environment-sync-status': Status;
  'environment-uids-json': string;
  'mock-url': string;
  'monitor-id': string;
  'repo-sync-summary-json': string;
  'commit-sha': string;
}

interface CoreLike {
  getInput(name: string, options?: { required?: boolean }): string;
  info(message: string): void;
  setFailed(message: string): void;
  setOutput(name: string, value: string): void;
  setSecret(secret: string): void;
  warning(message: string): void;
}

interface ExecLike {
  getExecOutput(
    commandLine: string,
    args?: string[],
    options?: Parameters<typeof exec.getExecOutput>[2]
  ): ReturnType<typeof exec.getExecOutput>;
}

interface RepoSyncDependencies {
  core: Pick<CoreLike, 'info' | 'setOutput' | 'warning'>;
  postman: Pick<
    PostmanAssetsClient,
    | 'createEnvironment'
    | 'createMock'
    | 'createMonitor'
    | 'getCollection'
    | 'getEnvironment'
    | 'updateEnvironment'
  >;
  github?: Pick<GitHubApiClient, 'getRepositoryVariable' | 'setRepositoryVariable'>;
  internalIntegration?: Pick<
    InternalIntegrationAdapter,
    'associateSystemEnvironments' | 'connectWorkspaceToRepository'
  >;
  repoMutation?: RepoMutationService;
}

function parseBooleanInput(value: string, defaultValue: boolean): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseJsonMap(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object');
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
      String(key),
      String(value ?? '')
    ])
  );
}

function parseJsonArray(raw: string): string[] {
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array');
  }
  return parsed.map((entry) => String(entry));
}

function readInput(
  actionCore: Pick<CoreLike, 'getInput'>,
  name: string,
  required = false
): string {
  return actionCore.getInput(name, { required }).trim();
}

function normalizeRepoWriteMode(value: string): 'none' | 'commit-only' | 'commit-and-push' {
  if (value === 'none' || value === 'commit-only' || value === 'commit-and-push') {
    return value;
  }
  return 'commit-and-push';
}

function normalizeGithubAuthMode(
  value: string
): 'github_token_first' | 'fallback_pat_first' | 'app_token' {
  if (
    value === 'github_token_first' ||
    value === 'fallback_pat_first' ||
    value === 'app_token'
  ) {
    return value;
  }
  return 'github_token_first';
}

function resolveRepoUrl(explicitRepoUrl: string): string {
  if (explicitRepoUrl) return explicitRepoUrl;
  const repository = process.env.GITHUB_REPOSITORY || '';
  if (!repository) return '';
  return `https://github.com/${repository}`;
}

function buildEnvironmentValues(envName: string, baseUrl: string): EnvironmentValues {
  return [
    { key: 'baseUrl', value: baseUrl, type: 'default' },
    { key: 'CI', value: 'false', type: 'default' },
    { key: 'RESPONSE_TIME_THRESHOLD', value: '2000', type: 'default' },
    { key: 'AWS_ACCESS_KEY_ID', value: '', type: 'secret' },
    { key: 'AWS_SECRET_ACCESS_KEY', value: '', type: 'secret' },
    { key: 'AWS_REGION', value: 'eu-west-2', type: 'default' },
    { key: 'AWS_SECRET_NAME', value: `api-credentials-${envName}`, type: 'default' }
  ];
}

function createOutputs(inputs: ResolvedInputs): RepoSyncOutputs {
  return {
    'integration-backend': inputs.integrationBackend,
    'resolved-current-ref': resolveCurrentRef({
      currentRef: inputs.currentRef || process.env.GITHUB_REF || '',
      githubHeadRef: process.env.GITHUB_HEAD_REF || '',
      githubRefName: process.env.GITHUB_REF_NAME || '',
      repoWriteMode: inputs.repoWriteMode
    }),
    'workspace-link-status': 'skipped',
    'environment-sync-status': 'skipped',
    'environment-uids-json': JSON.stringify(inputs.environmentUids),
    'mock-url': '',
    'monitor-id': '',
    'repo-sync-summary-json': '{}',
    'commit-sha': ''
  };
}

export function readActionInputs(actionCore: Pick<CoreLike, 'getInput' | 'setSecret'>): ResolvedInputs {
  const projectName = readInput(actionCore, 'project-name', true);
  const postmanApiKey = readInput(actionCore, 'postman-api-key', true);
  const postmanAccessToken = readInput(actionCore, 'postman-access-token');
  const githubToken = readInput(actionCore, 'github-token');
  const ghFallbackToken = readInput(actionCore, 'gh-fallback-token');

  actionCore.setSecret(postmanApiKey);
  if (postmanAccessToken) actionCore.setSecret(postmanAccessToken);
  if (githubToken) actionCore.setSecret(githubToken);
  if (ghFallbackToken) actionCore.setSecret(ghFallbackToken);

  const environments = parseJsonArray(readInput(actionCore, 'environments-json') || '["prod"]');
  const systemEnvMap = parseJsonMap(readInput(actionCore, 'system-env-map-json') || '{}');
  const environmentUids = parseJsonMap(readInput(actionCore, 'environment-uids-json') || '{}');
  const envRuntimeUrls = parseJsonMap(readInput(actionCore, 'env-runtime-urls-json') || '{}');

  return {
    projectName,
    workspaceId: readInput(actionCore, 'workspace-id'),
    baselineCollectionId: readInput(actionCore, 'baseline-collection-id'),
    smokeCollectionId: readInput(actionCore, 'smoke-collection-id'),
    contractCollectionId: readInput(actionCore, 'contract-collection-id'),
    monitorId: readInput(actionCore, 'monitor-id'),
    mockUrl: readInput(actionCore, 'mock-url'),
    monitorCron: readInput(actionCore, 'monitor-cron'),
    environments: environments.length > 0 ? environments : ['prod'],
    repoUrl: resolveRepoUrl(readInput(actionCore, 'repo-url')),
    integrationBackend: readInput(actionCore, 'integration-backend') || 'bifrost',
    workspaceLinkEnabled: parseBooleanInput(
      readInput(actionCore, 'workspace-link-enabled'),
      true
    ),
    environmentSyncEnabled: parseBooleanInput(
      readInput(actionCore, 'environment-sync-enabled'),
      true
    ),
    systemEnvMap,
    environmentUids,
    envRuntimeUrls,
    artifactDir: readInput(actionCore, 'artifact-dir') || 'postman',
    repoWriteMode: normalizeRepoWriteMode(readInput(actionCore, 'repo-write-mode') || 'commit-and-push'),
    currentRef: readInput(actionCore, 'current-ref'),
    committerName: readInput(actionCore, 'committer-name') || 'Postman FDE',
    committerEmail: readInput(actionCore, 'committer-email') || 'fde@postman.com',
    postmanApiKey,
    postmanAccessToken,
    githubToken,
    ghFallbackToken,
    githubAuthMode: normalizeGithubAuthMode(
      readInput(actionCore, 'github-auth-mode') || 'github_token_first'
    ),
    ciWorkflowBase64: readInput(actionCore, 'ci-workflow-base64'),
    generateCiWorkflow: parseBooleanInput(readInput(actionCore, 'generate-ci-workflow'), true),
    ciWorkflowPath: readInput(actionCore, 'ci-workflow-path') || '.github/workflows/ci.yml'
  };
}

async function upsertEnvironments(
  inputs: ResolvedInputs,
  dependencies: RepoSyncDependencies
): Promise<Record<string, string>> {
  const envUids = { ...inputs.environmentUids };
  if (!inputs.workspaceId) {
    return envUids;
  }

  if (dependencies.github) {
    try {
      const existing = await dependencies.github.getRepositoryVariable('POSTMAN_ENV_UIDS_JSON');
      if (existing) {
        Object.assign(envUids, parseJsonMap(existing));
      }
    } catch {
      // no-op, missing variable is expected on first run
    }
  }

  for (const envName of inputs.environments) {
    const runtimeUrl = String(inputs.envRuntimeUrls[envName] || '').trim();
    const values = buildEnvironmentValues(envName, runtimeUrl);
    const existingUid = envUids[envName];
    if (existingUid) {
      await dependencies.postman.updateEnvironment(
        existingUid,
        `${inputs.projectName} - ${envName}`,
        values
      );
      continue;
    }
    envUids[envName] = await dependencies.postman.createEnvironment(
      inputs.workspaceId,
      `${inputs.projectName} - ${envName}`,
      values
    );
  }

  return envUids;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/**
 * Keys that Postman regenerates on every export even when the underlying
 * content has not changed. Stripping them prevents cosmetic no-op commits.
 */
const VOLATILE_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'lastUpdatedBy'
]);

/**
 * Item-level `id` fields are regenerated on every Postman API export.
 * We strip them from request/folder entries but preserve `_postman_id`
 * and `uid` which are the stable collection/environment identifiers.
 */
function stripVolatileFields(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(stripVolatileFields);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(key)) {
        continue;
      }
      // Strip item-level `id` and `uid` but preserve top-level `_postman_id`
      if (key === 'id' && typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) {
        continue;
      }
      if (key === 'uid' && typeof value === 'string' && /^\d+-[0-9a-f-]{36}$/.test(value)) {
        continue;
      }
      result[key] = stripVolatileFields(value);
    }
    return result;
  }
  return obj;
}

function writeJsonFile(path: string, content: unknown, normalize = false): void {
  const data = normalize ? stripVolatileFields(content) : content;
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function buildResourcesManifest(
  workspaceId: string,
  collectionMap: Record<string, string>
): string {
  const manifest: Record<string, unknown> = {
    workspace: { id: workspaceId }
  };
  if (Object.keys(collectionMap).length > 0) {
    manifest.cloudResources = {
      collections: collectionMap
    };
  }
  manifest.localResources = {
    specs: ['../index.yaml']
  };
  return dumpYaml(manifest, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  });
}

async function exportArtifacts(
  inputs: ResolvedInputs,
  dependencies: RepoSyncDependencies,
  envUids: Record<string, string>
): Promise<void> {
  if (!inputs.workspaceId) {
    return;
  }

  const collectionsDir = `${inputs.artifactDir}/collections`;
  const environmentsDir = `${inputs.artifactDir}/environments`;
  const mocksDir = `${inputs.artifactDir}/mocks`;
  ensureDir(collectionsDir);
  ensureDir(environmentsDir);
  ensureDir(mocksDir);
  ensureDir('.postman');
  ensureDir('.github/workflows');

  const manifestCollections: Record<string, string> = {};

  if (inputs.baselineCollectionId) {
    const col = stripVolatileFields(
      await dependencies.postman.getCollection(inputs.baselineCollectionId)
    );
    await convertAndSplitCollection(col as any, `${collectionsDir}/[Baseline] ${inputs.projectName}`);
    manifestCollections[`../${collectionsDir}/[Baseline] ${inputs.projectName}`] =
      inputs.baselineCollectionId;
  }
  if (inputs.smokeCollectionId) {
    const col = stripVolatileFields(
      await dependencies.postman.getCollection(inputs.smokeCollectionId)
    );
    await convertAndSplitCollection(col as any, `${collectionsDir}/[Smoke] ${inputs.projectName}`);
    manifestCollections[`../${collectionsDir}/[Smoke] ${inputs.projectName}`] =
      inputs.smokeCollectionId;
  }
  if (inputs.contractCollectionId) {
    const col = stripVolatileFields(
      await dependencies.postman.getCollection(inputs.contractCollectionId)
    );
    await convertAndSplitCollection(col as any, `${collectionsDir}/[Contract] ${inputs.projectName}`);
    manifestCollections[`../${collectionsDir}/[Contract] ${inputs.projectName}`] =
      inputs.contractCollectionId;
  }

  for (const [envName, envUid] of Object.entries(envUids)) {
    writeJsonFile(
      `${environmentsDir}/${envName}.postman_environment.json`,
      await dependencies.postman.getEnvironment(envUid),
      true
    );
  }

  writeJsonFile('.postman/config.json', {
    schemaVersion: '1',
    workspace: { id: inputs.workspaceId },
    collectionPaths: [`${inputs.artifactDir}/collections/`],
    environmentPaths: [`${inputs.artifactDir}/environments/`],
    mockPaths: [`${inputs.artifactDir}/mocks/`]
  });

  writeFileSync('.postman/resources.yaml', buildResourcesManifest(inputs.workspaceId, manifestCollections));
}

function renderCiWorkflow(inputs: ResolvedInputs): string {
  if (inputs.ciWorkflowBase64) {
    return Buffer.from(inputs.ciWorkflowBase64, 'base64').toString('utf8');
  }
  return CI_WORKFLOW_TEMPLATE;
}

async function persistRepoVariables(
  inputs: ResolvedInputs,
  outputs: RepoSyncOutputs,
  dependencies: RepoSyncDependencies,
  envUids: Record<string, string>
): Promise<void> {
  if (!dependencies.github) {
    return;
  }

  const primaryEnvName = envUids.prod ? 'prod' : inputs.environments[0] || 'prod';
  const primaryEnvUid = envUids[primaryEnvName] || Object.values(envUids)[0] || '';
  const primaryBaseUrl = String(
    inputs.envRuntimeUrls[primaryEnvName] || Object.values(inputs.envRuntimeUrls)[0] || ''
  ).trim();

  await dependencies.github.setRepositoryVariable(
    'POSTMAN_ENV_UIDS_JSON',
    JSON.stringify(envUids)
  );
  if (primaryEnvUid) {
    await dependencies.github.setRepositoryVariable(
      'POSTMAN_ENVIRONMENT_UID',
      primaryEnvUid
    );
  }
  if (primaryBaseUrl) {
    await dependencies.github.setRepositoryVariable('RUNTIME_BASE_URL', primaryBaseUrl);
  }
  if (Object.keys(inputs.envRuntimeUrls).length > 0) {
    await dependencies.github.setRepositoryVariable(
      'ENV_RUNTIME_URLS_JSON',
      JSON.stringify(inputs.envRuntimeUrls)
    );
  }
  if (outputs['mock-url']) {
    await dependencies.github.setRepositoryVariable('MOCK_URL', outputs['mock-url']);
  }
  if (outputs['monitor-id']) {
    await dependencies.github.setRepositoryVariable(
      'SMOKE_MONITOR_UID',
      outputs['monitor-id']
    );
  }
}

function createRepoSummary(
  outputs: RepoSyncOutputs,
  envUids: Record<string, string>,
  pushed: boolean
): string {
  return JSON.stringify({
    commitSha: outputs['commit-sha'],
    environmentCount: Object.keys(envUids).length,
    environmentSyncStatus: outputs['environment-sync-status'],
    mockUrl: outputs['mock-url'],
    monitorId: outputs['monitor-id'],
    pushed,
    resolvedCurrentRef: outputs['resolved-current-ref'],
    workspaceLinkStatus: outputs['workspace-link-status']
  });
}

async function commitAndPushGeneratedFiles(
  inputs: ResolvedInputs,
  dependencies: RepoSyncDependencies
): Promise<{ commitSha: string; resolvedCurrentRef: string; pushed: boolean }> {
  if (!dependencies.repoMutation || inputs.repoWriteMode === 'none') {
    return { commitSha: '', resolvedCurrentRef: '', pushed: false };
  }


  if (inputs.generateCiWorkflow) {
    const ciWorkflow = renderCiWorkflow(inputs);

    // Extract dir from ciWorkflowPath
    const parts = inputs.ciWorkflowPath.split('/');
    if (parts.length > 1) {
      const dir = parts.slice(0, -1).join('/');
      ensureDir(dir);
    }

    writeFileSync(inputs.ciWorkflowPath, ciWorkflow);
  }

  if (existsSync('.github/workflows/provision.yml')) {
    rmSync('.github/workflows/provision.yml');
  }

  const stagePaths = [
    inputs.artifactDir,
    '.postman',
    inputs.generateCiWorkflow ? inputs.ciWorkflowPath : null
  ].filter((entry) => typeof entry === 'string' && existsSync(entry)) as string[];

  // also add .github/workflows directory for provision.yml removal
  if (!stagePaths.includes('.github/workflows') && existsSync('.github/workflows')) {
    stagePaths.push('.github/workflows');
  }

  const effectiveStagePaths = stagePaths.length > 0 ? stagePaths : ['.'];

  const result = await dependencies.repoMutation.commitAndPush({
    repoWriteMode: inputs.repoWriteMode,
    currentRef: inputs.currentRef || process.env.GITHUB_REF || '',
    githubHeadRef: process.env.GITHUB_HEAD_REF || '',
    githubRefName: process.env.GITHUB_REF_NAME || '',
    committerName: inputs.committerName,
    committerEmail: inputs.committerEmail,
    githubToken: inputs.githubToken,
    fallbackToken: inputs.ghFallbackToken,
    stagePaths: effectiveStagePaths
  });

  return {
    commitSha: result.commitSha,
    pushed: result.pushed,
    resolvedCurrentRef: result.resolvedCurrentRef
  };
}

export async function runRepoSync(
  inputs: ResolvedInputs,
  dependencies: RepoSyncDependencies
): Promise<RepoSyncOutputs> {
  const outputs = createOutputs(inputs);
  let pushed = false;

  const envUids = await upsertEnvironments(inputs, dependencies);
  outputs['environment-uids-json'] = JSON.stringify(envUids);

  if (inputs.environmentSyncEnabled && inputs.workspaceId && dependencies.internalIntegration) {
    const associations = Object.entries(envUids)
      .map(([envName, envUid]) => ({
        envUid,
        systemEnvId: inputs.systemEnvMap[envName] || ''
      }))
      .filter((entry) => entry.systemEnvId);
    if (associations.length > 0) {
      try {
        await dependencies.internalIntegration.associateSystemEnvironments(
          inputs.workspaceId,
          associations
        );
        outputs['environment-sync-status'] = 'success';
      } catch (error) {
        outputs['environment-sync-status'] = 'failed';
        dependencies.core.warning(
          `System environment association failed: ${error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  if (inputs.mockUrl) {
    outputs['mock-url'] = inputs.mockUrl;
    dependencies.core.info(`Reusing existing mock: ${inputs.mockUrl}`);
  } else if (
    inputs.workspaceId &&
    inputs.baselineCollectionId &&
    Object.keys(envUids).length > 0
  ) {
    const mockEnvUid = envUids.dev || envUids.prod || Object.values(envUids)[0];
    if (mockEnvUid) {
      const mock = await dependencies.postman.createMock(
        inputs.workspaceId,
        `${inputs.projectName} Mock`,
        inputs.baselineCollectionId,
        mockEnvUid
      );
      outputs['mock-url'] = mock.url;
    }
  }

  if (inputs.monitorId) {
    outputs['monitor-id'] = inputs.monitorId;
    dependencies.core.info(`Reusing existing monitor: ${inputs.monitorId}`);
  } else if (inputs.workspaceId && inputs.smokeCollectionId && Object.keys(envUids).length > 0) {
    const monitorEnvUid = envUids.prod || envUids.dev || Object.values(envUids)[0];
    if (monitorEnvUid) {
      outputs['monitor-id'] = await dependencies.postman.createMonitor(
        inputs.workspaceId,
        `${inputs.projectName} - Smoke Monitor`,
        inputs.smokeCollectionId,
        monitorEnvUid,
        inputs.monitorCron || undefined
      );
    }
  }

  if (
    inputs.workspaceLinkEnabled &&
    inputs.workspaceId &&
    inputs.repoUrl &&
    dependencies.internalIntegration
  ) {
    try {
      await dependencies.internalIntegration.connectWorkspaceToRepository(
        inputs.workspaceId,
        inputs.repoUrl
      );
      outputs['workspace-link-status'] = 'success';
    } catch (error) {
      outputs['workspace-link-status'] = 'failed';
      dependencies.core.warning(
        `Workspace link failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  await exportArtifacts(inputs, dependencies, envUids);
  await persistRepoVariables(inputs, outputs, dependencies, envUids);

  const commit = await commitAndPushGeneratedFiles(inputs, dependencies);
  outputs['commit-sha'] = commit.commitSha;
  if (commit.resolvedCurrentRef) {
    outputs['resolved-current-ref'] = commit.resolvedCurrentRef;
  }
  pushed = commit.pushed;

  outputs['repo-sync-summary-json'] = createRepoSummary(outputs, envUids, pushed);

  for (const [name, value] of Object.entries(outputs)) {
    dependencies.core.setOutput(name, value);
  }
  return outputs;
}

export async function runAction(
  actionCore: CoreLike = core,
  actionExec: ExecLike = exec
): Promise<RepoSyncOutputs> {
  const inputs = readActionInputs(actionCore);
  const masker = createSecretMasker([
    inputs.postmanApiKey,
    inputs.postmanAccessToken,
    inputs.githubToken,
    inputs.ghFallbackToken
  ]);
  const postman = new PostmanAssetsClient({
    apiKey: inputs.postmanApiKey,
    secretMasker: masker
  });

  const repository = process.env.GITHUB_REPOSITORY || '';
  const github =
    repository && inputs.githubToken
      ? new GitHubApiClient({
        repository,
        token: inputs.githubToken,
        fallbackToken: inputs.ghFallbackToken,
        authMode: inputs.githubAuthMode,
        secretMasker: masker
      })
      : undefined;

  const repoMutation =
    repository && (inputs.repoWriteMode === 'commit-only' || inputs.repoWriteMode === 'commit-and-push')
      ? new RepoMutationService({
        repository,
        secretMasker: masker,
        execute: async (command, args) => {
          const result = await actionExec.getExecOutput(command, args, {
            ignoreReturnCode: true
          });
          return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr
          };
        }
      })
      : undefined;

  const internalIntegration =
    inputs.postmanAccessToken
      ? createInternalIntegrationAdapter({
        accessToken: inputs.postmanAccessToken,
        backend: inputs.integrationBackend,
        teamId: process.env.POSTMAN_TEAM_ID || '',
        secretMasker: masker
      })
      : undefined;

  if (!github) {
    actionCore.info('GitHub variable persistence disabled for this run');
  }
  if (inputs.environmentSyncEnabled && !internalIntegration) {
    actionCore.warning(
      'Skipping system environment association because postman-access-token is not configured'
    );
  }
  if (inputs.workspaceLinkEnabled && !internalIntegration) {
    actionCore.warning(
      'Skipping workspace linking because postman-access-token is not configured'
    );
  }

  return runRepoSync(inputs, {
    core: actionCore,
    postman,
    github,
    internalIntegration,
    repoMutation
  });
}

const entrypoint = process.argv[1];
const currentModulePath = typeof __filename === 'string' ? __filename : '';

if (entrypoint && currentModulePath === entrypoint) {
  runAction().catch((error: unknown) => {
    if (error instanceof Error) {
      core.setFailed(error.message);
      return;
    }
    core.setFailed(String(error));
  });
}
