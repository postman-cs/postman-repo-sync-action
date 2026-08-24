import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  RepoMutationPreCommitError,
  RepoMutationService,
  buildAuthenticatedRemoteUrl,
  buildPushTokenOrder,
  resolveCurrentRef
} from '../src/lib/github/repo-mutation.js';

// vitest timeout flakes under full-suite load, so raise it file-wide.
vi.setConfig({ testTimeout: 60_000 });

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
const execFileAsync = promisify(execFile);

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
    'git status --porcelain=v1 --untracked-files=all -- postman .postman .github/workflows': {
      exitCode: 0,
      stdout: ' M postman/collection.yaml\n',
      stderr: ''
    },
    'git status --porcelain=v1 --untracked-files=all -- postman .postman .github/workflows/ci.yml .github/workflows/provision.yml': {
      exitCode: 0,
      stdout: ' M postman/collection.yaml\n',
      stderr: ''
    },
    'git add -A -- postman .postman .github/workflows/ci.yml .github/workflows/provision.yml':
      {
        exitCode: 0,
        stdout: '',
        stderr: ''
      },
    'git diff --cached --quiet': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git diff --quiet': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git ls-files --others --exclude-standard -- .postman/resources.yaml': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git ls-files --others --ignored --exclude-standard -- .postman/resources.yaml': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git reset --quiet HEAD -- postman .postman .github/workflows': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git diff --cached --quiet -- postman .postman .github/workflows': {
      exitCode: 1,
      stdout: '',
      stderr: ''
    },
    'git diff --cached --quiet -- postman .postman .github/workflows/ci.yml .github/workflows/provision.yml': {
      exitCode: 1,
      stdout: '',
      stderr: ''
    },
    'git commit --only -m chore: sync Postman artifacts and metadata -- postman .postman .github/workflows': {
      exitCode: 0,
      stdout: '[feature/sync-artifacts abc1234] sync',
      stderr: ''
    },
    'git commit --only -m chore: sync Postman artifacts and metadata -- postman .postman .github/workflows/ci.yml .github/workflows/provision.yml': {
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
    'git -c http.https://github.com/.extraheader= push --dry-run origin HEAD:refs/heads/feature/sync-artifacts':
      {
        exitCode: 0,
        stdout: '',
        stderr: ''
      },
    'git -c http.https://github.com/.extraheader= fetch --no-tags origin refs/heads/feature/sync-artifacts':
      {
        exitCode: 0,
        stdout: '',
        stderr: ''
      },
    'git fetch --no-tags origin refs/heads/feature/sync-artifacts': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git rebase FETCH_HEAD': {
      exitCode: 0,
      stdout: 'Current branch is up to date.\n',
      stderr: ''
    },
    'git diff --quiet abc1234 HEAD -- postman .postman .github/workflows': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git diff --quiet abc1234 HEAD -- postman .postman .github/workflows/ci.yml .github/workflows/provision.yml': {
      exitCode: 0,
      stdout: '',
      stderr: ''
    },
    'git rebase --abort': {
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

  it('authenticates, fetches, and dry-runs state-ref publication without writing', async () => {
    const execute = createExecuteMock(createCommandMap({}));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(repoMutation.preflightPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token'
    })).resolves.toEqual({ resolvedCurrentRef: 'feature/sync-artifacts' });

    expect(execute).toHaveBeenCalledWith('git', [
      '-c',
      'http.https://github.com/.extraheader=',
      'push',
      '--dry-run',
      'origin',
      'HEAD:refs/heads/feature/sync-artifacts'
    ]);
    expect(execute).not.toHaveBeenCalledWith('git', [
      '-c',
      'http.https://github.com/.extraheader=',
      'push',
      'origin',
      'HEAD:refs/heads/feature/sync-artifacts'
    ]);
  });

  it('fails and redacts an authenticated publication preflight denial', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git -c http.https://github.com/.extraheader= fetch --no-tags origin refs/heads/feature/sync-artifacts': {
        exitCode: 128,
        stdout: '',
        stderr: 'authentication failed for fallback-token'
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    let failure: Error | undefined;
    try {
      await repoMutation.preflightPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'feature/sync-artifacts',
        fallbackToken: 'fallback-token'
      });
    } catch (error) {
      failure = error as Error;
    }

    expect(failure?.message).toContain('REPO_PUSH_PREFLIGHT_FAILED');
    expect(failure?.message).toContain('[REDACTED]');
    expect(failure?.message).not.toContain('fallback-token');
  });

  it('fails securely when authenticated preflight cannot restore origin', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git remote set-url origin https://github.com/postman-cs/repo-sync-demo.git': {
        exitCode: 1,
        stdout: '',
        stderr: 'restore failed for fallback-token'
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(repoMutation.preflightPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token'
    })).rejects.toThrow(/Could not restore origin remote.*\[REDACTED\]/su);

    await expect(repoMutation.preflightPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token'
    })).rejects.not.toThrow('fallback-token');
  });

  it('fails securely when final publication cannot restore origin', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git remote set-url origin https://github.com/postman-cs/repo-sync-demo.git': {
        exitCode: 1,
        stdout: '',
        stderr: 'restore failed for fallback-token'
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    let failure: Error | undefined;
    try {
      await repoMutation.commitAndPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'feature/sync-artifacts',
        fallbackToken: 'fallback-token',
        committerName: 'Postman CSE',
        committerEmail: 'help@postman.com',
        stagePaths: ['postman', '.postman', '.github/workflows']
      });
    } catch (error) {
      failure = error as Error;
    }

    expect(failure?.message).toMatch(/Could not restore origin remote.*\[REDACTED\]/su);
    expect(failure?.message).not.toContain('fallback-token');
    expect(execute).toHaveBeenCalledWith('git', [
      '-c',
      'http.https://github.com/.extraheader=',
      'push',
      'origin',
      'HEAD:refs/heads/feature/sync-artifacts'
    ]);
  });

  it('rejects dirty durable authority paths before remote publication preflight', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git ls-files --others --ignored --exclude-standard -- .postman/resources.yaml': {
        exitCode: 0,
        stdout: '.postman/resources.yaml\n',
        stderr: ''
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(repoMutation.preflightPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token',
      authorityPaths: ['.postman/resources.yaml']
    })).rejects.toThrow('DURABLE_STATE_DIRTY');

    expect(execute).not.toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin']);
  });

  it('allows ignored siblings when the exact durable authority file is absent', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'repo-mutation-authority-'));
    try {
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: fixtureRoot });
      await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: fixtureRoot });
      await execFileAsync('git', ['config', 'user.email', 'fixture@example.com'], {
        cwd: fixtureRoot
      });
      await writeFile(path.join(fixtureRoot, '.gitignore'), '/.postman/\n', 'utf8');
      await writeFile(path.join(fixtureRoot, 'README.md'), 'initial\n', 'utf8');
      await execFileAsync('git', ['add', '.gitignore', 'README.md'], { cwd: fixtureRoot });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: fixtureRoot });
      await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://dev.azure.com/postman/CSE/_git/repo-sync-demo'],
        { cwd: fixtureRoot }
      );
      await mkdir(path.join(fixtureRoot, '.postman'), { recursive: true });
      await writeFile(path.join(fixtureRoot, '.postman', 'local-cache'), 'ignored sibling\n', 'utf8');

      const execute = async (command: string, args: string[]): Promise<CommandResult> => {
        if (command === 'git' && (args.includes('fetch') || args.includes('push'))) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        try {
          const result = await execFileAsync(command, args, { cwd: fixtureRoot, encoding: 'utf8' });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          return {
            exitCode: typeof failure.code === 'number' ? failure.code : 1,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? ''
          };
        }
      };
      const repoMutation = new RepoMutationService({
        cwd: fixtureRoot,
        execute,
        provider: 'azure-devops',
        repository: 'fixture/repository'
      });

      await expect(repoMutation.preflightPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'main',
        authorityPaths: ['.postman/resources.yaml']
      })).resolves.toEqual({ resolvedCurrentRef: 'main' });

      await writeFile(
        path.join(fixtureRoot, '.postman', 'resources.yaml'),
        'version: 3\n',
        'utf8'
      );
      await expect(repoMutation.preflightPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'main',
        authorityPaths: ['.postman/resources.yaml']
      })).rejects.toThrow('DURABLE_STATE_DIRTY');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects a dirty index during publication preflight', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git diff --cached --quiet': {
        exitCode: 1,
        stdout: '',
        stderr: ''
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(repoMutation.preflightPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token',
      authorityPaths: ['.postman/resources.yaml']
    })).rejects.toThrow('Pre-existing staged changes');

    expect(execute).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['status', '--porcelain=v1'])
    );
    expect(execute).not.toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin']);
  });

  it('rejects unstaged tracked changes during publication preflight', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git diff --quiet': {
        exitCode: 1,
        stdout: '',
        stderr: ''
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(repoMutation.preflightPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token',
      authorityPaths: ['.postman/resources.yaml']
    })).rejects.toThrow('Pre-existing unstaged tracked changes');

    expect(execute).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['ls-files'])
    );
    expect(execute).not.toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin']);
  });

  it('rejects generated-path drift after remote reconciliation before push', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git diff --quiet abc1234 HEAD -- postman .postman .github/workflows': {
        exitCode: 1,
        stdout: '',
        stderr: ''
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token',
      committerName: 'Postman',
      committerEmail: 'support@postman.com',
      stagePaths: ['postman', '.postman', '.github/workflows']
    })).rejects.toThrow(/REPO_PUSH_STATE_DRIFT/);

    expect(execute).not.toHaveBeenCalledWith('git', [
      '-c',
      'http.https://github.com/.extraheader=',
      'push',
      'origin',
      'HEAD:refs/heads/feature/sync-artifacts'
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

  it('authenticates and pushes an unchanged clean generated tree', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git status --porcelain=v1 --untracked-files=all -- postman .postman .github/workflows': {
        exitCode: 0,
        stdout: '',
        stderr: ''
      },
      'git diff --cached --quiet -- postman .postman .github/workflows': {
        exitCode: 0,
        stdout: '',
        stderr: ''
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    const result = await repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token',
      committerName: 'Postman CSE',
      committerEmail: 'help@postman.com',
      stagePaths: ['postman', '.postman', '.github/workflows']
    });

    expect(result).toMatchObject({ pushed: true, resolvedCurrentRef: 'feature/sync-artifacts' });
    expect(execute).toHaveBeenCalledWith('git', [
      'add',
      '-A',
      '--',
      'postman',
      '.postman',
      '.github/workflows'
    ]);
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['-f']));
    expect(execute).toHaveBeenCalledWith('git', ['diff', '--cached', '--quiet']);
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['commit']));
    expect(execute).toHaveBeenCalledWith('git', [
      '-c',
      'http.https://github.com/.extraheader=',
      'push',
      'origin',
      'HEAD:refs/heads/feature/sync-artifacts'
    ]);
  });

  it('force-stages ignored generated artifacts before committing and pushing', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git status --porcelain=v1 --untracked-files=all -- .postman/resources.yaml': {
        exitCode: 0,
        stdout: '',
        stderr: ''
      },
      'git status --porcelain=v1 --untracked-files=all --ignored=matching -- .postman/resources.yaml': {
        exitCode: 0,
        stdout: '!! .postman/resources.yaml\n',
        stderr: ''
      },
      'git add -A -- .postman/resources.yaml': {
        exitCode: 0,
        stdout: '',
        stderr: ''
      },
      'git add -f -A -- .postman/resources.yaml': {
        exitCode: 0,
        stdout: '',
        stderr: ''
      },
      'git diff --cached --quiet -- .postman/resources.yaml': {
        exitCode: 1,
        stdout: '',
        stderr: ''
      },
      'git commit --only -m chore: sync Postman artifacts and metadata -- .postman/resources.yaml': {
        exitCode: 0,
        stdout: '[feature/sync-artifacts abc1234] sync',
        stderr: ''
      },
      'git diff --quiet abc1234 HEAD -- .postman/resources.yaml': {
        exitCode: 0,
        stdout: '',
        stderr: ''
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    const result = await repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token',
      committerName: 'Postman CSE',
      committerEmail: 'help@postman.com',
      forceStagePaths: ['.postman/resources.yaml'],
      stagePaths: ['.postman/resources.yaml']
    });

    expect(result).toMatchObject({ commitSha: 'abc1234', pushed: true });
    expect(execute).toHaveBeenCalledWith('git', [
      'add',
      '-f',
      '-A',
      '--',
      '.postman/resources.yaml'
    ]);
  });

  it('rejects a directory as a force-stage path before staging it', async () => {
    const execute = createExecuteMock(createCommandMap({}));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token',
      committerName: 'Postman CSE',
      committerEmail: 'help@postman.com',
      forceStagePaths: ['postman'],
      stagePaths: ['postman']
    })).rejects.toThrow('Force-stage path must identify an exact generated file');

    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['add']));
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']));
  });

  it('force-stages only an exact generated file and leaves ignored siblings untracked', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'repo-mutation-force-stage-'));
    try {
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: fixtureRoot });
      await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: fixtureRoot });
      await execFileAsync('git', ['config', 'user.email', 'fixture@example.com'], {
        cwd: fixtureRoot
      });
      await writeFile(path.join(fixtureRoot, '.gitignore'), '/postman/\n', 'utf8');
      await writeFile(path.join(fixtureRoot, 'README.md'), 'initial\n', 'utf8');
      await execFileAsync('git', ['add', '.gitignore', 'README.md'], { cwd: fixtureRoot });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: fixtureRoot });
      await mkdir(path.join(fixtureRoot, 'postman'), { recursive: true });
      await writeFile(path.join(fixtureRoot, 'postman', 'generated.yaml'), 'name: generated\n', 'utf8');
      await writeFile(path.join(fixtureRoot, 'postman', 'local-secret.txt'), 'must-not-publish\n', 'utf8');

      const execute = async (command: string, args: string[]): Promise<CommandResult> => {
        try {
          const result = await execFileAsync(command, args, { cwd: fixtureRoot, encoding: 'utf8' });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          return {
            exitCode: typeof failure.code === 'number' ? failure.code : 1,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? ''
          };
        }
      };
      const repoMutation = new RepoMutationService({
        cwd: fixtureRoot,
        repository: 'fixture/repository',
        execute
      });

      const result = await repoMutation.commitAndPush({
        repoWriteMode: 'commit-only',
        currentRef: 'main',
        committerName: 'Postman CSE',
        committerEmail: 'help@postman.com',
        forceStagePaths: ['postman/generated.yaml'],
        stagePaths: ['postman/generated.yaml']
      });

      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/u);
      const generated = await execFileAsync(
        'git',
        ['show', 'HEAD:postman/generated.yaml'],
        { cwd: fixtureRoot, encoding: 'utf8' }
      );
      expect(generated.stdout).toBe('name: generated\n');
      const secret = await execFileAsync(
        'git',
        ['ls-files', '--', 'postman/local-secret.txt'],
        { cwd: fixtureRoot, encoding: 'utf8' }
      );
      expect(secret.stdout).toBe('');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects unrelated staged files when generated paths are clean', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git status --porcelain=v1 --untracked-files=all -- postman .postman .github/workflows': {
        exitCode: 0,
        stdout: '',
        stderr: ''
      },
      'git diff --cached --quiet': {
        exitCode: 1,
        stdout: '',
        stderr: ''
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token',
      committerName: 'Postman CSE',
      committerEmail: 'help@postman.com',
      stagePaths: ['postman', '.postman', '.github/workflows']
    })).rejects.toThrow('Pre-existing staged changes');

    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['add']));
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['commit']));
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']));
  });

  it('rejects unrelated staged files before staging dirty generated paths', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git diff --cached --quiet': {
        exitCode: 1,
        stdout: '',
        stderr: ''
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    await expect(repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token',
      committerName: 'Postman CSE',
      committerEmail: 'help@postman.com',
      stagePaths: ['postman', '.postman', '.github/workflows']
    })).rejects.toThrow('Pre-existing staged changes');

    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['add']));
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['commit']));
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['rebase']));
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']));
  });

  it('fails before diff or push when generated paths cannot be staged', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git add -A -- postman .postman .github/workflows': {
        exitCode: 128,
        stdout: '',
        stderr: "fatal: Unable to create '.git/index.lock': File exists.\n"
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    const failure = repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token',
      committerName: 'Postman CSE',
      committerEmail: 'help@postman.com',
      stagePaths: ['postman', '.postman', '.github/workflows']
    });
    await expect(failure).rejects.toBeInstanceOf(RepoMutationPreCommitError);
    await expect(failure).rejects.toThrow(/Failed to stage generated changes.*index\.lock/su);

    expect(execute).toHaveBeenCalledWith('git', [
      'reset',
      '--quiet',
      'HEAD',
      '--',
      'postman',
      '.postman',
      '.github/workflows'
    ]);
    expect(execute).not.toHaveBeenCalledWith('git', [
      'diff',
      '--cached',
      '--quiet',
      '--',
      'postman',
      '.postman',
      '.github/workflows'
    ]);
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']));
  });

  it('fails before resolving HEAD or pushing when the generated commit is rejected', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git commit --only -m chore: sync Postman artifacts and metadata -- postman .postman .github/workflows': {
        exitCode: 1,
        stdout: '',
        stderr: 'commit-msg hook rejected generated commit\n'
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    const failure = repoMutation.commitAndPush({
      repoWriteMode: 'commit-and-push',
      currentRef: 'feature/sync-artifacts',
      fallbackToken: 'fallback-token',
      committerName: 'Postman CSE',
      committerEmail: 'help@postman.com',
      stagePaths: ['postman', '.postman', '.github/workflows']
    });
    await expect(failure).rejects.toBeInstanceOf(RepoMutationPreCommitError);
    await expect(failure).rejects.toThrow(/Failed to commit generated changes.*commit-msg hook/su);

    expect(execute).toHaveBeenCalledWith('git', [
      'reset',
      '--quiet',
      'HEAD',
      '--',
      'postman',
      '.postman',
      '.github/workflows'
    ]);
    expect(execute).not.toHaveBeenCalledWith('git', ['rev-parse', 'HEAD']);
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']));
  });

  it('marks a pre-commit failure as unrestored when scoped index cleanup fails', async () => {
    const execute = createExecuteMock(createCommandMap({
      'git commit --only -m chore: sync Postman artifacts and metadata -- postman .postman .github/workflows': {
        exitCode: 1,
        stdout: '',
        stderr: 'commit-msg hook rejected generated commit\n'
      },
      'git reset --quiet HEAD -- postman .postman .github/workflows': {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: Unable to create index.lock\n'
      }
    }));
    const repoMutation = new RepoMutationService({
      repository: 'postman-cs/repo-sync-demo',
      execute
    });

    let failure: unknown;
    try {
      await repoMutation.commitAndPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'feature/sync-artifacts',
        fallbackToken: 'fallback-token',
        committerName: 'Postman CSE',
        committerEmail: 'help@postman.com',
        stagePaths: ['postman', '.postman', '.github/workflows']
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RepoMutationPreCommitError);
    expect((failure as RepoMutationPreCommitError).indexRestored).toBe(false);
    expect((failure as Error).message).toMatch(/failed to restore.*index\.lock/su);
  });

  it.skipIf(process.platform === 'win32')(
    'unstages owned paths and preserves working bytes when a commit hook rejects publication',
    async () => {
      const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'repo-mutation-hook-rejection-'));
      try {
        await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: fixtureRoot });
        await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: fixtureRoot });
        await execFileAsync('git', ['config', 'user.email', 'fixture@example.com'], {
          cwd: fixtureRoot
        });
        await writeFile(path.join(fixtureRoot, '.gitignore'), '/.postman/\n/postman/\n', 'utf8');
        await writeFile(path.join(fixtureRoot, 'README.md'), 'initial\n', 'utf8');
        await execFileAsync('git', ['add', '.gitignore', 'README.md'], { cwd: fixtureRoot });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: fixtureRoot });
        const hookPath = path.join(fixtureRoot, '.git', 'hooks', 'commit-msg');
        await writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
        await chmod(hookPath, 0o755);
        await mkdir(path.join(fixtureRoot, '.postman'), { recursive: true });
        await mkdir(path.join(fixtureRoot, 'postman', 'environments'), { recursive: true });
        const statePath = path.join(fixtureRoot, '.postman', 'resources.yaml');
        const artifactPath = path.join(
          fixtureRoot,
          'postman',
          'environments',
          'Payments API - dev.environment.yaml'
        );
        await writeFile(statePath, 'version: 3\n', 'utf8');
        await writeFile(artifactPath, 'name: Payments API - dev\n', 'utf8');

        const execute = async (command: string, args: string[]): Promise<CommandResult> => {
          try {
            const result = await execFileAsync(command, args, { cwd: fixtureRoot, encoding: 'utf8' });
            return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
          } catch (error) {
            const failure = error as { code?: number; stdout?: string; stderr?: string };
            return {
              exitCode: typeof failure.code === 'number' ? failure.code : 1,
              stdout: failure.stdout ?? '',
              stderr: failure.stderr ?? ''
            };
          }
        };
        const repoMutation = new RepoMutationService({
          cwd: fixtureRoot,
          execute,
          repository: 'fixture/repository'
        });

        await expect(repoMutation.commitAndPush({
          repoWriteMode: 'commit-only',
          currentRef: 'main',
          committerName: 'Postman CSE',
          committerEmail: 'help@postman.com',
          forceStagePaths: [
            '.postman/resources.yaml',
            'postman/environments/Payments API - dev.environment.yaml'
          ],
          stagePaths: [
            '.postman/resources.yaml',
            'postman/environments/Payments API - dev.environment.yaml'
          ]
        })).rejects.toBeInstanceOf(RepoMutationPreCommitError);

        const staged = await execFileAsync('git', ['diff', '--cached', '--name-only'], {
          cwd: fixtureRoot,
          encoding: 'utf8'
        });
        expect(staged.stdout).toBe('');
        await expect(readFile(statePath, 'utf8')).resolves.toBe('version: 3\n');
        await expect(readFile(artifactPath, 'utf8'))
          .resolves.toBe('name: Payments API - dev\n');
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  );

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

  it.skipIf(process.platform === 'win32')(
    'rejects symlinked removal paths outside cwd before invoking git',
    async () => {
      const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'repo-mutation-symlink-'));
      const cwd = path.join(fixtureRoot, 'cwd');
      const outside = path.join(fixtureRoot, 'outside');
      const victim = path.join(outside, 'victim');
      const execute = vi.fn();

      try {
        await mkdir(cwd, { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(victim, 'must remain\n', 'utf8');
        await symlink(outside, path.join(cwd, 'link'));

        const repoMutation = new RepoMutationService({
          cwd,
          repository: 'postman-cs/repo-sync-demo',
          execute
        });

        await expect(
          repoMutation.commitAndPush({
            repoWriteMode: 'commit-only',
            committerName: 'Postman CSE',
            committerEmail: 'help@postman.com',
            stagePaths: ['link/victim'],
            removePaths: ['link/victim']
          })
        ).rejects.toThrow('Unsafe repository mutation path');

        await expect(readFile(victim, 'utf8')).resolves.toBe('must remain\n');
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  );

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
    expect(execute).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['reset'])
    );
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
        'git -c http.https://dev.azure.com/postman/.extraheader= -c http.https://dev.azure.com/postman/CSE/_git/repo-sync-demo.extraheader= fetch --no-tags origin refs/heads/feature/sync-artifacts':
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

  it('creates a branch when the target ref does not exist on the remote', async () => {
    const execute = createExecuteMock(
      createCommandMap({
        'git -c http.https://github.com/.extraheader= fetch --no-tags origin refs/heads/feature/sync-artifacts':
          {
            exitCode: 128,
            stdout: '',
            stderr: "fatal: couldn't find remote ref refs/heads/feature/sync-artifacts\n"
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
      fallbackToken: 'fallback-token',
      committerName: 'Postman',
      committerEmail: 'support@postman.com',
      stagePaths: ['postman', '.postman', '.github/workflows']
    });

    expect(result.pushed).toBe(true);
    expect(execute).not.toHaveBeenCalledWith('git', [
      'rebase',
      'FETCH_HEAD'
    ]);
  });

  it('aborts and fails closed when a generated conflict remains unresolved', async () => {
    const execute = createExecuteMock(
      createCommandMap({
        'git rebase FETCH_HEAD': {
          exitCode: 1,
          stdout: '',
          stderr: 'CONFLICT (content): Merge conflict in postman/collection.yaml\n'
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
        fallbackToken: 'fallback-token',
        committerName: 'Postman',
        committerEmail: 'support@postman.com',
        stagePaths: ['postman', '.postman', '.github/workflows']
      })
    ).rejects.toThrow('REPO_PUSH_RECONCILE_FAILED');

    expect(execute).toHaveBeenCalledWith('git', ['rebase', '--abort']);
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']));
  });

  it('returns without commit when commit-only has no staged changes', async () => {
    const execute = createExecuteMock(
      createCommandMap({
        'git status --porcelain=v1 --untracked-files=all -- postman .postman .github/workflows': {
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
      repoWriteMode: 'commit-only',
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
      resolvedCurrentRef: ''
    });
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['config']));
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['add']));
    expect(execute).not.toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: sync Postman artifacts and metadata'
    ]);
  });

  it('fails token preflight before scoped change detection or git mutation', async () => {
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

    expect(execute).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['config']));
    expect(execute).not.toHaveBeenCalledWith('git', expect.arrayContaining(['add']));
    expect(execute).not.toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      'chore: sync Postman artifacts and metadata'
    ]);
  });

  it('fails ref preflight before scoped change detection or git mutation', async () => {
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

    expect(execute).not.toHaveBeenCalled();
  });

  it('fails provider preflight before scoped change detection or git mutation', async () => {
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

    expect(execute).not.toHaveBeenCalled();
  });

  it('rebases generated changes when the target advances before and during the push', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'repo-mutation-stale-checkout-'));
    const remoteRoot = path.join(fixtureRoot, 'remote.git');
    const checkoutRoot = path.join(fixtureRoot, 'checkout');
    const peerRoot = path.join(fixtureRoot, 'peer');
    try {
      await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remoteRoot]);
      await mkdir(checkoutRoot, { recursive: true });
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: checkoutRoot });
      await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: checkoutRoot });
      await execFileAsync('git', ['config', 'user.email', 'fixture@example.com'], {
        cwd: checkoutRoot
      });
      await writeFile(path.join(checkoutRoot, 'README.md'), 'initial\n', 'utf8');
      await execFileAsync('git', ['add', 'README.md'], { cwd: checkoutRoot });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: checkoutRoot });
      await execFileAsync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: checkoutRoot });
      await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: checkoutRoot });

      await execFileAsync('git', ['clone', remoteRoot, peerRoot]);
      await execFileAsync('git', ['config', 'user.name', 'Peer'], { cwd: peerRoot });
      await execFileAsync('git', ['config', 'user.email', 'peer@example.com'], { cwd: peerRoot });
      await writeFile(path.join(peerRoot, 'peer.txt'), 'remote advance\n', 'utf8');
      await execFileAsync('git', ['add', 'peer.txt'], { cwd: peerRoot });
      await execFileAsync('git', ['commit', '-m', 'peer advance'], { cwd: peerRoot });
      await execFileAsync('git', ['push', 'origin', 'main'], { cwd: peerRoot });

      await mkdir(path.join(checkoutRoot, 'postman'), { recursive: true });
      await writeFile(path.join(checkoutRoot, 'postman', 'collection.yaml'), 'name: demo\n', 'utf8');
      let advanceRemoteBeforeFirstPush = true;
      const execute = async (command: string, args: string[]): Promise<CommandResult> => {
        if (command === 'git' && args.includes('push') && advanceRemoteBeforeFirstPush) {
          advanceRemoteBeforeFirstPush = false;
          await writeFile(path.join(peerRoot, 'late-peer.txt'), 'late remote advance\n', 'utf8');
          await execFileAsync('git', ['add', 'late-peer.txt'], { cwd: peerRoot });
          await execFileAsync('git', ['commit', '-m', 'late peer advance'], { cwd: peerRoot });
          await execFileAsync('git', ['push', 'origin', 'main'], { cwd: peerRoot });
        }
        try {
          const result = await execFileAsync(command, args, { cwd: checkoutRoot, encoding: 'utf8' });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          return {
            exitCode: typeof failure.code === 'number' ? failure.code : 1,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? ''
          };
        }
      };
      const repoMutation = new RepoMutationService({
        cwd: checkoutRoot,
        execute,
        provider: 'azure-devops',
        repoUrl: remoteRoot,
        repository: 'fixture/repository'
      });

      const result = await repoMutation.commitAndPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'main',
        committerName: 'Postman',
        committerEmail: 'support@postman.com',
        stagePaths: ['postman']
      });

      expect(result.pushed).toBe(true);
      const remoteLog = await execFileAsync(
        'git',
        ['--git-dir', remoteRoot, 'log', '--format=%s', 'main'],
        { encoding: 'utf8' }
      );
      expect(remoteLog.stdout).toContain('chore: sync Postman artifacts and metadata');
      expect(remoteLog.stdout).toContain('late peer advance');
      expect(remoteLog.stdout).toContain('peer advance');
      const remoteCollection = await execFileAsync(
        'git',
        ['--git-dir', remoteRoot, 'show', 'main:postman/collection.yaml'],
        { encoding: 'utf8' }
      );
      expect(remoteCollection.stdout).toBe('name: demo\n');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails an unchanged repeat when remote durable state drifts before publication', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'repo-mutation-state-drift-'));
    const remoteRoot = path.join(fixtureRoot, 'remote.git');
    const checkoutRoot = path.join(fixtureRoot, 'checkout');
    const peerRoot = path.join(fixtureRoot, 'peer');
    try {
      await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remoteRoot]);
      await mkdir(path.join(checkoutRoot, '.postman'), { recursive: true });
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: checkoutRoot });
      await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: checkoutRoot });
      await execFileAsync('git', ['config', 'user.email', 'fixture@example.com'], {
        cwd: checkoutRoot
      });
      await writeFile(
        path.join(checkoutRoot, '.postman', 'resources.yaml'),
        'version: 3\nworkspace:\n  id: ws-original\n',
        'utf8'
      );
      await execFileAsync('git', ['add', '.postman/resources.yaml'], { cwd: checkoutRoot });
      await execFileAsync('git', ['commit', '-m', 'initial state'], { cwd: checkoutRoot });
      await execFileAsync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: checkoutRoot });
      await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: checkoutRoot });

      await execFileAsync('git', ['clone', remoteRoot, peerRoot]);
      await execFileAsync('git', ['config', 'user.name', 'Peer'], { cwd: peerRoot });
      await execFileAsync('git', ['config', 'user.email', 'peer@example.com'], { cwd: peerRoot });
      await writeFile(
        path.join(peerRoot, '.postman', 'resources.yaml'),
        'version: 3\nworkspace:\n  id: ws-drifted\n',
        'utf8'
      );
      await execFileAsync('git', ['add', '.postman/resources.yaml'], { cwd: peerRoot });
      await execFileAsync('git', ['commit', '-m', 'drift state'], { cwd: peerRoot });
      await execFileAsync('git', ['push', 'origin', 'main'], { cwd: peerRoot });

      const execute = async (command: string, args: string[]): Promise<CommandResult> => {
        try {
          const result = await execFileAsync(command, args, { cwd: checkoutRoot, encoding: 'utf8' });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          return {
            exitCode: typeof failure.code === 'number' ? failure.code : 1,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? ''
          };
        }
      };
      const repoMutation = new RepoMutationService({
        cwd: checkoutRoot,
        execute,
        provider: 'azure-devops',
        repoUrl: remoteRoot,
        repository: 'fixture/repository'
      });

      await expect(repoMutation.commitAndPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'main',
        committerName: 'Postman',
        committerEmail: 'support@postman.com',
        stagePaths: ['.postman/resources.yaml']
      })).rejects.toThrow(/REPO_PUSH_STATE_DRIFT/);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('preserves provision.yml and the index on push preflight failures, then removes it after valid preflight', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'repo-mutation-preflight-'));
    try {
      await execFileAsync('git', ['init'], { cwd: repoRoot });
      await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: repoRoot });
      await execFileAsync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: repoRoot });
      await mkdir(path.join(repoRoot, 'postman'), { recursive: true });
      await mkdir(path.join(repoRoot, '.github', 'workflows'), { recursive: true });
      await writeFile(path.join(repoRoot, 'postman', 'collection.yaml'), 'name: demo\n', 'utf8');
      const provisionPath = path.join(repoRoot, '.github', 'workflows', 'provision.yml');
      const provisionWorkflow = [
        'name: Provision',
        'on: [push]',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo test',
        ''
      ].join('\n');
      await writeFile(provisionPath, provisionWorkflow, 'utf8');
      await execFileAsync('git', ['add', '.github/workflows/provision.yml'], { cwd: repoRoot });
      await execFileAsync('git', ['commit', '-m', 'test: add provision fixture'], { cwd: repoRoot });
      await execFileAsync('git', ['remote', 'add', 'origin', 'https://dev.azure.com/postman/CSE/_git/repo-sync-demo'], { cwd: repoRoot });
      const execute = async (command: string, args: string[]): Promise<CommandResult> => {
        if (
          command === 'git' &&
          (args.includes('push') || args.includes('fetch') || args[0] === 'rebase')
        ) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        try {
          const result = await execFileAsync(command, args, { cwd: repoRoot, encoding: 'utf8' });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          return {
            exitCode: typeof failure.code === 'number' ? failure.code : 1,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? ''
          };
        }
      };
      const failures = [
        {
          service: new RepoMutationService({ cwd: repoRoot, repository: 'postman-cs/repo-sync-demo', execute }),
          options: { currentRef: 'feature/sync-artifacts' },
          message: /No push token configured/
        },
        {
          service: new RepoMutationService({ cwd: repoRoot, repository: 'postman-cs/repo-sync-demo', execute }),
          options: { currentRef: 'refs/tags/v1.2.3', githubToken: 'token' },
          message: /No current ref could be resolved/
        },
        {
          service: new RepoMutationService({ cwd: repoRoot, provider: 'bitbucket', repository: 'postman-cs/repo-sync-demo', execute }),
          options: { currentRef: 'feature/sync-artifacts', githubToken: 'token' },
          message: /not supported for git provider "bitbucket"/
        }
      ];

      for (const failure of failures) {
        await expect(
          failure.service.commitAndPush({
            repoWriteMode: 'commit-and-push',
            committerName: 'Postman',
            committerEmail: 'support@postman.com',
            stagePaths: ['postman', '.github/workflows/provision.yml'],
            removePaths: ['.github/workflows/provision.yml'],
            ...failure.options
          })
        ).rejects.toThrow(failure.message);

        expect(await readFile(provisionPath, 'utf8')).toBe(provisionWorkflow);
        const staged = await execFileAsync('git', ['diff', '--cached', '--name-only'], {
          cwd: repoRoot,
          encoding: 'utf8'
        });
        expect(staged.stdout).toBe('');
      }

      const validMutation = new RepoMutationService({
        cwd: repoRoot,
        provider: 'azure-devops',
        repository: 'postman-cs/repo-sync-demo',
        repoUrl: 'https://dev.azure.com/postman/CSE/_git/repo-sync-demo',
        execute
      });
      await validMutation.commitAndPush({
        repoWriteMode: 'commit-and-push',
        currentRef: 'feature/sync-artifacts',
        committerName: 'Postman',
        committerEmail: 'support@postman.com',
        stagePaths: ['postman', '.github/workflows/provision.yml'],
        removePaths: ['.github/workflows/provision.yml']
      });

      await expect(readFile(provisionPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const committed = await execFileAsync('git', ['show', '--name-status', '--format='], {
        cwd: repoRoot,
        encoding: 'utf8'
      });
      expect(committed.stdout).toContain('D\t.github/workflows/provision.yml');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
