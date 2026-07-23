import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleReporter, parseCliArgs, runCli, toDotenv, writeOptionalFileAtomic } from '../src/cli.js';
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

  it('resolves credentials from flags, action inputs, then plain environment variables', () => {
    const plain = resolveInputs({
      POSTMAN_API_KEY: 'plain-api-key',
      POSTMAN_ACCESS_TOKEN: 'plain-access-token'
    });
    expect(plain.postmanApiKey).toBe('plain-api-key');
    expect(plain.postmanAccessToken).toBe('plain-access-token');

    const actionInput = resolveInputs({
      INPUT_POSTMAN_API_KEY: 'input-api-key',
      INPUT_POSTMAN_ACCESS_TOKEN: 'input-access-token',
      POSTMAN_API_KEY: 'plain-api-key',
      POSTMAN_ACCESS_TOKEN: 'plain-access-token'
    });
    expect(actionInput.postmanApiKey).toBe('input-api-key');
    expect(actionInput.postmanAccessToken).toBe('input-access-token');

    const cli = parseCliArgs(
      [
        '--postman-api-key',
        'flag-api-key',
        '--postman-access-token',
        'flag-access-token'
      ],
      {
        INPUT_POSTMAN_API_KEY: 'input-api-key',
        INPUT_POSTMAN_ACCESS_TOKEN: 'input-access-token',
        POSTMAN_API_KEY: 'plain-api-key',
        POSTMAN_ACCESS_TOKEN: 'plain-access-token'
      }
    );
    expect(resolveInputs(cli.inputEnv).postmanApiKey).toBe('flag-api-key');
    expect(resolveInputs(cli.inputEnv).postmanAccessToken).toBe('flag-access-token');
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

  it('selects EU public API endpoints from postman-region', () => {
    const inputs = resolveInputs({ INPUT_POSTMAN_REGION: 'eu' });

    expect(inputs.postmanRegion).toBe('eu');
    expect(inputs.postmanApiBase).toBe('https://api.eu.postman.com');
    expect(() => resolveInputs({ INPUT_POSTMAN_REGION: 'ap' })).toThrow(/Unsupported postman-region/);
    expect(() => resolveInputs({ INPUT_POSTMAN_REGION: 'eu', INPUT_POSTMAN_STACK: 'beta' })).toThrow(/postman-region=eu/);
  });

  it.each([
    ['none', 'none'],
    ['commit-only', 'commit-only'],
    ['commit-and-push', 'commit-and-push']
  ] as const)('accepts repo-write-mode=%s from CLI flag and normalized INPUT', (mode, expected) => {
    expect(parseCliArgs(['--repo-write-mode', mode], {}).inputEnv.INPUT_REPO_WRITE_MODE).toBe(mode);
    expect(resolveInputs({ INPUT_REPO_WRITE_MODE: mode }).repoWriteMode).toBe(expected);
  });

  it('defaults absent repo-write-mode to commit-and-push', () => {
    expect(resolveInputs({}).repoWriteMode).toBe('commit-and-push');
  });

  it('rejects unsupported present repo-write-mode values', () => {
    expect(() => resolveInputs({ INPUT_REPO_WRITE_MODE: 'push-please' })).toThrow(
      /Unsupported repo-write-mode "push-please".*none, commit-only, commit-and-push/
    );
    expect(() => resolveInputs({ 'INPUT_REPO-WRITE-MODE': 'typo' } as NodeJS.ProcessEnv)).toThrow(
      /Unsupported repo-write-mode "typo"/
    );
    expect(() => resolveInputs({ INPUT_REPO_WRITE_MODE: '' })).toThrow(
      /Unsupported repo-write-mode ""/
    );
  });

  it('reads runner-form INPUT_REPO-WRITE-MODE when normalized form is absent', () => {
    const inputs = resolveInputs({ 'INPUT_REPO-WRITE-MODE': 'none' } as NodeJS.ProcessEnv);
    expect(inputs.repoWriteMode).toBe('none');
  });

  it('rejects conflicting runner-form and normalized INPUT aliases', () => {
    expect(() =>
      resolveInputs({
        INPUT_REPO_WRITE_MODE: 'none',
        'INPUT_REPO-WRITE-MODE': 'commit-and-push'
      } as NodeJS.ProcessEnv)
    ).toThrow(/Conflicting values for repo-write-mode/);
  });

  it('allows matching runner-form and normalized INPUT aliases', () => {
    const inputs = resolveInputs({
      INPUT_REPO_WRITE_MODE: 'commit-only',
      'INPUT_REPO-WRITE-MODE': 'commit-only'
    } as NodeJS.ProcessEnv);
    expect(inputs.repoWriteMode).toBe('commit-only');
  });

  it('ignores an empty runner-form INPUT alias when the normalized alias has a value', () => {
    const inputs = resolveInputs({
      INPUT_INTEGRATION_BACKEND: 'bifrost',
      'INPUT_INTEGRATION-BACKEND': ''
    } as NodeJS.ProcessEnv);
    expect(inputs.integrationBackend).toBe('bifrost');
  });

  it('ignores an empty normalized INPUT alias when the runner-form alias has a value', () => {
    const inputs = resolveInputs({
      INPUT_INTEGRATION_BACKEND: '',
      'INPUT_INTEGRATION-BACKEND': 'bifrost'
    } as NodeJS.ProcessEnv);
    expect(inputs.integrationBackend).toBe('bifrost');
  });

  it('rejects unknown flags, missing values, and unexpected positionals', () => {
    expect(() => parseCliArgs(['--not-a-real-flag', 'x'], {})).toThrow(/Unknown option --not-a-real-flag/);
    expect(() => parseCliArgs(['--repo-write-mode'], {})).toThrow(/Missing value for --repo-write-mode/);
    expect(() => parseCliArgs(['--repo-write-mode', '--project-name', 'demo'], {})).toThrow(
      /Missing value for --repo-write-mode/
    );
    expect(() => parseCliArgs(['--repo-write-mode='], {})).toThrow(/Missing value for --repo-write-mode/);
    expect(() => parseCliArgs(['positional-arg'], {})).toThrow(/Unexpected positional argument/);
  });

  it('rejects conflicting repeated CLI flags while allowing identical repeats', () => {
    expect(() =>
      parseCliArgs(['--repo-write-mode=none', '--repo-write-mode', 'commit-only'], {})
    ).toThrow(/Conflicting values for --repo-write-mode/);
    expect(
      parseCliArgs(['--repo-write-mode=none', '--repo-write-mode', 'none'], {}).inputEnv
        .INPUT_REPO_WRITE_MODE
    ).toBe('none');
  });

  it('gives an explicit CLI flag precedence over both INPUT aliases', () => {
    const config = parseCliArgs(['--repo-write-mode', 'none'], {
      INPUT_REPO_WRITE_MODE: 'commit-and-push',
      'INPUT_REPO-WRITE-MODE': 'commit-only'
    } as NodeJS.ProcessEnv);

    expect(resolveInputs(config.inputEnv).repoWriteMode).toBe('none');
  });

  it('rejects conflicting help and version commands', () => {
    expect(() => parseCliArgs(['--help', '--version'], {})).toThrow(
      /Cannot use --help and --version together/
    );
  });

  it('lets CLI flags override env by writing the normalized INPUT key', () => {
    const config = parseCliArgs(['--repo-write-mode', 'none'], {
      INPUT_REPO_WRITE_MODE: 'commit-and-push'
    });
    expect(config.inputEnv.INPUT_REPO_WRITE_MODE).toBe('none');
    expect(resolveInputs(config.inputEnv).repoWriteMode).toBe('none');
  });
});

describe('runCli help and version', () => {
  it('prints help without credentials, network, or repo sync', async () => {
    const executeRepoSync = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let stdout = '';

    await runCli(['--help', '--repo-write-mode', 'commit-and-push'], {
      env: {},
      executeRepoSync,
      writeStdout: (chunk) => {
        stdout += chunk;
      }
    });

    expect(stdout).toMatch(/Usage:\s+postman-repo-sync/i);
    expect(executeRepoSync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('prints version without credentials, network, or repo sync', async () => {
    const executeRepoSync = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let stdout = '';
    const packageJson = JSON.parse(
      await (await import('node:fs/promises')).readFile(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
        'utf8'
      )
    ) as { version: string };

    await runCli(['--version'], {
      env: { INPUT_POSTMAN_API_KEY: 'should-not-matter' },
      executeRepoSync,
      writeStdout: (chunk) => {
        stdout += chunk;
      }
    });

    expect(stdout.trim()).toBe(packageJson.version);
    expect(executeRepoSync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
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
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

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
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
      /\[repo-sync timing\] \{"stage":"credential preflight","ms":\d+(?:\.\d+)?,"status":"error"\}/
    );
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
    expect(logged).toMatch(/\[repo-sync timing\] \{"stage":"access-token mint","ms":\d+(?:\.\d+)?,"status":"success"\}/);
    expect(logged).toMatch(/\[repo-sync timing\] \{"stage":"credential preflight","ms":\d+(?:\.\d+)?,"status":"success"\}/);
    expect(logged).toMatch(/\[repo-sync timing\] \{"stage":"API-key\/team resolution","ms":\d+(?:\.\d+)?,"status":"success"\}/);
    expect(logged).toMatch(/\[repo-sync timing\] \{"stage":"runRepoSync finalize","ms":\d+(?:\.\d+)?,"status":"success"\}/);
  });

  it('persists partial ownership outputs when a later repo-sync step fails', async () => {
    stubIdentityFetch(333, 333);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await withTempCwd(async () => {
      const executeRepoSync: typeof runRepoSync = async (_inputs, dependencies) => {
        dependencies.core.setOutput('mock-url', 'https://owned.mock.pstmn.io');
        dependencies.core.setOutput('monitor-id', 'owned-monitor');
        throw new Error('late finalize failure');
      };

      await expect(
        runCli(
          [
            '--project-name', 'partial-ownership',
            '--postman-api-key', 'pmak-ok',
            '--postman-access-token', 'tok-ok',
            '--credential-preflight', 'warn',
            '--result-json', 'partial-result.json'
          ],
          { env: {}, executeRepoSync, writeStdout: () => undefined }
        )
      ).rejects.toThrow('late finalize failure');

      const receipt = JSON.parse(
        await (await import('node:fs/promises')).readFile('partial-result.json', 'utf8')
      ) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        'mock-url': 'https://owned.mock.pstmn.io',
        'monitor-id': 'owned-monitor'
      });
    });
  });

  it('rejects credential-preflight=off instead of skipping identity checks', async () => {
    const executeRepoSync = vi.fn(async () => fullRepoSyncOutputs());

    await expect(
      withTempCwd(async () => {
        await runCli(
          [
            '--project-name', 'preflight-off',
            '--postman-api-key', 'pmak-xyz',
            '--postman-access-token', 'tok-xyz',
            '--credential-preflight', 'off'
          ],
          { env: {}, executeRepoSync, writeStdout: () => undefined }
        );
      })
    ).rejects.toThrow(/Unsupported credential-preflight/);

    expect(executeRepoSync).not.toHaveBeenCalled();
  });
});

describe('CLI partial result output containment', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    __resetIdentityMemo();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function withTempCwd<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'pm-repo-sync-output-'));
    tempDirs.push(dir);
    const previous = process.cwd();
    process.chdir(dir);
    try { return await fn(dir); } finally { process.chdir(previous); }
  }

  function baseArgs(resultJson: string): string[] {
    return [
      '--project-name', 'result-boundary',
      '--postman-api-key', 'pmak-ok',
      '--postman-access-token', 'tok-ok',
      '--credential-preflight', 'warn',
      '--repo-write-mode', 'commit-only',
      '--result-json', resultJson
    ];
  }

  function stubMatchingIdentity(): void {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-pmak', teamId: 333 } }), { status: 200 });
      }
      if (url.includes('/api/sessions/current')) {
        return new Response(JSON.stringify({ identity: { team: 333 }, data: { user: { id: 'u-sess' } } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
  }

  it('rejects a result nested under the artifact root before execution and writes no file', async () => {
    await withTempCwd(async (dir) => {
      const executeRepoSync = vi.fn(async () => fullRepoSyncOutputs());
      await expect(runCli(baseArgs('postman/results/result.json'), {
        env: {}, executeRepoSync, writeStdout: () => undefined
      })).rejects.toThrow(/must not overlap a generated or staged repository path/);
      expect(executeRepoSync).not.toHaveBeenCalled();
      await expect(readFile(path.join(dir, 'postman/results/result.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('rejects a symlink alias into the staged artifact root', async () => {
    await withTempCwd(async (dir) => {
      await mkdir(path.join(dir, 'postman'), { recursive: true });
      await symlink(path.join(dir, 'postman'), path.join(dir, 'artifact-alias'));
      const executeRepoSync = vi.fn(async () => fullRepoSyncOutputs());
      await expect(runCli(baseArgs('artifact-alias/result.json'), {
        env: {}, executeRepoSync, writeStdout: () => undefined
      })).rejects.toThrow(/must not overlap a generated or staged repository path/);
      expect(executeRepoSync).not.toHaveBeenCalled();
    });
  });

  it.each([
    '.postman/result.json',
    '.github/workflows/ci.yml',
    '.github/workflows/postman-preview-gc.yml'
  ])('rejects generated or staged result path %s', async (resultJson) => {
    await withTempCwd(async () => {
      const executeRepoSync = vi.fn(async () => fullRepoSyncOutputs());
      await expect(runCli(baseArgs(resultJson), {
        env: {}, executeRepoSync, writeStdout: () => undefined
      })).rejects.toThrow(/must not overlap a generated or staged repository path/);
      expect(executeRepoSync).not.toHaveBeenCalled();
    });
  });

  it('allows a path-component sibling beside the artifact root', async () => {
    stubMatchingIdentity();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await withTempCwd(async (dir) => {
      const executeRepoSync = vi.fn(async () => fullRepoSyncOutputs());
      await runCli(baseArgs('postman-results/result.json'), {
        env: {}, executeRepoSync, writeStdout: () => undefined
      });
      expect(executeRepoSync).toHaveBeenCalledTimes(1);
      await expect(readFile(path.join(dir, 'postman-results/result.json'), 'utf8')).resolves.toContain('repo-sync-summary-json');
    });
  });

  it('rejects a parent-directory symlink before writing partial output', async () => {
    await withTempCwd(async (dir) => {
      const outside = await mkdtemp(path.join(tmpdir(), 'pm-repo-sync-outside-'));
      tempDirs.push(outside);
      await symlink(outside, path.join(dir, 'escape'));
      expect(() => writeOptionalFileAtomic('escape/result.json', '{}')).toThrow(/stay within workspace/);
      await expect(readFile(path.join(outside, 'result.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('rejects a preexisting outside result-file symlink without changing its target', async () => {
    await withTempCwd(async (dir) => {
      const outside = await mkdtemp(path.join(tmpdir(), 'pm-repo-sync-outside-'));
      tempDirs.push(outside);
      const target = path.join(outside, 'target.json');
      await writeFile(target, 'unchanged', 'utf8');
      await symlink(target, path.join(dir, 'result.json'));
      expect(() => writeOptionalFileAtomic('result.json', 'overwritten')).toThrow(/stay within workspace/);
      await expect(readFile(target, 'utf8')).resolves.toBe('unchanged');
    });
  });

  it('does not follow the former predictable temporary-file symlink', async () => {
    await withTempCwd(async (dir) => {
      const outside = await mkdtemp(path.join(tmpdir(), 'pm-repo-sync-outside-'));
      tempDirs.push(outside);
      const target = path.join(outside, 'target.json');
      await writeFile(target, 'unchanged', 'utf8');
      await symlink(target, path.join(dir, `.result.json.${process.pid}.tmp`));

      writeOptionalFileAtomic('result.json', '{"mock-url":"owned"}');

      await expect(readFile(target, 'utf8')).resolves.toBe('unchanged');
      await expect(readFile(path.join(dir, 'result.json'), 'utf8')).resolves.toBe(
        '{"mock-url":"owned"}'
      );
    });
  });

  it('leaves normal in-workspace partial output atomic and readable after a later failure', async () => {
    await withTempCwd(async (dir) => {
      await mkdir(path.join(dir, 'results'), { recursive: true });
      writeOptionalFileAtomic('results/result.json', '{"mock-url":"partial"}');
      await expect(readFile(path.join(dir, 'results/result.json'), 'utf8')).resolves.toBe('{"mock-url":"partial"}');
      expect(() => writeOptionalFileAtomic('../outside.json', 'escape')).toThrow(/stay within workspace/);
      await expect(readFile(path.join(dir, 'results/result.json'), 'utf8')).resolves.toBe('{"mock-url":"partial"}');
    });
  });
});
