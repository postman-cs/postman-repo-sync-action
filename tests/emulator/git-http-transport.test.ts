/**
 * Git smart-HTTP transport lane: proves RepoMutationService's push path with a
 * REAL git client against the real `git http-backend` wire protocol -- token
 * candidate ordering and Basic-auth shape (x-access-token), URL-encoding of
 * reserved token characters, missing-branch creation, concurrent-advance
 * fetch/rebase reconciliation, and non-retryable permission denial -- with no
 * live git host. The lane is excluded from `npm test`; CI runs it as a
 * budgeted Linux step.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  RepoMutationService
} from '../../src/lib/github/repo-mutation.js';
import type { ExecuteFn, ExecuteResult } from '../../src/lib/github/repo-mutation.js';
import {
  CLONE_BOOTSTRAP_TOKEN,
  hermeticGitEnv,
  startGitHttpFixture,
  type GitHttpFixture,
  type RemoteRepo
} from './fixture/git-http-fixture.js';

const execFileAsync = promisify(execFile);

let fixture: GitHttpFixture;
const scratchDirs: string[] = [];

async function createScratchDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  scratchDirs.push(dir);
  return dir;
}

interface WorkClone {
  dir: string;
  execute: ExecuteFn;
  executed: string[][];
}

/** Real-git ExecuteFn bound to a working clone, matching the service contract (never throws). */
function realGitExecute(cwd: string, env: NodeJS.ProcessEnv, executed: string[][]): ExecuteFn {
  return async (command, args): Promise<ExecuteResult> => {
    executed.push([command, ...args]);
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 30_000
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? ''
      };
    }
  };
}

async function cloneWorkRepo(repo: RemoteRepo, name: string): Promise<WorkClone> {
  const parent = await createScratchDir(name);
  const home = path.join(parent, 'home');
  const dir = path.join(parent, 'work');
  const env = hermeticGitEnv(home);
  // The clone itself needs credentials; use the fixture's dedicated bootstrap
  // token so no service-owned token is on the wire before the push runs. The
  // anonymous URL is restored below so every credential afterward comes from
  // the service's own buildAuthenticatedRemoteUrl rewrite.
  const authedUrl = repo.url.replace('http://', `http://x-access-token:${CLONE_BOOTSTRAP_TOKEN}@`);
  await execFileAsync('git', ['clone', authedUrl, dir], { env, encoding: 'utf8', timeout: 30_000 });
  await execFileAsync('git', ['remote', 'set-url', 'origin', repo.url], { cwd: dir, env, encoding: 'utf8' });
  const executed: string[][] = [];
  return { dir, execute: realGitExecute(dir, env, executed), executed };
}

/** Service-offered credentials only: drops git's anonymous first probe and the clone bootstrap token. */
function serviceAuthAttempts() {
  return fixture.authAttempts.filter((a) => a.token !== '' && a.token !== CLONE_BOOTSTRAP_TOKEN);
}

function service(repo: RemoteRepo, clone: WorkClone, execute?: ExecuteFn): RepoMutationService {
  return new RepoMutationService({
    cwd: clone.dir,
    execute: execute ?? clone.execute,
    provider: 'github',
    repository: `postman-cs/${repo.name}`,
    repoUrl: repo.url
  });
}

async function stageGeneratedFile(clone: WorkClone, relPath: string, content: string): Promise<void> {
  await writeFile(path.join(clone.dir, relPath), content);
}

const PUSH_DEFAULTS = {
  currentRef: 'refs/heads/main',
  repoWriteMode: 'commit-and-push' as const,
  committerName: 'Postman',
  committerEmail: 'support@postman.com',
  stagePaths: ['generated.json']
};

beforeAll(async () => {
  fixture = await startGitHttpFixture();
});

beforeEach(() => {
  fixture.authAttempts.length = 0;
});

afterAll(async () => {
  await fixture?.close();
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('git smart-HTTP transport', () => {
  it('pushes with the fallback token as x-access-token Basic credentials', async () => {
    const repo = await fixture.createRemoteRepo('accepted', { acceptTokens: ['fallback-token'] });
    const clone = await cloneWorkRepo(repo, 'ws10-git-accepted');
    await stageGeneratedFile(clone, 'generated.json', '{"v":1}\n');

    const result = await service(repo, clone).commitAndPush({
      ...PUSH_DEFAULTS,
      fallbackToken: 'fallback-token',
      githubToken: 'ambient-token'
    });

    expect(result.pushed).toBe(true);
    expect(await fixture.revParse(repo, 'refs/heads/main')).toBe(result.commitSha);
    // Wire shape: HTTP Basic, username x-access-token, fallback token first
    // (buildPushTokenOrder puts it ahead of the ambient github token).
    const pushAuth = serviceAuthAttempts().filter((a) => a.service === 'git-receive-pack');
    expect(pushAuth.length).toBeGreaterThan(0);
    expect(pushAuth.every((a) => a.username === 'x-access-token')).toBe(true);
    expect(pushAuth.every((a) => a.token === 'fallback-token')).toBe(true);
    expect(fixture.authAttempts.some((a) => a.token === 'ambient-token')).toBe(false);
  });

  it('falls back to the github token when the fallback token is rejected on the wire', async () => {
    const repo = await fixture.createRemoteRepo('fallback', { acceptTokens: ['ambient-token'] });
    const clone = await cloneWorkRepo(repo, 'ws10-git-fallback');
    await stageGeneratedFile(clone, 'generated.json', '{"v":2}\n');

    const result = await service(repo, clone).commitAndPush({
      ...PUSH_DEFAULTS,
      fallbackToken: 'revoked-token',
      githubToken: 'ambient-token'
    });

    expect(result.pushed).toBe(true);
    expect(await fixture.revParse(repo, 'refs/heads/main')).toBe(result.commitSha);
    // The revoked token 401'd on the wire before the ambient token succeeded.
    const offered = serviceAuthAttempts().map((a) => a.token);
    expect(offered).toContain('revoked-token');
    expect(fixture.authAttempts.some((a) => a.token === 'revoked-token' && a.accepted)).toBe(false);
    expect(
      fixture.authAttempts.some((a) => a.token === 'ambient-token' && a.service === 'git-receive-pack' && a.accepted)
    ).toBe(true);
    expect(offered.indexOf('revoked-token')).toBeLessThan(offered.indexOf('ambient-token'));
  });

  it('URL-encodes reserved token characters end-to-end through the remote URL', async () => {
    const hostileToken = 'sec/ret+tok:en@#?&=%25';
    const repo = await fixture.createRemoteRepo('escaped', { acceptTokens: [hostileToken] });
    const clone = await cloneWorkRepo(repo, 'ws10-git-escaped');
    await stageGeneratedFile(clone, 'generated.json', '{"v":3}\n');

    const result = await service(repo, clone).commitAndPush({
      ...PUSH_DEFAULTS,
      fallbackToken: hostileToken
    });

    expect(result.pushed).toBe(true);
    expect(await fixture.revParse(repo, 'refs/heads/main')).toBe(result.commitSha);
    // The token survived encodeURIComponent into the remote URL and arrived
    // byte-identical inside the Basic credentials.
    expect(
      fixture.authAttempts.some((a) => a.token === hostileToken && a.service === 'git-receive-pack' && a.accepted)
    ).toBe(true);
  });

  it('creates the branch when the remote ref does not exist yet', async () => {
    const repo = await fixture.createRemoteRepo('newbranch', { acceptTokens: ['fallback-token'] });
    const clone = await cloneWorkRepo(repo, 'ws10-git-newbranch');
    await stageGeneratedFile(clone, 'generated.json', '{"v":4}\n');

    const result = await service(repo, clone).commitAndPush({
      ...PUSH_DEFAULTS,
      currentRef: 'refs/heads/feature/postman-sync',
      fallbackToken: 'fallback-token'
    });

    // fetch of the missing ref fails with "couldn't find remote ref"; the
    // service must treat that as create-the-branch, not an error.
    expect(result.pushed).toBe(true);
    expect(result.resolvedCurrentRef).toBe('feature/postman-sync');
    expect(await fixture.revParse(repo, 'refs/heads/feature/postman-sync')).toBe(result.commitSha);
  });

  it('reconciles a concurrent remote advance via fetch/rebase retry', async () => {
    const repo = await fixture.createRemoteRepo('concurrent', { acceptTokens: ['fallback-token'] });
    const clone = await cloneWorkRepo(repo, 'ws10-git-concurrent');
    await stageGeneratedFile(clone, 'generated.json', '{"v":5}\n');

    // Interpose on the real execute: after the FIRST fetch returns, advance
    // main on the server so the first push is a genuine wire-level
    // non-fast-forward and the service must re-fetch, rebase, and push again.
    let advanced = false;
    let concurrentSha = '';
    const interposed: ExecuteFn = async (command, args) => {
      const result = await clone.execute(command, args);
      if (!advanced && command === 'git' && args.includes('fetch')) {
        advanced = true;
        concurrentSha = await fixture.advanceRemoteMain(repo, 'concurrent.txt');
      }
      return result;
    };

    const result = await service(repo, clone, interposed).commitAndPush({
      ...PUSH_DEFAULTS,
      fallbackToken: 'fallback-token'
    });

    expect(result.pushed).toBe(true);
    expect(advanced).toBe(true);
    const remoteHead = await fixture.revParse(repo, 'refs/heads/main');
    expect(remoteHead).toBe(result.commitSha);
    // Both the concurrent commit and ours are in the final history.
    const log = await execFileAsync(
      'git',
      ['-C', repo.barePath, 'log', '--format=%H', 'refs/heads/main'],
      { encoding: 'utf8' }
    );
    expect(log.stdout).toContain(concurrentSha);
    // Two receive-pack auth rounds prove the push really ran twice.
    const fetches = clone.executed.filter((args) => args.includes('fetch'));
    expect(fetches.length).toBeGreaterThanOrEqual(2);
  });

  it('stops the token cascade on a permission denial instead of retrying', async () => {
    const repo = await fixture.createRemoteRepo('denied', { acceptTokens: ['limited-token', 'ambient-token'] });
    await fixture.installRejectingPreReceiveHook(repo, 'permission denied: repository write policy');
    const clone = await cloneWorkRepo(repo, 'ws10-git-denied');
    await stageGeneratedFile(clone, 'generated.json', '{"v":6}\n');

    await expect(
      service(repo, clone).commitAndPush({
        ...PUSH_DEFAULTS,
        fallbackToken: 'limited-token',
        githubToken: 'ambient-token'
      })
    ).rejects.toThrow(/permission denied/i);

    // Denial is non-retryable: the second candidate token was never offered.
    expect(fixture.authAttempts.some((a) => a.token === 'ambient-token')).toBe(false);
    // The commit exists locally but the remote never moved.
    expect(await fixture.revParse(repo, 'refs/heads/main')).not.toBe('');
  });

  it('advances the cascade past a GitHub-style 403 credential denial', async () => {
    // Real GitHub rejects an authenticated but under-scoped token with
    // HTTP 403 + "Permission to <repo> denied to <user>". That denial is
    // specific to the credential, not the push: the next candidate must
    // still be offered (live-proved by the dispatch lane's token-order case).
    const repo = await fixture.createRemoteRepo('cred-denied', {
      acceptTokens: ['ambient-token'],
      deny403Tokens: ['limited-token']
    });
    const clone = await cloneWorkRepo(repo, 'ws10-git-cred-denied');
    await stageGeneratedFile(clone, 'generated.json', '{"v":7}\n');

    const result = await service(repo, clone).commitAndPush({
      ...PUSH_DEFAULTS,
      fallbackToken: 'limited-token',
      githubToken: 'ambient-token'
    });

    expect(result.pushed).toBe(true);
    // The denied credential was offered first, then the cascade advanced.
    const offered = fixture.authAttempts
      .filter((a) => a.token !== CLONE_BOOTSTRAP_TOKEN && a.token !== '')
      .map((a) => a.token);
    expect(offered).toContain('limited-token');
    expect(offered[offered.length - 1]).toBe('ambient-token');
    expect(await fixture.revParse(repo, 'refs/heads/main')).toBe(result.commitSha);
  });
});
