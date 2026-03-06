import { createSecretMasker, type SecretMasker } from '../secrets.js';

export type RepoWriteMode = 'none' | 'commit-only' | 'commit-and-push';

export interface RepoMutationContext {
  currentRef?: string;
  githubHeadRef?: string;
  githubRefName?: string;
  repoWriteMode: RepoWriteMode | string;
}

export interface BuildPushTokenOrderOptions {
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
  committerEmail: string;
  committerName: string;
  fallbackToken?: string;
  githubToken?: string;
  stagePaths: string[];
}

export interface RepoMutationServiceOptions {
  execute: ExecuteFn;
  repository: string;
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
  const ordered = [options.fallbackToken, options.githubToken]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  return ordered.filter((token, index) => ordered.indexOf(token) === index);
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

export class RepoMutationService {
  private readonly execute: ExecuteFn;
  private readonly repository: string;
  private readonly secretMasker: SecretMasker;

  constructor(options: RepoMutationServiceOptions) {
    this.execute = options.execute;
    this.repository = options.repository;
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([]);
  }

  async commitAndPush(options: CommitAndPushOptions): Promise<{
    commitSha: string;
    pushed: boolean;
    resolvedCurrentRef: string;
  }> {
    const resolvedCurrentRef = resolveCurrentRef(options);
    const tokens = buildPushTokenOrder({
      fallbackToken: options.fallbackToken,
      githubToken: options.githubToken
    });
    const secretMasker = createSecretMasker(tokens);

    await this.execute('git', ['config', 'user.name', options.committerName]);
    await this.execute('git', ['config', 'user.email', options.committerEmail]);
    await this.execute('git', ['add', '-A', '--', ...options.stagePaths]);

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
    if (tokens.length === 0) {
      throw new Error('No push token configured for repo-write-mode=commit-and-push');
    }

    const originalRemote = (await this.execute('git', ['remote', 'get-url', 'origin']))
      .stdout.trim();

    await this.execute('git', [
      'config',
      '--unset-all',
      'http.https://github.com/.extraheader'
    ]);

    let pushed = false;
    let lastError = '';

    const isNonRetryablePushError = (message: string): boolean =>
      /workflow|permission/i.test(message);

    try {
      for (const token of tokens) {
        await this.execute('git', [
          'remote',
          'set-url',
          'origin',
          `https://x-access-token:${token}@github.com/${this.repository}.git`
        ]);

        const push = await this.execute('git', [
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
      await this.execute('git', ['remote', 'set-url', 'origin', originalRemote]);
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
