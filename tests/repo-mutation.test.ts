import { describe, expect, it, vi } from 'vitest';

import {
  RepoMutationService,
  buildAuthenticatedRemoteUrl,
  buildPushTokenOrder,
  resolveCurrentRef
} from '../src/lib/github/repo-mutation.js';

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandKey = string;

const githubRepoUrl = 'https://github.com/postman-cs/repo-sync-demo.git';
const defaultGithubPushRemote = buildAuthenticatedRemoteUrl(
  'github',
  'postman-cs/repo-sync-demo',
  'fallback-token',
  githubRepoUrl
);

function commandKey(command: string, args: string[]): CommandKey {
  return `${command} ${args.join(' ')}`;
}

function createCommandMap(
  overrides: Partial<Record<CommandKey, CommandResult>>
): Record<string, CommandResult> {
  const commands: Record<string, CommandResult> = {
    'git config user.name Postman': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git config user.name Postman CSE': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git config user.email support@postman.com': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git config user.email help@postman.com': {
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
      stdout: `${githubRepoUrl}\n`,
      stderr: ''
    },
    [commandKey('git', ['remote', 'set-url', 'origin', defaultGithubPushRemote])]: {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git -c http.https://github.com/.extraheader= push origin HEAD:refs/heads/feature/sync-artifacts':
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
    }
  };

  for (const [key, result] of Object.entries(overrides)) {
    if (result) {
      commands[key] = result;
    }
  }

  return commands;
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
        adoToken: 'ado-token',
        githubToken: 'same-token',
        fallbackToken: 'same-token'
      })
    ).toEqual(['ado-token', 'same-token']);
  });

  it('builds provider-specific authenticated remotes without mutating the repository path', () => {
    const githubUrl = new URL(
      buildAuthenticatedRemoteUrl(
        'github',
        'postman-cs/repo-sync-demo',
        'github token',
        'https://github.com/postman-cs/repo-sync-demo.git'
      )
    );
    expect(githubUrl.protocol).toBe('https:');
    expect(githubUrl.username).toBe('x-access-token');
    expect(decodeURIComponent(githubUrl.password)).toBe('github token');
    expect(githubUrl.host).toBe('github.com');
    expect(githubUrl.pathname).toBe('/postman-cs/repo-sync-demo.git');

    const gitlabUrl = new URL(
      buildAuthenticatedRemoteUrl(
        'gitlab',
        'postman-cs/repo-sync-demo',
        'gitlab-token',
        'https://gitlab.com/postman-cs/repo-sync-demo'
      )
    );
    expect(gitlabUrl.protocol).toBe('https:');
    expect(gitlabUrl.username).toBe('oauth2');
    expect(gitlabUrl.password).toBe('gitlab-token');
    expect(gitlabUrl.host).toBe('gitlab.com');
    expect(gitlabUrl.pathname).toBe('/postman-cs/repo-sync-demo.git');

    const adoUrl = new URL(
      buildAuthenticatedRemoteUrl(
        'azure-devops',
        'unused/repo',
        'ado token',
        'https://dev.azure.com/postman/CSE/_git/repo-sync-demo'
      )
    );
    expect(adoUrl.protocol).toBe('https:');
    expect(adoUrl.username).toBe('anything');
    expect(decodeURIComponent(adoUrl.password)).toBe('ado token');
    expect(adoUrl.host).toBe('dev.azure.com');
    expect(adoUrl.pathname).toBe('/postman/CSE/_git/repo-sync-demo');

    const adoSshUrl = new URL(
      buildAuthenticatedRemoteUrl(
        'azure-devops',
        'unused/repo',
        'ado token',
        'git@ssh.dev.azure.com:v3/postman/CSE/repo-sync-demo'
      )
    );
    expect(adoSshUrl.protocol).toBe('https:');
    expect(adoSshUrl.username).toBe('anything');
    expect(decodeURIComponent(adoSshUrl.password)).toBe('ado token');
    expect(adoSshUrl.host).toBe('dev.azure.com');
    expect(adoSshUrl.pathname).toBe('/postman/CSE/_git/repo-sync-demo');
  });

  it('normalizes trailing slashes before adding .git to token remotes', () => {
    expect(
      new URL(
        buildAuthenticatedRemoteUrl(
          'github',
          'unused/repo',
          'github-token',
          'https://github.com/postman-cs/repo-sync-demo/'
        )
      ).pathname
    ).toBe('/postman-cs/repo-sync-demo.git');

    expect(
      new URL(
        buildAuthenticatedRemoteUrl(
          'gitlab',
          'unused/repo',
          'gitlab-token',
          'https://gitlab.com/postman-cs/repo-sync-demo.git/'
        )
      ).pathname
    ).toBe('/postman-cs/repo-sync-demo.git');
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
      committerName: 'Postman',
      committerEmail: 'support@postman.com',
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
      '-c',
      'http.https://github.com/.extraheader=',
      'push',
      'origin',
      'HEAD:refs/heads/feature/sync-artifacts'
    ]);
    expect(execute).not.toHaveBeenCalledWith('git', ['push', 'origin', 'main']);
    expect(execute).toHaveBeenCalledWith('git', [
      'remote',
      'set-url',
      'origin',
      defaultGithubPushRemote
    ]);
  });

  it('returns before git mutations when no stage paths are provided', async () => {
    const execute = createExecuteMock(createCommandMap({}));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    const result = await repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      committerName: 'Postman CSE',
      committerEmail: 'help@postman.com',
      stagePaths: ['', '  ']
    });

    expect(result).toEqual({
      commitSha: '',
      pushed: false,
      resolvedCurrentRef: 'feature/sync-artifacts'
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['/tmp/out'],
    ['C:\\tmp\\out'],
    ['../outside'],
    ['postman/../../outside'],
    [':(top)'],
    ['postman\0out'],
    ['postman\rout'],
    ['postman\nout'],
    ['postman\x1Fout']
  ])('rejects unsafe git stage path %j before git mutations', async (stagePath) => {
    const execute = createExecuteMock(createCommandMap({}));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(
      repoMutation.commitAndPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'feature/sync-artifacts',
        githubToken: 'primary-token',
        committerName: 'Postman CSE',
        committerEmail: 'help@postman.com',
        stagePaths: [stagePath]
      })
    ).rejects.toThrow('Unsafe git stage path');
    expect(execute).not.toHaveBeenCalled();
  });

  it('redacts secrets from git push failures', async () => {
    const deniedMessage = [
      'remote: workflow denied for ',
      defaultGithubPushRemote,
      ' with primary-token'
    ].join('');
    const execute = createExecuteMock(
      createCommandMap({
        'git -c http.https://github.com/.extraheader= push origin HEAD:refs/heads/feature/sync-artifacts':
          {
            exitCode: 1,
            stdout: '',
            stderr: deniedMessage
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
        committerName: 'Postman',
        committerEmail: 'support@postman.com',
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
        committerName: 'Postman',
        committerEmail: 'support@postman.com',
        stagePaths: [
          'postman',
          '.postman',
          '.github/workflows/ci.yml',
          '.github/workflows/provision.yml'
        ]
      })
    ).rejects.not.toThrow('primary-token');
  });

  it('uses URL-scoped extraheader resets when pushing with an Azure DevOps token', async () => {
    const adoRemote = 'https://dev.azure.com/postman/CSE/_git/repo-sync-demo';
    const adoPushRemote = buildAuthenticatedRemoteUrl(
      'azure-devops',
      'postman-cs/repo-sync-demo',
      'ado-token',
      adoRemote
    );
    const execute = createExecuteMock(
      createCommandMap({
        'git remote get-url origin': {
          exitCode: 0,
          stdout: `${adoRemote}\n`,
          stderr: ''
        },
        [commandKey('git', ['remote', 'set-url', 'origin', adoPushRemote])]: {
          exitCode: 0,
          stdout: '',
          stderr: ''
        },
        'git -c http.https://dev.azure.com/postman/.extraheader= -c http.https://dev.azure.com/postman/CSE/_git/repo-sync-demo.extraheader= push origin HEAD:refs/heads/feature/sync-artifacts':
          {
            exitCode: 0,
            stdout: '',
            stderr: ''
        },
        [`git remote set-url origin ${adoRemote}`]: {
          exitCode: 0,
          stdout: '',
          stderr: ''
        }
      })
    );
    const repoMutation = new RepoMutationService({
      provider: 'azure-devops',
      repository: 'postman-cs/repo-sync-demo',
      repoUrl: adoRemote,
      execute
    });

    const result = await repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'refs/heads/feature/sync-artifacts',
      adoToken: 'ado-token',
      committerName: 'Postman CSE',
      committerEmail: 'help@postman.com',
      stagePaths: [
        'postman',
        '.postman',
        '.github/workflows/ci.yml',
        '.github/workflows/provision.yml'
      ]
    });

    expect(result.pushed).toBe(true);
    expect(execute).toHaveBeenCalledWith('git', [
      '-c',
      'http.https://dev.azure.com/postman/.extraheader=',
      '-c',
      'http.https://dev.azure.com/postman/CSE/_git/repo-sync-demo.extraheader=',
      'push',
      'origin',
      'HEAD:refs/heads/feature/sync-artifacts'
    ]);
    expect(execute).not.toHaveBeenCalledWith('git', [
      '-c',
      'http.extraHeader=',
      'push',
      'origin',
      'HEAD:refs/heads/feature/sync-artifacts'
    ]);
  });

  it('uses Azure DevOps persisted checkout credentials when no ADO token is configured', async () => {
    const adoRemote = 'https://dev.azure.com/postman/CSE/_git/repo-sync-demo';
    const execute = createExecuteMock(
      createCommandMap({
        'git remote get-url origin': {
          exitCode: 0,
          stdout: `${adoRemote}\n`,
          stderr: ''
        }
      })
    );
    const repoMutation = new RepoMutationService({
      provider: 'azure-devops',
      repository: 'postman-cs/repo-sync-demo',
      repoUrl: adoRemote,
      execute
    });

    const result = await repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'refs/heads/feature/sync-artifacts',
      committerName: 'Postman CSE',
      committerEmail: 'help@postman.com',
      stagePaths: ['postman', '.postman', '.github/workflows']
    });

    expect(result.pushed).toBe(true);
    expect(execute).toHaveBeenCalledWith('git', [
      'push',
      'origin',
      'HEAD:refs/heads/feature/sync-artifacts'
    ]);
    expect(execute).not.toHaveBeenCalledWith('git', [
      'remote',
      'set-url',
      'origin',
      expect.stringContaining('@dev.azure.com')
    ]);
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
      committerName: 'Postman',
      committerEmail: 'support@postman.com',
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

  it('fails commit-and-push token validation after staged changes and before git commit', async () => {
    const execute = createExecuteMock(createCommandMap({}));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(
      repoMutation.commitAndPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'feature/sync-artifacts',
        committerName: 'Postman',
        committerEmail: 'support@postman.com',
        stagePaths: ['postman', '.postman', '.github/workflows']
      })
    ).rejects.toThrow(/No push token configured for repo-write-mode=commit-and-push/);

    expect(execute).toHaveBeenCalledWith('git', ['diff', '--cached', '--quiet']);
    expect(execute).not.toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: sync Postman artifacts and metadata'
    ]);
  });

  it('fails commit-and-push missing ref validation after staged changes and before git commit', async () => {
    const execute = createExecuteMock(createCommandMap({}));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(
      repoMutation.commitAndPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'refs/tags/v1.2.3',
        githubToken: 'primary-token',
        committerName: 'Postman',
        committerEmail: 'support@postman.com',
        stagePaths: ['postman', '.postman', '.github/workflows']
      })
    ).rejects.toThrow(/No current ref could be resolved for repo-write-mode=commit-and-push/);

    expect(execute).toHaveBeenCalledWith('git', ['diff', '--cached', '--quiet']);
    expect(execute).not.toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: sync Postman artifacts and metadata'
    ]);
  });

  it('fails unsupported provider validation after staged changes and before git commit', async () => {
    const execute = createExecuteMock(createCommandMap({}));
    const repoMutation = new RepoMutationService({
      provider: 'bitbucket',
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(
      repoMutation.commitAndPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'feature/sync-artifacts',
        githubToken: 'primary-token',
        committerName: 'Postman',
        committerEmail: 'support@postman.com',
        stagePaths: ['postman', '.postman', '.github/workflows']
      })
    ).rejects.toThrow(/not supported for git provider "bitbucket"/);

    expect(execute).toHaveBeenCalledWith('git', ['diff', '--cached', '--quiet']);
    expect(execute).not.toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: sync Postman artifacts and metadata'
    ]);
  });
});
