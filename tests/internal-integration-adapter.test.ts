import { describe, expect, it, vi } from 'vitest';

import { createInternalIntegrationAdapter } from '../src/lib/postman/internal-integration-adapter.js';
import { createSecretMasker, REDACTED } from '../src/lib/secrets.js';
import { PostmanAppVersionProvider } from '../src/lib/postman/app-version.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json'
    },
    ...init
  });
}

describe('internal integration adapter', () => {
  it('adds one cached app-version to every direct ws/proxy path', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { path?: string };
      return body.path === '/api/keys' ? jsonResponse({ apikey: { key: 'created' } }) : jsonResponse({ data: null });
    });
    const lookup = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ version: '12.34.56' }));
    const adapter = createInternalIntegrationAdapter({ backend: 'bifrost', accessToken: 'token-123', teamId: '11430732', fetchImpl, appVersionProvider: new PostmanAppVersionProvider({ fetchImpl: lookup }) });
    await adapter.findWorkspaceForRepo('https://github.com/postman-cs/repo-sync-demo');
    await adapter.connectWorkspaceToRepository('ws-1', 'https://github.com/postman-cs/repo-sync-demo');
    await adapter.createApiKey('key');
    expect(lookup).toHaveBeenCalledTimes(1);
    for (const call of fetchImpl.mock.calls) {
      if (String(call[0]).endsWith('/ws/proxy')) expect((call[1] as RequestInit).headers).toMatchObject({ 'x-app-version': '12.34.56' });
    }
  });
  it('groups direct associations by system environment, preserves public UIDs, and rejects partial readback', async () => {
    const requestJson = vi.fn(async () => ({ success: true, data: [
      { systemEnvironmentId: 'sys-a', workspaceId: 'ws-1', postmanEnvironmentId: '10490519-a' },
      { systemEnvironmentId: 'sys-a', workspaceId: 'ws-1', postmanEnvironmentId: '10490519-b' }
    ] }));
    const adapter = createInternalIntegrationAdapter({ backend: 'bifrost', accessToken: 'token', teamId: '1', gateway: { requestJson } as never });
    await adapter.associateSystemEnvironments('ws-1', [{ envUid: '10490519-b', systemEnvId: 'sys-a' }, { envUid: '10490519-a', systemEnvId: 'sys-a' }]);
    expect(requestJson).toHaveBeenCalledWith(expect.objectContaining({ fallback: 'none', body: { systemEnvironmentId: 'sys-a', workspaceEntries: [{ workspaceId: 'ws-1', postmanEnvironmentIds: ['10490519-a', '10490519-b'] }] } }), { retryTransient: true });
    requestJson.mockResolvedValueOnce({ success: true, data: [] });
    await expect(adapter.associateSystemEnvironments('ws-1', [{ envUid: '10490519-a', systemEnvId: 'sys-a' }])).rejects.toThrow('SYSTEM_ENV_ASSOCIATION_INCOMPLETE');
  });
  describe('findWorkspaceForRepo', () => {
    it('returns free when the filesystem lookup yields 200 with null data', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: null }));
      const adapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        bifrostBaseUrl: 'https://bifrost.example.test',
        fetchImpl
      });

      await expect(
        adapter.findWorkspaceForRepo('https://github.com/postman-cs/repo-sync-demo')
      ).resolves.toEqual({ state: 'free' });

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://bifrost.example.test/ws/proxy',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('/workspaces/filesystem')
        })
      );
      const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body));
      expect(body).toMatchObject({
        service: 'workspaces',
        method: 'GET'
      });
      expect(String(body.path)).toContain('repo=');
      expect(String(body.path)).toContain('path=');
    });

    it('returns linked-visible when the lookup yields a workspace payload', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ data: { id: 'ws-owner', name: 'Payments Service' } })
      );
      const adapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        fetchImpl
      });

      await expect(
        adapter.findWorkspaceForRepo('https://github.com/postman-cs/repo-sync-demo', '/')
      ).resolves.toEqual({
        state: 'linked-visible',
        workspace: { id: 'ws-owner', name: 'Payments Service' }
      });
    });

    it('returns linked-invisible when the lookup is 403 with error.meta.workspaceId', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              name: 'forbiddenError',
              message: 'You are not authorized to perform this action',
              meta: { workspaceId: 'ws-hidden' }
            }
          },
          { status: 403 }
        )
      );
      const adapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        fetchImpl
      });

      await expect(
        adapter.findWorkspaceForRepo('https://github.com/postman-cs/repo-sync-demo')
      ).resolves.toEqual({ state: 'linked-invisible', workspaceId: 'ws-hidden' });
    });

    it('returns linked-invisible when the proxy wraps error.meta.workspaceId in an outer HTTP 200', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          data: null,
          error: {
            name: 'forbiddenError',
            message: 'You are not authorized to perform this action',
            meta: { workspaceId: 'ws-hidden-via-200' }
          }
        })
      );
      const adapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        fetchImpl
      });

      await expect(
        adapter.findWorkspaceForRepo('https://github.com/postman-cs/repo-sync-demo')
      ).resolves.toEqual({
        state: 'linked-invisible',
        workspaceId: 'ws-hidden-via-200'
      });
    });

    it('uses the exact repository URL and root path that the link POST sends', async () => {
      const repoUrl = 'https://github.com/postman-cs/repo-sync-demo.git?ref=feature%2Fone';
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ data: null }))
        .mockResolvedValueOnce(jsonResponse({ data: {} }));
      const adapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        bifrostBaseUrl: 'https://bifrost.example.test',
        fetchImpl
      });

      await adapter.findWorkspaceForRepo(repoUrl, '/');
      await adapter.connectWorkspaceToRepository('ws-target', repoUrl);

      const preflight = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
        path: string;
      };
      const link = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
        body: { path: string; repo: string };
      };
      const query = new URL(`https://example.test${preflight.path}`).searchParams;
      expect(query.get('repo')).toBe(link.body.repo);
      expect(query.get('path')).toBe(link.body.path);
      expect(link.body.repo).toBe(repoUrl);
      expect(link.body.path).toBe('/');
    });

    it('returns unknown for non-fatal probe failures (network / unexpected status)', async () => {
      const repoUrl = 'https://github.com/postman-cs/repo-sync-demo';
      const fsPath = '/';
      const syntheticToken = 'synthetic-access-token-abc123';
      const secretMasker = createSecretMasker([syntheticToken]);
      const remediation = 'verify Bifrost connectivity/credentials then rerun';

      const networkAdapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        secretMasker,
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockRejectedValue(
            new Error(`socket hang up while using ${syntheticToken}`)
          )
      });
      const networkResult = await networkAdapter.findWorkspaceForRepo(repoUrl, fsPath);
      expect(networkResult.state).toBe('unknown');
      if (networkResult.state !== 'unknown') {
        throw new Error('expected unknown');
      }
      expect(networkResult.reason).toContain('filesystem lookup');
      expect(networkResult.reason).toContain(`repository ${repoUrl}`);
      expect(networkResult.reason).toContain(`path ${fsPath}`);
      expect(networkResult.reason).toContain('failed: socket hang up');
      expect(networkResult.reason).toContain(remediation);
      expect(networkResult.reason).toContain(REDACTED);
      expect(networkResult.reason).not.toContain(syntheticToken);

      const statusAdapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        secretMasker,
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValue(jsonResponse({ error: { name: 'serverError' } }, { status: 500 }))
      });
      const statusResult = await statusAdapter.findWorkspaceForRepo(repoUrl, fsPath);
      expect(statusResult.state).toBe('unknown');
      if (statusResult.state !== 'unknown') {
        throw new Error('expected unknown');
      }
      expect(statusResult.reason).toContain('filesystem lookup');
      expect(statusResult.reason).toContain(`repository ${repoUrl}`);
      expect(statusResult.reason).toContain(`path ${fsPath}`);
      expect(statusResult.reason).toContain('returned HTTP 500');
      expect(statusResult.reason).toContain(remediation);

      const nonJsonAdapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        secretMasker,
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('not-json', { status: 502, statusText: 'Bad Gateway' })
        )
      });
      const nonJsonResult = await nonJsonAdapter.findWorkspaceForRepo(repoUrl, fsPath);
      expect(nonJsonResult.state).toBe('unknown');
      if (nonJsonResult.state !== 'unknown') {
        throw new Error('expected unknown');
      }
      expect(nonJsonResult.reason).toContain('filesystem lookup');
      expect(nonJsonResult.reason).toContain(`repository ${repoUrl}`);
      expect(nonJsonResult.reason).toContain(`path ${fsPath}`);
      expect(nonJsonResult.reason).toContain('returned non-JSON body (HTTP 502)');
      expect(nonJsonResult.reason).toContain(remediation);

      const missingIdAdapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        secretMasker,
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValue(jsonResponse({ data: { name: 'No Id Workspace' } }))
      });
      const missingIdResult = await missingIdAdapter.findWorkspaceForRepo(repoUrl, fsPath);
      expect(missingIdResult.state).toBe('unknown');
      if (missingIdResult.state !== 'unknown') {
        throw new Error('expected unknown');
      }
      expect(missingIdResult.reason).toContain('filesystem lookup');
      expect(missingIdResult.reason).toContain(`repository ${repoUrl}`);
      expect(missingIdResult.reason).toContain(`path ${fsPath}`);
      expect(missingIdResult.reason).toContain('returned 200 without a workspace id');
      expect(missingIdResult.reason).toContain(remediation);

      const hostileRepoUrl = `https://github.com/postman-cs/repo-sync-demo\nforged-line`;
      const hostilePath = `/\rsecret-path`;
      const hostileAdapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        secretMasker,
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockRejectedValue(
            new Error(`socket hang up\nwith ${syntheticToken}\rand forged`)
          )
      });
      const hostileResult = await hostileAdapter.findWorkspaceForRepo(
        hostileRepoUrl,
        hostilePath
      );
      expect(hostileResult.state).toBe('unknown');
      if (hostileResult.state !== 'unknown') {
        throw new Error('expected unknown');
      }
      expect(hostileResult.reason).toContain('filesystem lookup');
      expect(hostileResult.reason).toContain('repository https://github.com/postman-cs/repo-sync-demo forged-line');
      expect(hostileResult.reason).toContain('path / secret-path');
      expect(hostileResult.reason).toContain('failed: socket hang up');
      expect(hostileResult.reason).toContain(remediation);
      expect(hostileResult.reason).toContain(REDACTED);
      expect(hostileResult.reason).not.toContain(syntheticToken);
      expect(hostileResult.reason).not.toContain('\n');
      expect(hostileResult.reason).not.toContain('\r');
    });
  });

  it('surfaces REPOSITORY_LINK_CONFLICT_UNRESOLVED when preflight was free but POST still conflicts', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            status: 400,
            name: 'invalidParamError',
            message: 'File system with this repo and path already exists',
            meta: { workspaceId: 'ws-race' }
          }
        },
        { status: 400 }
      )
    );
    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl
    });

    await expect(
      adapter.connectWorkspaceToRepository(
        'ws-123',
        'https://github.com/postman-cs/repo-sync-demo',
        { preflightWasFree: true }
      )
    ).rejects.toThrow(
      /REPOSITORY_LINK_CONFLICT_UNRESOLVED: Preflight found no active owner, but link creation reported workspace ws-race\. Stop and contact Postman support; do not alter the repository URL\./
    );
    // No workspace-visibility lookup — the race contract is terminal.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('associates system environments through the worker endpoint', async () => {
    vi.stubEnv('POSTMAN_SYSTEM_ENV_ASSOCIATION_MODE', 'worker');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: true
      })
    );
    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      workerBaseUrl: 'https://catalog-admin.example.test',
      fetchImpl
    });

    await adapter.associateSystemEnvironments('ws-123', [
      { envUid: 'env-prod', systemEnvId: 'sys-prod' }
    ]);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://catalog-admin.example.test/api/internal/system-envs/associate',
      expect.objectContaining({
        method: 'POST'
      })
    );
    vi.unstubAllEnvs();
  });

  it('honors custom bifrostBaseUrl override for beta stacks', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ apikey: { key: 'pmak-beta-generated' } }));

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-beta',
      teamId: '99999999',
      bifrostBaseUrl: 'https://bifrost-https-v4.gw.postman-beta.com/',
      fetchImpl
    });

    await adapter.connectWorkspaceToRepository(
      'ws-beta',
      'https://github.com/postman-cs/repo-sync-demo'
    );
    await adapter.createApiKey('beta-key');

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://bifrost-https-v4.gw.postman-beta.com/ws/proxy',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://bifrost-https-v4.gw.postman-beta.com/ws/proxy',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('treats a duplicate link on the same workspace as idempotent success', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            status: 400,
            name: 'invalidParamError',
            message: 'File system with this repo and path already exists',
            meta: { workspaceId: 'ws-123' }
          }
        },
        { status: 400 }
      )
    );
    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl
    });

    await expect(
      adapter.connectWorkspaceToRepository(
        'ws-123',
        'https://github.com/postman-cs/repo-sync-demo'
      )
    ).resolves.toBeUndefined();
  });

  it('fails with workspace identity when the conflicting workspace is visible', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(
        {
          error: {
            status: 400,
            name: 'invalidParamError',
            message: 'File system with this repo and path already exists',
            meta: { workspaceId: 'ws-stale' }
          }
        },
        { status: 400 }
      ))
      .mockResolvedValueOnce(
        jsonResponse({ data: { id: 'ws-stale', name: 'Payments Service' } })
      );
    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl
    });

    await expect(
      adapter.connectWorkspaceToRepository(
        'ws-123',
        'https://github.com/postman-cs/repo-sync-demo'
      )
    ).rejects.toThrow(
      /already linked to workspace ws-stale.*Payments Service.*go\.postman\.co\/workspace\/ws-stale/s
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('explains invisible conflicting workspaces and points at workspace-team-id', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(
        {
          error: {
            status: 400,
            name: 'invalidParamError',
            message: 'File system with this repo and path already exists',
            meta: { workspaceId: 'ws-stale' }
          }
        },
        { status: 400 }
      ))
      .mockResolvedValueOnce(
        jsonResponse({ error: { name: 'forbidden' } }, { status: 403 })
      );
    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl
    });

    await expect(
      adapter.connectWorkspaceToRepository(
        'ws-123',
        'https://github.com/postman-cs/repo-sync-demo'
      )
    ).rejects.toThrow(
      /already linked to workspace ws-stale.*invisible to the credentials.*workspace-team-id/s
    );
  });

  it('notes recently deleted conflicting workspaces', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(
        {
          error: {
            status: 400,
            name: 'invalidParamError',
            message: 'File system with this repo and path already exists',
            meta: { workspaceId: 'ws-stale' }
          }
        },
        { status: 400 }
      ))
      .mockResolvedValueOnce(
        jsonResponse({ error: { name: 'workspaceNotFoundError' } }, { status: 404 })
      );
    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl
    });

    await expect(
      adapter.connectWorkspaceToRepository(
        'ws-123',
        'https://github.com/postman-cs/repo-sync-demo'
      )
    ).rejects.toThrow(/already linked to workspace ws-stale.*recently deleted/s);
  });

  it('still fails usefully when the conflict lookup itself fails', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(
        {
          error: {
            status: 400,
            name: 'invalidParamError',
            message: 'File system with this repo and path already exists',
            meta: { workspaceId: 'ws-stale' }
          }
        },
        { status: 400 }
      ))
      .mockRejectedValueOnce(new Error('network down'));
    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl
    });

    await expect(
      adapter.connectWorkspaceToRepository(
        'ws-123',
        'https://github.com/postman-cs/repo-sync-demo'
      )
    ).rejects.toThrow(
      /already linked to workspace ws-stale.*could not be resolved/s
    );
  });

  it('keeps legacy duplicate bodies without a workspace id idempotent', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('projectAlreadyConnected', { status: 400 })
    );
    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl
    });

    await expect(
      adapter.connectWorkspaceToRepository(
        'ws-123',
        'https://github.com/postman-cs/repo-sync-demo'
      )
    ).resolves.toBeUndefined();
  });

  it('UNAUTHENTICATED on associateSystemEnvironments yields re-mint guidance', async () => {
    vi.stubEnv('POSTMAN_SYSTEM_ENV_ASSOCIATION_MODE', 'worker');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: { code: 'UNAUTHENTICATED' } },
        { status: 401, statusText: 'Unauthorized' }
      )
    );
    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      workerBaseUrl: 'https://catalog-admin.example.test',
      fetchImpl
    });

    await expect(
      adapter.associateSystemEnvironments('ws-123', [
        { envUid: 'env-prod', systemEnvId: 'sys-prod' }
      ])
    ).rejects.toThrow(
      /Bifrost rejected the access token \(UNAUTHENTICATED\).*Re-mint a fresh token.*service-account-tokens/s
    );
    vi.unstubAllEnvs();
  });

  it('createApiKey 403 yields role guidance', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: { message: 'You are not authorized to perform this action' } },
        { status: 403, statusText: 'Forbidden' }
      )
    );
    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl
    });

    await expect(adapter.createApiKey('repo-sync-action-key')).rejects.toThrow(
      /Bifrost refused API key generation with 403.*Verify the token's role/s
    );
  });

  it('sanitizes token content in internal failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('token-123 worker failure', {
        status: 500,
        statusText: 'Internal Server Error'
      })
    );
    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      fetchImpl
    });

    await expect(
      adapter.connectWorkspaceToRepository(
        'ws-123',
        'https://github.com/postman-cs/repo-sync-demo'
      )
    ).rejects.toThrow('[REDACTED]');
    await expect(
      adapter.connectWorkspaceToRepository(
        'ws-123',
        'https://github.com/postman-cs/repo-sync-demo'
      )
    ).rejects.not.toThrow('token-123');
  });
});
