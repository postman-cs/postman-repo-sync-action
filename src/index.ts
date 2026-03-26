import * as core from '@actions/core';
import * as exec from '@actions/exec';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import * as path from 'node:path';
import { dump as dumpYaml } from 'js-yaml';

import { convertAndSplitCollection } from './postman-v3/converter.js';
import { CI_WORKFLOW_TEMPLATE } from './lib/ci-workflow-template.js';
import { GitHubApiClient } from './lib/github/github-api-client.js';
import { RepoMutationService, resolveCurrentRef } from './lib/github/repo-mutation.js';
import { detectRepoContext } from './lib/repo/context.js';
import {
  createInternalIntegrationAdapter,
  type InternalIntegrationAdapter
} from './lib/postman/internal-integration-adapter.js';
import { PostmanAssetsClient } from './lib/postman/postman-assets-client.js';
import { createSecretMasker, type SecretMasker } from './lib/secrets.js';
import { validateCertMaterial } from './lib/ssl-validation.js';

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
  collectionSyncMode: 'reuse' | 'refresh' | 'version';
  specSyncMode: 'update' | 'version';
  releaseLabel?: string;
  setAsCurrent: boolean;
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
  githubHeadRef: string;
  githubRefName: string;
  committerName: string;
  committerEmail: string;
  postmanApiKey: string;
  postmanAccessToken: string;
  githubToken: string;
  ghFallbackToken: string;
  githubAuthMode: 'github_token_first' | 'fallback_pat_first' | 'app_token';
  ciWorkflowBase64: string;
  generateCiWorkflow: boolean;
  monitorType: string;
  ciWorkflowPath: string;
  orgMode: boolean;
  monitorId: string;
  mockUrl: string;
  monitorCron: string;
  sslClientCert: string;
  sslClientKey: string;
  sslClientPassphrase: string;
  sslExtraCaCerts: string;
  teamId: string;
  repository: string;
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

export interface ExecLike {
  getExecOutput(
    commandLine: string,
    args?: string[],
    options?: Parameters<typeof exec.getExecOutput>[2]
  ): ReturnType<typeof exec.getExecOutput>;
}

export interface RepoSyncDependencies {
  core: Pick<CoreLike, 'info' | 'setOutput' | 'warning'>;
  postman: Pick<
    PostmanAssetsClient,
    | 'createEnvironment'
    | 'createMock'
    | 'createMonitor'
    | 'getCollection'
    | 'getEnvironment'
    | 'updateEnvironment'
    | 'listMonitors'
    | 'listMocks'
    | 'monitorExists'
    | 'mockExists'
    | 'findMonitorByCollection'
    | 'findMockByCollection'
  >;
  github?: Pick<GitHubApiClient, 'getRepositoryVariable' | 'setRepositoryVariable'>;
  internalIntegration?: Pick<
    InternalIntegrationAdapter,
    'associateSystemEnvironments' | 'connectWorkspaceToRepository'
  >;
  repoMutation?: RepoMutationService;
}

export interface RepoSyncDependencyFactories {
  core: Pick<CoreLike, 'info' | 'setOutput' | 'warning'>;
  exec: ExecLike;
}

function parseBooleanInput(value: string, defaultValue: boolean): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function normalizeInputValue(value: string | undefined): string {
  return String(value ?? '').trim();
}

export function getInput(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const envName = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
  return normalizeInputValue(env[envName]);
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

function normalizeCollectionSyncMode(value: string): 'reuse' | 'refresh' | 'version' {
  if (value === 'reuse' || value === 'refresh' || value === 'version') {
    return value;
  }
  return 'refresh';
}

function normalizeSpecSyncMode(value: string): 'update' | 'version' {
  if (value === 'update' || value === 'version') {
    return value;
  }
  return 'update';
}

function normalizeReleaseLabel(value: string): string {
  const cleaned = normalizeInputValue(value)
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/tags\//, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return cleaned;
}

function deriveReleaseLabel(inputs: Pick<ResolvedInputs, 'releaseLabel' | 'githubRefName'>): string {
  const explicit = normalizeReleaseLabel(inputs.releaseLabel || '');
  if (explicit) {
    return explicit;
  }
  return normalizeReleaseLabel(inputs.githubRefName);
}

function createAssetProjectName(
  inputs: Pick<ResolvedInputs, 'projectName' | 'collectionSyncMode' | 'specSyncMode'>,
  releaseLabel: string
): string {
  if ((inputs.collectionSyncMode === 'version' || inputs.specSyncMode === 'version') && releaseLabel) {
    return `${inputs.projectName} ${releaseLabel}`;
  }
  return inputs.projectName;
}

function shouldPersistCurrentPointers(inputs: Pick<ResolvedInputs, 'collectionSyncMode' | 'setAsCurrent'>): boolean {
  if (inputs.collectionSyncMode === 'refresh') {
    return true;
  }
  return inputs.setAsCurrent;
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

export function resolveInputs(env: NodeJS.ProcessEnv = process.env): ResolvedInputs {
  const repoContext = detectRepoContext(
    {
      repoUrl: getInput('repo-url', env)
    },
    env
  );

  const environments = parseJsonArray(getInput('environments-json', env) || '["prod"]');
  const systemEnvMap = parseJsonMap(getInput('system-env-map-json', env) || '{}');
  const environmentUids = parseJsonMap(getInput('environment-uids-json', env) || '{}');
  const envRuntimeUrls = parseJsonMap(getInput('env-runtime-urls-json', env) || '{}');

  return {
    projectName: getInput('project-name', env),
    workspaceId: getInput('workspace-id', env),
    baselineCollectionId: getInput('baseline-collection-id', env),
    smokeCollectionId: getInput('smoke-collection-id', env),
    contractCollectionId: getInput('contract-collection-id', env),
    collectionSyncMode: normalizeCollectionSyncMode(getInput('collection-sync-mode', env) || 'refresh'),
    specSyncMode: normalizeSpecSyncMode(getInput('spec-sync-mode', env) || 'update'),
    releaseLabel: normalizeReleaseLabel(getInput('release-label', env)) || undefined,
    setAsCurrent: parseBooleanInput(getInput('set-as-current', env), true),
    environments: environments.length > 0 ? environments : ['prod'],
    repoUrl: repoContext.repoUrl || '',
    integrationBackend: getInput('integration-backend', env) || 'bifrost',
    workspaceLinkEnabled: parseBooleanInput(getInput('workspace-link-enabled', env), true),
    environmentSyncEnabled: parseBooleanInput(getInput('environment-sync-enabled', env), true),
    systemEnvMap,
    environmentUids,
    envRuntimeUrls,
    artifactDir: getInput('artifact-dir', env) || 'postman',
    repoWriteMode: normalizeRepoWriteMode(getInput('repo-write-mode', env) || 'commit-and-push'),
    currentRef: getInput('current-ref', env) || normalizeInputValue(env.GITHUB_REF),
    githubHeadRef: getInput('github-head-ref', env) || normalizeInputValue(env.GITHUB_HEAD_REF),
    githubRefName:
      getInput('github-ref-name', env) ||
      normalizeInputValue(env.GITHUB_REF_NAME) ||
      normalizeInputValue(repoContext.ref),
    committerName: getInput('committer-name', env) || 'Postman CSE',
    committerEmail: getInput('committer-email', env) || 'help@postman.com',
    postmanApiKey: getInput('postman-api-key', env),
    postmanAccessToken: getInput('postman-access-token', env),
    githubToken: getInput('github-token', env),
    ghFallbackToken: getInput('gh-fallback-token', env),
    githubAuthMode: normalizeGithubAuthMode(getInput('github-auth-mode', env) || 'github_token_first'),
    ciWorkflowBase64: getInput('ci-workflow-base64', env),
    generateCiWorkflow: parseBooleanInput(getInput('generate-ci-workflow', env), true),
    monitorType: getInput('monitor-type', env) || 'cloud',
    ciWorkflowPath: getInput('ci-workflow-path', env) || '.github/workflows/ci.yml',
    orgMode: parseBooleanInput(getInput('org-mode', env), false),
    monitorId: getInput('monitor-id', env),
    mockUrl: getInput('mock-url', env),
    monitorCron: getInput('monitor-cron', env),
    sslClientCert: getInput('ssl-client-cert', env),
    sslClientKey: getInput('ssl-client-key', env),
    sslClientPassphrase: getInput('ssl-client-passphrase', env),
    sslExtraCaCerts: getInput('ssl-extra-ca-certs', env),
    teamId: getInput('team-id', env) || normalizeInputValue(env.POSTMAN_TEAM_ID),
    repository:
      getInput('repository', env) ||
      normalizeInputValue(env.GITHUB_REPOSITORY) ||
      normalizeInputValue(repoContext.repoSlug)
  };
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
      currentRef: inputs.currentRef,
      githubHeadRef: inputs.githubHeadRef,
      githubRefName: inputs.githubRefName,
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

function varName(projectName: string, baseName: string): string {
  const slug = projectName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `POSTMAN_${slug}_${baseName}`;
}

async function readVariable(
  github: { getRepositoryVariable(name: string): Promise<string> } | undefined,
  projectName: string,
  baseName: string
): Promise<string | undefined> {
  if (!github) return undefined;
  const namespaced = await github.getRepositoryVariable(varName(projectName, baseName)).catch(() => undefined);
  if (namespaced) return namespaced;
  const legacy = await github.getRepositoryVariable(`POSTMAN_${baseName}`).catch(() => undefined);
  return legacy || undefined;
}

async function persistVariable(
  github: { setRepositoryVariable(name: string, value: string): Promise<void> } | undefined,
  name: string,
  value: string,
  actionCore: { warning(msg: string): void }
): Promise<void> {
  if (!github || !value) return;
  try {
    await github.setRepositoryVariable(name, value);
  } catch (err) {
    actionCore.warning(`Failed to persist ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writeVariable(
  github: { setRepositoryVariable(name: string, value: string): Promise<void> } | undefined,
  projectName: string,
  baseName: string,
  value: string,
  actionCore: { warning(msg: string): void }
): Promise<void> {
  if (!github || !value) return;
  await persistVariable(github, varName(projectName, baseName), value, actionCore);
  await persistVariable(github, `POSTMAN_${baseName}`, value, actionCore);
}

export function readActionInputs(actionCore: Pick<CoreLike, 'getInput' | 'setSecret'>): ResolvedInputs {
  const projectName = readInput(actionCore, 'project-name', true);
  const postmanApiKey = readInput(actionCore, 'postman-api-key', true);
  const postmanAccessToken = readInput(actionCore, 'postman-access-token');
  const githubToken = readInput(actionCore, 'github-token');
  const ghFallbackToken = readInput(actionCore, 'gh-fallback-token');
  const sslClientCert = readInput(actionCore, 'ssl-client-cert');
  const sslClientKey = readInput(actionCore, 'ssl-client-key');
  const sslClientPassphrase = readInput(actionCore, 'ssl-client-passphrase');
  const sslExtraCaCerts = readInput(actionCore, 'ssl-extra-ca-certs');

  actionCore.setSecret(postmanApiKey);
  if (postmanAccessToken) actionCore.setSecret(postmanAccessToken);
  if (githubToken) actionCore.setSecret(githubToken);
  if (ghFallbackToken) actionCore.setSecret(ghFallbackToken);
  if (sslClientCert) actionCore.setSecret(sslClientCert);
  if (sslClientKey) actionCore.setSecret(sslClientKey);
  if (sslClientPassphrase) actionCore.setSecret(sslClientPassphrase);
  if (sslExtraCaCerts) actionCore.setSecret(sslExtraCaCerts);

  if (sslClientCert) {
    if (!sslClientKey) {
      throw new Error('ssl-client-key is required when ssl-client-cert is provided');
    }
    validateCertMaterial(sslClientCert, sslClientKey, sslClientPassphrase || undefined);
  }

  return resolveInputs({
    ...process.env,
    INPUT_PROJECT_NAME: projectName,
    INPUT_WORKSPACE_ID: readInput(actionCore, 'workspace-id'),
    INPUT_BASELINE_COLLECTION_ID: readInput(actionCore, 'baseline-collection-id'),
    INPUT_SMOKE_COLLECTION_ID: readInput(actionCore, 'smoke-collection-id'),
    INPUT_CONTRACT_COLLECTION_ID: readInput(actionCore, 'contract-collection-id'),
    INPUT_COLLECTION_SYNC_MODE: readInput(actionCore, 'collection-sync-mode') || 'refresh',
    INPUT_SPEC_SYNC_MODE: readInput(actionCore, 'spec-sync-mode') || 'update',
    INPUT_RELEASE_LABEL: readInput(actionCore, 'release-label'),
    INPUT_SET_AS_CURRENT: readInput(actionCore, 'set-as-current') || 'true',
    INPUT_ENVIRONMENTS_JSON: readInput(actionCore, 'environments-json') || '["prod"]',
    INPUT_REPO_URL: readInput(actionCore, 'repo-url'),
    INPUT_INTEGRATION_BACKEND: readInput(actionCore, 'integration-backend') || 'bifrost',
    INPUT_WORKSPACE_LINK_ENABLED: readInput(actionCore, 'workspace-link-enabled'),
    INPUT_ENVIRONMENT_SYNC_ENABLED: readInput(actionCore, 'environment-sync-enabled'),
    INPUT_SYSTEM_ENV_MAP_JSON: readInput(actionCore, 'system-env-map-json') || '{}',
    INPUT_ENVIRONMENT_UIDS_JSON: readInput(actionCore, 'environment-uids-json') || '{}',
    INPUT_ENV_RUNTIME_URLS_JSON: readInput(actionCore, 'env-runtime-urls-json') || '{}',
    INPUT_ARTIFACT_DIR: readInput(actionCore, 'artifact-dir') || 'postman',
    INPUT_REPO_WRITE_MODE: readInput(actionCore, 'repo-write-mode') || 'commit-and-push',
    INPUT_CURRENT_REF: readInput(actionCore, 'current-ref'),
    INPUT_GITHUB_HEAD_REF: readInput(actionCore, 'github-head-ref'),
    INPUT_GITHUB_REF_NAME: readInput(actionCore, 'github-ref-name'),
    INPUT_COMMITTER_NAME: readInput(actionCore, 'committer-name') || 'Postman CSE',
    INPUT_COMMITTER_EMAIL: readInput(actionCore, 'committer-email') || 'help@postman.com',
    INPUT_POSTMAN_API_KEY: postmanApiKey,
    INPUT_POSTMAN_ACCESS_TOKEN: postmanAccessToken,
    INPUT_GITHUB_TOKEN: githubToken,
    INPUT_GH_FALLBACK_TOKEN: ghFallbackToken,
    INPUT_GITHUB_AUTH_MODE: readInput(actionCore, 'github-auth-mode') || 'github_token_first',
    INPUT_CI_WORKFLOW_BASE64: readInput(actionCore, 'ci-workflow-base64'),
    INPUT_GENERATE_CI_WORKFLOW: readInput(actionCore, 'generate-ci-workflow'),
    INPUT_MONITOR_TYPE: readInput(actionCore, 'monitor-type') || 'cloud',
    INPUT_CI_WORKFLOW_PATH: readInput(actionCore, 'ci-workflow-path') || '.github/workflows/ci.yml',
    INPUT_ORG_MODE: readInput(actionCore, 'org-mode'),
    INPUT_MONITOR_ID: readInput(actionCore, 'monitor-id'),
    INPUT_MOCK_URL: readInput(actionCore, 'mock-url'),
    INPUT_MONITOR_CRON: readInput(actionCore, 'monitor-cron'),
    INPUT_SSL_CLIENT_CERT: sslClientCert,
    INPUT_SSL_CLIENT_KEY: sslClientKey,
    INPUT_SSL_CLIENT_PASSPHRASE: sslClientPassphrase,
    INPUT_SSL_EXTRA_CA_CERTS: sslExtraCaCerts,
    INPUT_TEAM_ID: readInput(actionCore, 'team-id') || process.env.POSTMAN_TEAM_ID,
    INPUT_REPOSITORY: readInput(actionCore, 'repository') || process.env.GITHUB_REPOSITORY,
    GITHUB_HEAD_REF: process.env.GITHUB_HEAD_REF,
    GITHUB_REF_NAME: process.env.GITHUB_REF_NAME
  });
}

function buildGhCliEnv(env: NodeJS.ProcessEnv, token: string): Record<string, string> {
  const allowList = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'GH_CONFIG_DIR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'RUNNER_TEMP',
    'SYSTEMROOT'
  ];
  const filtered: Record<string, string> = { GH_TOKEN: token };
  for (const key of allowList) {
    const value = env[key];
    if (value) {
      filtered[key] = value;
    }
  }
  return filtered;
}

async function persistSslSecrets(
  inputs: ResolvedInputs,
  actionCore: Pick<CoreLike, 'info' | 'warning'>,
  actionExec: ExecLike,
  repository: string,
  githubClient?: Pick<GitHubApiClient, 'setRepositoryVariable'>,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!inputs.sslClientCert) {
    return;
  }

  if (!githubClient) {
    actionCore.warning(
      'SSL inputs were provided but GitHub secret persistence is unavailable. Set these repository secrets manually: POSTMAN_SSL_CLIENT_CERT_B64, POSTMAN_SSL_CLIENT_KEY_B64, POSTMAN_SSL_CLIENT_PASSPHRASE (optional), POSTMAN_SSL_EXTRA_CA_CERTS_B64 (optional).'
    );
    return;
  }

  const token = inputs.ghFallbackToken || inputs.githubToken;
  if (!token || !repository) {
    actionCore.warning(
      'SSL inputs were provided but no GitHub token/repository context is available for secret persistence. Set these repository secrets manually: POSTMAN_SSL_CLIENT_CERT_B64, POSTMAN_SSL_CLIENT_KEY_B64, POSTMAN_SSL_CLIENT_PASSPHRASE (optional), POSTMAN_SSL_EXTRA_CA_CERTS_B64 (optional).'
    );
    return;
  }

  const secretsToPersist: Array<[name: string, value: string]> = [
    ['POSTMAN_SSL_CLIENT_CERT_B64', inputs.sslClientCert],
    ['POSTMAN_SSL_CLIENT_KEY_B64', inputs.sslClientKey]
  ];
  if (inputs.sslClientPassphrase) {
    secretsToPersist.push(['POSTMAN_SSL_CLIENT_PASSPHRASE', inputs.sslClientPassphrase]);
  }
  if (inputs.sslExtraCaCerts) {
    secretsToPersist.push(['POSTMAN_SSL_EXTRA_CA_CERTS_B64', inputs.sslExtraCaCerts]);
  }

  try {
    for (const [name, value] of secretsToPersist) {
      const result = await actionExec.getExecOutput(
        'gh',
        ['secret', 'set', name, '--repo', repository],
        {
          input: Buffer.from(value),
          env: buildGhCliEnv(env, token),
          ignoreReturnCode: true
        }
      );

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `gh secret set ${name} failed`);
      }
    }
    actionCore.info('SSL certificate inputs persisted to repository secrets');
  } catch (error) {
    actionCore.warning(
      `Unable to persist SSL certificate secrets automatically (missing secrets:write permissions?): ${error instanceof Error ? error.message : String(error)}. Set these repository secrets manually: POSTMAN_SSL_CLIENT_CERT_B64, POSTMAN_SSL_CLIENT_KEY_B64, POSTMAN_SSL_CLIENT_PASSPHRASE (optional), POSTMAN_SSL_EXTRA_CA_CERTS_B64 (optional).`
    );
  }
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
      const existing = await readVariable(dependencies.github, inputs.projectName, 'ENV_UIDS_JSON');
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
    await writeVariable(
      dependencies.github,
      inputs.projectName,
      'ENV_UIDS_JSON',
      JSON.stringify(envUids),
      dependencies.core
    );
  }

  return envUids;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function getCollectionDirectoryName(kind: 'Baseline' | 'Smoke' | 'Contract', projectName: string): string {
  return `[${kind}] ${projectName}`;
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


export function assertPathWithinCwd(targetPath: string, fieldName: string): void {
  const base = path.resolve('.');
  const resolved = path.resolve(base, targetPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must stay within the repository root; received ${targetPath}`);
  }
}

async function exportArtifacts(
  inputs: ResolvedInputs,
  dependencies: RepoSyncDependencies,
  envUids: Record<string, string>,
  assetProjectName: string
): Promise<void> {
  if (!inputs.workspaceId) {
    return;
  }

  assertPathWithinCwd(inputs.artifactDir, 'artifact-dir');
  if (inputs.generateCiWorkflow) {
    assertPathWithinCwd(inputs.ciWorkflowPath, 'ci-workflow-path');
  }

  const collectionsDir = `${inputs.artifactDir}/collections`;
  const environmentsDir = `${inputs.artifactDir}/environments`;
  const mocksDir = `${inputs.artifactDir}/mocks`;
  ensureDir(collectionsDir);
  ensureDir(environmentsDir);
  ensureDir(mocksDir);
  ensureDir('.postman');
  if (inputs.generateCiWorkflow) {
    ensureDir('.github/workflows');
  }

  const manifestCollections: Record<string, string> = {};

  if (inputs.baselineCollectionId) {
    const col = stripVolatileFields(
      await dependencies.postman.getCollection(inputs.baselineCollectionId)
    );
    const dirName = getCollectionDirectoryName('Baseline', assetProjectName);
    await convertAndSplitCollection(col as any, `${collectionsDir}/${dirName}`);
    manifestCollections[`../${collectionsDir}/${dirName}`] =
      inputs.baselineCollectionId;
  }
  if (inputs.smokeCollectionId) {
    const col = stripVolatileFields(
      await dependencies.postman.getCollection(inputs.smokeCollectionId)
    );
    const dirName = getCollectionDirectoryName('Smoke', assetProjectName);
    await convertAndSplitCollection(col as any, `${collectionsDir}/${dirName}`);
    manifestCollections[`../${collectionsDir}/${dirName}`] =
      inputs.smokeCollectionId;
  }
  if (inputs.contractCollectionId) {
    const col = stripVolatileFields(
      await dependencies.postman.getCollection(inputs.contractCollectionId)
    );
    const dirName = getCollectionDirectoryName('Contract', assetProjectName);
    await convertAndSplitCollection(col as any, `${collectionsDir}/${dirName}`);
    manifestCollections[`../${collectionsDir}/${dirName}`] =
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

  if (!shouldPersistCurrentPointers(inputs)) {
    return;
  }

  const primaryEnvName = envUids.prod ? 'prod' : inputs.environments[0] || 'prod';
  const primaryEnvUid = envUids[primaryEnvName] || Object.values(envUids)[0] || '';
  const primaryBaseUrl = String(
    inputs.envRuntimeUrls[primaryEnvName] || Object.values(inputs.envRuntimeUrls)[0] || ''
  ).trim();

  await writeVariable(
    dependencies.github,
    inputs.projectName,
    'ENV_UIDS_JSON',
    JSON.stringify(envUids),
    dependencies.core
  );
  if (primaryEnvUid) {
    await writeVariable(dependencies.github, inputs.projectName, 'ENVIRONMENT_UID', primaryEnvUid, dependencies.core);
  }
  if (primaryBaseUrl) {
    await writeVariable(dependencies.github, inputs.projectName, 'RUNTIME_BASE_URL', primaryBaseUrl, dependencies.core);
  }
  if (Object.keys(inputs.envRuntimeUrls).length > 0) {
    await writeVariable(
      dependencies.github,
      inputs.projectName,
      'ENV_RUNTIME_URLS_JSON',
      JSON.stringify(inputs.envRuntimeUrls),
      dependencies.core
    );
  }
  if (outputs['mock-url']) {
    await writeVariable(dependencies.github, inputs.projectName, 'MOCK_URL', outputs['mock-url'], dependencies.core);
  }
  if (outputs['monitor-id']) {
    await writeVariable(dependencies.github, inputs.projectName, 'SMOKE_MONITOR_UID', outputs['monitor-id'], dependencies.core);
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

  const provisionExists = existsSync('.github/workflows/provision.yml');
  if (provisionExists) {
    rmSync('.github/workflows/provision.yml');
  }

  const stagePaths = [
    inputs.artifactDir,
    '.postman',
    inputs.generateCiWorkflow ? inputs.ciWorkflowPath : null,
    provisionExists ? '.github/workflows/provision.yml' : null
  ].filter((entry) => typeof entry === 'string' && (existsSync(entry) || entry === '.github/workflows/provision.yml')) as string[];

  const effectiveStagePaths = stagePaths.length > 0 ? stagePaths : ['.'];

  const result = await dependencies.repoMutation.commitAndPush({
    repoWriteMode: inputs.repoWriteMode,
    currentRef: inputs.currentRef,
    githubHeadRef: inputs.githubHeadRef,
    githubRefName: inputs.githubRefName,
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
  const persistCurrentPointers = shouldPersistCurrentPointers(inputs);
  const versionRequested = inputs.collectionSyncMode === 'version' || inputs.specSyncMode === 'version';
  const releaseLabel = deriveReleaseLabel(inputs);
  if (versionRequested && !releaseLabel) {
    throw new Error('release-label is required when collection-sync-mode or spec-sync-mode is version');
  }
  const assetProjectName = createAssetProjectName(inputs, releaseLabel);

  // Auto-resolve asset IDs from repo variables when not provided explicitly
  if (dependencies.github) {
    if (!inputs.workspaceId) {
      const stored = await readVariable(dependencies.github, inputs.projectName, 'WORKSPACE_ID');
      if (stored) {
        inputs.workspaceId = stored;
        dependencies.core.info(`Resolved workspace-id from repo variable: ${stored}`);
      }
    }
    if (!inputs.baselineCollectionId) {
      const stored = await readVariable(dependencies.github, inputs.projectName, 'BASELINE_COLLECTION_UID');
      if (stored) {
        inputs.baselineCollectionId = stored;
        dependencies.core.info(`Resolved baseline-collection-id from repo variable: ${stored}`);
      }
    }
    if (!inputs.smokeCollectionId) {
      const stored = await readVariable(dependencies.github, inputs.projectName, 'SMOKE_COLLECTION_UID');
      if (stored) {
        inputs.smokeCollectionId = stored;
        dependencies.core.info(`Resolved smoke-collection-id from repo variable: ${stored}`);
      }
    }
    if (!inputs.contractCollectionId) {
      const stored = await readVariable(dependencies.github, inputs.projectName, 'CONTRACT_COLLECTION_UID');
      if (stored) {
        inputs.contractCollectionId = stored;
        dependencies.core.info(`Resolved contract-collection-id from repo variable: ${stored}`);
      }
    }
  }

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

  if (
    inputs.workspaceId &&
    inputs.baselineCollectionId &&
    Object.keys(envUids).length > 0
  ) {
    const mockEnvUid = envUids.dev || envUids.prod || Object.values(envUids)[0];
    if (mockEnvUid) {
      let resolvedMockUrl = '';

      if (inputs.mockUrl) {
        resolvedMockUrl = inputs.mockUrl;
        dependencies.core.info(`Reusing mock from explicit input: ${resolvedMockUrl}`);
      }

      if (!resolvedMockUrl && inputs.baselineCollectionId) {
        const discovered = await dependencies.postman.findMockByCollection(inputs.baselineCollectionId);
        if (discovered) {
          resolvedMockUrl = discovered.mockUrl;
          dependencies.core.info(`Discovered existing mock for collection ${inputs.baselineCollectionId}: ${resolvedMockUrl}`);
        }
      }

      if (!resolvedMockUrl && dependencies.github && inputs.collectionSyncMode !== 'version') {
        const cached = (await readVariable(dependencies.github, inputs.projectName, 'MOCK_URL')) || '';
        if (cached) {
          resolvedMockUrl = cached;
          dependencies.core.info(`Reusing mock from repo variable: ${resolvedMockUrl}`);
        }
      }

      if (!resolvedMockUrl) {
        const mock = await dependencies.postman.createMock(
          inputs.workspaceId,
          `${assetProjectName} Mock`,
          inputs.baselineCollectionId,
          mockEnvUid
        );
        resolvedMockUrl = mock.url;
        dependencies.core.info(`Created new mock: ${resolvedMockUrl}`);
        if (dependencies.github && resolvedMockUrl && persistCurrentPointers) {
          await writeVariable(
            dependencies.github,
            inputs.projectName,
            'MOCK_URL',
            resolvedMockUrl,
            dependencies.core
          );
        }
      }

      outputs['mock-url'] = resolvedMockUrl;
    }
  }

  if (inputs.workspaceId && inputs.smokeCollectionId && Object.keys(envUids).length > 0) {
    const monitorEnvUid = envUids.prod || envUids.dev || Object.values(envUids)[0];
    let disableMonitor = false;

    let effectiveCron = inputs.monitorCron && inputs.monitorCron.trim() ? inputs.monitorCron.trim() : '';
    if (!effectiveCron && dependencies.github) {
      const storedCron = (await readVariable(
        dependencies.github,
        inputs.projectName,
        'MONITOR_CRON_SCHEDULE'
      )) || '';
      if (storedCron) {
        if (storedCron.toLowerCase() === 'disabled' || storedCron.toLowerCase() === 'off') {
          disableMonitor = true;
        } else {
          effectiveCron = storedCron;
        }
      }
    }

    if (monitorEnvUid && !disableMonitor && inputs.monitorType !== 'cli') {
      let resolvedMonitorId = '';

      if (inputs.monitorId) {
        const valid = await dependencies.postman.monitorExists(inputs.monitorId);
        if (valid) {
          resolvedMonitorId = inputs.monitorId;
          dependencies.core.info(`Reusing monitor from explicit input: ${resolvedMonitorId}`);
        } else {
          dependencies.core.warning(`Explicit monitor-id ${inputs.monitorId} not found in Postman, falling through to discovery.`);
        }
      }

      if (!resolvedMonitorId && inputs.smokeCollectionId) {
        const discovered = await dependencies.postman.findMonitorByCollection(inputs.smokeCollectionId);
        if (discovered) {
          resolvedMonitorId = discovered.uid;
          dependencies.core.info(`Discovered existing monitor for collection ${inputs.smokeCollectionId}: ${resolvedMonitorId}`);
        }
      }

      if (!resolvedMonitorId && dependencies.github && inputs.collectionSyncMode !== 'version') {
        const cached =
          (await readVariable(dependencies.github, inputs.projectName, 'SMOKE_MONITOR_UID')) || '';
        if (cached) {
          const valid = await dependencies.postman.monitorExists(cached);
          if (valid) {
            resolvedMonitorId = cached;
            dependencies.core.info(`Reusing monitor from repo variable: ${resolvedMonitorId}`);
          } else {
            dependencies.core.warning(`Cached monitor ${cached} no longer exists in Postman, creating a new one.`);
          }
        }
      }

      if (!resolvedMonitorId) {
        resolvedMonitorId = await dependencies.postman.createMonitor(
          inputs.workspaceId,
          `${assetProjectName} - Smoke Monitor`,
          inputs.smokeCollectionId,
          monitorEnvUid,
          effectiveCron || undefined
        );
        dependencies.core.info(`Created new monitor: ${resolvedMonitorId}${effectiveCron ? '' : ' (disabled — no cron configured)'}`);
        if (dependencies.github && resolvedMonitorId && persistCurrentPointers) {
          await writeVariable(
            dependencies.github,
            inputs.projectName,
            'SMOKE_MONITOR_UID',
            resolvedMonitorId,
            dependencies.core
          );
        }
      }

      outputs['monitor-id'] = resolvedMonitorId;
    } else if (disableMonitor) {
      dependencies.core.info('Monitor creation skipped because MONITOR_CRON_SCHEDULE is disabled.');
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

  await exportArtifacts(inputs, dependencies, envUids, assetProjectName);
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

export async function resolvePostmanApiKeyAndTeamId(
  inputs: ResolvedInputs,
  actionCore: Pick<CoreLike, 'info' | 'setSecret' | 'warning'>,
  actionExec: ExecLike,
  masker: SecretMasker,
  options: {
    persistGeneratedApiKeySecret?: boolean;
    env: NodeJS.ProcessEnv;
  }
): Promise<{ apiKey: string; teamId: string }> {
  let apiKey = inputs.postmanApiKey;
  let teamId = inputs.teamId;
  let keyValid = false;

  if (apiKey) {
    const tempClient = new PostmanAssetsClient({ apiKey, secretMasker: masker });
    try {
      const me = await tempClient.getMe();
      if (me && me.user) {
        keyValid = true;
        if (!teamId && typeof me.user === 'object' && 'teamId' in me.user && me.user.teamId) {
          teamId = String(me.user.teamId);
        }
      }
    } catch (error: any) {
      if (error?.status === 401 || error?.status === 403) {
        actionCore.warning('Provided postman-api-key is invalid or expired.');
      } else {
        throw error;
      }
    }
  }

  if (!keyValid) {
    if (!inputs.postmanAccessToken) {
      throw new Error('postman-api-key is missing or invalid, and no postman-access-token provided to generate a new one.');
    }

    actionCore.info('Generating a new Postman API key using postman-access-token...');

    const internalIntegration = createInternalIntegrationAdapter({
      accessToken: inputs.postmanAccessToken,
      backend: inputs.integrationBackend,
      orgMode: inputs.orgMode,
      teamId,
      secretMasker: masker
    });

    const keyName = `repo-sync-action-${Date.now()}`;
    apiKey = await internalIntegration.createApiKey(keyName);
    actionCore.setSecret(apiKey);

    if (!teamId) {
       const tempClient = new PostmanAssetsClient({ apiKey, secretMasker: masker });
       const autoTeamId = await tempClient.getAutoDerivedTeamId();
       if (autoTeamId) teamId = autoTeamId;
    }

    if ((options.persistGeneratedApiKeySecret ?? true) && (inputs.githubToken || inputs.ghFallbackToken)) {
      actionCore.info('Persisting new Postman API key to GitHub repository secrets...');
      const ghToken = inputs.ghFallbackToken || inputs.githubToken;
      const repo = inputs.repository;
      if (repo) {
        try {
          const ghCommand = await actionExec.getExecOutput('gh', [
            'secret', 'set', 'POSTMAN_API_KEY', '--repo', repo
          ], {
            input: Buffer.from(apiKey),
            env: buildGhCliEnv(options.env, ghToken),
            ignoreReturnCode: true
          });
          if (ghCommand.exitCode !== 0) {
            actionCore.warning(`Failed to save POSTMAN_API_KEY secret: ${ghCommand.stderr}`);
          }
        } catch (e: any) {
          actionCore.warning(`Error saving POSTMAN_API_KEY secret: ${e.message}`);
        }
      }
    } else if (options.persistGeneratedApiKeySecret ?? true) {
      actionCore.warning('No GitHub token provided; cannot save generated POSTMAN_API_KEY secret.');
    } else {
      actionCore.info('Skipping generated POSTMAN_API_KEY GitHub secret persistence for this run.');
    }
  }


  // Auto-detect org-mode when not explicitly set
  if (!inputs.orgMode && teamId) {
    try {
      const client = new PostmanAssetsClient({ apiKey, secretMasker: masker });
      const teams = await client.getTeams();
      if (teams.length > 1 && teams.every(t => t.organizationId == null)) {
        actionCore.warning(
          'GET /teams returned multiple teams but none include organizationId. ' +
          'Org-mode auto-detection may be degraded due to an upstream API change. ' +
          'Set org-mode and team-id explicitly if Bifrost calls fail.'
        );
      }
      const orgIds = new Set(teams.filter(t => t.organizationId != null).map(t => t.organizationId));
      const meTeamId = parseInt(teamId, 10);
      if (teams.length > 1 && orgIds.size === 1 && orgIds.has(meTeamId)) {
        inputs.orgMode = true;
        actionCore.info(`Org-mode auto-detected (${teams.length} sub-teams under org ${meTeamId}). x-entity-team-id will be included in Bifrost calls.`);
      }
    } catch {
      // Non-fatal: if detection fails, orgMode stays false (header omitted) which is safe
    }
  }

  return { apiKey, teamId };
}

export function createRepoSyncDependencies(
  inputs: ResolvedInputs,
  resolved: { apiKey: string; teamId: string },
  factories: RepoSyncDependencyFactories,
  options: { repository?: string; secretMasker?: SecretMasker } = {}
): RepoSyncDependencies {
  const repository = options.repository ?? inputs.repository;
  const masker =
    options.secretMasker ??
    createSecretMasker([
      resolved.apiKey,
      inputs.postmanAccessToken,
      inputs.githubToken,
      inputs.ghFallbackToken,
      inputs.sslClientCert,
      inputs.sslClientKey,
      inputs.sslClientPassphrase,
      inputs.sslExtraCaCerts
    ]);

  const postman = new PostmanAssetsClient({
    apiKey: resolved.apiKey,
    secretMasker: masker
  });

  const github =
    repository && (inputs.githubToken || inputs.ghFallbackToken)
      ? new GitHubApiClient({
          repository,
          token: inputs.githubToken || inputs.ghFallbackToken,
          fallbackToken: inputs.ghFallbackToken,
          authMode: inputs.githubAuthMode,
          secretMasker: masker
        })
      : undefined;

  const repoMutation =
    repository &&
    (inputs.repoWriteMode === 'commit-only' || inputs.repoWriteMode === 'commit-and-push')
      ? new RepoMutationService({
          repository,
          secretMasker: masker,
          execute: async (command, args) => {
            const result = await factories.exec.getExecOutput(command, args, {
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

  const internalIntegration = inputs.postmanAccessToken
    ? createInternalIntegrationAdapter({
        accessToken: inputs.postmanAccessToken,
        backend: inputs.integrationBackend,
        orgMode: inputs.orgMode,
        teamId: resolved.teamId,
        secretMasker: masker
      })
    : undefined;

  return {
    core: factories.core,
    postman,
    github,
    internalIntegration,
    repoMutation
  };
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
    inputs.ghFallbackToken,
    inputs.sslClientCert,
    inputs.sslClientKey,
    inputs.sslClientPassphrase,
    inputs.sslExtraCaCerts
  ]);

  const resolved = await resolvePostmanApiKeyAndTeamId(inputs, actionCore, actionExec, masker, {
    env: process.env
  });
  const repository = inputs.repository;
  const dependencies = createRepoSyncDependencies(
    inputs,
    resolved,
    {
      core: actionCore,
      exec: actionExec
    },
    {
      repository,
      secretMasker: masker
    }
  );

  if (!dependencies.github) {
    actionCore.info('GitHub variable persistence disabled for this run');
  }
  if (inputs.environmentSyncEnabled && !dependencies.internalIntegration) {
    actionCore.warning(
      'Skipping system environment association because postman-access-token is not configured'
    );
  }
  if (inputs.workspaceLinkEnabled && !dependencies.internalIntegration) {
    actionCore.warning(
      'Skipping workspace linking because postman-access-token is not configured'
    );
  }

  await persistSslSecrets(inputs, actionCore, actionExec, repository, dependencies.github);

  return runRepoSync(inputs, dependencies);
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
