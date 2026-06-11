import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleReporter, parseCliArgs, runCli, toDotenv } from '../src/cli.js';
import { resolveInputs, runRepoSync } from '../src/index.js';
import { __resetIdentityMemo } from '../src/lib/postman/credential-identity.js';

type RepoSyncResult = Awaited<ReturnType<typeof runRepoSync>>;

function fullRepoSyncOutputs(): RepoSyncResult {
  return {
    'integration-backend': 'bifrost',
    'resolved-current-ref': '',
    'workspace-link-status': 'skipped',
    'environment-sync-status': 'skipped',
    'environment-uids-json': '{}',
    'mock-url': '',
    'monitor-id': '',
    'repo-sync-summary-json': '{}',
    'commit-sha': ''
  } as RepoSyncResult;
}

describe('cli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps flags to INPUT_* env variables', () => {
    const config = parseCliArgs(
      [
        '--project-name',
        'core-payments',
        '--workspace-id=ws-123',
        '--repo-url',
        'https://github.com/postman-cs/repo-sync-demo',
        '--postman-stack',
        'beta',
        '--team-id',
        'team-001',
        '--result-json',
        'outputs/result.json',
        '--dotenv-path=.env.repo-sync'
      ],
      { EXISTING_ENV: 'keep-me' }
    );

    expect(config.inputEnv.EXISTING_ENV).toBe('keep-me');
    expect(config.inputEnv.INPUT_PROJECT_NAME).toBe('core-payments');
    expect(config.inputEnv.INPUT_WORKSPACE_ID).toBe('ws-123');
    expect(config.inputEnv.INPUT_REPO_URL).toBe('https://github.com/postman-cs/repo-sync-demo');
    expect(config.inputEnv.INPUT_POSTMAN_STACK).toBe('beta');
    expect(config.inputEnv.INPUT_TEAM_ID).toBe('team-001');
    expect(config.resultJsonPath).toBe('outputs/result.json');
    expect(config.dotenvPath).toBe('.env.repo-sync');
  });

  it('formats dotenv output with POSTMAN_REPO_SYNC_ prefix', () => {
    const rendered = toDotenv({
      'workspace-link-status': 'success',
      'environment-uids-json': '{"prod":"env-prod"}'
    });

    expect(rendered).toContain('POSTMAN_REPO_SYNC_WORKSPACE_LINK_STATUS="success"');
    expect(rendered).toContain(
      'POSTMAN_REPO_SYNC_ENVIRONMENT_UIDS_JSON="{\\"prod\\":\\"env-prod\\"}"'
    );
  });

  it('writes reporter logs to stderr', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reporter = new ConsoleReporter();

    reporter.info('info message');
    reporter.warning('warn message');

    expect(errorSpy).toHaveBeenCalledWith('info message');
    expect(errorSpy).toHaveBeenCalledWith('warning: warn message');
  });

  it('resolves non-GitHub branch and repository from CI context', () => {
    const config = parseCliArgs([], {
      BITBUCKET_BRANCH: 'feature/non-github-ref',
      BITBUCKET_WORKSPACE: 'acme',
      BITBUCKET_REPO_SLUG: 'payments-api'
    });

    const inputs = resolveInputs(config.inputEnv);

    expect(inputs.currentRef).toBe('');
    expect(inputs.githubHeadRef).toBe('');
    expect(inputs.githubRefName).toBe('feature/non-github-ref');
    expect(inputs.repository).toBe('acme/payments-api');
  });

  it('selects beta endpoints from postman-stack', () => {
    const inputs = resolveInputs({
      INPUT_POSTMAN_STACK: 'beta',
      INPUT_POSTMAN_API_BASE: 'https://override.example.com',
      INPUT_POSTMAN_BIFROST_BASE: 'https://override.example.com',
      INPUT_POSTMAN_CLI_INSTALL_URL: 'https://override.example.com/install.sh'
    });

    expect(inputs.postmanStack).toBe('beta');
    expect(inputs.postmanApiBase).toBe('https://api.getpostman-beta.com');
    expect(inputs.postmanBifrostBase).toBe('https://bifrost-https-v4.gw.postman-beta.com');
    expect(inputs.postmanCliInstallUrl).toBe('https://dl-cli.pstmn-beta.io/install/unix.sh');
    expect(() => resolveInputs({ INPUT_POSTMAN_STACK: 'stage' })).toThrow(/Unsupported postman-stack/);
  });
});

describe('runCli credential preflight seam', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetIdentityMemo();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'pm-repo-sync-preflight-'));
    tempDirs.push(dir);
    const previous = process.cwd();
    process.chdir(dir);
    try {
      return await fn();
    } finally {
      process.chdir(previous);
    }
  }

  function stubIdentityFetch(pmakTeam: number, sessionTeam: number): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return new Response(
          JSON.stringify({
            user: { id: 'u-pmak', fullName: 'PMAK User', teamId: pmakTeam, teamName: 'Alpha' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/api/sessions/current')) {
        return new Response(
          JSON.stringify({
            identity: { team: sessionTeam, domain: 'beta' },
            data: { user: { id: 'u-sess' } }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch in preflight seam test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('fails closed before repo sync when enforce sees a cross-org team mismatch', async () => {
    const fetchMock = stubIdentityFetch(111, 222);
    const executeRepoSync = vi.fn();

    await expect(
      runCli(
        [
          '--project-name', 'preflight-demo',
          '--postman-api-key', 'pmak-xyz',
          '--postman-access-token', 'tok-xyz',
          '--credential-preflight', 'enforce'
        ],
        { env: {}, executeRepoSync }
      )
    ).rejects.toThrow(/credential preflight FAILED/);

    expect(executeRepoSync).not.toHaveBeenCalled();
    const probed = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(probed.some((url) => url.includes('/api/sessions/current'))).toBe(true);
  });

  it('names both team ids in the enforce mismatch verdict', async () => {
    stubIdentityFetch(111, 222);
    let captured = '';
    try {
      await runCli(
        [
          '--project-name', 'preflight-demo',
          '--postman-api-key', 'pmak-xyz',
          '--postman-access-token', 'tok-xyz',
          '--credential-preflight', 'enforce'
        ],
        { env: {}, executeRepoSync: vi.fn() }
      );
    } catch (error) {
      captured = error instanceof Error ? error.message : String(error);
    }
    expect(captured).toContain('111');
    expect(captured).toContain('222');
  });

  it('logs both identity lines and proceeds to repo sync when teams match under warn', async () => {
    stubIdentityFetch(333, 333);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const executeRepoSync = vi.fn(async () => fullRepoSyncOutputs());

    await withTempCwd(async () => {
      await runCli(
        [
          '--project-name', 'preflight-ok',
          '--postman-api-key', 'pmak-ok',
          '--postman-access-token', 'tok-ok',
          '--credential-preflight', 'warn'
        ],
        { env: {}, executeRepoSync, writeStdout: () => undefined }
      );
    });

    expect(executeRepoSync).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('postman: PMAK identity - ');
    expect(logged).toContain('postman: access-token session identity - ');
  });

  it('skips the preflight entirely when credential-preflight is off', async () => {
    const fetchMock = stubIdentityFetch(111, 222);
    const executeRepoSync = vi.fn(async () => fullRepoSyncOutputs());

    await withTempCwd(async () => {
      await runCli(
        [
          '--project-name', 'preflight-off',
          '--postman-api-key', 'pmak-xyz',
          '--postman-access-token', 'tok-xyz',
          '--credential-preflight', 'off'
        ],
        { env: {}, executeRepoSync, writeStdout: () => undefined }
      );
    });

    expect(executeRepoSync).toHaveBeenCalledTimes(1);
    const probed = fetchMock.mock.calls.map((call) => String(call[0]));
    // off short-circuits the cross-check; no session probe runs. The resolve
    // path may still call GET /me to derive the team id.
    expect(probed.some((url) => url.includes('/api/sessions/current'))).toBe(false);
  });
});
