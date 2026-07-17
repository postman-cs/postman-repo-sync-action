import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

const PRIMARY = 'https://bifrost-premium-https-v4.gw.postman.com';
const FALLBACK = 'https://go.postman.co/_api';

function makeClient(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new AccessTokenGatewayClient({
    tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
    fetchImpl,
    sleepImpl: async () => undefined,
    fallbackBaseUrl: FALLBACK,
    ...extra
  });
}

describe('AccessTokenGatewayClient /_api cold fallback', () => {
  it('falls back for a safe read after the primary retry budget is exhausted', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'downstream' }, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ error: 'downstream' }, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ error: 'downstream' }, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ error: 'downstream' }, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const client = makeClient(fetchImpl, { maxRetries: 3 });

    const result = await client.requestJson({ service: 'sync', method: 'get', path: '/x' });
    expect(result).toEqual({ data: { ok: true } });
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.slice(0, 4)).toEqual(Array(4).fill(PRIMARY + '/ws/proxy'));
    expect(urls[4]).toBe(FALLBACK + '/ws/proxy');
  });

  it('does NOT fall back for an unsafe create without fallback: auto', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'downstream' }, { status: 502 }));
    const client = makeClient(fetchImpl, { maxRetries: 0 });

    await expect(
      client.requestJson({ service: 'mock', method: 'post', path: '/mocks?workspace=w' }, { retryTransient: false })
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back for an unsafe create with fallback: auto', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'downstream' }, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'm-1', url: 'https://mock' } }));
    const client = makeClient(fetchImpl, { maxRetries: 0 });

    const result = await client.requestJson(
      { service: 'mock', method: 'post', path: '/mocks?workspace=w', fallback: 'auto' },
      { retryTransient: false }
    );
    expect(result).toEqual({ data: { id: 'm-1', url: 'https://mock' } });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(FALLBACK + '/ws/proxy');
  });

  it('falls back after a transport rejection on a safe read', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('socket hangup'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = makeClient(fetchImpl, { maxRetries: 0 });

    const result = await client.requestJson({ service: 'sync', method: 'get', path: '/x' });
    expect(result).toEqual({ ok: true });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(FALLBACK + '/ws/proxy');
  });

  it('surfaces the original error when the fallback also fails transiently', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'downstream' }, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ error: 'still down' }, { status: 503 }));
    const client = makeClient(fetchImpl, { maxRetries: 0 });

    await expect(
      client.requestJson({ service: 'sync', method: 'get', path: '/x' })
    ).rejects.toThrow(/502/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces a non-transient fallback failure as its own HttpError', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'downstream' }, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ error: 'bad request' }, { status: 400 }));
    const client = makeClient(fetchImpl, { maxRetries: 0 });

    await expect(
      client.requestJson({ service: 'sync', method: 'get', path: '/x' })
    ).rejects.toThrow(/400/);
  });

  it('is disabled when POSTMAN_ITEM_CREATE_FALLBACK=off', async () => {
    process.env.POSTMAN_ITEM_CREATE_FALLBACK = 'off';
    try {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ error: 'downstream' }, { status: 502 }));
      const client = makeClient(fetchImpl, { maxRetries: 0 });

      await expect(
        client.requestJson({ service: 'sync', method: 'get', path: '/x' })
      ).rejects.toThrow(/502/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.POSTMAN_ITEM_CREATE_FALLBACK;
    }
  });

  it('is disabled when no fallbackBaseUrl is configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'downstream' }, { status: 502 }));
    const client = new AccessTokenGatewayClient({
      tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
      fetchImpl,
      sleepImpl: async () => undefined,
      maxRetries: 0
    });

    await expect(
      client.requestJson({ service: 'sync', method: 'get', path: '/x' })
    ).rejects.toThrow(/502/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
