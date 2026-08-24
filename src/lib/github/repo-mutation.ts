import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

import { createSecretMasker, type SecretMasker } from '../secrets.js';
import type { GitProvider } from '../repo/context.js';

export type RepoWriteMode = 'none' | 'commit-only' | 'commit-and-push';

export interface RepoMutationContext {
  currentRef?: string;
  githubHeadRef?: string;
  githubRefName?: string;
  repoWriteMode: RepoWriteMode | string;
}

export interface BuildPushTokenOrderOptions {
  adoToken?: string;
  fallbackToken?: string;
  githubToken?: string;
}

export interface ExecuteResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type ExecuteFn = (
  command: string,
  args: string[]
) => Promise<ExecuteResult>;

export interface CommitAndPushOptions extends RepoMutationContext {
  adoToken?: string;
  committerEmail: string;
  committerName: string;
  fallbackToken?: string;
  /** Exact generated files that may bypass repository ignore rules. */
  forceStagePaths?: string[];
  githubToken?: string;
  removePaths?: string[];
  stagePaths: string[];
}

export interface PreflightPushOptions extends RepoMutationContext {
  adoToken?: string;
  authorityPaths?: string[];
  fallbackToken?: string;
  githubToken?: string;
}

export interface RepoMutationServiceOptions {
  cwd?: string;
  execute: ExecuteFn;
  provider?: GitProvider;
  repository: string;
  repoUrl?: string;
  secretMasker?: SecretMasker;
}

/** Publication failed before a generated commit existed; callers may restore working files. */
export class RepoMutationPreCommitError extends Error {
  readonly code = 'REPO_MUTATION_PRE_COMMIT_FAILED';

  constructor(
    message: string,
    readonly indexRestored = true
  ) {
    super(message);
    this.name = 'RepoMutationPreCommitError';
  }
}

function normalizeBranchRef(value: string | undefined): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  const branch = trimmed.startsWith('refs/heads/')
    ? trimmed.slice('refs/heads/'.length)
    : trimmed;
  if (branch.startsWith('refs/')) {
    return '';
  }
  return branch;
}

export function buildPushTokenOrder(
  options: BuildPushTokenOrderOptions
): string[] {
  const ordered = [options.adoToken, options.fallbackToken, options.githubToken]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  return ordered.filter((token, index) => ordered.indexOf(token) === index);
}

function parseHttpsRemote(rawUrl: string): URL {
  const trimmed = String(rawUrl || '').trim();
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  let normalized = sshMatch ? normalizeSshRemote(sshMatch[1], sshMatch[2]) : trimmed;
  const url = new URL(normalized);
  if (url.hostname === 'ssh.dev.azure.com') {
    normalized = normalizeAzureReposSshPath(url.pathname.replace(/^\/+/, ''));
  }
  const parsed = new URL(normalized);
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed;
}

function normalizeSshRemote(host: string, remotePath: string): string {
  if (host === 'ssh.dev.azure.com') {
    return normalizeAzureReposSshPath(remotePath);
  }
  return `https://${host}/${remotePath}`;
}

function normalizeAzureReposSshPath(remotePath: string): string {
  const segments = remotePath.split('/').filter(Boolean);
  if (segments.length < 4 || segments[0] !== 'v3') {
    return `https://ssh.dev.azure.com/${remotePath}`;
  }
  const [organization, project, ...repoParts] = segments.slice(1);
  return `https://dev.azure.com/${organization}/${project}/_git/${repoParts.join('/')}`;
}

function normalizeRemotePathname(pathname: string): string {
  return pathname.replace(/\/+$/g, '');
}

function withoutGitSuffix(pathname: string): string {
  const normalized = normalizeRemotePathname(pathname);
  return normalized.endsWith('.git') ? normalized.slice(0, -4) : normalized;
}

function withGitSuffix(pathname: string): string {
  const normalized = normalizeRemotePathname(pathname);
  return normalized.endsWith('.git') ? normalized : `${normalized}.git`;
}

function formatUrl(url: URL, pathname = url.pathname): string {
  return `${url.protocol}//${url.host}${pathname}${url.search}`;
}

export function buildAuthenticatedRemoteUrl(
  provider: GitProvider,
  repository: string,
  token: string,
  repoUrl?: string
): string {
  const encodedToken = encodeURIComponent(token);
  if (provider === 'github') {
    const url = parseHttpsRemote(repoUrl || `https://github.com/${repository}`);
    return `${url.protocol}//x-access-token:${encodedToken}@${url.host}${withGitSuffix(withoutGitSuffix(url.pathname))}${url.search}`;
  }
  if (provider === 'gitlab') {
    const url = parseHttpsRemote(repoUrl || `https://gitlab.com/${repository}`);
    return `${url.protocol}//oauth2:${encodedToken}@${url.host}${withGitSuffix(withoutGitSuffix(url.pathname))}${url.search}`;
  }
  if (provider === 'azure-devops') {
    const url = parseHttpsRemote(repoUrl || `https://dev.azure.com/${repository}`);
    return `${url.protocol}//anything:${encodedToken}@${url.host}${url.pathname}${url.search}`;
  }
  throw new Error(`repo-write-mode=commit-and-push is not supported for git provider "${provider}"`);
}

function supportsTokenRemote(provider: GitProvider): boolean {
  return provider === 'github' || provider === 'gitlab' || provider === 'azure-devops';
}

function buildScopedExtraHeaderResetConfigs(
  provider: GitProvider,
  remoteUrl: string
): string[] {
  const fallbackRoot = provider === 'gitlab' ? 'https://gitlab.com/' : 'https://github.com/';
  const url = parseHttpsRemote(remoteUrl || fallbackRoot);
  const keys: string[] = [];

  if (provider === 'azure-devops') {
    if (url.hostname === 'dev.azure.com') {
      const [organization] = url.pathname.split('/').filter(Boolean);
      if (organization) {
        keys.push(`http.${url.protocol}//${url.host}/${organization}/.extraheader=`);
      }
    } else if (url.hostname.endsWith('.visualstudio.com')) {
      keys.push(`http.${url.protocol}//${url.host}/.extraheader=`);
    }
    keys.push(`http.${formatUrl(url)}.extraheader=`);
  } else {
    keys.push(`http.${url.protocol}//${url.host}/.extraheader=`);
  }

  return keys.filter((key, index) => keys.indexOf(key) === index);
}

export function resolveCurrentRef(context: RepoMutationContext): string {
  if (context.repoWriteMode !== 'commit-and-push') {
    return '';
  }

  const currentRef = String(context.currentRef || '').trim();
  if (currentRef.startsWith('refs/heads/')) {
    return normalizeBranchRef(currentRef);
  }
  if (currentRef.startsWith('refs/pull/')) {
    return normalizeBranchRef(context.githubHeadRef);
  }
  if (currentRef.startsWith('refs/')) {
    return '';
  }

  const githubRefName = normalizeBranchRef(context.githubRefName);
  const isPullMergeShorthand = /^\d+\/merge$/.test(githubRefName);

  return (
    normalizeBranchRef(currentRef) ||
    normalizeBranchRef(context.githubHeadRef) ||
    (isPullMergeShorthand ? '' : githubRefName)
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

function normalizeStagePaths(stagePaths: string[]): string[] {
  const normalized: string[] = [];

  for (const entry of stagePaths) {
    const rawPath = String(entry || '');
    const stagePath = rawPath.trim();
    if (!stagePath) {
      continue;
    }

    const segments = stagePath.split(/[\\/]+/).filter(Boolean);
    if (
      hasControlCharacter(rawPath) ||
      path.isAbsolute(stagePath) ||
      path.win32.isAbsolute(stagePath) ||
      segments.includes('..') ||
      stagePath.startsWith(':') ||
      hasControlCharacter(stagePath)
    ) {
      throw new Error(`Unsafe git stage path: ${stagePath}`);
    }

    if (!normalized.includes(stagePath)) {
      normalized.push(stagePath);
    }
  }

  return normalized;
}

function isContainedPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function throwUnsafeMutationPath(): never {
  throw new Error('Unsafe repository mutation path: resolved path escapes the working directory');
}

function assertMutationPathsAreContained(cwd: string, paths: string[]): void {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    throwUnsafeMutationPath();
  }

  const normalizedCwd = path.resolve(cwd);
  for (const mutationPath of paths) {
    let candidate = path.resolve(normalizedCwd, mutationPath);

    while (true) {
      try {
        const resolvedCandidate = realpathSync(candidate);
        if (!isContainedPath(realCwd, resolvedCandidate)) {
          throwUnsafeMutationPath();
        }
      } catch {
        try {
          lstatSync(candidate);
        } catch {
          if (candidate === normalizedCwd) {
            throwUnsafeMutationPath();
          }
          candidate = path.dirname(candidate);
          continue;
        }
        throwUnsafeMutationPath();
      }

      if (candidate === normalizedCwd) {
        break;
      }
      candidate = path.dirname(candidate);
    }
  }
}

export class RepoMutationService {
  private readonly cwd: string;
  private readonly execute: ExecuteFn;
  private readonly provider: GitProvider;
  private readonly repository: string;
  private readonly repoUrl: string | undefined;
  private readonly secretMasker: SecretMasker;

  constructor(options: RepoMutationServiceOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.execute = options.execute;
    this.provider = options.provider ?? 'github';
    this.repository = options.repository;
    this.repoUrl = options.repoUrl;
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([]);
  }

  private async restoreOriginOrThrow(
    originalRemote: string,
    secretMasker: SecretMasker
  ): Promise<void> {
    let restoreFailure = '';
    try {
      const restored = await this.execute('git', [
        'remote',
        'set-url',
        'origin',
        originalRemote
      ]);
      if (restored.exitCode !== 0) {
        restoreFailure = restored.stderr || restored.stdout || 'git remote set-url failed';
      }
    } catch (error) {
      restoreFailure = error instanceof Error ? error.message : String(error);
    }
    if (restoreFailure) {
      throw new Error(secretMasker(
        `REPO_PUSH_ORIGIN_RESTORE_FAILED: Could not restore origin remote: ${restoreFailure}`
      ));
    }
  }

  /** Authenticate, read the state ref, and prove a dry-run push before cloud mutation. */
  async preflightPush(options: PreflightPushOptions): Promise<{ resolvedCurrentRef: string }> {
    const resolvedCurrentRef = resolveCurrentRef(options);
    const authorityPaths = normalizeStagePaths(options.authorityPaths ?? []);
    assertMutationPathsAreContained(this.cwd, authorityPaths);
    const tokens =
      this.provider === 'azure-devops'
        ? buildPushTokenOrder({ adoToken: options.adoToken })
        : buildPushTokenOrder({
            fallbackToken: options.fallbackToken,
            githubToken: options.githubToken
          });
    const usePersistedCredentials = tokens.length === 0 && this.provider === 'azure-devops';
    if (!supportsTokenRemote(this.provider)) {
      throw new Error(
        `repo-write-mode=commit-and-push is not supported for git provider "${this.provider}"`
      );
    }
    if (!resolvedCurrentRef) {
      throw new Error('No current ref could be resolved for repo-write-mode=commit-and-push');
    }
    if (tokens.length === 0 && !usePersistedCredentials) {
      throw new Error('No push token configured for repo-write-mode=commit-and-push');
    }

    const secretMasker = createSecretMasker(tokens);
    const preexistingStaged = await this.execute('git', ['diff', '--cached', '--quiet']);
    if (preexistingStaged.exitCode === 1) {
      throw new Error(
        'Pre-existing staged changes are present; refusing repository publication'
      );
    }
    if (preexistingStaged.exitCode !== 0) {
      const cause = preexistingStaged.stderr || preexistingStaged.stdout || 'git diff failed';
      throw new Error(secretMasker(`Failed to inspect pre-existing staged changes: ${cause}`));
    }

    const preexistingUnstaged = await this.execute('git', ['diff', '--quiet']);
    if (preexistingUnstaged.exitCode === 1) {
      throw new Error(
        'Pre-existing unstaged tracked changes are present; refusing repository publication'
      );
    }
    if (preexistingUnstaged.exitCode !== 0) {
      const cause = preexistingUnstaged.stderr || preexistingUnstaged.stdout || 'git diff failed';
      throw new Error(secretMasker(`Failed to inspect pre-existing unstaged changes: ${cause}`));
    }

    if (authorityPaths.length > 0) {
      for (const ignored of [false, true]) {
        const authorityStatus = await this.execute('git', [
          'ls-files',
          '--others',
          ...(ignored ? ['--ignored'] : []),
          '--exclude-standard',
          '--',
          ...authorityPaths
        ]);
        if (authorityStatus.exitCode !== 0) {
          throw new Error(this.secretMasker(
            authorityStatus.stderr || authorityStatus.stdout ||
            'Failed to inspect durable authority paths'
          ));
        }
        if (authorityStatus.stdout.trim()) {
          throw new Error(
            'DURABLE_STATE_DIRTY: Durable authority paths must match the checked-out commit before cloud mutation'
          );
        }
      }
    }

    const remote = await this.execute('git', ['remote', 'get-url', 'origin']);
    if (remote.exitCode !== 0 || !remote.stdout.trim()) {
      throw new Error(secretMasker(
        remote.stderr || remote.stdout || 'REPO_PUSH_PREFLIGHT_FAILED: origin remote is unavailable'
      ));
    }
    const originalRemote = remote.stdout.trim();
    let remoteChanged = false;
    let lastError = '';
    let preflightSucceeded = false;
    let preflightFailed = false;
    let preflightError: unknown;

    try {
      const candidates: Array<string | null> = usePersistedCredentials ? [null] : tokens;
      for (const token of candidates) {
        const resetConfigArgs = token === null
          ? []
          : buildScopedExtraHeaderResetConfigs(
              this.provider,
              originalRemote || this.repoUrl || ''
            ).flatMap((config) => ['-c', config]);

        if (token !== null) {
          const setRemote = await this.execute('git', [
            'remote',
            'set-url',
            'origin',
            buildAuthenticatedRemoteUrl(
              this.provider,
              this.repository,
              token,
              this.repoUrl || originalRemote
            )
          ]);
          if (setRemote.exitCode !== 0) {
            lastError = setRemote.stderr || setRemote.stdout || 'could not configure authenticated origin';
            continue;
          }
          remoteChanged = true;
        }

        const fetch = await this.execute('git', [
          ...resetConfigArgs,
          'fetch',
          '--no-tags',
          'origin',
          `refs/heads/${resolvedCurrentRef}`
        ]);
        const fetchError = fetch.stderr || fetch.stdout || '';
        const targetBranchDoesNotExist = /couldn't find remote ref|remote ref .* not found/iu.test(
          fetchError
        );
        if (fetch.exitCode !== 0 && !targetBranchDoesNotExist) {
          lastError = fetchError;
          continue;
        }

        const dryRun = await this.execute('git', [
          ...resetConfigArgs,
          'push',
          '--dry-run',
          'origin',
          `HEAD:refs/heads/${resolvedCurrentRef}`
        ]);
        if (dryRun.exitCode === 0) {
          preflightSucceeded = true;
          break;
        }
        lastError = dryRun.stderr || dryRun.stdout || '';
      }
    } catch (error) {
      preflightFailed = true;
      preflightError = error;
    }

    if (remoteChanged) {
      await this.restoreOriginOrThrow(originalRemote, secretMasker);
    }

    if (preflightFailed) throw preflightError;
    if (preflightSucceeded) return { resolvedCurrentRef };

    throw new Error(secretMasker(
      `REPO_PUSH_PREFLIGHT_FAILED: Could not read and dry-run publish ${resolvedCurrentRef}: ${lastError || 'repository publication access was denied'}`
    ));
  }

  async commitAndPush(options: CommitAndPushOptions): Promise<{
    commitSha: string;
    pushed: boolean;
    resolvedCurrentRef: string;
  }> {
    const resolvedCurrentRef = resolveCurrentRef(options);
    const removePaths = normalizeStagePaths(options.removePaths ?? []);
    const forceStagePaths = normalizeStagePaths(options.forceStagePaths ?? []);
    const stagePaths = normalizeStagePaths([
      ...options.stagePaths,
      ...forceStagePaths,
      ...removePaths
    ]);
    assertMutationPathsAreContained(this.cwd, stagePaths);
    assertMutationPathsAreContained(this.cwd, forceStagePaths);
    assertMutationPathsAreContained(this.cwd, removePaths);
    const forceStagePathSet = new Set(forceStagePaths);
    const regularStagePaths = stagePaths.filter((stagePath) => !forceStagePathSet.has(stagePath));
    const tokens =
      this.provider === 'azure-devops'
        ? buildPushTokenOrder({ adoToken: options.adoToken })
        : buildPushTokenOrder({
            fallbackToken: options.fallbackToken,
            githubToken: options.githubToken
          });
    const secretMasker = createSecretMasker(tokens);
    let stagingStarted = false;
    const failBeforeCommit = async (
      message: string,
      resetOwnedIndexPaths = false
    ): Promise<never> => {
      let detail = secretMasker(message);
      let indexRestored = true;
      if (resetOwnedIndexPaths) {
        try {
          const reset = await this.execute('git', [
            'reset',
            '--quiet',
            'HEAD',
            '--',
            ...stagePaths
          ]);
          if (reset.exitCode !== 0) {
            indexRestored = false;
            const cause = reset.stderr || reset.stdout || 'git reset failed';
            detail += secretMasker(`; failed to restore the generated-path index: ${cause}`);
          }
        } catch (error) {
          indexRestored = false;
          const cause = error instanceof Error ? error.message : String(error);
          detail += secretMasker(`; failed to restore the generated-path index: ${cause}`);
        }
      }
      throw new RepoMutationPreCommitError(detail, indexRestored);
    };
    const executeBeforeCommit = async (
      command: string,
      args: string[]
    ): Promise<ExecuteResult> => {
      try {
        return await this.execute(command, args);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        return await failBeforeCommit(
          `Repository publication command failed before commit: ${cause}`,
          stagingStarted
        );
      }
    };

    if (stagePaths.length === 0) {
      return {
        commitSha: '',
        pushed: false,
        resolvedCurrentRef
      };
    }

    const usePersistedCredentials = tokens.length === 0 && this.provider === 'azure-devops';
    if (options.repoWriteMode === 'commit-and-push') {
      if (!supportsTokenRemote(this.provider)) {
        await failBeforeCommit(
          `repo-write-mode=commit-and-push is not supported for git provider "${this.provider}"`
        );
      }
      if (!resolvedCurrentRef) {
        await failBeforeCommit(
          'No current ref could be resolved for repo-write-mode=commit-and-push'
        );
      }
      if (tokens.length === 0 && !usePersistedCredentials) {
        await failBeforeCommit('No push token configured for repo-write-mode=commit-and-push');
      }
    }

    for (const forceStagePath of forceStagePaths) {
      const absoluteForceStagePath = path.resolve(this.cwd, forceStagePath);
      let isFile = false;
      try {
        isFile = existsSync(absoluteForceStagePath) && lstatSync(absoluteForceStagePath).isFile();
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        await failBeforeCommit(`Failed to inspect force-stage path ${forceStagePath}: ${cause}`);
      }
      if (!isFile) {
        await failBeforeCommit(
          `Force-stage path must identify an exact generated file: ${forceStagePath}`
        );
      }
    }

    const changed = await executeBeforeCommit('git', [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      ...stagePaths
    ]);
    if (changed.exitCode !== 0) {
      await failBeforeCommit(
        this.secretMasker(changed.stderr || changed.stdout || 'Failed to inspect generated changes')
      );
    }
    const hasPlannedRemoval = removePaths.some((removePath) =>
      existsSync(path.resolve(this.cwd, removePath))
    );
    const preexistingStaged = await executeBeforeCommit('git', ['diff', '--cached', '--quiet']);
    if (preexistingStaged.exitCode === 1) {
      await failBeforeCommit(
        'Pre-existing staged changes are present; refusing repository publication'
      );
    }
    if (preexistingStaged.exitCode !== 0) {
      const cause = preexistingStaged.stderr || preexistingStaged.stdout || 'git diff failed';
      await failBeforeCommit(`Failed to inspect pre-existing staged changes: ${cause}`);
    }
    let hasForcedChanges = false;
    if (forceStagePaths.length > 0) {
      const forcedChanged = await executeBeforeCommit('git', [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignored=matching',
        '--',
        ...forceStagePaths
      ]);
      if (forcedChanged.exitCode !== 0) {
        await failBeforeCommit(
          forcedChanged.stderr || forcedChanged.stdout || 'Failed to inspect force-staged changes'
        );
      }
      hasForcedChanges = Boolean(forcedChanged.stdout.trim());
    }
    const hasGeneratedChanges = Boolean(changed.stdout.trim()) || hasForcedChanges || hasPlannedRemoval;
    if (!hasGeneratedChanges) {
      if (options.repoWriteMode !== 'commit-and-push') {
        return {
          commitSha: '',
          pushed: false,
          resolvedCurrentRef
        };
      }
    }

    let commitSha = '';
    if (hasGeneratedChanges || options.repoWriteMode === 'commit-and-push') {
      await executeBeforeCommit('git', ['config', 'user.name', options.committerName]);
      await executeBeforeCommit('git', ['config', 'user.email', options.committerEmail]);
      for (const removePath of removePaths) {
        try {
          rmSync(path.resolve(this.cwd, removePath), { force: true });
        } catch (error) {
          const cause = error instanceof Error ? error.message : String(error);
          await failBeforeCommit(`Failed to remove generated path: ${cause}`);
        }
      }
      if (regularStagePaths.length > 0) {
        stagingStarted = true;
        const added = await executeBeforeCommit('git', ['add', '-A', '--', ...regularStagePaths]);
        if (added.exitCode !== 0) {
          const cause = added.stderr || added.stdout || 'git add failed';
          await failBeforeCommit(`Failed to stage generated changes: ${cause}`, true);
        }
      }
      if (forceStagePaths.length > 0) {
        stagingStarted = true;
        const forceAdded = await executeBeforeCommit('git', [
          'add',
          '-f',
          '-A',
          '--',
          ...forceStagePaths
        ]);
        if (forceAdded.exitCode !== 0) {
          const cause = forceAdded.stderr || forceAdded.stdout || 'git add failed';
          await failBeforeCommit(`Failed to force-stage generated files: ${cause}`, true);
        }
      }

      const staged = await executeBeforeCommit('git', [
        'diff',
        '--cached',
        '--quiet',
        '--',
        ...stagePaths
      ]);
      if (staged.exitCode === 0) {
        if (options.repoWriteMode !== 'commit-and-push') {
          return {
            commitSha: '',
            pushed: false,
            resolvedCurrentRef
          };
        }
      } else if (staged.exitCode !== 1) {
        const cause = staged.stderr || staged.stdout || 'git diff failed';
        await failBeforeCommit(`Failed to inspect staged generated changes: ${cause}`, true);
      } else {
        const committed = await executeBeforeCommit('git', [
          'commit',
          '--only',
          '-m',
          'chore: sync Postman artifacts and metadata',
          '--',
          ...stagePaths
        ]);
        if (committed.exitCode !== 0) {
          const cause = committed.stderr || committed.stdout || 'git commit failed';
          await failBeforeCommit(`Failed to commit generated changes: ${cause}`, true);
        }
        const resolvedCommit = await this.execute('git', ['rev-parse', 'HEAD']);
        if (resolvedCommit.exitCode !== 0 || !resolvedCommit.stdout.trim()) {
          const cause = resolvedCommit.stderr || resolvedCommit.stdout || 'git rev-parse failed';
          throw new Error(secretMasker(`Failed to resolve generated commit: ${cause}`));
        }
        commitSha = resolvedCommit.stdout.trim();
      }
    }

    const currentHead = commitSha
      ? { exitCode: 0, stdout: commitSha, stderr: '' }
      : await this.execute('git', ['rev-parse', 'HEAD']);
    if (currentHead.exitCode !== 0 || !currentHead.stdout.trim()) {
      const cause = currentHead.stderr || currentHead.stdout || 'git rev-parse failed';
      throw new Error(secretMasker(`Failed to resolve publication commit: ${cause}`));
    }
    const desiredHead = currentHead.stdout.trim();

    if (options.repoWriteMode !== 'commit-and-push') {
      return {
        commitSha,
        pushed: false,
        resolvedCurrentRef
      };
    }

    const originalRemote = (await this.execute('git', ['remote', 'get-url', 'origin']))
      .stdout.trim();

    let pushed = false;
    let lastError = '';
    let remoteChanged = false;
    let stopCandidates = false;

    // Credential-level denials (this token cannot write to the repo) must
    // advance the candidate cascade. The permission-denied prose is
    // ambiguous: GitHub emits it with an HTTP 403 for a bad credential, but
    // hooks and branch policy can emit the exact same text. Require transport
    // or authentication evidence before treating it as token-specific.
    const isCredentialDenial = (message: string): boolean =>
      /authentication failed/i.test(message) ||
      /the requested url returned error:\s*40[13]\b|http(?:\/\d(?:\.\d)?)?\s+(?:error\s+)?(?:status\s+)?40[13]\b|curl.*?\b40[13]\b/i.test(
        message
      );

    // Policy-level denials (any token would be rejected: branch policy,
    // pre-receive hooks, repository rules, workflow-scope refusals) stop the
    // whole cascade. Credential evidence retains precedence above.
    const isNonRetryablePushError = (message: string): boolean =>
      !isCredentialDenial(message) &&
      /gh006|protected branch|gh013|repository rule violations|pre-receive|hook declined|workflow|permission/i.test(
        message
      );

    try {
      const pushCandidates = usePersistedCredentials ? [null] : tokens;

      for (const token of pushCandidates) {
        const resetConfigArgs =
          token === null
            ? []
            : buildScopedExtraHeaderResetConfigs(this.provider, originalRemote || this.repoUrl || '')
                .flatMap((config) => ['-c', config]);

        if (token !== null) {
          await this.execute('git', [
            'remote',
            'set-url',
            'origin',
            buildAuthenticatedRemoteUrl(
              this.provider,
              this.repository,
              token,
              this.repoUrl || originalRemote
            )
          ]);
          remoteChanged = true;
        }

        for (let pushAttempt = 0; pushAttempt < 2; pushAttempt += 1) {
          const fetch = await this.execute('git', [
            ...resetConfigArgs,
            'fetch',
            '--no-tags',
            'origin',
            `refs/heads/${resolvedCurrentRef}`
          ]);
          const fetchError = fetch.stderr || fetch.stdout || '';
          const targetBranchDoesNotExist = /couldn't find remote ref|remote ref .* not found/i.test(
            fetchError
          );
          if (fetch.exitCode !== 0 && !targetBranchDoesNotExist) {
            lastError = fetchError;
            stopCandidates = isNonRetryablePushError(lastError);
            break;
          }

          if (fetch.exitCode === 0) {
            const rebase = await this.execute('git', [
              'rebase',
              'FETCH_HEAD'
            ]);
            if (rebase.exitCode !== 0) {
              await this.execute('git', ['rebase', '--abort']);
              const cause = rebase.stderr || rebase.stdout || 'Failed to rebase generated changes';
              throw new Error(
                secretMasker(
                  `REPO_PUSH_RECONCILE_FAILED: Could not rebase generated changes onto ${resolvedCurrentRef}: ${cause}`
                )
              );
            }
            commitSha = (await this.execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
            const generatedPathDrift = await this.execute('git', [
              'diff',
              '--quiet',
              desiredHead,
              'HEAD',
              '--',
              ...stagePaths
            ]);
            if (generatedPathDrift.exitCode !== 0) {
              throw new Error(
                'REPO_PUSH_STATE_DRIFT: Generated state paths changed while reconciling the remote ref; refusing to claim publication'
              );
            }
          }

          const push = await this.execute('git', [
            ...resetConfigArgs,
            'push',
            'origin',
            `HEAD:refs/heads/${resolvedCurrentRef}`
          ]);

          if (push.exitCode === 0) {
            pushed = true;
            break;
          }

          lastError = push.stderr || push.stdout || '';
          stopCandidates = isNonRetryablePushError(lastError);
          const targetAdvanced = /non-fast-forward|fetch first|remote contains work/i.test(lastError);
          if (stopCandidates || !targetAdvanced) {
            break;
          }
        }

        if (pushed || stopCandidates) {
          break;
        }
      }
    } finally {
      if (remoteChanged) {
        await this.restoreOriginOrThrow(originalRemote, secretMasker);
      }
    }

    if (!pushed) {
      throw new Error(secretMasker(lastError || 'Failed to push generated changes'));
    }

    return {
      commitSha,
      pushed,
      resolvedCurrentRef
    };
  }
}
