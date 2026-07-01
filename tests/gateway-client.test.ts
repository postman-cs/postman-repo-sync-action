import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { createMutableSecretMasker } from '../src/lib/secrets.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

const GATEWAY = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';

describe('AccessTokenGatewayClient (repo-sync)', () => {
  it('sends the proxy envelope with the live access token', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const provider = new AccessTokenProvider({ accessToken: 'tok-1' });
    const client = new AccessTokenGatewayClient({ tokenProvider: provider, fetchImpl });

    await client.requestJson({
      service: 'collection',
      method: 'get',
      path: '/v3/collections/abc/export'
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      GATEWAY,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-access-token': 'tok-1'
        }),
        body: JSON.stringify({
          service: 'collection',
          method: 'get',
          path: '/v3/collections/abc/export'
        })
      })
    );
  });

  it('adds x-entity-team-id only in org-mode', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    const provider = new AccessTokenProvider({ accessToken: 'tok' });
    const orgClient = new AccessTokenGatewayClient({
      tokenProvider: provider,
      teamId: '777',
      orgMode: true,
      fetchImpl
    });

    await orgClient.requestJson({ service: 'workspaces', method: 'get', path: '/workspaces' });
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      'x-entity-team-id': '777'
    });

    fetchImpl.mockClear();
    const personalClient = new AccessTokenGatewayClient({
      tokenProvider: provider,
      teamId: '777',
      orgMode: false,
      fetchImpl
    });
    await personalClient.requestJson({ service: 'workspaces', method: 'get', path: '/workspaces' });
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-entity-team-id']).toBeUndefined();
  });

  it('refreshes the token on UNAUTHENTICATED and retries once with the new token', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":"UNAUTHENTICATED"}', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-fresh' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const provider = new AccessTokenProvider({
      accessToken: 'tok-stale',
      apiKey: 'PMAK',
      fetchImpl,
      sleep: async () => undefined
    });
    const client = new AccessTokenGatewayClient({ tokenProvider: provider, fetchImpl });

    const result = await client.requestJson({
      service: 'workspaces',
      method: 'get',
      path: '/workspaces'
    });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const retried = fetchImpl.mock.calls[2]?.[1] as RequestInit;
    expect((retried.headers as Record<string, string>)['x-access-token']).toBe('tok-fresh');
  });

  it('retries a transient downstream export timeout with backoff, then succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"name":"serverError","details":"ESOCKETTIMEDOUT","source":"downstream"}}', { status: 500 })
      )
      .mockResolvedValueOnce(jsonResponse({ data: { collection: { name: 'ok' } } }));
    const provider = new AccessTokenProvider({ accessToken: 'tok' });
    const sleep = vi.fn(async () => undefined);
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      fetchImpl,
      retryBaseDelayMs: 10,
      sleepImpl: sleep
    });

    const result = await client.requestJson({
      service: 'collection',
      method: 'get',
      path: '/v3/collections/x/export'
    });

    expect(result).toEqual({ data: { collection: { name: 'ok' } } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('exhausts the transient retry budget and raises a redacted error', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"error":{"message":"ESOCKETTIMEDOUT"}} secret-tok', { status: 504 }));
    const provider = new AccessTokenProvider({ accessToken: 'secret-tok' });
    const masker = createMutableSecretMasker(['secret-tok']);
    const sleep = vi.fn(async () => undefined);
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      fetchImpl,
      secretMasker: masker.mask,
      maxRetries: 2,
      retryBaseDelayMs: 5,
      sleepImpl: sleep
    });

    let captured: unknown;
    try {
      await client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x/export' });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    const message = captured instanceof Error ? captured.message : String(captured);
    expect(message).toContain('504');
    expect(message).not.toContain('secret-tok');
    // initial attempt + 2 retries
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 5);
    expect(sleep).toHaveBeenNthCalledWith(2, 10);
  });

  it('does not retry a non-transient 4xx', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"error":{"code":"RESOURCE_NOT_FOUND"}}', { status: 404 }));
    const provider = new AccessTokenProvider({ accessToken: 'tok' });
    const sleep = vi.fn(async () => undefined);
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      fetchImpl,
      sleepImpl: sleep
    });

    await expect(
      client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x/export' })
    ).rejects.toThrow('404');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
