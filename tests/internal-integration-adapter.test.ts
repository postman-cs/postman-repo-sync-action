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
