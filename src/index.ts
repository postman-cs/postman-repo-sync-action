import * as core from '@actions/core';
import * as exec from '@actions/exec';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs';
import * as path from 'node:path';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';

import { convertAndSplitAnyCollection } from './postman-v3/converter.js';
import { getCiWorkflowTemplate, renderCiWorkflowTemplate, renderGcWorkflowTemplate } from './lib/ci-workflow-template.js';
import { RepoMutationService, resolveCurrentRef } from './lib/github/repo-mutation.js';
import { detectRepoContext, type GitProvider } from './lib/repo/context.js';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';
import { resolveActionVersion } from './action-version.js';
import {
  createInternalIntegrationAdapter,
  type InternalIntegrationAdapter
} from './lib/postman/internal-integration-adapter.js';
import {
  parsePostmanRegion,
  parsePostmanStack,
  resolvePostmanEndpointProfile,
  type PostmanRegion,
  type PostmanStack
} from './lib/postman/base-urls.js';
import {
  getMemoizedSessionIdentity,
  resolveSessionIdentity,
  runCredentialPreflight,
  type PreflightMode
} from './lib/postman/credential-identity.js';
import { HttpError } from './lib/http-error.js';
import { postmanRepoSyncActionContract } from './contracts.js';
import { PostmanAssetsClient } from './lib/postman/postman-assets-client.js';
import { PostmanGatewayAssetsClient } from './lib/postman/postman-gateway-assets-client.js';
import { AccessTokenProvider, mintAccessTokenIfNeeded } from './lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from './lib/postman/gateway-client.js';
import {
  createMutableSecretMasker,
  createSecretMasker,
  type SecretMasker
} from './lib/secrets.js';
import { validateCertMaterial } from './lib/ssl-validation.js';
import {
  BRANCH_DECISION_ENV,
  channelAssetName,
  parseChannelRules,
  previewAssetName,
  parseAssetMarker,
  resolveBranchIdentity,
  buildBranchSlug,
  resolveEffectiveBranchDecision,
  serializeBranchDecision,
  type AssetMarker,
  type BranchDecision,
  type BranchStrategy
} from './lib/repo/branch-decision.js';

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
  collectionSyncMode: 'refresh' | 'version';
  specSyncMode: 'update' | 'version';
  releaseLabel?: string;
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
  credentialPreflight: PreflightMode;
  branchStrategy: BranchStrategy;
  canonicalBranch?: string;
  channels?: string;
  /** Sliding preview TTL in days (plan §6.5 rule 3). Default 30. */
  previewTtlDays: number;
  adoToken: string;
  githubToken: string;
  ghFallbackToken: string;
  provider: GitProvider;
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
  specId: string;
  specContentChanged?: boolean;
  specPath: string;
  teamId: string;
  repository: string;
  postmanRegion: PostmanRegion;
  postmanStack: PostmanStack;
  postmanApiBase: string;
  postmanBifrostBase: string;
  postmanCliInstallUrl: string;
  postmanIapubBase: string;
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
  'sync-status': string;
  'branch-decision': string;
  'spec-version-tag': string;
  'spec-version-url': string;
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
  teamId?: string;
  core: Pick<CoreLike, 'info' | 'setOutput' | 'warning'>;
  postman: Pick<
    PostmanGatewayAssetsClient,
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
    | 'findEnvironmentByName'
    | 'findMonitorByCollection'
    | 'findMockByCollection'
    | 'runMonitor'
    | 'listEnvironments'
    | 'deleteEnvironment'
    | 'deleteMock'
    | 'deleteMonitor'
  > & Partial<Pick<PostmanGatewayAssetsClient, 'deleteCollection' | 'listSpecifications' | 'getSpecContent' | 'listSpecCollections' | 'deleteSpec' | 'tagSpecVersion' | 'listSpecVersionTags'>>;
  github?: {
    getRepositoryVariable(name: string): Promise<string>;
    setRepositoryVariable(name: string, value: string): Promise<void>;
  };
  internalIntegration?: Pick<
    InternalIntegrationAdapter,
    'associateSystemEnvironments' | 'connectWorkspaceToRepository'
  >;
  repoMutation?: RepoMutationService;
}

export interface RepoSyncDependencyFactories {
  core: Pick<CoreLike, 'info' | 'setOutput' | 'warning' | 'setSecret'>;
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
  const normalizedName = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
  const runnerName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const normalizedRaw = env[normalizedName];
  const runnerRaw = runnerName === normalizedName ? undefined : env[runnerName];
  const hasNormalized = normalizedRaw !== undefined;
  const hasRunner = runnerRaw !== undefined;

  if (hasNormalized && hasRunner) {
    const normalizedValue = normalizeInputValue(normalizedRaw);
    const runnerValue = normalizeInputValue(runnerRaw);
    if (normalizedValue !== runnerValue) {
      throw new Error(
        `Conflicting values for ${name}: ${normalizedName}=${JSON.stringify(normalizedValue)} vs ${runnerName}=${JSON.stringify(runnerValue)}`
      );
    }
  }

  return normalizeInputValue(hasNormalized ? normalizedRaw : runnerRaw);
}

export function hasInput(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalizedName = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
  const runnerName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return (
    env[normalizedName] !== undefined ||
    (runnerName !== normalizedName && env[runnerName] !== undefined)
  );
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
  throw new Error(
    `Unsupported repo-write-mode "${value}". Allowed values: none, commit-only, commit-and-push`
  );
}

function normalizeCollectionSyncMode(value: string): 'refresh' | 'version' {
  if (value === 'refresh' || value === 'version') {
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

function parseCredentialPreflight(value: string | undefined): PreflightMode {
  const definition = postmanRepoSyncActionContract.inputs['credential-preflight'];
  const allowed = definition.allowedValues ?? [];
  const normalized = String(value || '').trim() || (definition.default ?? 'warn');
  if (allowed.includes(normalized)) {
    return normalized as PreflightMode;
  }
  throw new Error(
    `Unsupported credential-preflight "${normalized}". Supported values: ${allowed.join(', ')}`
  );
}

function parseBranchStrategy(value: string | undefined): BranchStrategy {
  const definition = postmanRepoSyncActionContract.inputs['branch-strategy'];
  const allowed = definition.allowedValues ?? [];
  const normalized = String(value || '').trim() || (definition.default ?? 'legacy');
  if (allowed.includes(normalized)) {
    return normalized as BranchStrategy;
  }
  throw new Error(
    `Unsupported branch-strategy "${normalized}". Supported values: ${allowed.join(', ')}`
  );
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

function deriveReleaseLabel(
  inputs: Pick<
    ResolvedInputs,
    'currentRef' | 'githubHeadRef' | 'githubRefName' | 'releaseLabel'
  >
): string {
  const explicit = normalizeReleaseLabel(inputs.releaseLabel || '');
  if (explicit) {
    return explicit;
  }
  return normalizeReleaseLabel(resolveCurrentRef({
    currentRef: inputs.currentRef,
    githubHeadRef: inputs.githubHeadRef,
    githubRefName: inputs.githubRefName,
    repoWriteMode: 'commit-and-push'
  }));
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

export function resolveInputs(env: NodeJS.ProcessEnv = process.env): ResolvedInputs {
  const repoContext = detectRepoContext(
    {
      repoUrl: getInput('repo-url', env),
      gitProvider: getInput('git-provider', env)
    },
    env
  );

  const environments = parseJsonArray(getInput('environments-json', env) || '["prod"]');
  const systemEnvMap = parseJsonMap(getInput('system-env-map-json', env) || '{}');
  const environmentUids = parseJsonMap(getInput('environment-uids-json', env) || '{}');
  const envRuntimeUrls = parseJsonMap(getInput('env-runtime-urls-json', env) || '{}');
  const postmanRegion = parsePostmanRegion(getInput('postman-region', env));
  const postmanStack = parsePostmanStack(getInput('postman-stack', env));
  const endpointProfile = resolvePostmanEndpointProfile(postmanStack, postmanRegion);

  return {
    projectName: getInput('project-name', env),
    workspaceId: getInput('workspace-id', env),
    baselineCollectionId: getInput('baseline-collection-id', env),
    smokeCollectionId: getInput('smoke-collection-id', env),
    contractCollectionId: getInput('contract-collection-id', env),
    specId: getInput('spec-id', env),
    specContentChanged: parseBooleanInput(getInput('spec-content-changed', env), true),
    specPath: getInput('spec-path', env),
    collectionSyncMode: normalizeCollectionSyncMode(getInput('collection-sync-mode', env) || 'refresh'),
    specSyncMode: normalizeSpecSyncMode(getInput('spec-sync-mode', env) || 'update'),
    releaseLabel: normalizeReleaseLabel(getInput('release-label', env)) || undefined,
    environments: environments.length > 0 ? environments : ['prod'],
    repoUrl: repoContext.repoUrl || '',
    integrationBackend: getInput('integration-backend', env) || 'bifrost',
    workspaceLinkEnabled: parseBooleanInput(getInput('workspace-link-enabled', env), true),
    environmentSyncEnabled: parseBooleanInput(getInput('environment-sync-enabled', env), true),
    systemEnvMap,
    environmentUids,
    envRuntimeUrls,
    artifactDir: getInput('artifact-dir', env) || 'postman',
    repoWriteMode: hasInput('repo-write-mode', env)
      ? normalizeRepoWriteMode(getInput('repo-write-mode', env))
      : 'commit-and-push',
    currentRef:
      getInput('current-ref', env) ||
      normalizeInputValue(env.GITHUB_REF) ||
      normalizeInputValue(env.BUILD_SOURCEBRANCH),
    githubHeadRef:
      getInput('github-head-ref', env) ||
      normalizeInputValue(env.GITHUB_HEAD_REF) ||
      normalizeInputValue(env.SYSTEM_PULLREQUEST_SOURCEBRANCH),
    githubRefName:
      getInput('github-ref-name', env) ||
      normalizeInputValue(env.GITHUB_REF_NAME) ||
      normalizeInputValue(repoContext.ref),
    committerName: getInput('committer-name', env) || 'Postman',
    committerEmail: getInput('committer-email', env) || 'support@postman.com',
    postmanApiKey: getInput('postman-api-key', env),
    postmanAccessToken: getInput('postman-access-token', env),
    credentialPreflight: parseCredentialPreflight(getInput('credential-preflight', env)),
    branchStrategy: parseBranchStrategy(getInput('branch-strategy', env)),
    canonicalBranch: getInput('canonical-branch', env) || undefined,
    channels: getInput('channels', env) || undefined,
    previewTtlDays: Math.max(1, Number.parseInt(getInput('preview-ttl', env) || '30', 10) || 30),
    adoToken: getInput('ado-token', env) || normalizeInputValue(env.SYSTEM_ACCESSTOKEN),
    githubToken: getInput('github-token', env),
    ghFallbackToken: getInput('gh-fallback-token', env),
    provider: repoContext.provider,
    ciWorkflowBase64: getInput('ci-workflow-base64', env),
    generateCiWorkflow: parseBooleanInput(getInput('generate-ci-workflow', env), true),
    monitorType: getInput('monitor-type', env) || 'cloud',
    ciWorkflowPath:
      getInput('ci-workflow-path', env) ||
      (repoContext.provider === 'azure-devops' ? 'azure-pipelines.yml' : '.github/workflows/ci.yml'),
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
      normalizeInputValue(repoContext.repoSlug),
    postmanRegion,
    postmanStack,
    postmanApiBase: endpointProfile.apiBaseUrl,
    postmanBifrostBase: endpointProfile.bifrostBaseUrl,
    postmanCliInstallUrl: endpointProfile.cliInstallUrl,
    postmanIapubBase: endpointProfile.iapubBaseUrl
  };
}

/**
 * Machine-identity marker for preview/channel asset sets (plan §6.2 dual-channel;
 * fields feed the §6.5 retention machine). Stored as an environment value with
 * key `x-pm-onboarding` — the discovery channel the GC sweep reads. Sliding
 * TTL: lastSyncedAt/expiresAt refresh on every successful upsert.
 */
export function buildBranchAssetMarker(
  decision: BranchDecision,
  inputs: Pick<ResolvedInputs, 'repoUrl' | 'repository' | 'previewTtlDays'>,
  now: Date = new Date()
): AssetMarker | undefined {
  if (decision.tier !== 'preview' && decision.tier !== 'channel') {
    return undefined;
  }
  const rawBranch = decision.identity.headBranch;
  const repo = inputs.repoUrl || inputs.repository;
  if (!rawBranch || !repo) {
    return undefined;
  }
  const ttlMs = inputs.previewTtlDays * 24 * 60 * 60 * 1000;
  return {
    repo,
    rawBranch,
    sanitizedBranch: buildBranchSlug(rawBranch).suffix,
    role: decision.tier,
    headSha: decision.identity.headSha,
    createdAt: now.toISOString(),
    lastSyncedAt: now.toISOString(),
    ...(decision.tier === 'preview' ? { expiresAt: new Date(now.getTime() + ttlMs).toISOString() } : {})
  };
}

/** Reject canonical collection IDs on standalone preview/channel runs. */
export function assertBranchAssetIds(
  inputs: Pick<ResolvedInputs, 'baselineCollectionId' | 'smokeCollectionId' | 'contractCollectionId'>,
  decision: BranchDecision,
  branchOwnedIds = process.env.POSTMAN_BRANCH_ASSET_IDS === 'owned'
): void {
  if (decision.tier === 'legacy' || decision.tier === 'canonical' || branchOwnedIds) return;
  const provided = [
    ['baseline-collection-id', inputs.baselineCollectionId],
    ['smoke-collection-id', inputs.smokeCollectionId],
    ['contract-collection-id', inputs.contractCollectionId]
  ].filter(([, value]) => Boolean(value));
  if (provided.length > 0) {
    throw new Error(
      `CONTRACT_BRANCH_CANONICAL_WRITE: a ${decision.tier} repo-sync run cannot accept explicit collection IDs (${provided.map(([name]) => name).join(', ')}). ` +
      'Run bootstrap in the same branch-aware pipeline so it can produce branch-owned IDs.'
    );
  }
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

type CloudResourceMap = Record<string, string>;

const LEGACY_BASELINE_COLLECTION_PREFIX = '[Baseline]';

type PostmanResourcesState = {
  /** State schema version. Absent = v1 (legacy). v2 is canonical-only. */
  version?: number;
  workspace?: {
    id?: string;
  };
  localResources?: Record<string, string[]>;
  cloudResources?: {
    collections?: CloudResourceMap;
    environments?: CloudResourceMap;
    specs?: CloudResourceMap;
  };
  canonical?: {
    collections?: CloudResourceMap;
    environments?: CloudResourceMap;
    specs?: CloudResourceMap;
  };
} & Record<string, unknown>;

const RESOURCES_STATE_VERSION = 2;
const SUPPORTED_STATE_VERSIONS = new Set([1, RESOURCES_STATE_VERSION]);

/** Contract violation raised when tracked state exists but cannot be trusted. */
export class StateUnreadableError extends Error {
  readonly code = 'CONTRACT_STATE_UNREADABLE';
  constructor(message: string) {
    super(`CONTRACT_STATE_UNREADABLE: ${message}`);
    this.name = 'StateUnreadableError';
  }
}

type SpecReference = {
  repoRelativePath: string;
  configRelativePath: string;
};

function readResourcesState(): PostmanResourcesState | null {
  let raw: string;
  try {
    raw = readFileSync('.postman/resources.yaml', 'utf8');
  } catch {
    // Missing state is a first run: fall through to discover/create.
    return null;
  }
  // Malformed is NOT missing: an unreadable tracked-state file must fail loud
  // instead of silently reopening the duplicate-creation path.
  let parsed: unknown;
  try {
    parsed = loadYaml(raw);
  } catch (error) {
    throw new StateUnreadableError(
      `.postman/resources.yaml exists but is not parseable YAML (${error instanceof Error ? error.message : String(error)}). Fix or delete the file; refusing to treat tracked state as absent.`
    );
  }
  if (parsed === null || parsed === undefined) {
    return null;
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StateUnreadableError(
      '.postman/resources.yaml exists but does not contain a YAML mapping. Fix or delete the file; refusing to treat tracked state as absent.'
    );
  }
  const state = parsed as PostmanResourcesState;
  if (state.version !== undefined && !SUPPORTED_STATE_VERSIONS.has(Number(state.version))) {
    throw new StateUnreadableError(
      `.postman/resources.yaml declares unsupported state version ${String(state.version)} (supported: 1, ${RESOURCES_STATE_VERSION}). Upgrade the action or fix the file.`
    );
  }
  // State v2 is canonical-only on disk. Existing materialization code reads
  // cloudResources, so present a transient alias and strip it in the writer.
  if (state.canonical && !state.cloudResources) {
    state.cloudResources = { ...state.canonical };
  }
  return state;
}

function findCloudResourceId(
  map: CloudResourceMap | undefined,
  matcher: (filePath: string) => boolean
): string | undefined {
  if (!map) {
    return undefined;
  }

  const match = Object.entries(map).find(([filePath]) => matcher(filePath));
  return match?.[1];
}

function matchesCollectionDirectory(filePath: string, directoryName: string): boolean {
  return normalizeToPosix(filePath).replace(/\/+$/g, '').endsWith(`/collections/${directoryName}`);
}

function matchesBaselineCollectionResource(filePath: string, assetProjectName: string): boolean {
  return (
    matchesCollectionDirectory(filePath, assetProjectName) ||
    matchesCollectionDirectory(filePath, `${LEGACY_BASELINE_COLLECTION_PREFIX} ${assetProjectName}`)
  );
}

function getEnvironmentUidsFromResources(
  resourcesState: PostmanResourcesState | null
): Record<string, string> {
  const cloudEnvironments = resourcesState?.cloudResources?.environments;
  if (!cloudEnvironments) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(cloudEnvironments)
      .map(([filePath, uid]) => {
        const match = filePath.match(/\/environments\/(.+)\.postman_environment\.json$/);
        return match ? [match[1], uid] : null;
      })
      .filter((entry): entry is [string, string] => Boolean(entry))
  );
}

function normalizeToPosix(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/\\/g, '/');
}

function isOpenApiSpecFile(filePath: string): boolean {
  if (!(filePath.endsWith('.json') || filePath.endsWith('.yaml') || filePath.endsWith('.yml'))) {
    return false;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = filePath.endsWith('.json')
      ? JSON.parse(raw)
      : loadYaml(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }

    const doc = parsed as Record<string, unknown>;
    if (doc.swagger === '2.0' && doc.paths && typeof doc.paths === 'object') {
      return true;
    }
    if (
      typeof doc.openapi === 'string' &&
      doc.paths &&
      typeof doc.paths === 'object'
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

function scanLocalSpecReferences(baseDir = '.'): SpecReference[] {
  const ignoredDirs = new Set([
    '.git',
    '.omc',
    '.omx',
    '.llm-plans',
    'node_modules',
    'dist'
  ]);
  const found = new Set<string>();
  const refs: SpecReference[] = [];

  const visit = (currentDir: string): void => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (ignoredDirs.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !isOpenApiSpecFile(fullPath)) {
        continue;
      }

      const repoRelativePath = normalizeToPosix(path.relative(baseDir, fullPath));
      if (found.has(repoRelativePath)) {
        continue;
      }
      found.add(repoRelativePath);
      refs.push({
        repoRelativePath,
        configRelativePath: normalizeToPosix(path.join('..', repoRelativePath))
      });
    }
  };

  visit(baseDir);
  return refs.sort((left, right) => left.repoRelativePath.localeCompare(right.repoRelativePath));
}

function resolveMappedSpecReference(
  explicitSpecPath: string,
  discoveredSpecs: SpecReference[]
): SpecReference | undefined {
  const normalizedExplicitPath = normalizeToPosix(explicitSpecPath.trim());
  if (normalizedExplicitPath) {
    const explicitFullPath = path.resolve(normalizedExplicitPath);
    if (existsSync(explicitFullPath) && statSync(explicitFullPath).isFile()) {
      return {
        repoRelativePath: normalizedExplicitPath,
        configRelativePath: normalizeToPosix(path.join('..', normalizedExplicitPath))
      };
    }
  }

  if (discoveredSpecs.length === 1) {
    return discoveredSpecs[0];
  }

  return undefined;
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
    'commit-sha': '',
    'sync-status': '',
    'branch-decision': '',
    'spec-version-tag': '',
    'spec-version-url': ''
  };
}

export function readActionInputs(actionCore: Pick<CoreLike, 'getInput' | 'setSecret'>): ResolvedInputs {
  const projectName = readInput(actionCore, 'project-name', true);
  const postmanApiKey = readInput(actionCore, 'postman-api-key');
  const postmanAccessToken = readInput(actionCore, 'postman-access-token');
  const adoToken = readInput(actionCore, 'ado-token');
  const githubToken = readInput(actionCore, 'github-token');
  const ghFallbackToken = readInput(actionCore, 'gh-fallback-token');
  const sslClientCert = readInput(actionCore, 'ssl-client-cert');
  const sslClientKey = readInput(actionCore, 'ssl-client-key');
  const sslClientPassphrase = readInput(actionCore, 'ssl-client-passphrase');
  const sslExtraCaCerts = readInput(actionCore, 'ssl-extra-ca-certs');

  const inputs = resolveInputs({
    ...process.env,
    INPUT_PROJECT_NAME: projectName,
    INPUT_WORKSPACE_ID: readInput(actionCore, 'workspace-id'),
    INPUT_BASELINE_COLLECTION_ID: readInput(actionCore, 'baseline-collection-id'),
    INPUT_SMOKE_COLLECTION_ID: readInput(actionCore, 'smoke-collection-id'),
    INPUT_CONTRACT_COLLECTION_ID: readInput(actionCore, 'contract-collection-id'),
    INPUT_SPEC_ID: readInput(actionCore, 'spec-id'),
    INPUT_SPEC_PATH: readInput(actionCore, 'spec-path'),
    INPUT_COLLECTION_SYNC_MODE: readInput(actionCore, 'collection-sync-mode') || 'refresh',
    INPUT_SPEC_SYNC_MODE: readInput(actionCore, 'spec-sync-mode') || 'update',
    INPUT_RELEASE_LABEL: readInput(actionCore, 'release-label'),
    INPUT_ENVIRONMENTS_JSON: readInput(actionCore, 'environments-json') || '["prod"]',
    INPUT_GIT_PROVIDER: readInput(actionCore, 'git-provider'),
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
    INPUT_COMMITTER_NAME: readInput(actionCore, 'committer-name') || 'Postman',
    INPUT_COMMITTER_EMAIL: readInput(actionCore, 'committer-email') || 'support@postman.com',
    INPUT_POSTMAN_API_KEY: postmanApiKey,
    INPUT_POSTMAN_ACCESS_TOKEN: postmanAccessToken,
    INPUT_CREDENTIAL_PREFLIGHT: readInput(actionCore, 'credential-preflight') || 'warn',
    INPUT_BRANCH_STRATEGY: readInput(actionCore, 'branch-strategy'),
    INPUT_CANONICAL_BRANCH: readInput(actionCore, 'canonical-branch'),
    INPUT_CHANNELS: readInput(actionCore, 'channels'),
    INPUT_PREVIEW_TTL: readInput(actionCore, 'preview-ttl'),
    INPUT_ADO_TOKEN: adoToken,
    INPUT_GITHUB_TOKEN: githubToken,
    INPUT_GH_FALLBACK_TOKEN: ghFallbackToken,
    INPUT_CI_WORKFLOW_BASE64: readInput(actionCore, 'ci-workflow-base64'),
    INPUT_GENERATE_CI_WORKFLOW: readInput(actionCore, 'generate-ci-workflow'),
    INPUT_MONITOR_TYPE: readInput(actionCore, 'monitor-type') || 'cloud',
    INPUT_CI_WORKFLOW_PATH: readInput(actionCore, 'ci-workflow-path'),
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
    INPUT_POSTMAN_REGION: readInput(actionCore, 'postman-region') || 'us',
    INPUT_POSTMAN_STACK: readInput(actionCore, 'postman-stack') || 'prod',
    GITHUB_HEAD_REF: process.env.GITHUB_HEAD_REF,
    GITHUB_REF_NAME: process.env.GITHUB_REF_NAME
  });

  if (inputs.postmanApiKey) actionCore.setSecret(inputs.postmanApiKey);
  if (inputs.postmanAccessToken) actionCore.setSecret(inputs.postmanAccessToken);
  if (inputs.adoToken) actionCore.setSecret(inputs.adoToken);
  if (inputs.githubToken) actionCore.setSecret(inputs.githubToken);
  if (inputs.ghFallbackToken) actionCore.setSecret(inputs.ghFallbackToken);
  if (inputs.sslClientCert) actionCore.setSecret(inputs.sslClientCert);
  if (inputs.sslClientKey) actionCore.setSecret(inputs.sslClientKey);
  if (inputs.sslClientPassphrase) actionCore.setSecret(inputs.sslClientPassphrase);
  if (inputs.sslExtraCaCerts) actionCore.setSecret(inputs.sslExtraCaCerts);

  if (inputs.sslClientCert) {
    if (!inputs.sslClientKey) {
      throw new Error('ssl-client-key is required when ssl-client-cert is provided');
    }
    validateCertMaterial(
      inputs.sslClientCert,
      inputs.sslClientKey,
      inputs.sslClientPassphrase || undefined
    );
  }

  return inputs;
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
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!inputs.sslClientCert) {
    return;
  }

  if (inputs.provider === 'azure-devops') {
    actionCore.warning(
      'SSL inputs were provided but automatic secret persistence is not supported for Azure DevOps. Set these pipeline secret variables manually: POSTMAN_SSL_CLIENT_CERT_B64, POSTMAN_SSL_CLIENT_KEY_B64, POSTMAN_SSL_CLIENT_PASSPHRASE (optional), POSTMAN_SSL_EXTRA_CA_CERTS_B64 (optional).'
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
  dependencies: RepoSyncDependencies,
  resourcesState: PostmanResourcesState | null,
  assetMarker?: AssetMarker
): Promise<Record<string, string>> {
  const envUids = {
    ...getEnvironmentUidsFromResources(resourcesState),
    ...inputs.environmentUids
  };
  if (!inputs.workspaceId) {
    return envUids;
  }

  for (const envName of inputs.environments) {
    const runtimeUrl = String(inputs.envRuntimeUrls[envName] || '').trim();
    const displayName = `${inputs.projectName} - ${envName}`;
    let existingUid = String(envUids[envName] || '').trim();

    // Explicit input / .postman/resources.yaml UIDs win. Otherwise discover by
    // exact workspace display name so a fresh checkout without tracked UIDs
    // still updates instead of creating a duplicate.
    if (!existingUid) {
      const discovered = await dependencies.postman.findEnvironmentByName(
        inputs.workspaceId,
        displayName
      );
      if (discovered?.uid) {
        existingUid = discovered.uid;
        dependencies.core.info(
          `Discovered existing environment for ${displayName}: ${existingUid}`
        );
      }
    }

    if (existingUid) {
      let marker = assetMarker;
      if (marker) {
        try {
          const existing = await dependencies.postman.getEnvironment(existingUid) as { data?: { values?: Array<{ key?: string; value?: string }> }; values?: Array<{ key?: string; value?: string }> };
          const values = existing.data?.values ?? existing.values ?? [];
          const prior = values.find((value) => value.key === 'x-pm-onboarding')?.value;
          const priorMarker = parseAssetMarker(prior ? `x-pm-onboarding: ${prior}` : undefined);
          // `createdAt` identifies a branch generation. Preserve it across
          // successful refreshes; only lastSyncedAt/expiresAt slide forward.
          if (priorMarker?.repo === marker.repo && priorMarker.rawBranch === marker.rawBranch) {
            marker = { ...marker, createdAt: priorMarker.createdAt };
          }
        } catch {
          // Marker reads are optimization/safety metadata. Continue with a
          // fresh marker when the environment cannot be read for refresh.
        }
      }
      const values = buildEnvironmentValues(envName, runtimeUrl);
      if (marker) values.push({ key: 'x-pm-onboarding', value: JSON.stringify(marker), type: 'default' });
      await dependencies.postman.updateEnvironment(existingUid, displayName, values);
      envUids[envName] = existingUid;
      continue;
    }

    const values = buildEnvironmentValues(envName, runtimeUrl);
    if (assetMarker) values.push({ key: 'x-pm-onboarding', value: JSON.stringify(assetMarker), type: 'default' });
    envUids[envName] = await dependencies.postman.createEnvironment(
      inputs.workspaceId,
      displayName,
      values
    );
  }

  return envUids;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function getCollectionDirectoryName(kind: 'Baseline' | 'Smoke' | 'Contract', projectName: string): string {
  if (kind === 'Baseline') {
    return projectName;
  }
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

function buildMappedSpecCloudKey(
  mappedSource: string,
  specSyncMode: ResolvedInputs['specSyncMode'],
  releaseLabel?: string
): string | undefined {
  if (specSyncMode !== 'version') {
    return mappedSource;
  }
  const normalized = normalizeReleaseLabel(releaseLabel || '');
  if (!normalized) {
    return undefined;
  }
  return `${mappedSource}#release=${normalized}`;
}

/**
 * Decide which workspace id (if any) may be written into resources.yaml.
 * Persist when linking succeeds, linking is explicitly disabled, or the same
 * prior durable id is already present. A new id with linking enabled that
 * fails/skips must not be written.
 */
function resolveDurableWorkspaceId(options: {
  candidateId: string;
  priorId?: string;
  workspaceLinkEnabled: boolean;
  workspaceLinkStatus: Status;
}): string | undefined {
  const { candidateId, priorId, workspaceLinkEnabled, workspaceLinkStatus } = options;
  const candidate = candidateId.trim();
  const prior = priorId?.trim() || undefined;

  if (!workspaceLinkEnabled) {
    return candidate || prior;
  }

  if (workspaceLinkStatus === 'success') {
    return candidate || undefined;
  }

  // A different prior id would make the manifest's workspace disagree with
  // the candidate workspace that produced its resource mappings.
  return prior === candidate ? prior : undefined;
}

function buildResourcesManifest(
  workspaceId: string | undefined,
  collectionMap: Record<string, string>,
  envMap: Record<string, string>,
  artifactDir: string,
  localSpecRefs: string[],
  mappedSpecRef?: string,
  specId?: string,
  existingSpecs?: CloudResourceMap,
  priorState?: PostmanResourcesState | null
): string {
  // Merge-preserving writer (state v2): round-trip every unknown field from
  // the prior tracked state instead of rebuilding the document from scratch,
  // so fields written by other actions (or newer versions) survive a sync.
  const manifest: Record<string, unknown> = { ...(priorState ?? {}) };
  delete manifest.version;
  delete manifest.workspace;
  delete manifest.localResources;
  delete manifest.cloudResources;
  delete manifest.canonical;
  manifest.version = RESOURCES_STATE_VERSION;
  if (workspaceId) {
    manifest.workspace = { id: workspaceId };
  }

  const cloudResources: Record<string, Record<string, string>> = {};

  // Collections
  const collectionKeys = Object.keys(collectionMap);
  if (collectionKeys.length > 0) {
    cloudResources.collections = collectionMap;
  }

  // Environments
  const envEntries = Object.entries(envMap);
  if (envEntries.length > 0) {
    cloudResources.environments = {};
    for (const [envName, envUid] of envEntries) {
      cloudResources.environments[`../${artifactDir}/environments/${envName}.postman_environment.json`] = envUid;
    }
  }

  void localSpecRefs;

  // Preserve existing cloudResources.specs and merge any newly mapped entry.
  const specs: CloudResourceMap = { ...(existingSpecs || {}) };
  if (mappedSpecRef && specId) {
    specs[mappedSpecRef] = specId;
  }
  if (Object.keys(specs).length > 0) {
    cloudResources.specs = specs;
  }

  if (Object.keys(cloudResources).length > 0) {
    manifest.canonical = cloudResources;
  }

  return dumpYaml(manifest, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  });
}

function buildSpecCollectionWorkflowManifest(
  specRef: string,
  collectionRefs: string[]
): string {
  return dumpYaml(
    {
      workflows: {
        syncSpecToCollection: collectionRefs.map((collectionRef) => ({
          spec: specRef,
          collection: collectionRef
        }))
      }
    },
    {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false
    }
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}


export function assertPathWithinCwd(targetPath: string, fieldName: string): void {
  const originalPath = String(targetPath || '');
  const rawPath = originalPath.trim();
  const segments = rawPath.split(/[\\/]+/).filter(Boolean);
  if (
    !rawPath ||
    hasControlCharacter(originalPath) ||
    path.isAbsolute(rawPath) ||
    path.win32.isAbsolute(rawPath) ||
    segments.includes('..') ||
    rawPath.startsWith(':') ||
    hasControlCharacter(rawPath)
  ) {
    throw new Error(`${fieldName} must stay within the repository root; received ${targetPath}`);
  }

  const base = realpathSync(process.cwd());
  const resolved = path.resolve(base, rawPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must stay within the repository root; received ${targetPath}`);
  }

  let existingPath = resolved;
  while (!existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) {
      break;
    }
    existingPath = parent;
  }

  const realExistingPath = realpathSync(existingPath);
  const realRelative = path.relative(base, realExistingPath);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`${fieldName} must stay within the repository root; received ${targetPath}`);
  }
}

async function exportArtifacts(
  inputs: ResolvedInputs,
  dependencies: RepoSyncDependencies,
  envUids: Record<string, string>,
  assetProjectName: string,
  options: {
    workspaceLinkStatus: Status;
    priorWorkspaceId?: string;
    existingSpecs?: CloudResourceMap;
    releaseLabel?: string;
    priorState?: PostmanResourcesState | null;
  }
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
  const flowsDir = `${inputs.artifactDir}/flows`;
  const globalsDir = `${inputs.artifactDir}/globals`;
  const mocksDir = `${inputs.artifactDir}/mocks`;
  const specsDir = `${inputs.artifactDir}/specs`;
  ensureDir(collectionsDir);
  ensureDir(environmentsDir);
  ensureDir(flowsDir);
  ensureDir(globalsDir);
  ensureDir(mocksDir);
  ensureDir(specsDir);
  ensureDir('.postman');
  const globalsFilePath = `${globalsDir}/workspace.globals.yaml`;
  if (!existsSync(globalsFilePath)) {
    writeFileSync(globalsFilePath, 'name: Globals\nvalues: []\n');
  }
  if (inputs.generateCiWorkflow) {
    const ciDir = inputs.ciWorkflowPath.split('/').slice(0, -1).join('/');
    if (ciDir) {
      ensureDir(ciDir);
    }
  }

  const manifestCollections: Record<string, string> = {};
  const discoveredSpecs = scanLocalSpecReferences();
  const mappedSpec = resolveMappedSpecReference(inputs.specPath, discoveredSpecs);
  const mappedSpecCloudKey =
    mappedSpec && inputs.specId
      ? buildMappedSpecCloudKey(
          mappedSpec.configRelativePath,
          inputs.specSyncMode,
          options.releaseLabel
        )
      : undefined;

  if (inputs.baselineCollectionId) {
    const col = await dependencies.postman.getCollection(inputs.baselineCollectionId);
    const dirName = getCollectionDirectoryName('Baseline', assetProjectName);
    await convertAndSplitAnyCollection(col as Parameters<typeof convertAndSplitAnyCollection>[0], `${collectionsDir}/${dirName}`);
    manifestCollections[`../${collectionsDir}/${dirName}`] =
      inputs.baselineCollectionId;
  }
  if (inputs.smokeCollectionId) {
    const col = await dependencies.postman.getCollection(inputs.smokeCollectionId);
    const dirName = getCollectionDirectoryName('Smoke', assetProjectName);
    await convertAndSplitAnyCollection(col as Parameters<typeof convertAndSplitAnyCollection>[0], `${collectionsDir}/${dirName}`);
    manifestCollections[`../${collectionsDir}/${dirName}`] =
      inputs.smokeCollectionId;
  }
  if (inputs.contractCollectionId) {
    const col = await dependencies.postman.getCollection(inputs.contractCollectionId);
    const dirName = getCollectionDirectoryName('Contract', assetProjectName);
    await convertAndSplitAnyCollection(col as Parameters<typeof convertAndSplitAnyCollection>[0], `${collectionsDir}/${dirName}`);
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

  const durableWorkspaceId = resolveDurableWorkspaceId({
    candidateId: inputs.workspaceId,
    priorId: options.priorWorkspaceId,
    workspaceLinkEnabled: inputs.workspaceLinkEnabled,
    workspaceLinkStatus: options.workspaceLinkStatus
  });

  writeFileSync('.postman/resources.yaml', buildResourcesManifest(
    durableWorkspaceId,
    manifestCollections,
    envUids,
    inputs.artifactDir,
    discoveredSpecs.map((spec) => spec.configRelativePath),
    mappedSpecCloudKey,
    inputs.specId || undefined,
    options.existingSpecs,
    options.priorState
  ));

  if (mappedSpec && Object.keys(manifestCollections).length > 0) {
    writeFileSync(
      '.postman/workflows.yaml',
      buildSpecCollectionWorkflowManifest(
        mappedSpec.configRelativePath,
        Object.keys(manifestCollections)
      )
    );
  }
}

function renderCiWorkflow(inputs: ResolvedInputs): string {
  if (inputs.ciWorkflowBase64) {
    return Buffer.from(inputs.ciWorkflowBase64, 'base64').toString('utf8');
  }
  if (inputs.provider === 'azure-devops') {
    return getCiWorkflowTemplate(inputs.provider, {
      postmanCliInstallUrl: inputs.postmanCliInstallUrl,
      postmanRegion: inputs.postmanRegion
    });
  }
  return renderCiWorkflowTemplate({
    postmanCliInstallUrl: inputs.postmanCliInstallUrl,
    postmanRegion: inputs.postmanRegion
  });
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
  // File generation is independent of git mutation: mode=none still writes the
  // requested CI workflow, but never stages/commits/pushes.
  if (inputs.generateCiWorkflow) {
    assertPathWithinCwd(inputs.ciWorkflowPath, 'ci-workflow-path');
    const ciWorkflow = renderCiWorkflow(inputs);

    // Extract dir from ciWorkflowPath
    const parts = inputs.ciWorkflowPath.split('/');
    if (parts.length > 1) {
      const dir = parts.slice(0, -1).join('/');
      ensureDir(dir);
    }

    writeFileSync(inputs.ciWorkflowPath, ciWorkflow);

    // GC workflow: dedicated generated workflow for preview retention (R18a).
    // Emitted alongside the CI workflow when generate-ci-workflow is enabled;
    // never rides the smoke/contract CI template.
    if (inputs.provider === 'github' || inputs.provider === 'unknown') {
      const gcPath = '.github/workflows/postman-preview-gc.yml';
      if (inputs.ciWorkflowPath.endsWith('.github/workflows/ci.yml') || inputs.ciWorkflowPath === '.github/workflows/ci.yml') {
        ensureDir('.github/workflows');
        writeFileSync(gcPath, renderGcWorkflowTemplate());
      }
    }
  }

  if (!dependencies.repoMutation || inputs.repoWriteMode === 'none') {
    return { commitSha: '', resolvedCurrentRef: '', pushed: false };
  }

  const provisionPath = '.github/workflows/provision.yml';
  const provisionExists = inputs.provider === 'github' && existsSync(provisionPath);
  const gcWorkflowPath = '.github/workflows/postman-preview-gc.yml';
  const gcExists = inputs.generateCiWorkflow && existsSync(gcWorkflowPath);

  const stagePaths = [
    inputs.artifactDir,
    '.postman',
    inputs.generateCiWorkflow ? inputs.ciWorkflowPath : null,
    gcExists ? gcWorkflowPath : null,
    provisionExists ? provisionPath : null
  ].filter((entry) => typeof entry === 'string' && (existsSync(entry) || entry === provisionPath)) as string[];

  if (stagePaths.length === 0) {
    dependencies.core.info('No generated repository paths were found; skipping repo mutation.');
    return {
      commitSha: '',
      pushed: false,
      resolvedCurrentRef: resolveCurrentRef({
        currentRef: inputs.currentRef,
        githubHeadRef: inputs.githubHeadRef,
        githubRefName: inputs.githubRefName,
        repoWriteMode: inputs.repoWriteMode
      })
    };
  }

  const result = await dependencies.repoMutation.commitAndPush({
    repoWriteMode: inputs.repoWriteMode,
    currentRef: inputs.currentRef,
    githubHeadRef: inputs.githubHeadRef,
    githubRefName: inputs.githubRefName,
    committerName: inputs.committerName,
    committerEmail: inputs.committerEmail,
    adoToken: inputs.provider === 'azure-devops' ? inputs.adoToken : undefined,
    githubToken: inputs.provider === 'azure-devops' ? undefined : inputs.githubToken,
    fallbackToken: inputs.provider === 'azure-devops' ? undefined : inputs.ghFallbackToken,
    removePaths: provisionExists ? [provisionPath] : [],
    stagePaths
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
  const telemetry = createTelemetryContext({ action: 'postman-repo-sync-action', actionVersion: resolveActionVersion(), logger: dependencies.core });
  telemetry.setTeamId(dependencies.teamId);
  try {
    const result = await runRepoSyncInner(inputs, dependencies);
    telemetry.setAccountType(getMemoizedSessionIdentity()?.consumerType);
    telemetry.emitCompletion('success');
    return result;
  } catch (error) {
    telemetry.setAccountType(getMemoizedSessionIdentity()?.consumerType);
    telemetry.emitCompletion('failure');
    throw error;
  }
}

async function runRepoSyncInner(
  inputs: ResolvedInputs,
  dependencies: RepoSyncDependencies
): Promise<RepoSyncOutputs> {
  // Branch-aware sync: the effective BranchDecision (inherited from bootstrap
  // via POSTMAN_BRANCH_DECISION, or resolved locally; legacy under default
  // inputs). Gated runs never reach here (runAction short-circuits), so the
  // non-canonical tiers seen here are preview and channel.
  const branchDecision = decideBranchTier(inputs);
  assertBranchAssetIds(inputs, branchDecision);
  const isCanonicalWriter = branchDecision.tier === 'legacy' || branchDecision.tier === 'canonical';
  if (!isCanonicalWriter) {
    // Preview/channel runs: branch-scoped asset names; no repo-link mutation;
    // no canonical state write-back; no git push of generated state.
    if (branchDecision.tier === 'preview' && branchDecision.identity.headBranch) {
      inputs = {
        ...inputs,
        projectName: previewAssetName(inputs.projectName, branchDecision.identity.headBranch),
        workspaceLinkEnabled: false,
        environmentSyncEnabled: false,
        repoWriteMode: 'none'
      };
    } else if (branchDecision.tier === 'channel' && branchDecision.channel) {
      inputs = {
        ...inputs,
        projectName: channelAssetName(inputs.projectName, branchDecision.channel.code),
        workspaceLinkEnabled: false,
        environmentSyncEnabled: false,
        repoWriteMode: 'none'
      };
    }
    dependencies.core.info(
      `branch-aware sync: ${branchDecision.tier} run — branch-scoped asset set "${inputs.projectName}", no workspace repo-link mutation, no state write-back`
    );
  }

  const outputs = createOutputs(inputs);
  const versionRequested = inputs.collectionSyncMode === 'version' || inputs.specSyncMode === 'version';
  const releaseLabel = deriveReleaseLabel(inputs);
  if (versionRequested && !releaseLabel) {
    throw new Error('release-label is required when collection-sync-mode or spec-sync-mode is version');
  }
  const assetProjectName = createAssetProjectName(inputs, releaseLabel);
  const trackedState = readResourcesState();
  // State v2 (canonical-only): asset ids in tracked state belong to the
  // canonical set; non-canonical runs may reuse the workspace id (shared
  // infrastructure) but never canonical asset ids (ref-aware v1 migration).
  const resourcesState = isCanonicalWriter
    ? trackedState
    : trackedState?.workspace
      ? { workspace: trackedState.workspace }
      : null;

  // .postman/ file fallback (works for all CI providers, not just GitHub)
  if (resourcesState) {
    if (!inputs.workspaceId && resourcesState.workspace?.id) {
      inputs.workspaceId = resourcesState.workspace.id;
      dependencies.core.info('Resolved workspace-id from .postman/resources.yaml');
    }

    const cloudCollections = resourcesState.cloudResources?.collections;
    if (!inputs.baselineCollectionId) {
      inputs.baselineCollectionId =
        findCloudResourceId(cloudCollections, (filePath) => matchesBaselineCollectionResource(filePath, assetProjectName)) || '';
      if (inputs.baselineCollectionId) {
        dependencies.core.info('Resolved baseline-collection-id from .postman/resources.yaml');
      }
    }
    if (!inputs.smokeCollectionId) {
      inputs.smokeCollectionId =
        findCloudResourceId(cloudCollections, (filePath) => filePath.includes('[Smoke]')) || '';
      if (inputs.smokeCollectionId) {
        dependencies.core.info('Resolved smoke-collection-id from .postman/resources.yaml');
      }
    }
    if (!inputs.contractCollectionId) {
      inputs.contractCollectionId =
        findCloudResourceId(cloudCollections, (filePath) => filePath.includes('[Contract]')) || '';
      if (inputs.contractCollectionId) {
        dependencies.core.info('Resolved contract-collection-id from .postman/resources.yaml');
      }
    }
  }

  const branchAssetMarker = buildBranchAssetMarker(branchDecision, inputs);
  const envUids = await upsertEnvironments(inputs, dependencies, resourcesState, branchAssetMarker);
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
    } else if (Object.keys(envUids).length > 0) {
      // Catalog indexes the git filesystem link without system-env associations, but the
      // Catalog UI system-environment filter (Prod/Stage/Dev) hides services that have no
      // mapping — operators then report "not in catalog" even when the link succeeded.
      const configuredKeys = Object.keys(inputs.systemEnvMap).filter((key) =>
        Boolean(String(inputs.systemEnvMap[key] ?? '').trim())
      );
      if (configuredKeys.length === 0) {
        dependencies.core.warning(
          'system-env-map-json is empty while environment-sync-enabled is true. ' +
            'Workspace↔git linking still registers the service in API Catalog, but Catalog ' +
            'system-environment filters (Prod/Stage/Dev) hide services until Postman environments ' +
            'are associated. Pass system-env-map-json like {"prod":"<system-env-uuid>"} or clear ' +
            'the Catalog system-environment filter to see the service.'
        );
      } else {
        dependencies.core.warning(
          `system-env-map-json keys (${configuredKeys.join(', ')}) did not match any synced ` +
            `environment (${Object.keys(envUids).join(', ')}). No system-environment associations ` +
            'were made; Catalog system-environment filters may hide this service.'
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
      const mockName = `${assetProjectName} Mock`;

      if (inputs.mockUrl) {
        resolvedMockUrl = inputs.mockUrl;
        dependencies.core.info(`Reusing mock from explicit input: ${resolvedMockUrl}`);
      }

      if (!resolvedMockUrl && inputs.baselineCollectionId) {
        const discovered = await dependencies.postman.findMockByCollection(
          inputs.baselineCollectionId,
          mockEnvUid,
          mockName
        );
        if (discovered) {
          resolvedMockUrl = discovered.mockUrl;
          dependencies.core.info(`Discovered existing mock for collection ${inputs.baselineCollectionId}: ${resolvedMockUrl}`);
        }
      }

      if (!resolvedMockUrl) {
        const mock = await dependencies.postman.createMock(
          inputs.workspaceId,
          mockName,
          inputs.baselineCollectionId,
          mockEnvUid
        );
        resolvedMockUrl = mock.url;
        dependencies.core.info(`Created new mock: ${resolvedMockUrl}`);
      }

      outputs['mock-url'] = resolvedMockUrl;
    }
  }

  if (inputs.workspaceId && inputs.smokeCollectionId && Object.keys(envUids).length > 0) {
    const monitorEnvUid = envUids.prod || envUids.dev || Object.values(envUids)[0];
    const effectiveCron = inputs.monitorCron && inputs.monitorCron.trim() ? inputs.monitorCron.trim() : '';

    if (monitorEnvUid && inputs.monitorType !== 'cli') {
      let resolvedMonitorId = '';
      const monitorName = `${assetProjectName} - Smoke Monitor`;

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
        const discovered = await dependencies.postman.findMonitorByCollection(
          inputs.smokeCollectionId,
          monitorEnvUid,
          monitorName
        );
        if (discovered) {
          resolvedMonitorId = discovered.uid;
          dependencies.core.info(`Discovered existing monitor for collection ${inputs.smokeCollectionId}: ${resolvedMonitorId}`);
        }
      }

      if (!resolvedMonitorId) {
        resolvedMonitorId = await dependencies.postman.createMonitor(
          inputs.workspaceId,
          monitorName,
          inputs.smokeCollectionId,
          monitorEnvUid,
          effectiveCron || undefined
        );
        dependencies.core.info(`Created new monitor: ${resolvedMonitorId}${effectiveCron ? '' : ' (disabled — no cron configured; will trigger a one-time run)'}`);
      }

      outputs['monitor-id'] = resolvedMonitorId;

      if (!effectiveCron && resolvedMonitorId) {
        try {
          await dependencies.postman.runMonitor(resolvedMonitorId);
          dependencies.core.info(`Triggered one-time run for monitor: ${resolvedMonitorId}`);
        } catch (error) {
          dependencies.core.warning(
            `Failed to trigger one-time run for monitor ${resolvedMonitorId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
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
      dependencies.core.info(
        `workspace-link-status=success workspace-id=${inputs.workspaceId} repo=${inputs.repoUrl}`
      );
    } catch (error) {
      outputs['workspace-link-status'] = 'failed';
      const message = `Workspace link failed: ${error instanceof Error ? error.message : String(error)}`;
      // A canonical non-legacy run is the finalize boundary: reporting success
      // here would allow a later version tag to claim fully linked onboarding.
      if (branchDecision.tier === 'canonical') {
        throw new Error(message, { cause: error });
      }
      dependencies.core.warning(message);
    }
  }

  await exportArtifacts(inputs, dependencies, envUids, assetProjectName, {
    workspaceLinkStatus: outputs['workspace-link-status'],
    priorWorkspaceId: resourcesState?.workspace?.id,
    existingSpecs: resourcesState?.cloudResources?.specs,
    releaseLabel,
    priorState: resourcesState
  });

  const commit = await commitAndPushGeneratedFiles(inputs, dependencies);
  outputs['commit-sha'] = commit.commitSha;
  if (commit.resolvedCurrentRef) {
    outputs['resolved-current-ref'] = commit.resolvedCurrentRef;
  }
  outputs['repo-sync-summary-json'] = createRepoSummary(outputs, envUids, commit.pushed);

  // Publish the native Spec Hub tag only after all repo-sync responsibilities
  // succeeded. A version tag therefore means full onboarding, not just upload.
  if (
    branchDecision.tier === 'canonical' &&
    inputs.specId &&
    inputs.specContentChanged !== false &&
    dependencies.postman.tagSpecVersion
  ) {
    const shortSha = (branchDecision.identity.headSha ?? '').slice(0, 7);
    const tagName = inputs.releaseLabel
      ? `${inputs.releaseLabel}${shortSha ? ` (${shortSha})` : ''}`
      : shortSha || `sync-${new Date().toISOString().slice(0, 10)}`;
    try {
      const tag = await dependencies.postman.tagSpecVersion(inputs.specId, tagName);
      outputs['spec-version-tag'] = tag.name || tagName;
      if (tag.id) {
        outputs['spec-version-url'] = `https://web.postman.co/workspace/${encodeURIComponent(inputs.workspaceId)}/specification/${encodeURIComponent(inputs.specId)}?tagId=${encodeURIComponent(tag.id)}&versionLabel=${encodeURIComponent(tag.name || tagName)}`;
      }
      dependencies.core.info(`Tagged spec version at finalize: ${tag.name || tagName}`);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) {
        const tags = await dependencies.postman.listSpecVersionTags?.(inputs.specId).catch(() => []) ?? [];
        const latest = tags[0];
        if (latest && (latest.name === tagName || /\([0-9a-f]{7}\)$/.test(latest.name) || /^[0-9a-f]{7}$/.test(latest.name))) {
          outputs['spec-version-tag'] = latest.name;
          outputs['spec-version-url'] = `https://web.postman.co/workspace/${encodeURIComponent(inputs.workspaceId)}/specification/${encodeURIComponent(inputs.specId)}?tagId=${encodeURIComponent(latest.id)}&versionLabel=${encodeURIComponent(latest.name)}`;
          dependencies.core.info(`Latest changelog group already tagged as "${latest.name}"; adopting.`);
        } else {
          dependencies.core.warning('Latest changelog group already carries a hand-applied tag; leaving it in place.');
        }
      } else {
        dependencies.core.warning(`Spec version tagging failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Branch-aware sync: surface the run's BranchDecision (inherited from
  // bootstrap via POSTMAN_BRANCH_DECISION or resolved locally) on executed runs.
  if (inputs.branchStrategy !== 'legacy' || process.env[BRANCH_DECISION_ENV]) {
    const decision = decideBranchTier(inputs);
    outputs['sync-status'] = 'synced';
    outputs['branch-decision'] = serializeBranchDecision(decision);
  }

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

  // The PMAK is only the access-token re-mint source (and, when none is
  // supplied, the createApiKey path below mints one for the generated CI's
  // `postman login --with-api-key`). Proactively validating it via `GET /me`
  // is NOT an identity fallback — team scope comes from the iapub session
  // identity below — it is a credential-validity check that preserves the
  // known-intended createApiKey reuse-vs-mint decision (don't mint a fresh
  // PMAK and overwrite the GitHub secret when the supplied one is usable) and
  // surfaces an invalid PMAK early. The session identity cannot validate the
  // PMAK, so this getMe is not redundant with it.
  if (apiKey) {
    const tempClient = new PostmanAssetsClient({
      apiKey,
      baseUrl: inputs.postmanApiBase,
      secretMasker: masker
    });
    try {
      const me = await tempClient.getMe();
      if (me && me.user) {
        keyValid = true;
      }
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        (error.status === 401 || error.status === 403)
      ) {
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
      bifrostBaseUrl: inputs.postmanBifrostBase,
      orgMode: inputs.orgMode,
      teamId,
      secretMasker: masker
    });

    const keyName = `repo-sync-action-${Date.now()}`;
    apiKey = await internalIntegration.createApiKey(keyName);
    actionCore.setSecret(apiKey);

    if (inputs.provider === 'azure-devops') {
      if (options.persistGeneratedApiKeySecret ?? true) {
        actionCore.warning(
          'A new Postman API key was generated but automatic secret persistence is not supported for Azure DevOps. Set the POSTMAN_API_KEY pipeline secret variable manually.'
        );
      } else {
        actionCore.info('Skipping generated POSTMAN_API_KEY secret persistence for this run.');
      }
    } else if ((options.persistGeneratedApiKeySecret ?? true) && (inputs.githubToken || inputs.ghFallbackToken)) {
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
        } catch (error: unknown) {
          actionCore.warning(
            `Error saving POSTMAN_API_KEY secret: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } else if (options.persistGeneratedApiKeySecret ?? true) {
      actionCore.warning('No GitHub token provided; cannot save generated POSTMAN_API_KEY secret.');
    } else {
      actionCore.info('Skipping generated POSTMAN_API_KEY GitHub secret persistence for this run.');
    }
  }


  // Resolve team scope from the access-token session identity (iapub
  // /api/sessions/current — live-proven 200 for service-account tokens in both
  // non-org and org-mode teams, 2026-06-30). This replaces the legacy PMAK
  // `GET /me` / `getAutoDerivedTeamId` teamId derivation — no PMAK identity
  // call is needed for team scope. `resolveSessionIdentity` is memoized, so
  // when the credential preflight already ran (runAction / runCli) this is
  // free; when `resolvePostmanApiKeyAndTeamId` is called directly it resolves
  // on demand, and updates the memoized session identity as a side effect
  // (feeding reactive error advice).
  if (!teamId && inputs.postmanAccessToken) {
    const session =
      getMemoizedSessionIdentity() ??
      (await resolveSessionIdentity({
        iapubBaseUrl: inputs.postmanIapubBase,
        accessToken: inputs.postmanAccessToken
      }));
    if (session?.teamId) {
      teamId = String(session.teamId);
    }
  }

  // Auto-detect org-mode when not explicitly set, via the access-token gateway:
  // `ums GET /api/teams/<orgTeamId>/squads?settings=true&userRoles=true`
  // (live-proven 200 for org-mode SA 2026-06-30; `<orgTeamId>` is the session
  // team). A 200 with a non-empty squad list means the parent account is
  // org-mode; a 400 "Squad feature is not available for your team." is the
  // expected non-org signal (mirrors the legacy PMAK non-org 400). This
  // replaces the PMAK `GET /teams` enumeration — no PMAK identity call remains
  // here. The probe needs an access token (gateway envelope) and a team id
  // (path parameter from the session identity above).
  if (!inputs.orgMode && inputs.postmanAccessToken && teamId) {
    try {
      const tokenProvider = new AccessTokenProvider({
        accessToken: inputs.postmanAccessToken,
        apiKey,
        apiBaseUrl: inputs.postmanApiBase
      });
      // orgMode:false so x-entity-team-id is omitted on the probe — Bifrost
      // infers team context from the access token; the team id rides in the
      // path. configureTeamContext is intentionally not called.
      const gateway = new AccessTokenGatewayClient({
        tokenProvider,
        bifrostBaseUrl: inputs.postmanBifrostBase,
        secretMasker: masker
      });
      const squads = await gateway.getSquads(teamId);
      if (squads.length > 0) {
        inputs.orgMode = true;
        actionCore.info(
          `Org-mode auto-detected via ums squads (${squads.length} squad${squads.length === 1 ? '' : 's'} for team ${teamId}). x-entity-team-id will be included in Bifrost calls.`
        );
      }
    } catch (error: unknown) {
      // 400 "Squad feature is not available for your team." is the expected
      // non-org signal — leave orgMode false silently. Any other failure is
      // non-fatal: orgMode stays false (header omitted) which is safe, but
      // surface it so an org-mode team that failed to probe can be fixed by
      // setting org-mode explicitly.
      const isNonOrgSquads =
        error instanceof HttpError &&
        error.status === 400 &&
        /squad feature is not available/i.test(error.responseBody);
      if (!isNonOrgSquads) {
        actionCore.warning(
          `Org-mode auto-detection via ums squads failed (non-fatal; set org-mode explicitly if Bifrost calls fail): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } else if (!inputs.orgMode && inputs.postmanAccessToken) {
    actionCore.info(
      'Org-mode not set explicitly and ums squads auto-detection skipped (no team id resolved from the session identity); relying on Bifrost to infer team context from the access token. Set org-mode and team-id explicitly for org-mode teams.'
    );
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
  // Mutable masker so a mid-run re-minted access token is redacted by the same
  // instance already threaded into every client (AccessTokenProvider.onToken
  // calls mutableMasker.add).
  const mutableMasker = createMutableSecretMasker([
    resolved.apiKey,
    inputs.postmanAccessToken,
    inputs.adoToken,
    inputs.githubToken,
    inputs.ghFallbackToken,
    inputs.sslClientCert,
    inputs.sslClientKey,
    inputs.sslClientPassphrase,
    inputs.sslExtraCaCerts
  ]);
  const masker = mutableMasker.mask;

  // Access-token-ONLY asset routing. The onboarding pipeline mints the access
  // token in `postman-resolve-service-token-action`; PMAK exists only at that
  // mint boundary and for `AccessTokenProvider` re-mint — never as an asset
  // fallback. Every asset op here (env create/get/update, collection read,
  // mock, monitor) goes through the gateway `x-access-token` client. A missing
  // token is a hard error (run resolve-service-token), and a gateway failure
  // surfaces instead of silently routing through PMAK — a PMAK detour would
  // hide gateway bugs (the exact mask that let the mock 403 fester).
  if (!inputs.postmanAccessToken) {
    throw new Error(
      'postman-access-token is required and could not be minted from postman-api-key (see the warning above for the diagnosis). ' +
        'Provide a valid service-account postman-api-key so the action can mint one, or run postman-resolve-service-token-action and pass postman-access-token; PMAK is not used for asset operations.'
    );
  }
  const tokenProvider = new AccessTokenProvider({
    accessToken: inputs.postmanAccessToken,
    apiKey: resolved.apiKey,
    apiBaseUrl: inputs.postmanApiBase,
    onToken: (token) => {
      factories.core.setSecret(token);
      mutableMasker.add(token);
    }
  });
  const gateway = new AccessTokenGatewayClient({
    tokenProvider,
    bifrostBaseUrl: inputs.postmanBifrostBase,
    teamId: resolved.teamId,
    orgMode: inputs.orgMode,
    secretMasker: masker
  });
  const gatewayAssets = new PostmanGatewayAssetsClient({
    gateway,
    workspaceId: inputs.workspaceId
  });
  const postman: RepoSyncDependencies['postman'] = {
    // Environments via the `sync` service (live-probed): import (create), GET
    // /environment/:id/sync (read), PUT /environment/:id (update). No PMAK.
    createEnvironment: gatewayAssets.createEnvironment.bind(gatewayAssets),
    getEnvironment: gatewayAssets.getEnvironment.bind(gatewayAssets),
    updateEnvironment: gatewayAssets.updateEnvironment.bind(gatewayAssets),
    findEnvironmentByName: gatewayAssets.findEnvironmentByName.bind(gatewayAssets),
    // Collection read via the v3 export endpoint — returns canonical v3 IR,
    // written to disk by `convertAndSplitAnyCollection`. PMAK is never used for
    // collection reads.
    getCollection: gatewayAssets.getCollection.bind(gatewayAssets),
    // Mocks via the `mock` service, collection-based monitors via the `monitors`
    // service (jobTemplates). Both reference the collection by its full public
    // uid (the gateway services key access off it, exactly like the public REST
    // API); the bare model id 403s "request access from the collection editor".
    createMock: gatewayAssets.createMock.bind(gatewayAssets),
    listMocks: gatewayAssets.listMocks.bind(gatewayAssets),
    mockExists: gatewayAssets.mockExists.bind(gatewayAssets),
    findMockByCollection: gatewayAssets.findMockByCollection.bind(gatewayAssets),
    createMonitor: gatewayAssets.createMonitor.bind(gatewayAssets),
    listMonitors: gatewayAssets.listMonitors.bind(gatewayAssets),
    monitorExists: gatewayAssets.monitorExists.bind(gatewayAssets),
    findMonitorByCollection: gatewayAssets.findMonitorByCollection.bind(gatewayAssets),
    runMonitor: gatewayAssets.runMonitor.bind(gatewayAssets),
    listEnvironments: gatewayAssets.listEnvironments.bind(gatewayAssets),
    // GC path (preview/channel retention machine — lib/repo/preview-gc.ts).
    deleteEnvironment: gatewayAssets.deleteEnvironment.bind(gatewayAssets),
    deleteMock: gatewayAssets.deleteMock.bind(gatewayAssets),
    deleteMonitor: gatewayAssets.deleteMonitor.bind(gatewayAssets),
    deleteCollection: gatewayAssets.deleteCollection.bind(gatewayAssets),
    listSpecifications: gatewayAssets.listSpecifications.bind(gatewayAssets),
    getSpecContent: gatewayAssets.getSpecContent.bind(gatewayAssets),
    listSpecCollections: gatewayAssets.listSpecCollections.bind(gatewayAssets),
    deleteSpec: gatewayAssets.deleteSpec.bind(gatewayAssets),
    tagSpecVersion: gatewayAssets.tagSpecVersion.bind(gatewayAssets),
    listSpecVersionTags: gatewayAssets.listSpecVersionTags.bind(gatewayAssets)
  };

  const repoMutation =
    repository &&
    (inputs.repoWriteMode === 'commit-only' || inputs.repoWriteMode === 'commit-and-push')
      ? new RepoMutationService({
          provider: inputs.provider,
          repository,
          repoUrl: inputs.repoUrl || undefined,
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

  const internalIntegration = createInternalIntegrationAdapter({
    accessToken: inputs.postmanAccessToken,
    // Live accessor so a gateway-triggered re-mint propagates to the
    // governance / workspace-link / identity Bifrost calls too.
    getAccessToken: () => tokenProvider.current(),
    backend: inputs.integrationBackend,
    bifrostBaseUrl: inputs.postmanBifrostBase,
    orgMode: inputs.orgMode,
    teamId: resolved.teamId,
    secretMasker: masker
  });

  return {
    teamId: resolved.teamId,
    core: factories.core,
    postman,
    internalIntegration,
    repoMutation
  };
}

/**
 * Resolve the run's immutable BranchDecision BEFORE any credential is
 * validated or minted (decide step of decide -> execute -> finalize). An
 * inherited POSTMAN_BRANCH_DECISION env decision (exported by bootstrap) wins
 * so one decision spans bootstrap, repo-sync, smoke-flow, and insights within
 * a single run.
 */
export function decideBranchTier(
  inputs: Pick<ResolvedInputs, 'branchStrategy' | 'canonicalBranch' | 'channels'>,
  env: NodeJS.ProcessEnv = process.env
): BranchDecision {
  return resolveEffectiveBranchDecision(
    {
      strategy: inputs.branchStrategy,
      identity: resolveBranchIdentity(env, { defaultBranch: inputs.canonicalBranch }),
      canonicalBranch: inputs.canonicalBranch,
      channels: parseChannelRules(inputs.channels)
    },
    env
  );
}

/**
 * Gated tier (publish-gate / fork-PR / tag): repo-sync writes canonical
 * artifacts (collections export, envs, mocks, monitors, workspace link, git
 * push), so a gated run skips the entire sync. No token is minted and no
 * Postman API is called: zero writes by construction.
 */
export function runGatedSkip(
  inputs: ResolvedInputs,
  decision: BranchDecision,
  actionCore: Pick<CoreLike, 'info' | 'setOutput'>
): RepoSyncOutputs {
  actionCore.info(
    `branch-aware sync: gated run (${decision.reason}) — repo-sync skipped, zero workspace writes`
  );
  const outputs = createOutputs(inputs);
  outputs['sync-status'] = 'skipped-branch-gate';
  outputs['branch-decision'] = serializeBranchDecision(decision);
  outputs['repo-sync-summary-json'] = JSON.stringify({
    status: 'skipped-branch-gate',
    reason: decision.reason
  });
  for (const [name, value] of Object.entries(outputs)) {
    actionCore.setOutput(name, value);
  }
  return outputs;
}

export async function runAction(
  actionCore: CoreLike = core,
  actionExec: ExecLike = exec
): Promise<RepoSyncOutputs> {
  const inputs = readActionInputs(actionCore);

  // Decide step (branch-aware sync): resolve the immutable BranchDecision from
  // provider CI env BEFORE any credential validation or token mint.
  const branchDecision = decideBranchTier(inputs);
  if (branchDecision.tier === 'gated') {
    return runGatedSkip(inputs, branchDecision, actionCore);
  }
  if (branchDecision.tier !== 'legacy') {
    actionCore.info(`branch-aware sync: tier=${branchDecision.tier} (${branchDecision.reason})`);
    process.env[BRANCH_DECISION_ENV] = serializeBranchDecision(branchDecision);
  }

  // PMAK-only runs: eagerly mint the short-lived access token from the service
  // -account PMAK so the whole access-token surface (credential preflight,
  // gateway asset ops, Bifrost linking, env sync) works exactly as when
  // postman-access-token is supplied. Mirrors bootstrap's runAction. A failed
  // mint warns with a live-probed diagnosis (personal key vs permission gap vs
  // invalid key) and falls through to the existing missing-token guard.
  await mintAccessTokenIfNeeded(inputs, {
    info: (message) => actionCore.info(message),
    warning: (message) => actionCore.warning(message)
  }, (secret) => actionCore.setSecret(secret));

  const masker = createSecretMasker([
    inputs.postmanApiKey,
    inputs.postmanAccessToken,
    inputs.adoToken,
    inputs.githubToken,
    inputs.ghFallbackToken,
    inputs.sslClientCert,
    inputs.sslClientKey,
    inputs.sslClientPassphrase,
    inputs.sslExtraCaCerts
  ]);

  // Proactive credential preflight: resolve and cross-check both identities
  // once, before any environment, mock, monitor, or link call. It does not
  // depend on the lazy org-mode auto-detect inside resolvePostmanApiKeyAndTeamId.
  await runCredentialPreflight({
    apiBaseUrl: inputs.postmanApiBase,
    iapubBaseUrl: inputs.postmanIapubBase,
    postmanApiKey: inputs.postmanApiKey,
    postmanAccessToken: inputs.postmanAccessToken,
    explicitTeamId: inputs.teamId || undefined,
    mode: inputs.credentialPreflight,
    mask: masker,
    log: actionCore
  });

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

  await persistSslSecrets(inputs, actionCore, actionExec, repository);

  return runRepoSync(inputs, dependencies);
}
