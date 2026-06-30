import { describe, expect, it, vi } from 'vitest';

import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { createMutableSecretMasker } from '../src/lib/secrets.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

function parseEnvelope(call: Parameters<typeof fetch>): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function buildClient(fetchImpl: typeof fetch, opts: { apiKey?: string; accessToken?: string } = {}) {
  const masker = createMutableSecretMasker([opts.accessToken ?? 'tok-initial']);
  const onToken = vi.fn((t: string) => masker.add(t));
  const provider = new AccessTokenProvider({
    accessToken: opts.accessToken ?? 'tok-initial',
    apiKey: opts.apiKey ?? '',
    apiBaseUrl: 'https://api.getpostman.com',
    fetchImpl,
    onToken,
    sleep: async () => {}
  });
  const gateway = new AccessTokenGatewayClient({
    tokenProvider: provider,
    bifrostBaseUrl: 'https://bifrost.example.com',
    teamId: '10490519',
    orgMode: false,
    fetchImpl,
    secretMasker: masker.mask
  });
  const assets = new PostmanGatewayAssetsClient({ gateway, workspaceId: 'ws-1' });
  return { assets, provider, gateway, masker, onToken };
}

describe('PostmanGatewayAssetsClient', () => {
  it('createMock sends the live-probed bare body via the mock service and parses id/url', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ id: 'mock-uuid', url: 'https://mock-uuid.mock.pstmn.io', collection: 'col-1' })
    );
    const { assets } = buildClient(fetchImpl);

    const result = await assets.createMock('ws-1', 'm', 'col-1', '');
    expect(result).toEqual({ uid: 'mock-uuid', url: 'https://mock-uuid.mock.pstmn.io' });

    const env = parseEnvelope(fetchImpl.mock.calls[0]);
    expect(env.service).toBe('mock');
    expect(env.method).toBe('post');
    expect(env.path).toBe('/mocks?workspace=ws-1');
    // bare body, NOT wrapped in { mock: { ... } }
    expect(env.body).toEqual({ name: 'm', collection: 'col-1', private: false });
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-access-token']).toBe('tok-initial');
    expect(headers['X-Api-Key']).toBeUndefined();
  });

  it('listMocks parses the bare-array mock service response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([{ id: 'm1', name: 'a', collection: 'col-1', url: 'https://m1.mock' }])
    );
    const { assets } = buildClient(fetchImpl);
    const mocks = await assets.listMocks();
    expect(mocks).toEqual([
      { uid: 'm1', name: 'a', collection: 'col-1', mockUrl: 'https://m1.mock', environment: '' }
    ]);
    expect(parseEnvelope(fetchImpl.mock.calls[0]).path).toBe('/mocks?workspace=ws-1');
  });

  it('createMonitor sends the monitorsV2 schema (collection object + cronPattern/timeZone) and parses data.id', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ meta: { action: 'create' }, data: { id: 'mon-uuid', name: 'mon' } })
    );
    const { assets } = buildClient(fetchImpl);

    const uid = await assets.createMonitor('ws-1', 'mon', 'col-1', '', '0 5 * * 1');
    expect(uid).toBe('mon-uuid');

    const env = parseEnvelope(fetchImpl.mock.calls[0]);
    expect(env.service).toBe('monitorsV2');
    expect(env.path).toBe('/monitors?workspace=ws-1');
    expect(env.body).toEqual({
      name: 'mon',
      type: 'collection-based',
      collection: { id: 'col-1' },
      schedule: { cronPattern: '0 5 * * 1', timeZone: 'UTC' }
    });
  });

  it('listMonitors unwraps {data:[...]} and the nested collection.id', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: [{ id: 'mon1', name: 'm', active: true, collection: { id: 'col-1' } }] })
    );
    const { assets } = buildClient(fetchImpl);
    const monitors = await assets.listMonitors();
    expect(monitors).toEqual([
      { uid: 'mon1', name: 'm', active: true, collectionUid: 'col-1', environmentUid: '' }
    ]);
  });

  it('runMonitor posts to the monitorsV2 run path', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    const { assets } = buildClient(fetchImpl);
    await assets.runMonitor('mon1');
    const env = parseEnvelope(fetchImpl.mock.calls[0]);
    expect(env.service).toBe('monitorsV2');
    expect(env.method).toBe('post');
    expect(env.path).toBe('/monitors/mon1/run');
  });

  it('re-mints a stale access token once on UNAUTHENTICATED and retries (single-flight), masking the new token', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (u.includes('/service-account-tokens')) {
        return jsonResponse({ access_token: 'tok-fresh' });
      }
      calls.push(headers['x-access-token']);
      if (headers['x-access-token'] === 'tok-stale') {
        return jsonResponse({ error: { name: 'authenticationError' } }, { status: 401 });
      }
      return jsonResponse([{ id: 'm1', name: 'a', collection: 'col-1', url: 'https://m1.mock' }]);
    });
    const { assets, onToken, masker } = buildClient(fetchImpl, {
      apiKey: 'pmak-service',
      accessToken: 'tok-stale'
    });

    // concurrent calls must share one mint
    const [a, b] = await Promise.all([assets.listMocks(), assets.listMocks()]);
    expect(a[0].uid).toBe('m1');
    expect(b[0].uid).toBe('m1');

    const mintCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/service-account-tokens'));
    expect(mintCalls.length).toBe(1); // single-flight
    expect(onToken).toHaveBeenCalledWith('tok-fresh');
    expect(calls).toContain('tok-stale');
    expect(calls).toContain('tok-fresh');
    // re-minted token is registered with the mutable masker
    expect(masker.mask('leaked tok-fresh here')).toBe('leaked [REDACTED] here');
  });

  it('fails actionably when the token is stale and no PMAK is present to re-mint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: { name: 'authenticationError' } }, { status: 401 })
    );
    const { assets } = buildClient(fetchImpl, { accessToken: 'tok-stale' });
    await expect(assets.listMocks()).rejects.toThrow();
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('/service-account-tokens'))).toBe(false);
  });
});
