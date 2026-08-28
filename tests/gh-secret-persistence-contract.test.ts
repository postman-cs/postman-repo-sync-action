import { describe, expect, it, vi } from 'vitest';

import { persistSslSecrets, type ExecLike, type ResolvedInputs, writeGitHubRepositorySecrets } from '../src/index.js';

interface Receipt {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const publicKey = Buffer.alloc(32, 7).toString('base64');
const unusedExec: ExecLike = {
  getExecOutput: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
};

function recordingFetcher(receipts: Receipt[], failureStatus?: number): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : undefined;
    receipts.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(body === undefined ? {} : { body })
    });
    if (receipts.length === 1) {
      return new Response(JSON.stringify({ key_id: 'key-id-123', key: publicKey }), { status: 200 });
    }
    return failureStatus
      ? new Response(JSON.stringify({ message: 'permission denied' }), { status: failureStatus })
      : new Response(null, { status: 204 });
  });
}

function sslInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    projectName: 'core-payments',
    workspaceId: 'ws-123',
    baselineCollectionId: 'baseline',
    smokeCollectionId: 'smoke',
    contractCollectionId: 'contract',
    onboardingScope: 'full',
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
    githubToken: 'github-token',
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
    sslClientCert: 'CERT-B64',
    sslClientKey: 'KEY-B64',
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

describe('GitHub Actions secret REST persistence', () => {
  it('seals plaintext and writes through the configured GitHub API without invoking gh', async () => {
    const receipts: Receipt[] = [];
    const fetcher = recordingFetcher(receipts);

    await writeGitHubRepositorySecrets(
      'acme/payments',
      'github-token',
      [
        ['POSTMAN_API_KEY', 'pmak-secret'],
        ['POSTMAN_TEAM_ID', 'team-123']
      ],
      { GITHUB_API_URL: 'https://github.example/api/v3/' },
      fetcher
    );

    expect(receipts.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: 'https://github.example/api/v3/repos/acme/payments/actions/secrets/public-key' },
      { method: 'PUT', url: 'https://github.example/api/v3/repos/acme/payments/actions/secrets/POSTMAN_API_KEY' },
      { method: 'PUT', url: 'https://github.example/api/v3/repos/acme/payments/actions/secrets/POSTMAN_TEAM_ID' }
    ]);
    expect(receipts[0]?.headers.authorization).toBe('Bearer github-token');
    for (const receipt of receipts.slice(1)) {
      const body = JSON.parse(receipt.body ?? '') as { encrypted_value: string; key_id: string };
      expect(body.key_id).toBe('key-id-123');
      expect(body.encrypted_value).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(receipt.body).not.toContain('pmak-secret');
      expect(receipt.body).not.toContain('team-123');
    }
    expect(unusedExec.getExecOutput).not.toHaveBeenCalled();
  });

  it('persists SSL values through sealed REST writes and masks API failures', async () => {
    const successReceipts: Receipt[] = [];
    const core = { info: vi.fn(), warning: vi.fn() };
    await persistSslSecrets(
      sslInputs({ sslClientPassphrase: 'PASS-B64', sslExtraCaCerts: 'CA-B64' }),
      core,
      unusedExec,
      'acme/payments',
      {},
      recordingFetcher(successReceipts)
    );
    expect(successReceipts.map((receipt) => receipt.method)).toEqual(['GET', 'PUT', 'PUT', 'PUT', 'PUT']);
    expect(successReceipts.slice(1).map((receipt) => receipt.url.split('/').at(-1))).toEqual([
      'POSTMAN_SSL_CLIENT_CERT_B64',
      'POSTMAN_SSL_CLIENT_KEY_B64',
      'POSTMAN_SSL_CLIENT_PASSPHRASE',
      'POSTMAN_SSL_EXTRA_CA_CERTS_B64'
    ]);
    expect(core.info).toHaveBeenCalledWith('SSL certificate inputs persisted to repository secrets');
    expect(core.warning).not.toHaveBeenCalled();

    const failedCore = { info: vi.fn(), warning: vi.fn() };
    await persistSslSecrets(
      sslInputs({ githubToken: 'github-secret-token' }),
      failedCore,
      unusedExec,
      'acme/payments',
      {},
      recordingFetcher([], 403)
    );
    const warning = String(failedCore.warning.mock.calls[0]?.[0]);
    expect(warning).toContain('GitHub API request failed (HTTP 403)');
    expect(warning).not.toContain('github-secret-token');
    expect(warning).not.toContain('CERT-B64');
    expect(warning).not.toContain('KEY-B64');
  });

  it('preserves the existing provider, scope, token, and fallback-token guards', async () => {
    const fetcher = vi.fn<typeof fetch>();

    const specOnlyCore = { info: vi.fn(), warning: vi.fn() };
    await persistSslSecrets(
      sslInputs({ onboardingScope: 'spec-only' }),
      specOnlyCore,
      unusedExec,
      'acme/payments',
      {},
      fetcher
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(specOnlyCore.warning).not.toHaveBeenCalled();

    const azureCore = { info: vi.fn(), warning: vi.fn() };
    await persistSslSecrets(
      sslInputs({ provider: 'azure-devops' }),
      azureCore,
      unusedExec,
      'acme/payments',
      {},
      fetcher
    );
    expect(azureCore.warning).toHaveBeenCalledWith(expect.stringContaining('Azure DevOps'));

    const noTokenCore = { info: vi.fn(), warning: vi.fn() };
    await persistSslSecrets(
      sslInputs({ githubToken: '', ghFallbackToken: '' }),
      noTokenCore,
      unusedExec,
      'acme/payments',
      {},
      fetcher
    );
    expect(noTokenCore.warning).toHaveBeenCalledWith(expect.stringContaining('no GitHub token/repository context'));

    const fallbackReceipts: Receipt[] = [];
    await persistSslSecrets(
      sslInputs({ githubToken: 'primary-token', ghFallbackToken: 'fallback-token' }),
      { info: vi.fn(), warning: vi.fn() },
      unusedExec,
      'acme/payments',
      {},
      recordingFetcher(fallbackReceipts)
    );
    expect(fallbackReceipts[0]?.headers.authorization).toBe('Bearer fallback-token');
  });

  it.each(['owner', '/repo', 'owner/', 'owner/repo/extra', ' owner/repo'])(
    'rejects malformed repository %j before network access',
    async (repository) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        writeGitHubRepositorySecrets(repository, 'token', [['POSTMAN_API_KEY', 'value']], {}, fetcher)
      ).rejects.toThrow(/owner\/repository/);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );
});
