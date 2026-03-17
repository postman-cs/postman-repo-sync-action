import { describe, expect, it, vi } from 'vitest';

import { PostmanAssetsClient } from '../src/lib/postman/postman-assets-client.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json'
    },
    ...init
  });
}

describe('PostmanAssetsClient', () => {
  it('creates environments', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        environment: {
          uid: 'env-prod'
        }
      })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(
      client.createEnvironment('ws-123', 'core-payments - prod', [])
    ).resolves.toBe('env-prod');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.getpostman.com/environments?workspace=ws-123',
      expect.objectContaining({
        method: 'POST'
      })
    );
  });

  it('creates mocks and monitors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          mock: {
            uid: 'mock-123',
            mockUrl: 'https://mock.pstmn.io'
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          monitor: {
            uid: 'mon-123'
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ monitor: { uid: 'mon-123' } }));
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-test',
      fetchImpl
    });

    await expect(
      client.createMock('ws-123', 'Mock', 'col-1', 'env-1')
    ).resolves.toEqual({
      uid: 'mock-123',
      url: 'https://mock.pstmn.io'
    });
    await expect(
      client.createMonitor('ws-123', 'Monitor', 'col-2', 'env-1')
    ).resolves.toEqual({ uid: 'mon-123', type: 'cli' });
  });
});
