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
  githubToken?: string;
  removePaths?: string[];
  stagePaths: string[];
}

export interface RepoMutationServiceOptions {
  cwd?: string;
  execute: ExecuteFn;
  provider?: GitProvider;
  repository: string;
  repoUrl?: string;
  secretMasker?: SecretMasker;
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

  async commitAndPush(options: CommitAndPushOptions): Promise<{
    commitSha: string;
    pushed: boolean;
    resolvedCurrentRef: string;
  }> {
    const resolvedCurrentRef = resolveCurrentRef(options);
    const removePaths = normalizeStagePaths(options.removePaths ?? []);
    const stagePaths = normalizeStagePaths([...options.stagePaths, ...removePaths]);
    assertMutationPathsAreContained(this.cwd, stagePaths);
    assertMutationPathsAreContained(this.cwd, removePaths);
    const tokens =
      this.provider === 'azure-devops'
        ? buildPushTokenOrder({ adoToken: options.adoToken })
        : buildPushTokenOrder({
            fallbackToken: options.fallbackToken,
            githubToken: options.githubToken
          });
    const secretMasker = createSecretMasker(tokens);

    if (stagePaths.length === 0) {
      return {
        commitSha: '',
        pushed: false,
        resolvedCurrentRef
      };
    }

    const changed = await this.execute('git', [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      ...stagePaths
    ]);
    if (changed.exitCode !== 0) {
      throw new Error(this.secretMasker(changed.stderr || changed.stdout || 'Failed to inspect generated changes'));
    }
    const hasPlannedRemoval = removePaths.some((removePath) =>
      existsSync(path.resolve(this.cwd, removePath))
    );
    if (!changed.stdout.trim() && !hasPlannedRemoval) {
      return {
        commitSha: '',
        pushed: false,
        resolvedCurrentRef
      };
    }

    const usePersistedCredentials = tokens.length === 0 && this.provider === 'azure-devops';
    if (options.repoWriteMode === 'commit-and-push') {
      if (!supportsTokenRemote(this.provider)) {
        throw new Error(`repo-write-mode=commit-and-push is not supported for git provider "${this.provider}"`);
      }
      if (!resolvedCurrentRef) {
        throw new Error('No current ref could be resolved for repo-write-mode=commit-and-push');
      }
      if (tokens.length === 0 && !usePersistedCredentials) {
        throw new Error('No push token configured for repo-write-mode=commit-and-push');
      }
    }

    await this.execute('git', ['config', 'user.name', options.committerName]);
    await this.execute('git', ['config', 'user.email', options.committerEmail]);
    for (const removePath of removePaths) {
      rmSync(path.resolve(this.cwd, removePath), { force: true });
    }
    await this.execute('git', ['add', '-A', '--', ...stagePaths]);

    const staged = await this.execute('git', ['diff', '--cached', '--quiet']);
    if (staged.exitCode === 0) {
      return {
        commitSha: '',
        pushed: false,
        resolvedCurrentRef
      };
    }

    await this.execute('git', [
      'commit',
      '-m',
      'chore: sync Postman artifacts and metadata'
    ]);
    let commitSha = (await this.execute('git', ['rev-parse', 'HEAD'])).stdout.trim();

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
            // During rebase, "theirs" is the replayed commit. Generated paths are authoritative.
            const rebase = await this.execute('git', [
              'rebase',
              '-X',
              'theirs',
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
        await this.execute('git', ['remote', 'set-url', 'origin', originalRemote]);
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
