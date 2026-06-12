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
  stagePaths: string[];
}

export interface RepoMutationServiceOptions {
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
  if (trimmed.startsWith('refs/heads/')) {
    return trimmed.slice('refs/heads/'.length);
  }
  if (trimmed.startsWith('refs/tags/') || trimmed.startsWith('refs/pull/')) {
    return '';
  }
  if (trimmed.startsWith('refs/')) {
    return '';
  }
  return trimmed;
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
  const normalized = sshMatch ? `https://${sshMatch[1]}/${sshMatch[2]}` : trimmed;
  const url = new URL(normalized);
  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
}

function withoutGitSuffix(pathname: string): string {
  return pathname.endsWith('.git') ? pathname.slice(0, -4) : pathname;
}

function withGitSuffix(pathname: string): string {
  return pathname.endsWith('.git') ? pathname : `${pathname}.git`;
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
  if (currentRef.startsWith('refs/pull/')) {
    return normalizeBranchRef(context.githubHeadRef);
  }

  return (
    normalizeBranchRef(currentRef) ||
    normalizeBranchRef(context.githubHeadRef) ||
    normalizeBranchRef(context.githubRefName)
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

    normalized.push(stagePath);
  }

  return normalized;
}

export class RepoMutationService {
  private readonly execute: ExecuteFn;
  private readonly provider: GitProvider;
  private readonly repository: string;
  private readonly repoUrl: string | undefined;
  private readonly secretMasker: SecretMasker;

  constructor(options: RepoMutationServiceOptions) {
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
    const stagePaths = normalizeStagePaths(options.stagePaths);
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

    await this.execute('git', ['config', 'user.name', options.committerName]);
    await this.execute('git', ['config', 'user.email', options.committerEmail]);
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
    const commitSha = (await this.execute('git', ['rev-parse', 'HEAD'])).stdout.trim();

    if (options.repoWriteMode !== 'commit-and-push') {
      return {
        commitSha,
        pushed: false,
        resolvedCurrentRef
      };
    }

    if (!resolvedCurrentRef) {
      throw new Error('No current ref could be resolved for repo-write-mode=commit-and-push');
    }
    const usePersistedCredentials = tokens.length === 0 && this.provider === 'azure-devops';
    if (tokens.length === 0 && !usePersistedCredentials) {
      throw new Error('No push token configured for repo-write-mode=commit-and-push');
    }
    if (tokens.length > 0 && !supportsTokenRemote(this.provider)) {
      throw new Error(`repo-write-mode=commit-and-push is not supported for git provider "${this.provider}"`);
    }

    const originalRemote = (await this.execute('git', ['remote', 'get-url', 'origin']))
      .stdout.trim();

    let pushed = false;
    let lastError = '';
    let remoteChanged = false;

    const isNonRetryablePushError = (message: string): boolean =>
      /workflow|permission/i.test(message);

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
        if (isNonRetryablePushError(lastError)) {
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
