import { describe, expect, it, vi } from 'vitest';

import {
  RepoMutationService,
  buildPushTokenOrder,
  resolveCurrentRef
} from '../src/lib/github/repo-mutation.js';

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandKey =
  | 'git add -A -- postman .postman .github/workflows'
  | 'git add -A -- postman .postman .github/workflows/ci.yml .github/workflows/provision.yml'
  | 'git commit -m chore: sync Postman artifacts and metadata'
  | 'git config --unset-all http.https://github.com/.extraheader'
  | 'git config user.email fde@postman.com'
  | 'git config user.name Postman FDE'
  | 'git diff --cached --quiet'
  | 'git push origin HEAD:refs/heads/feature/sync-artifacts'
  | 'git remote get-url origin'
  | 'git remote set-url origin https://github.com/postman-cs/repo-sync-demo.git'
  | 'git remote set-url origin https://x-access-token:fallback-token@github.com/postman-cs/repo-sync-demo.git'
  | 'git rev-parse HEAD';

function createCommandMap(
  overrides: Partial<Record<CommandKey, CommandResult>>
): Record<string, CommandResult> {
  return {
    'git config user.name Postman FDE': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git config user.email fde@postman.com': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git add -A -- postman .postman .github/workflows': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git add -A -- postman .postman .github/workflows/ci.yml .github/workflows/provision.yml':
      {
        exitCode: 0,
        stdout: '',
        stderr: ''
      },
    'git diff --cached --quiet': {
      exitCode: 1,
      stdout: '',
      stderr: ''
    },
    'git commit -m chore: sync Postman artifacts and metadata': {
      exitCode: 0,
      stdout: '[feature/sync-artifacts abc1234] sync',
      stderr: ''
    },
    'git rev-parse HEAD': {
      exitCode: 0,
      stdout: 'abc1234\n',
      stderr: ''
    },
    'git remote get-url origin': {
      exitCode: 0,
      stdout: 'https://github.com/postman-cs/repo-sync-demo.git\n',
      stderr: ''
    },
    'git config --unset-all http.https://github.com/.extraheader': {
      exitCode: 1,
      stdout: '',
      stderr: ''
    },
    'git remote set-url origin https://x-access-token:fallback-token@github.com/postman-cs/repo-sync-demo.git':
      {
        exitCode: 0,
        stdout: '',
        stderr: ''
      },
    'git push origin HEAD:refs/heads/feature/sync-artifacts': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git remote set-url origin https://github.com/postman-cs/repo-sync-demo.git':
      {
        exitCode: 0,
        stdout: '',
        stderr: ''
      },
    ...overrides
  };
}

function createExecuteMock(results: Record<string, CommandResult>) {
  return vi.fn(
    async (command: string, args: string[]): Promise<CommandResult> => {
      const key = `${command} ${args.join(' ')}`;
      const result = results[key];

      if (!result) {
        throw new Error(`Unexpected command: ${key}`);
      }

      return result;
    }
  );
}

describe('repo mutation helpers', () => {
  it('deduplicates push tokens and prefers the fallback token first', () => {
    expect(
      buildPushTokenOrder({
        githubToken: 'primary-token',
        fallbackToken: 'fallback-token'
      })
    ).toEqual(['fallback-token', 'primary-token']);

    expect(
      buildPushTokenOrder({
        githubToken: 'same-token',
        fallbackToken: 'same-token'
      })
    ).toEqual(['same-token']);
  });

  it('resolves the current ref with branch-safe semantics', () => {
    expect(
      resolveCurrentRef({
        repoWriteMode: 'commit-and-push',
        currentRef: 'refs/pull/42/merge',
        githubHeadRef: 'feature/sync-artifacts',
        githubRefName: 'main'
      })
    ).toBe('feature/sync-artifacts');

    expect(
      resolveCurrentRef({
        repoWriteMode: 'commit-and-push',
        currentRef: 'refs/heads/release/2026-03'
      })
    ).toBe('release/2026-03');

    expect(
      resolveCurrentRef({
        repoWriteMode: 'commit-and-push',
        currentRef: 'refs/tags/v1.2.3',
        githubRefName: 'refs/pull/42/merge'
      })
    ).toBe('');
  });

  it('pushes HEAD to the resolved branch instead of hardcoding main', async () => {
    const execute = createExecuteMock(createCommandMap({}));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    const result = await repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'refs/pull/42/merge',
      githubHeadRef: 'feature/sync-artifacts',
      githubToken: 'primary-token',
      fallbackToken: 'fallback-token',
      committerName: 'Postman FDE',
      committerEmail: 'fde@postman.com',
      stagePaths: [
        'postman',
        '.postman',
        '.github/workflows/ci.yml',
        '.github/workflows/provision.yml'
      ]
    });

    expect(result).toMatchObject({
      commitSha: 'abc1234',
      pushed: true,
      resolvedCurrentRef: 'feature/sync-artifacts'
    });
    expect(execute).toHaveBeenCalledWith('git', [
      'push',
      'origin',
      'HEAD:refs/heads/feature/sync-artifacts'
    ]);
    expect(execute).not.toHaveBeenCalledWith('git', ['push', 'origin', 'main']);
    expect(execute).toHaveBeenCalledWith('git', [
      'remote',
      'set-url',
      'origin',
      'https://x-access-token:fallback-token@github.com/postman-cs/repo-sync-demo.git'
    ]);
  });

  it('redacts secrets from git push failures', async () => {
    const execute = createExecuteMock(
      createCommandMap({
        'git push origin HEAD:refs/heads/feature/sync-artifacts': {
          exitCode: 1,
          stdout: '',
          stderr:
            'remote: workflow denied for https://x-access-token:fallback-token@github.com/postman-cs/repo-sync-demo.git with primary-token'
        }
      })
    );
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(
      repoMutation.commitAndPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'feature/sync-artifacts',
        githubToken: 'primary-token',
        fallbackToken: 'fallback-token',
        committerName: 'Postman FDE',
        committerEmail: 'fde@postman.com',
        stagePaths: [
          'postman',
          '.postman',
          '.github/workflows/ci.yml',
          '.github/workflows/provision.yml'
        ]
      })
    ).rejects.toThrow('[REDACTED]');

    await expect(
      repoMutation.commitAndPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'feature/sync-artifacts',
        githubToken: 'primary-token',
        fallbackToken: 'fallback-token',
        committerName: 'Postman FDE',
        committerEmail: 'fde@postman.com',
        stagePaths: [
          'postman',
          '.postman',
          '.github/workflows/ci.yml',
          '.github/workflows/provision.yml'
        ]
      })
    ).rejects.not.toThrow('primary-token');
  });

  it('returns without commit when there are no staged changes', async () => {
    const execute = createExecuteMock(
      createCommandMap({
        'git diff --cached --quiet': {
          exitCode: 0,
          stdout: '',
          stderr: ''
        }
      })
    );
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    const result = await repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      githubToken: 'primary-token',
      fallbackToken: 'fallback-token',
      committerName: 'Postman FDE',
      committerEmail: 'fde@postman.com',
      stagePaths: ['postman', '.postman', '.github/workflows']
    });

    expect(result).toEqual({
      commitSha: '',
      pushed: false,
      resolvedCurrentRef: 'feature/sync-artifacts'
    });
    expect(execute).not.toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: sync Postman artifacts and metadata'
    ]);
  });
});
