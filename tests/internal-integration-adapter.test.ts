import { describe, expect, it, vi } from 'vitest';

import { createInternalIntegrationAdapter } from '../src/lib/postman/internal-integration-adapter.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json'
    },
    ...init
  });
}

describe('internal integration adapter', () => {
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
      const networkAdapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('socket hang up'))
      });
      await expect(
        networkAdapter.findWorkspaceForRepo('https://github.com/postman-cs/repo-sync-demo')
      ).resolves.toMatchObject({ state: 'unknown' });

      const statusAdapter = createInternalIntegrationAdapter({
        backend: 'bifrost',
        accessToken: 'token-123',
        teamId: '11430732',
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValue(jsonResponse({ error: { name: 'serverError' } }, { status: 500 }))
      });
      await expect(
        statusAdapter.findWorkspaceForRepo('https://github.com/postman-cs/repo-sync-demo')
      ).resolves.toMatchObject({ state: 'unknown' });
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
