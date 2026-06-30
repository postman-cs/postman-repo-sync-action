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
  // owner + 5-part uuid = 6 hyphen segments (see data/collections uid-helper)
  const PUBLIC_UID = '10490519-12345678-abcd-ef01-2345-678901234567';
  const ENV_PUBLIC_UID = '10490519-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('createMock references the collection + environment by their full public uids (no model-id strip)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ id: 'mock-uuid', url: 'https://mock-uuid.mock.pstmn.io' })
    );
    const { assets } = buildClient(fetchImpl);

    await assets.createMock('ws-1', 'm', PUBLIC_UID, ENV_PUBLIC_UID);

    const env = parseEnvelope(fetchImpl.mock.calls[0]);
    // public uid passed straight through — the bare model id 403s the mock service
    expect((env.body as Record<string, unknown>).collection).toBe(PUBLIC_UID);
    expect((env.body as Record<string, unknown>).environment).toBe(ENV_PUBLIC_UID);
  });

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

  it('createEnvironment returns the owner-prefixed public uid built from the import response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', owner: '10490519' } })
    );
    const { assets } = buildClient(fetchImpl);
    // bare model id from sync import -> public uid mock/monitor accept
    await expect(assets.createEnvironment('ws-1', 'e', [])).resolves.toBe(ENV_PUBLIC_UID);
    const env = parseEnvelope(fetchImpl.mock.calls[0]);
    expect(env.service).toBe('sync');
    expect(env.path).toBe('/environment/import?workspace=ws-1');
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

  it('findMockByCollection matches the public uid the mock list echoes', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([{ id: 'm1', name: 'a', collection: PUBLIC_UID, url: 'https://m1.mock' }])
    );
    const { assets } = buildClient(fetchImpl);
    await expect(assets.findMockByCollection(PUBLIC_UID)).resolves.toEqual({
      uid: 'm1',
      mockUrl: 'https://m1.mock'
    });
  });

  it('createMonitor sends the jobTemplates schema (flat collection uid + full envelope) and parses data.id', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ meta: { action: 'create' }, data: { id: 'mon-uuid', name: 'mon' } })
    );
    const { assets } = buildClient(fetchImpl);

    const uid = await assets.createMonitor('ws-1', 'mon', PUBLIC_UID, ENV_PUBLIC_UID, '0 5 * * 1');
    expect(uid).toBe('mon-uuid');

    const env = parseEnvelope(fetchImpl.mock.calls[0]);
    expect(env.service).toBe('monitors');
    expect(env.path).toBe('/jobTemplates?workspace=ws-1');
    expect(env.body).toEqual({
      name: 'mon',
      collection: PUBLIC_UID,
      options: { strictSSL: false, followRedirects: true, requestTimeout: null, requestDelay: 0 },
      notifications: { onFailure: [], onError: [] },
      retry: {},
      schedule: { cronPattern: '0 5 * * 1', timeZone: 'UTC' },
      distribution: null,
      environment: ENV_PUBLIC_UID
    });
  });

  it('createMonitor omits environment when none is supplied and defaults the cron', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: { id: 'mon-uuid' } })
    );
    const { assets } = buildClient(fetchImpl);
    await assets.createMonitor('ws-1', 'mon', PUBLIC_UID, '');
    const body = parseEnvelope(fetchImpl.mock.calls[0]).body as Record<string, unknown>;
    expect(body.environment).toBeUndefined();
    expect(body.schedule).toEqual({ cronPattern: '0 0 * * 0', timeZone: 'UTC' });
  });

  it('listMonitors reads /jobTemplates and the flat collection uid', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: [{ id: 'mon1', name: 'm', active: true, collection: PUBLIC_UID }] })
    );
    const { assets } = buildClient(fetchImpl);
    const monitors = await assets.listMonitors();
    expect(monitors).toEqual([
      { uid: 'mon1', name: 'm', active: true, collectionUid: PUBLIC_UID, environmentUid: '' }
    ]);
    expect(parseEnvelope(fetchImpl.mock.calls[0]).path).toBe('/jobTemplates?workspace=ws-1&_etc=true');
  });

  it('findMonitorByCollection reads the per-collection jobTemplates route', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: [{ id: 'mon1', name: 'm', active: true, collection: PUBLIC_UID }] })
    );
    const { assets } = buildClient(fetchImpl);
    await expect(assets.findMonitorByCollection(PUBLIC_UID)).resolves.toEqual({
      uid: 'mon1',
      name: 'm'
    });
    expect(parseEnvelope(fetchImpl.mock.calls[0]).path).toBe(
      `/collections/${PUBLIC_UID}/jobTemplates?_etc=true`
    );
  });

  it('runMonitor posts to the jobTemplates jobs path', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    const { assets } = buildClient(fetchImpl);
    await assets.runMonitor('mon1');
    const env = parseEnvelope(fetchImpl.mock.calls[0]);
    expect(env.service).toBe('monitors');
    expect(env.method).toBe('post');
    expect(env.path).toBe('/jobTemplates/mon1/jobs');
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
