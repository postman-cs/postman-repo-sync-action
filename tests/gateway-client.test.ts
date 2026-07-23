import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { createMutableSecretMasker } from '../src/lib/secrets.js';
import { PostmanAppVersionProvider } from '../src/lib/postman/app-version.js';

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
    const events: unknown[] = [];
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      fetchImpl,
      retryBaseDelayMs: 10,
      sleepImpl: sleep,
      randomImpl: () => 1,
      onRetryEvent: (event) => events.push(event)
    });

    const result = await client.requestJson({
      service: 'collection',
      method: 'get',
      path: '/v3/collections/x/export'
    });

    expect(result).toEqual({ data: { collection: { name: 'ok' } } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
    expect(events).toEqual([{ class: 'http', status: 500, attempt: 1, delay: 10 }]);
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
      sleepImpl: sleep,
      randomImpl: () => 1
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
    const onRetryEvent = vi.fn();
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      fetchImpl,
      sleepImpl: sleep,
      onRetryEvent
    });

    await expect(
      client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x/export' })
    ).rejects.toThrow('404');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onRetryEvent).not.toHaveBeenCalled();
  });

  it('reports inner, transport, auth-refresh, and fallback decisions without request content', async () => {
    const events: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('transport secret-token /route'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 503, error: 'downstream' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"error":"UNAUTHENTICATED"}', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'fresh-token' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const provider = new AccessTokenProvider({ accessToken: 'stale-token', apiKey: 'pmak', fetchImpl, sleep: async () => undefined });
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      fetchImpl,
      fallbackBaseUrl: 'https://fallback.example',
      maxRetries: 2,
      retryBaseDelayMs: 1,
      sleepImpl: async () => undefined,
      randomImpl: () => 0,
      onRetryEvent: (event) => events.push(event as unknown as Record<string, unknown>)
    });

    await expect(client.requestJson({ service: 'collection', method: 'get', path: '/secret-route', body: { token: 'secret-token' } })).resolves.toEqual({ ok: true });
    expect(events).toEqual([
      { class: 'transport', attempt: 1, delay: 0 },
      { class: 'inner', status: 503, attempt: 2, delay: 0 },
      { class: 'auth', status: 401, attempt: 1, delay: 0 }
    ]);
    expect(JSON.stringify(events)).not.toContain('secret-token');
    expect(JSON.stringify(events)).not.toContain('/secret-route');
  });

  it('reports a fallback attempt once after the retry budget is exhausted', async () => {
    const events: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('downstream', { status: 500 }))
      .mockResolvedValueOnce(new Response('fallback failure', { status: 500 }));
    const client = new AccessTokenGatewayClient({
      tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
      fetchImpl,
      fallbackBaseUrl: 'https://fallback.example',
      maxRetries: 0,
      onRetryEvent: (event) => events.push(event)
    });

    await expect(client.requestJson({ service: 'collection', method: 'get', path: '/x' })).rejects.toThrow('500');
    expect(events).toEqual([{ class: 'fallback', status: 500, attempt: 1, delay: 0 }]);
  });

  it('preserves cached app/team headers across auth refresh and honors Retry-After for a safe read', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('slow', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(new Response('{"error":"UNAUTHENTICATED"}', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'fresh' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const appLookup = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ version: '12.34.56' }));
    const sleep = vi.fn(async () => undefined);
    const events: unknown[] = [];
    const provider = new AccessTokenProvider({ accessToken: 'stale', apiKey: 'pmak', fetchImpl, sleep: async () => undefined });
    const client = new AccessTokenGatewayClient({ tokenProvider: provider, fetchImpl, teamId: '6029', orgMode: true, sleepImpl: sleep, appVersionProvider: new PostmanAppVersionProvider({ fetchImpl: appLookup }), randomImpl: () => 0, onRetryEvent: (event) => events.push(event) });
    await expect(client.requestJson({ service: 'collection', method: 'get', path: '/v3/a/export' })).resolves.toEqual({ ok: true });
    expect(appLookup).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(events).toEqual([{ class: 'http', status: 429, attempt: 1, delay: 2000 }, { class: 'auth', status: 401, attempt: 1, delay: 0 }]);
    for (const index of [0, 1, 3]) {
      expect((fetchImpl.mock.calls[index]?.[1] as RequestInit).headers).toMatchObject({ 'x-app-version': '12.34.56', 'x-entity-team-id': '6029' });
    }
  });
});
