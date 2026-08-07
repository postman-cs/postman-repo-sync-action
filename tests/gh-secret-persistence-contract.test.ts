/**
 * WS10 fake-`gh` contract tests for repo-sync secret persistence.
 *
 * Proves the argv/stdin/GH_TOKEN/env-allowList contract for both persistence
 * sites (SSL certificates and POSTMAN_API_KEY) by capturing the exact
 * (commandLine, args, input, env) the production code hands to
 * @actions/exec.getExecOutput. The buildGhCliEnv allowList is unit-tested
 * directly so every key is pinned. No real GitHub, no real gh, no network.
 *
 * The @actions/exec subprocess wiring (input→stdin, env→child process env)
 * is proven separately by an inline node test that spawns the fake gh binary
 * (tests/fixtures/fake-gh.cjs); this file focuses on the production code's
 * contract construction.
 */

// Hoisted adapter mock must sit at the top of the module (before any import that
// pulls in src/index.js) so createApiKey mints deterministically without network.
const { ADAPTER_MODULE, createAdapterMockModule } = vi.hoisted(() => {
  const ADAPTER_MODULE = '../src/lib/postman/internal-integration-adapter.js';
  function createAdapterMockModule() {
    return {
      createInternalIntegrationAdapter: vi.fn(() => ({
        createApiKey: vi.fn().mockResolvedValue('pmak-generated-from-mock'),
        associateSystemEnvironments: vi.fn().mockResolvedValue(undefined),
        connectWorkspaceToRepository: vi.fn().mockResolvedValue(undefined),
        findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' })
      }))
    };
  }
  return { ADAPTER_MODULE, createAdapterMockModule };
});

vi.mock(ADAPTER_MODULE, createAdapterMockModule);

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedInputs } from '../src/index.js';
import type { ExecLike } from '../src/index.js';

type IndexModule = typeof import('../src/index.js');

// The exact allowList buildGhCliEnv must enforce. Pinned here so any accidental
// addition/removal is caught. GH_TOKEN is injected separately from the token arg.
const GH_CLI_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'GH_CONFIG_DIR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'RUNNER_TEMP',
  'SYSTEMROOT'
] as const;

interface CapturedCall {
  commandLine: string;
  args: string[];
  input: string;
  env: Record<string, string>;
  exitCode: number;
}

function createCapturingExec(
  calls: CapturedCall[],
  exitCode = 0,
  stderr = ''
): ExecLike {
  return {
    getExecOutput: vi.fn(async (commandLine: string, args?: string[], options?: Record<string, unknown>) => {
      const input = options?.input;
      const env = (options?.env as Record<string, string> | undefined) ?? {};
      calls.push({
        commandLine,
        args: args ?? [],
        input: Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? ''),
        env,
        exitCode
      });
      return { exitCode, stdout: '', stderr };
    })
  };
}

function baseInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    projectName: 'core-payments',
    workspaceId: 'ws-123',
    baselineCollectionId: 'col-baseline',
    smokeCollectionId: 'col-smoke',
    contractCollectionId: 'col-contract',
    onboardingScope: 'full',
    prebuiltCollectionsJson: '',
    collectionSyncMode: 'refresh',
    specSyncMode: 'update',
    environments: ['prod'],
    repoUrl: 'https://github.com/acme/payments',
    integrationBackend: 'bifrost',
    workspaceLinkEnabled: true,
    environmentSyncEnabled: true,
    systemEnvMap: {},
    environmentUids: {},
    envRuntimeUrls: {},
    artifactDir: 'postman',
    repoWriteMode: 'commit-and-push',
    currentRef: 'main',
    githubHeadRef: '',
    githubRefName: 'main',
    committerName: 'Postman',
    committerEmail: 'support@postman.com',
    postmanApiKey: '',
    postmanAccessToken: '',
    credentialPreflight: 'warn',
    branchStrategy: 'legacy',
    previewTtlDays: 30,
    adoToken: '',
    githubToken: '',
    ghFallbackToken: '',
    provider: 'github',
    ciWorkflowBase64: '',
    generateCiWorkflow: true,
    monitorType: 'cloud',
    ciWorkflowPath: '.github/workflows/ci.yml',
    orgMode: false,
    monitorId: '',
    mockUrl: '',
    mockVisibility: 'public',
    mockEnvironmentEnabled: false,
    monitorCron: '',
    sslClientCert: '',
    sslClientKey: '',
    sslClientPassphrase: '',
    sslExtraCaCerts: '',
    specId: '',
    specPath: '',
    teamId: '',
    repository: 'acme/payments',
    postmanRegion: 'us',
    postmanStack: 'prod',
    postmanApiBase: 'https://api.getpostman.com',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
    postmanFallbackBase: 'https://go.postman.co/_api',
    postmanCliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh',
    postmanIapubBase: 'https://iapub.postman.co',
    secretsResolverProvider: 'none',
    ...overrides
  };
}

describe('buildGhCliEnv allowList contract', () => {
  let buildGhCliEnv: IndexModule['buildGhCliEnv'];

  beforeEach(async () => {
    ({ buildGhCliEnv } = await import('../src/index.js'));
  });

  it('always injects GH_TOKEN from the token argument', () => {
    expect(buildGhCliEnv({}, 'ghp_token_xyz')).toEqual({ GH_TOKEN: 'ghp_token_xyz' });
  });

  it('token argument overrides any source GH_TOKEN', () => {
    const env = buildGhCliEnv({ GH_TOKEN: 'stale-source-token' }, 'fresh-arg-token');
    expect(env.GH_TOKEN).toBe('fresh-arg-token');
  });

  it('passes through every allowListed key when present and drops everything else', () => {
    const source: Record<string, string> = {
      GH_TOKEN: 'should-be-overridden',
      POSTMAN_API_KEY: 'pmak-must-not-leak',
      POSTMAN_ACCESS_TOKEN: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'aws-must-not-leak',
      GITHUB_TOKEN: 'must-not-leak',
      RANDOM_UNRELATED: 'dropped'
    };
    for (const key of GH_CLI_ENV_ALLOWLIST) {
      source[key] = `value-for-${key}`;
    }
    const env = buildGhCliEnv(source, 'arg-token');

    expect(Object.keys(env).sort()).toEqual(
      ['GH_TOKEN', ...GH_CLI_ENV_ALLOWLIST].sort()
    );
    expect(env.GH_TOKEN).toBe('arg-token');
    for (const key of GH_CLI_ENV_ALLOWLIST) {
      expect(env[key]).toBe(`value-for-${key}`);
    }
    expect(env.POSTMAN_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.RANDOM_UNRELATED).toBeUndefined();
  });

  it('omits allowListed keys that are absent from the source env', () => {
    const env = buildGhCliEnv({ HOME: '/home/runner' }, 'tok');
    expect(Object.keys(env).sort()).toEqual(['GH_TOKEN', 'HOME'].sort());
    expect(env.HOME).toBe('/home/runner');
  });

  it('returns only GH_TOKEN when source env is empty', () => {
    expect(buildGhCliEnv({}, 'lonely-token')).toEqual({ GH_TOKEN: 'lonely-token' });
  });
});

describe('persistSslSecrets — argv/stdin/GH_TOKEN/env contract', () => {
  let persistSslSecrets: IndexModule['persistSslSecrets'];
  let calls: CapturedCall[];

  beforeEach(async () => {
    ({ persistSslSecrets } = await import('../src/index.js'));
    calls = [];
  });

  it('persists cert/key/passphrase/ca with exact argv, stdin, GH_TOKEN, and filtered env', async () => {
    const actionCore = { info: vi.fn(), warning: vi.fn() };
    const inputs = baseInputs({
      provider: 'github',
      sslClientCert: 'CERT-B64',
      sslClientKey: 'KEY-B64',
      sslClientPassphrase: 'PASS-PHRASE',
      sslExtraCaCerts: 'CA-B64',
      githubToken: 'ghp_ssl_token'
    });
    const envInput: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/runner',
      POSTMAN_API_KEY: 'pmak-must-not-leak',
      POSTMAN_ACCESS_TOKEN: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'aws-must-not-leak',
      RANDOM_UNRELATED: 'dropped'
    };

    await persistSslSecrets(inputs, actionCore, createCapturingExec(calls), 'acme/payments', envInput);

    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.args)).toEqual([
      ['secret', 'set', 'POSTMAN_SSL_CLIENT_CERT_B64', '--repo', 'acme/payments'],
      ['secret', 'set', 'POSTMAN_SSL_CLIENT_KEY_B64', '--repo', 'acme/payments'],
      ['secret', 'set', 'POSTMAN_SSL_CLIENT_PASSPHRASE', '--repo', 'acme/payments'],
      ['secret', 'set', 'POSTMAN_SSL_EXTRA_CA_CERTS_B64', '--repo', 'acme/payments']
    ]);
    expect(calls[0]!.input).toBe('CERT-B64');
    expect(calls[1]!.input).toBe('KEY-B64');
    expect(calls[2]!.input).toBe('PASS-PHRASE');
    expect(calls[3]!.input).toBe('CA-B64');

    for (const call of calls) {
      // GH_TOKEN contract: the resolved token value reaches the gh process.
      expect(call.env.GH_TOKEN).toBe('ghp_ssl_token');
      // AllowList contract: leaked secrets never reach the gh process.
      expect(call.env.POSTMAN_API_KEY).toBeUndefined();
      expect(call.env.POSTMAN_ACCESS_TOKEN).toBeUndefined();
      expect(call.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(call.env.RANDOM_UNRELATED).toBeUndefined();
      // AllowListed keys that were present DO survive.
      expect(call.env.PATH).toBe('/usr/bin');
      expect(call.env.HOME).toBe('/home/runner');
    }

    expect(actionCore.warning).not.toHaveBeenCalled();
    expect(actionCore.info).toHaveBeenCalledWith('SSL certificate inputs persisted to repository secrets');
  });

  it('does not persist SSL secrets in spec-only scope', async () => {
    const actionCore = { info: vi.fn(), warning: vi.fn() };
    const inputs = baseInputs({
      onboardingScope: 'spec-only',
      sslClientCert: 'CERT-B64',
      sslClientKey: 'KEY-B64',
      githubToken: 'ghp_ssl_token'
    });

    await persistSslSecrets(inputs, actionCore, createCapturingExec(calls), 'acme/payments', {});

    expect(calls).toEqual([]);
    expect(actionCore.info).not.toHaveBeenCalled();
    expect(actionCore.warning).not.toHaveBeenCalled();
  });

  it('prefers ghFallbackToken over githubToken for the GH_TOKEN value', async () => {
    const actionCore = { info: vi.fn(), warning: vi.fn() };
    const inputs = baseInputs({
      provider: 'github',
      sslClientCert: 'CERT-ONLY',
      sslClientKey: '',
      githubToken: 'github-primary',
      ghFallbackToken: 'fallback-primary'
    });

    await persistSslSecrets(inputs, actionCore, createCapturingExec(calls), 'acme/payments', {});

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.env.GH_TOKEN).toBe('fallback-primary');
    }
    expect(actionCore.warning).not.toHaveBeenCalled();
  });

  it('warns once and does not throw when gh exits nonzero', async () => {
    const actionCore = { info: vi.fn(), warning: vi.fn() };
    const inputs = baseInputs({
      provider: 'github',
      sslClientCert: 'CERT-B64',
      sslClientKey: 'KEY-B64',
      githubToken: 'ghp_token'
    });

    await expect(
      persistSslSecrets(
        inputs,
        actionCore,
        createCapturingExec(calls, 1, 'permission denied'),
        'acme/payments',
        {}
      )
    ).resolves.toBeUndefined();

    expect(actionCore.warning).toHaveBeenCalledTimes(1);
    const warning = String(actionCore.warning.mock.calls[0]![0]);
    expect(warning).toContain('Unable to persist SSL certificate secrets');
    expect(warning).toContain('permission denied');
  });

  it('skips persistence for Azure DevOps provider with a warning', async () => {
    const actionCore = { info: vi.fn(), warning: vi.fn() };
    const inputs = baseInputs({
      provider: 'azure-devops',
      sslClientCert: 'CERT-B64',
      sslClientKey: 'KEY-B64',
      githubToken: 'ghp_token'
    });

    await persistSslSecrets(inputs, actionCore, createCapturingExec(calls), 'acme/payments', {});

    expect(calls).toEqual([]);
    expect(actionCore.warning).toHaveBeenCalledTimes(1);
    expect(String(actionCore.warning.mock.calls[0]![0])).toContain('Azure DevOps');
  });

  it('skips persistence when no token or repository is available', async () => {
    const actionCore = { info: vi.fn(), warning: vi.fn() };
    const inputs = baseInputs({
      provider: 'github',
      sslClientCert: 'CERT-B64',
      sslClientKey: '',
      githubToken: '',
      ghFallbackToken: ''
    });

    await persistSslSecrets(inputs, actionCore, createCapturingExec(calls), '', {});

    expect(calls).toEqual([]);
    expect(actionCore.warning).toHaveBeenCalledTimes(1);
    expect(String(actionCore.warning.mock.calls[0]![0])).toContain('no GitHub token/repository context');
  });
});

describe('resolvePostmanApiKeyAndTeamId — POSTMAN_API_KEY persistence contract', () => {
  let resolvePostmanApiKeyAndTeamId: IndexModule['resolvePostmanApiKeyAndTeamId'];
  let createSecretMasker: typeof import('../src/lib/secrets.js').createSecretMasker;
  let calls: CapturedCall[];

  function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
    });
  }

  function orgModeFetchRouter(opts: {
    meStatus?: number;
    sessionTeam?: number | string;
    squadsBody?: unknown;
  }): typeof fetch {
    return vi.fn<typeof fetch>().mockImplementation(async (input: string | URL | Request) => {
      const urlStr = input instanceof Request ? input.url : String(input);
      if (urlStr === 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy') {
        return jsonResponse(opts.squadsBody ?? { data: [] });
      }
      if (urlStr === 'https://api.getpostman.com/me') {
        if (opts.meStatus && opts.meStatus !== 200) {
          return jsonResponse({ error: { name: 'AuthenticationError' } }, { status: opts.meStatus });
        }
        return jsonResponse({ user: { id: 'u1', name: 'Test' } });
      }
      if (urlStr === 'https://iapub.postman.co/api/sessions/current') {
        return jsonResponse({
          identity: { team: opts.sessionTeam ?? 10490519 },
          consumerType: 'service_account'
        });
      }
      return new Response('', { status: 404 });
    });
  }

  beforeEach(async () => {
    ({ resolvePostmanApiKeyAndTeamId } = await import('../src/index.js'));
    ({ createSecretMasker } = await import('../src/lib/secrets.js'));
    calls = [];
  });

  it('persists the generated POSTMAN_API_KEY with exact argv, stdin, GH_TOKEN, and filtered env', async () => {
    globalThis.fetch = orgModeFetchRouter({ meStatus: 401, sessionTeam: 10490519 });

    const actionCore = {
      info: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };
    const masker = createSecretMasker(['pmak-invalid']);
    const inputs = baseInputs({
      postmanApiKey: 'pmak-invalid',
      postmanAccessToken: 'postman-access-token',
      teamId: '',
      orgMode: false,
      repository: 'acme/payments',
      githubToken: 'ghp_apikey_token',
      ghFallbackToken: ''
    });

    const envInput: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/runner',
      POSTMAN_ACCESS_TOKEN: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'aws-must-not-leak'
    };

    const result = await resolvePostmanApiKeyAndTeamId(
      inputs,
      actionCore,
      createCapturingExec(calls),
      masker,
      { persistGeneratedApiKeySecret: true, env: envInput }
    );

    expect(result.apiKey).toBe('pmak-generated-from-mock');

    const ghCalls = calls.filter((c) => c.commandLine === 'gh');
    expect(ghCalls).toHaveLength(1);
    const call = ghCalls[0]!;
    expect(call.args).toEqual(['secret', 'set', 'POSTMAN_API_KEY', '--repo', 'acme/payments']);
    expect(call.input).toBe('pmak-generated-from-mock');
    // GH_TOKEN contract: the resolved githubToken value reaches the gh process.
    expect(call.env.GH_TOKEN).toBe('ghp_apikey_token');
    // AllowList contract: no credential env leaks into the gh process.
    expect(call.env.POSTMAN_ACCESS_TOKEN).toBeUndefined();
    expect(call.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(call.env.PATH).toBe('/usr/bin');

    // The PMAK /me 401 warning is expected (that's why a new key is minted).
    // Assert no gh-specific warning was emitted.
    const ghWarning = actionCore.warning.mock.calls
      .map((c) => String(c[0]))
      .find((msg) => msg.includes('gh secret set'));
    expect(ghWarning).toBeUndefined();
  });
});
