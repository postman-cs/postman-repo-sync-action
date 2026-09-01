import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient, HttpError } from '@postman-cs/automation-core';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import {
  PRIVATE_MOCK_AUTH_ROOT_MARKER,
  PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
  PRIVATE_MOCK_AUTH_ROOT_TYPE
} from '../src/lib/postman/private-mock-auth-script.js';
import { createMutableSecretMasker } from '../src/lib/secrets.js';

function bifrostDeleteHttpError(status: number, responseBody: string): HttpError {
  return new HttpError({
    method: 'DELETE',
    url: 'https://bifrost.example.com/ws/proxy',
    status,
    statusText: status === 500 ? 'Internal Server Error' : String(status),
    responseBody
  });
}

function bifrostPatchHttpError(status: number, responseBody: string): HttpError {
  return new HttpError({
    method: 'PATCH',
    url: 'https://bifrost.example.com/ws/proxy',
    status,
    statusText: status === 500 ? 'Internal Server Error' : String(status),
    responseBody
  });
}

type RootScript = { type: string; code: string; language: string };

function collectionRoot(scripts: RootScript[] | null | undefined = []) {
  return { data: { id: 'col-1', scripts } };
}

function scriptsAfterRootPatch(body: unknown): RootScript[] {
  const operations = body as Array<{
    op: string;
    path: string;
    value: RootScript[] | RootScript;
  }>;
  expect(operations).toHaveLength(2);
  expect(operations[0]).toMatchObject({ op: 'test', path: '/scripts' });
  expect(operations[1]).toMatchObject({ op: 'add', path: '/scripts/-' });
  return [
    ...((operations[0]?.value as RootScript[]) ?? []).map((script) => ({ ...script })),
    { ...(operations[1]?.value as RootScript) }
  ];
}

function rootPatchResponse(body: unknown) {
  return collectionRoot(scriptsAfterRootPatch(body));
}

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

  it('reads the one-page Spec Hub tree ROOT without legacy files calls', async () => {
    const requestJson = vi.fn(async (request: { path: string }) => request.path.endsWith('/tree')
      ? { data: [{ id: 'root', type: 'FILE', fileType: 'ROOT', path: 'openapi.yaml', content: 'openapi: 3.0.0' }] }
      : null);
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
    await expect(assets.getSpecContent('spec')).resolves.toBe('openapi: 3.0.0');
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('follows tree cursors, rejects repeats/caps, and never falls back after semantic invalidity', async () => {
    const paged = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: 'a', type: 'FILE', fileType: 'OTHER', path: 'a.yaml', content: 'a' }], meta: { cursor: { next: 'next' } } })
      .mockResolvedValueOnce({ data: [{ id: 'root', type: 'FILE', fileType: 'ROOT', path: 'root.yaml', content: 'root' }] });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson: paged } as never, workspaceId: 'ws' });
    await expect(assets.getSpecContent('spec')).resolves.toBe('root');
    expect(paged).toHaveBeenCalledTimes(2);
    const repeated = vi.fn(async () => ({ data: [], meta: { cursor: { next: 'same' } } }));
    await expect(new PostmanGatewayAssetsClient({ gateway: { requestJson: repeated } as never, workspaceId: 'ws' }).getSpecContent('spec')).rejects.toThrow('SPEC_TREE_CURSOR_REPEATED');
    const invalid = vi.fn(async (request: { path: string }) => request.path.endsWith('/tree') ? { data: [{ id: 'root', type: 'FILE', fileType: 'ROOT', path: '../bad', content: 'x' }] } : { data: [] });
    await expect(new PostmanGatewayAssetsClient({ gateway: { requestJson: invalid } as never, workspaceId: 'ws' }).getSpecContent('spec')).rejects.toThrow('CONTRACT_DEFINITION_PATH_INVALID');
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it('uses the legacy file route once only for an incomplete or capability-missing tree', async () => {
    const incomplete = vi.fn(async (request: { path: string }) => request.path.endsWith('/tree') ? { data: [{}] } : request.path.endsWith('/files') ? { data: [{ id: 'root', type: 'ROOT' }] } : { data: { content: 'legacy' } });
    await expect(new PostmanGatewayAssetsClient({ gateway: { requestJson: incomplete } as never, workspaceId: 'ws' }).getSpecContent('spec')).resolves.toBe('legacy');
    expect(incomplete.mock.calls.filter(([r]) => String((r as { path: string }).path).includes('/files')).length).toBe(2);
  });

  it('normalizes production-shaped nameless specification collection relations', async () => {
    const requestJson = vi.fn().mockResolvedValue({
      data: [{
        collection: '12345678-abcd-ef01-2345-678901234567',
        state: 'out-of-sync',
        options: { parameters: {} }
      }]
    });
    const assets = new PostmanGatewayAssetsClient({
      gateway: { requestJson } as never,
      workspaceId: 'ws'
    });

    await expect(assets.listSpecCollections('spec-1')).resolves.toEqual([{
      uid: '12345678-abcd-ef01-2345-678901234567',
      name: ''
    }]);
    expect(requestJson).toHaveBeenCalledWith({
      service: 'specification',
      method: 'get',
      path: '/specifications/spec-1/collections'
    });
  });

  it('rejects a malformed specification relation instead of authorizing a partial parent inventory', async () => {
    const requestJson = vi.fn().mockResolvedValue({
      data: [
        { collection: 'valid-relation' },
        { collection: 'unsafe/relation' }
      ]
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.listSpecCollections('spec-1')).rejects.toThrow(/Specification collection UID/);
  });

  it('drains the authoritative workspace collection inventory without using export routes', async () => {
    const requestJson = vi.fn()
      .mockResolvedValueOnce({
        data: [{ id: PUBLIC_UID, name: 'Payments - Baseline' }],
        meta: { pagination: { nextPage: 'collections-page-2', pageSize: 100 } }
      })
      .mockResolvedValueOnce({
        data: [{ uid: '10490519-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Payments - Smoke' }],
        meta: { pagination: { nextPage: null, pageSize: 100 } }
      });
    const assets = new PostmanGatewayAssetsClient({
      gateway: { requestJson } as never,
      workspaceId: 'ws-1'
    });

    await expect(assets.listCollections('ws-1')).resolves.toEqual([
      { uid: PUBLIC_UID, name: 'Payments - Baseline' },
      { uid: '10490519-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Payments - Smoke' }
    ]);
    expect(requestJson).toHaveBeenNthCalledWith(1, {
      service: 'collection', method: 'get', path: '/v3/collections/?workspace=ws-1'
    });
    expect(requestJson).toHaveBeenNthCalledWith(2, {
      service: 'collection', method: 'get', path: '/v3/collections/?workspace=ws-1',
      query: { cursor: 'collections-page-2' }
    });
    expect(requestJson.mock.calls.every(([request]) => !String(request.path).includes('/export'))).toBe(true);
  });

  it('accepts the cursor.next collection-list envelope and rejects repeated cursors', async () => {
    const requestJson = vi.fn()
      .mockResolvedValueOnce({ data: [], meta: { cursor: { next: 'next' } } })
      .mockResolvedValueOnce({ data: [], meta: { cursor: { next: 'next' } } });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.listCollections('ws')).rejects.toThrow('COLLECTION_LIST_CURSOR_REPEATED');
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it('drains a flattened nextCursor envelope without treating page one as complete', async () => {
    const requestJson = vi.fn()
      .mockResolvedValueOnce({ data: [], nextCursor: 'next' })
      .mockResolvedValueOnce({ data: [{ id: PUBLIC_UID, name: 'Payments' }] });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.listCollections('ws')).resolves.toEqual([{ uid: PUBLIC_UID, name: 'Payments' }]);
    expect(requestJson).toHaveBeenNthCalledWith(2, expect.objectContaining({ query: { cursor: 'next' } }));
  });

  it.each([
    ['missing data array', {}],
    ['non-object row', { data: ['bad'] }],
    ['missing row UID', { data: [{ name: 'Payments' }] }],
    ['missing row name', { data: [{ id: PUBLIC_UID }] }],
    ['unsafe row UID', { data: [{ id: 'bad/id', name: 'Payments' }] }],
    ['malformed pagination envelope', { data: [], meta: { pagination: [] } }],
    ['malformed next cursor', { data: [], meta: { pagination: { nextPage: 42 } } }],
    ['conflicting cursor envelopes', { data: [], meta: { pagination: { nextPage: 'a' }, cursor: { next: 'b' } } }]
  ])('rejects a %s in the collection inventory', async (_label, response) => {
    const requestJson = vi.fn().mockResolvedValue(response);
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.listCollections('ws')).rejects.toThrow(/COLLECTION_LIST_(?:RESPONSE|CURSOR)/);
  });

  it('fails closed at the collection-list page ceiling', async () => {
    let page = 0;
    const requestJson = vi.fn(async () => ({
      data: [{ id: `col-${page}`, name: `Collection ${page}` }],
      meta: { pagination: { nextPage: `cursor-${++page}` } }
    }));
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.listCollections('ws')).rejects.toThrow('COLLECTION_LIST_PAGE_LIMIT_EXCEEDED');
    expect(requestJson).toHaveBeenCalledTimes(100);
  });

  it('rejects an unsafe workspace UID before collection inventory transport', async () => {
    const requestJson = vi.fn();
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.listCollections('ws?other=1')).rejects.toThrow(/Workspace UID/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('createMock references the collection + environment by their full public uids (no model-id strip)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValue(jsonResponse({ id: 'mock-uuid', name: 'm', collection: PUBLIC_UID, environment: ENV_PUBLIC_UID, url: 'https://mock-uuid.mock.pstmn.io', published: true }));
    const { assets } = buildClient(fetchImpl);

    await assets.createMock('ws-1', 'm', PUBLIC_UID, ENV_PUBLIC_UID, 'public');

    const env = parseEnvelope(fetchImpl.mock.calls[1]);
    // public uid passed straight through — the bare model id 403s the mock service
    expect((env.body as Record<string, unknown>).collection).toBe(PUBLIC_UID);
    expect((env.body as Record<string, unknown>).environment).toBe(ENV_PUBLIC_UID);
  });

  it('createMock defaults to a private mock and sends the live-probed bare body', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValue(
        jsonResponse({ id: 'mock-uuid', name: 'm', url: 'https://mock-uuid.mock.pstmn.io', collection: 'col-1', published: false })
      );
    const { assets } = buildClient(fetchImpl);

    const result = await assets.createMock('ws-1', 'm', 'col-1', '');
    expect(result).toEqual({ uid: 'mock-uuid', url: 'https://mock-uuid.mock.pstmn.io', visibility: 'private' });

    const env = parseEnvelope(fetchImpl.mock.calls[1]);
    expect(env.service).toBe('mock');
    expect(env.method).toBe('post');
    expect(env.path).toBe('/mocks?workspace=ws-1');
    // bare body, NOT wrapped in { mock: { ... } }
    expect(env.body).toEqual({ name: 'm', collection: 'col-1', private: true });
    const headers = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-access-token']).toBe('tok-initial');
    expect(headers['X-Api-Key']).toBeUndefined();
  });

  it('createMock refuses a mock the service reports as public under the private default', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValue(
        jsonResponse({ id: 'mock-public', name: 'm', collection: 'col-1', url: 'https://mock-public.mock.pstmn.io', published: true })
      );
    const { assets } = buildClient(fetchImpl);

    await expect(assets.createMock('ws-1', 'm', 'col-1', '')).rejects.toThrow(
      /MOCK_NOT_PRIVATE.*mock-public/
    );
  });

  it('createMock requests and accepts a public mock only when explicitly configured', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValue(
        jsonResponse({ id: 'mock-public', name: 'm', collection: 'col-1', url: 'https://mock-public.mock.pstmn.io', published: true })
      );
    const { assets } = buildClient(fetchImpl);

    await expect(assets.createMock('ws-1', 'm', 'col-1', '', 'public')).resolves.toEqual({
      uid: 'mock-public',
      url: 'https://mock-public.mock.pstmn.io',
      visibility: 'public'
    });
    expect(parseEnvelope(fetchImpl.mock.calls[1]).body).toEqual({
      name: 'm',
      collection: 'col-1',
      private: false
    });
  });

  it('keeps the owner-prefixed UID on private-mock collection root reads and writes', async () => {
    const requestJson = vi.fn(async (request: { method: string; path: string; body?: unknown }) => {
      if (request.method === 'get' && request.path === `/v3/collections/${PUBLIC_UID}`) {
        return collectionRoot([]);
      }
      if (request.method === 'patch' && request.path === `/v3/collections/${PUBLIC_UID}`) {
        return rootPatchResponse(request.body);
      }
      const id = request.path.split('/').filter(Boolean).at(-1);
      throw bifrostPatchHttpError(
        403,
        JSON.stringify({
          error: {
            code: 'FORBIDDEN',
            message: `Access to the requested resource "${id}" has been denied`
          }
        })
      );
    });
    const assets = new PostmanGatewayAssetsClient({
      gateway: { requestJson } as never,
      workspaceId: 'ws'
    });

    await expect(assets.configurePrivateMockRuntimeAuth(PUBLIC_UID)).resolves.toBe(1);
    expect(requestJson.mock.calls.map(([request]) => request.path)).toEqual([
      `/v3/collections/${PUBLIC_UID}`,
      `/v3/collections/${PUBLIC_UID}`
    ]);
  });

  it('rejects a bare collection model ID before addressing a private-mock root route', async () => {
    const bareId = PUBLIC_UID.split('-').slice(1).join('-');
    const requestJson = vi.fn();
    const assets = new PostmanGatewayAssetsClient({
      gateway: { requestJson } as never,
      workspaceId: 'ws'
    });

    await expect(assets.configurePrivateMockRuntimeAuth(bareId)).rejects.toThrow(
      /COLLECTION_ROOT_UID_REQUIRED/
    );
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('adds an idempotent private-mock runtime hook at the collection root without persisting a credential', async () => {
    const requestJson = vi.fn(async (request: { method: string; path: string; body?: unknown }) => {
      if (request.method === 'get') {
        return collectionRoot([
          { type: 'http:afterResponse', code: 'pm.test("ok")', language: 'text/javascript' }
        ]);
      }
      return rootPatchResponse(request.body);
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);
    const patch = requestJson.mock.calls.find(([request]) => request.method === 'patch')?.[0];
    const serialized = JSON.stringify(patch?.body);
    expect(serialized).toContain('postmanPrivateMockApiKey');
    expect(serialized).toContain('x-api-key');
    expect(serialized).toContain('replaceIn');
    expect(serialized).toContain(PRIVATE_MOCK_AUTH_ROOT_MARKER);
    expect(serialized).toContain('http:afterResponse');
    expect(serialized).not.toContain('pmak-');
    expect(requestJson.mock.calls.some(([request]) => request.method === 'patch' && String(request.path ?? '').includes('/items/'))).toBe(false);

    const scripts = scriptsAfterRootPatch(patch?.body);
    const code = scripts.find((script) => script.type === PRIVATE_MOCK_AUTH_ROOT_TYPE)?.code ?? '';
    const mockUpsert = vi.fn();
    runInNewContext(code, {
      URL,
      pm: {
        variables: {
          get: () => 'test-private-mock-key',
          replaceIn: (value: string) => value.replace('{{baseUrl}}', 'https://example.mock.pstmn.io')
        },
        request: {
          url: {
            getHost: () => ['{{baseUrl}}'],
            toString: () => '{{baseUrl}}/orders'
          },
          headers: { upsert: mockUpsert }
        }
      }
    });
    expect(mockUpsert).toHaveBeenCalledWith({
      key: 'x-api-key',
      value: 'test-private-mock-key'
    });

    const apiUpsert = vi.fn();
    runInNewContext(code, {
      URL,
      pm: {
        variables: {
          get: () => 'test-private-mock-key',
          replaceIn: (value: string) => value.replace('{{baseUrl}}', 'https://api.getpostman.com')
        },
        request: {
          url: {
            getHost: () => ['{{baseUrl}}'],
            toString: () => '{{baseUrl}}/collections'
          },
          headers: { upsert: apiUpsert }
        }
      }
    });
    expect(apiUpsert).not.toHaveBeenCalled();
  });

  it('preserves pre-existing customer root http:beforeRequest code as a separate listener ahead of the managed hook', async () => {
    const authorLine = 'var callerOwned = true;';
    const customerRootScript = {
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: authorLine,
      language: 'text/javascript'
    };

    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        return collectionRoot([customerRootScript]);
      }
      return rootPatchResponse(request.body);
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);

    const patch = requestJson.mock.calls.find(([request]) => request.method === 'patch')?.[0];
    const scripts = scriptsAfterRootPatch(patch?.body);
    const beforeScripts = scripts.filter((script) => script.type === PRIVATE_MOCK_AUTH_ROOT_TYPE);

    expect(beforeScripts).toHaveLength(2);
    expect(beforeScripts[0]?.code).toBe(authorLine);
    expect(beforeScripts[1]?.code).toBe(PRIVATE_MOCK_AUTH_ROOT_SCRIPT);
    expect(beforeScripts[1]?.code).toContain(PRIVATE_MOCK_AUTH_ROOT_MARKER);
    expect(requestJson.mock.calls.some(([request]) => request.method === 'patch' && String(request.path ?? '').includes('/items/'))).toBe(false);
  });

  it('leaves the collection untouched when the exact managed root hook is already installed', async () => {
    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        return collectionRoot([
          {
            type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
            code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
            language: 'text/javascript'
          }
        ]);
      }
      return rootPatchResponse(request.body);
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(0);
    expect(requestJson.mock.calls.some(([request]) => request.method === 'patch')).toBe(false);
  });

  it('preserves marker-only corrupt root listeners and appends one exact managed hook', async () => {
    const corrupt = `// ${PRIVATE_MOCK_AUTH_ROOT_MARKER}\nvar privateMockApiKey = 1;`;
    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        return collectionRoot([
          {
            type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
            code: corrupt,
            language: 'text/javascript'
          }
        ]);
      }
      return rootPatchResponse(request.body);
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);

    const patch = requestJson.mock.calls.find(([request]) => request.method === 'patch')?.[0];
    const scripts = scriptsAfterRootPatch(patch?.body);
    const beforeScripts = scripts.filter((script) => script.type === PRIVATE_MOCK_AUTH_ROOT_TYPE);

    expect(beforeScripts).toHaveLength(2);
    expect(beforeScripts[0]?.code).toBe(corrupt);
    expect(beforeScripts[1]?.code).toBe(PRIVATE_MOCK_AUTH_ROOT_SCRIPT);
  });

  it('warns instead of silently sending nothing when a private mock host has no key', async () => {
    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        return collectionRoot([]);
      }
      return rootPatchResponse(request.body);
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await assets.configurePrivateMockRuntimeAuth('owner-col-1');
    const patch = requestJson.mock.calls.find(([request]) => request.method === 'patch')?.[0];
    const code = JSON.stringify(patch?.body);

    expect(code).toContain('console.warn');
    expect(code).toContain('postmanPrivateMockApiKey');
    expect(code).toContain('replaceIn');
  });

  it('uses a trusted digest-bound root snapshot without any cloud read', async () => {
    const customer = {
      type: 'http:afterResponse',
      code: 'pm.test("customer", function () {});',
      language: 'text/javascript'
    };
    const requestJson = vi.fn(async (request: { method?: string; body?: unknown }) => {
      if (request.method !== 'patch') throw new Error('trusted snapshot must not read');
      return rootPatchResponse(request.body);
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(
      assets.configurePrivateMockRuntimeAuth('owner-col-1', [customer])
    ).resolves.toBe(1);

    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0][0].method).toBe('patch');
    expect(scriptsAfterRootPatch(requestJson.mock.calls[0][0].body)).toEqual([
      customer,
      {
        type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
        code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
        language: 'text/javascript'
      }
    ]);
  });

  it('does no cloud I/O when the trusted root snapshot already has the exact hook', async () => {
    const requestJson = vi.fn();
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
    const managed = {
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
      language: 'text/javascript'
    };

    await expect(
      assets.configurePrivateMockRuntimeAuth('owner-col-1', [managed])
    ).resolves.toBe(0);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('fails closed without cloud I/O when a trusted snapshot contains duplicate exact hooks', async () => {
    const requestJson = vi.fn();
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
    const managed = {
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
      language: 'text/javascript'
    };

    await expect(
      assets.configurePrivateMockRuntimeAuth('owner-col-1', [managed, { ...managed }])
    ).rejects.toThrow(/PRIVATE_MOCK_AUTH_ROOT_DUPLICATE/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('fails closed on a concurrent root edit that makes the JSON Patch test fail', async () => {
    const concurrent = {
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: 'console.log("concurrent customer edit");',
      language: 'text/javascript'
    };
    const requestJson = vi.fn(async (request: { method?: string }) => {
      if (request.method === 'patch') {
        throw bifrostPatchHttpError(409, '{"error":{"name":"REJECTED_PATCH"}}');
      }
      if (request.method === 'get') {
        return collectionRoot([concurrent]);
      }
      throw new Error('unexpected request');
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(
      assets.configurePrivateMockRuntimeAuth('owner-col-1', [])
    ).rejects.toMatchObject({ status: 409 });
    expect(requestJson.mock.calls.map(([request]) => request.method)).toEqual(['patch', 'get']);
  });

  it('accepts a prior partial run when JSON Patch test fails but root read proves the exact hook', async () => {
    const managed = {
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
      language: 'text/javascript'
    };
    const requestJson = vi.fn(async (request: { method?: string }) => {
      if (request.method === 'patch') {
        throw bifrostPatchHttpError(409, '{"error":{"name":"REJECTED_PATCH"}}');
      }
      return collectionRoot([managed]);
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(
      assets.configurePrivateMockRuntimeAuth('owner-col-1', [])
    ).resolves.toBe(0);
    expect(requestJson.mock.calls.map(([request]) => request.method)).toEqual(['patch', 'get']);
  });

  it.each([
    {
      name: 'an extra script after the expected managed hook',
      current: [
        { type: 'http:afterResponse', code: 'pm.test("original")', language: 'text/javascript' },
        {
          type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
          code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
          language: 'text/javascript'
        },
        { type: 'http:afterResponse', code: 'pm.test("concurrent extra")', language: 'text/javascript' }
      ]
    },
    {
      name: 'a replaced prior script before the expected managed hook',
      current: [
        { type: 'http:afterResponse', code: 'pm.test("replacement")', language: 'text/javascript' },
        {
          type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
          code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
          language: 'text/javascript'
        }
      ]
    }
  ])('rejects a snapshot conflict reconciled to $name', async ({ current }) => {
    const original = {
      type: 'http:afterResponse',
      code: 'pm.test("original")',
      language: 'text/javascript'
    };
    const requestJson = vi.fn(async (request: { method?: string }) => {
      if (request.method === 'patch') {
        throw bifrostPatchHttpError(409, '{"error":{"name":"REJECTED_PATCH"}}');
      }
      if (request.method === 'get') {
        return collectionRoot(current);
      }
      throw new Error('unexpected request');
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(
      assets.configurePrivateMockRuntimeAuth('owner-col-1', [original])
    ).rejects.toMatchObject({ status: 409 });
    expect(requestJson.mock.calls.map(([request]) => request.method)).toEqual(['patch', 'get']);
  });

  it.each([
    { data: null },
    { data: {} },
    { data: { scripts: 'not-an-array' } },
    collectionRoot([]),
    collectionRoot([
      {
        type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
        code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
        language: 'text/javascript'
      },
      { type: 'http:afterResponse', code: 'pm.test("unexpected extra")', language: 'text/javascript' }
    ]),
    collectionRoot([
      { type: 'http:afterResponse', code: 'pm.test("replacement")', language: 'text/javascript' },
      {
        type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
        code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
        language: 'text/javascript'
      }
    ])
  ])('rejects malformed or unverified root PATCH envelope %#', async (envelope) => {
    const requestJson = vi.fn(async (request: { method?: string }) => {
      if (request.method === 'get') return collectionRoot([]);
      return envelope;
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).rejects.toThrow(
      /PRIVATE_MOCK_AUTH_ROOT_PATCH_(?:INVALID|UNVERIFIED)|PRIVATE_MOCK_AUTH_ROOT_INVALID/
    );
  });

  it('reconciles an ambiguous root PATCH when the exact managed hook is already present after re-read', async () => {
    let rootReads = 0;
    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        rootReads += 1;
        if (rootReads === 1) {
          return collectionRoot([]);
        }
        return collectionRoot([
          {
            type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
            code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
            language: 'text/javascript'
          }
        ]);
      }
      if (request.method === 'patch') {
        throw bifrostPatchHttpError(500, '{"error":{"name":"serverError","details":"ESOCKETTIMEDOUT"}}');
      }
      return { data: {} };
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);
    expect(requestJson.mock.calls.filter(([request]) => request.method === 'patch').length).toBe(1);
  });

  it('retries exactly once when an ambiguous root PATCH leaves the exact original snapshot unchanged', async () => {
    let patchAttempts = 0;
    let rootReads = 0;
    const customer = {
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: 'var customer = true;',
      language: 'text/javascript'
    };
    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        rootReads += 1;
        return collectionRoot([customer]);
      }
      if (request.method === 'patch') {
        patchAttempts += 1;
        if (patchAttempts === 1) {
          throw bifrostPatchHttpError(500, '{"error":{"name":"serverError","details":"ESOCKETTIMEDOUT"}}');
        }
        return rootPatchResponse(request.body);
      }
      throw new Error('unexpected request');
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);
    expect(patchAttempts).toBe(2);
    expect(rootReads).toBe(2);

    const patchBodies = requestJson.mock.calls
      .filter(([request]) => request.method === 'patch')
      .map(([request]) => request.body);
    const firstScripts = scriptsAfterRootPatch(patchBodies[0]);
    const retryScripts = scriptsAfterRootPatch(patchBodies[1]);
    expect(retryScripts).toEqual(firstScripts);
    expect(retryScripts.some((script) => script.type === PRIVATE_MOCK_AUTH_ROOT_TYPE)).toBe(true);
    const retryCustomer = retryScripts.find((script) => script.code.includes('var customer'));
    const retryManaged = retryScripts.find((script) => script.code.includes(PRIVATE_MOCK_AUTH_ROOT_MARKER));
    expect(retryCustomer?.code).toBe(customer.code);
    expect(retryManaged?.code).toBe(PRIVATE_MOCK_AUTH_ROOT_SCRIPT);
    expect(
      requestJson.mock.calls.some(
        ([request]) => request.method === 'patch' && String(request.path ?? '').includes('/items/')
      )
    ).toBe(false);
  });

  it('accepts an ambiguous one-time resend only after a final stable read proves the exact result', async () => {
    let patchAttempts = 0;
    let rootReads = 0;
    const managed = {
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
      language: 'text/javascript'
    };
    const requestJson = vi.fn(async (request: { method?: string }) => {
      if (request.method === 'get') {
        rootReads += 1;
        return collectionRoot(rootReads < 3 ? [] : [managed]);
      }
      if (request.method === 'patch') {
        patchAttempts += 1;
        throw bifrostPatchHttpError(500, '{"error":{"name":"serverError","details":"ESOCKETTIMEDOUT"}}');
      }
      throw new Error('unexpected request');
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);
    expect(patchAttempts).toBe(2);
    expect(rootReads).toBe(3);
  });

  it('fails after one ambiguous resend when final stable read still shows the original scripts', async () => {
    let patchAttempts = 0;
    let rootReads = 0;
    const requestJson = vi.fn(async (request: { method?: string }) => {
      if (request.method === 'get') {
        rootReads += 1;
        return collectionRoot([]);
      }
      if (request.method === 'patch') {
        patchAttempts += 1;
        throw bifrostPatchHttpError(500, '{"error":{"name":"serverError","details":"ESOCKETTIMEDOUT"}}');
      }
      throw new Error('unexpected request');
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).rejects.toMatchObject({
      status: 500
    });
    expect(patchAttempts).toBe(2);
    expect(rootReads).toBe(3);
  });

  it.each([
    {
      name: 'an extra script',
      current: [
        { type: 'http:afterResponse', code: 'pm.test("original")', language: 'text/javascript' },
        { type: 'http:afterResponse', code: 'pm.test("concurrent extra")', language: 'text/javascript' }
      ]
    },
    {
      name: 'a replaced script',
      current: [
        { type: 'http:afterResponse', code: 'pm.test("replacement")', language: 'text/javascript' }
      ]
    }
  ])('fails closed when ambiguous PATCH reconciliation observes $name', async ({ current }) => {
    const original = {
      type: 'http:afterResponse',
      code: 'pm.test("original")',
      language: 'text/javascript'
    };
    let rootReads = 0;
    const requestJson = vi.fn(async (request: { method?: string }) => {
      if (request.method === 'get') {
        rootReads += 1;
        return collectionRoot(rootReads === 1 ? [original] : current);
      }
      if (request.method === 'patch') {
        throw bifrostPatchHttpError(500, '{"error":{"name":"serverError","details":"ESOCKETTIMEDOUT"}}');
      }
      throw new Error('unexpected request');
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).rejects.toThrow(
      /PRIVATE_MOCK_AUTH_ROOT_RECONCILE_DIVERGED/
    );
    expect(rootReads).toBe(2);
    expect(requestJson.mock.calls.filter(([request]) => request.method === 'patch')).toHaveLength(1);
  });

  it('second and third configurePrivateMockRuntimeAuth calls perform zero writes', async () => {
    let rootScripts: Array<{ type: string; code: string; language: string }> = [];
    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        return collectionRoot(rootScripts);
      }
      if (request.method === 'patch') {
        const scripts = scriptsAfterRootPatch(request.body);
        rootScripts = scripts.map((script) => ({ ...script }));
        return collectionRoot(rootScripts);
      }
      throw new Error('unexpected request');
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);
    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(0);
    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(0);

    const patches = requestJson.mock.calls.filter(([request]) => request.method === 'patch');
    expect(patches).toHaveLength(1);
    expect(patches.every(([request]) => !String(request.path ?? '').includes('/items/'))).toBe(true);
  });

  it('keeps customer root http:beforeRequest verbatim and unduplicated across re-runs', async () => {
    const authorLine = 'var callerOwned = true;';
    const customerRootScript = {
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: authorLine,
      language: 'text/javascript'
    };
    let rootScripts: Array<{ type: string; code: string; language: string }> = [customerRootScript];
    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        return collectionRoot(rootScripts);
      }
      if (request.method === 'patch') {
        const scripts = scriptsAfterRootPatch(request.body);
        rootScripts = scripts.map((script) => ({ ...script }));
        return collectionRoot(rootScripts);
      }
      throw new Error('unexpected request');
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);
    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(0);

    const beforeScripts = rootScripts.filter((script) => script.type === PRIVATE_MOCK_AUTH_ROOT_TYPE);
    expect(beforeScripts).toHaveLength(2);
    expect(beforeScripts[0]?.code).toBe(authorLine);
    expect(beforeScripts[1]?.code).toBe(PRIVATE_MOCK_AUTH_ROOT_SCRIPT);
    expect(requestJson.mock.calls.filter(([request]) => request.method === 'patch')).toHaveLength(1);
  });

  it('fails actionably when the collection root envelope is unexpected', async () => {
    for (const envelope of [{ unexpected: true }, { data: null }, null]) {
      const requestJson = vi.fn(async (request: { method?: string; path?: string }) => {
        if (request.method === 'get') {
          return envelope;
        }
        return { data: {} };
      });
      const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
      await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).rejects.toThrow(
        /PRIVATE_MOCK_AUTH_ROOT_INVALID: Collection owner-col-1 /
      );
      expect(requestJson.mock.calls.some(([request]) => request.method === 'patch')).toBe(false);
    }
  });

  it('preserves every customer http:beforeRequest root script ahead of one managed listener', async () => {
    const first = 'var firstCustomer = 1;';
    const second = 'var secondCustomer = 2;';
    const afterResponse = 'pm.test("untouched", function () {});';
    const originalScripts: Array<{ type: string; code: string; language: string }> = [
      { type: PRIVATE_MOCK_AUTH_ROOT_TYPE, code: first, language: 'text/javascript' },
      { type: PRIVATE_MOCK_AUTH_ROOT_TYPE, code: second, language: 'text/javascript' },
      { type: 'http:afterResponse', code: afterResponse, language: 'text/javascript' }
    ];
    let rootScripts: Array<{ type: string; code: string; language: string }> = originalScripts.map(
      (script) => ({ ...script })
    );
    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        return collectionRoot(rootScripts);
      }
      if (request.method === 'patch') {
        const scripts = scriptsAfterRootPatch(request.body);
        rootScripts = scripts.map((script) => ({ ...script }));
        return collectionRoot(rootScripts);
      }
      throw new Error('unexpected request');
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);
    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(0);

    const beforeScripts = rootScripts.filter((script) => script.type === PRIVATE_MOCK_AUTH_ROOT_TYPE);
    expect(beforeScripts.map((script) => script.code)).toEqual([
      first,
      second,
      PRIVATE_MOCK_AUTH_ROOT_SCRIPT
    ]);
    expect(rootScripts.filter((script) => script.type === 'http:afterResponse')).toEqual([
      { type: 'http:afterResponse', code: afterResponse, language: 'text/javascript' }
    ]);
    expect(requestJson.mock.calls.filter(([request]) => request.method === 'patch')).toHaveLength(1);
  });

  it('preserves every existing root listener in order and appends the managed hook', async () => {
    const first = 'var firstCustomer = 1;';
    const second = 'var secondCustomer = 2;';
    const third = 'var thirdCustomer = 3;';
    const afterResponse = 'pm.test("untouched", function () {});';
    const prerequest = 'console.log("also-untouched");';
    const originalScripts: Array<{ type: string; code: string; language: string }> = [
      { type: PRIVATE_MOCK_AUTH_ROOT_TYPE, code: first, language: 'text/javascript' },
      { type: 'http:afterResponse', code: afterResponse, language: 'text/javascript' },
      { type: PRIVATE_MOCK_AUTH_ROOT_TYPE, code: second, language: 'text/javascript' },
      { type: 'prerequest', code: prerequest, language: 'text/javascript' },
      { type: PRIVATE_MOCK_AUTH_ROOT_TYPE, code: third, language: 'text/javascript' }
    ];
    let rootScripts: Array<{ type: string; code: string; language: string }> = originalScripts.map(
      (script) => ({ ...script })
    );
    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        return collectionRoot(rootScripts);
      }
      if (request.method === 'patch') {
        const scripts = scriptsAfterRootPatch(request.body);
        rootScripts = scripts.map((script) => ({ ...script }));
        return collectionRoot(rootScripts);
      }
      throw new Error('unexpected request');
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);

    expect(rootScripts.map((script) => script.type)).toEqual([
      PRIVATE_MOCK_AUTH_ROOT_TYPE,
      'http:afterResponse',
      PRIVATE_MOCK_AUTH_ROOT_TYPE,
      'prerequest',
      PRIVATE_MOCK_AUTH_ROOT_TYPE,
      PRIVATE_MOCK_AUTH_ROOT_TYPE
    ]);
    const beforeScripts = rootScripts.filter((script) => script.type === PRIVATE_MOCK_AUTH_ROOT_TYPE);
    expect(beforeScripts.map((script) => script.code)).toEqual([
      first,
      second,
      third,
      PRIVATE_MOCK_AUTH_ROOT_SCRIPT
    ]);
    expect(rootScripts.filter((script) => script.type === 'http:afterResponse')).toEqual([
      { type: 'http:afterResponse', code: afterResponse, language: 'text/javascript' }
    ]);
    expect(rootScripts.filter((script) => script.type === 'prerequest')).toEqual([
      { type: 'prerequest', code: prerequest, language: 'text/javascript' }
    ]);
  });

  it('keeps customer listeners separate so duplicate lexical declarations remain runnable', async () => {
    const first = 'const shared = 1;';
    const second = 'const shared = 2;';
    const originalScripts = [
      { type: PRIVATE_MOCK_AUTH_ROOT_TYPE, code: first, language: 'text/javascript' },
      { type: PRIVATE_MOCK_AUTH_ROOT_TYPE, code: second, language: 'text/javascript' }
    ];
    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        return collectionRoot(originalScripts);
      }
      return rootPatchResponse(request.body);
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);

    const patch = requestJson.mock.calls.find(([request]) => request.method === 'patch')?.[0];
    const scripts = scriptsAfterRootPatch(patch?.body);
    const beforeScripts = scripts.filter((script) => script.type === PRIVATE_MOCK_AUTH_ROOT_TYPE);

    expect(beforeScripts.map((script) => script.code)).toEqual([
      first,
      second,
      PRIVATE_MOCK_AUTH_ROOT_SCRIPT
    ]);
    expect(() => runInNewContext(beforeScripts[0]?.code ?? '', {})).not.toThrow();
    expect(() => runInNewContext(beforeScripts[1]?.code ?? '', {})).not.toThrow();
  });

  it.each([
    ['omitted', { data: { id: 'col-1' } }],
    ['undefined', { data: { id: 'col-1', scripts: undefined } }],
    ['empty', { data: { id: 'col-1', scripts: [] } }],
    ['null', { data: { id: 'col-1', scripts: null } }]
  ])(
    'uses the atomic empty-array guard for a %s collection root scripts field',
    async (_shape, envelope) => {
      const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
        if (request.method === 'get') {
          return envelope;
        }
        return rootPatchResponse(request.body);
      });
      const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
      await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).resolves.toBe(1);
      const patch = requestJson.mock.calls.find(([request]) => request.method === 'patch')?.[0];
      expect(patch?.body).toEqual([
        { op: 'test', path: '/scripts', value: [] },
        {
          op: 'add',
          path: '/scripts/-',
          value: {
            type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
            code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
            language: 'text/javascript'
          }
        }
      ]);
    }
  );

  it.each([{ nope: true }, 'scripts', [null]])(
    'rejects malformed collection root scripts %j before PATCH',
    async (scripts) => {
      const requestJson = vi.fn(async (request: { method?: string }) => {
        if (request.method === 'get') return { data: { id: 'col-1', scripts } };
        throw new Error('PATCH must not run');
      });
      const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
      await expect(assets.configurePrivateMockRuntimeAuth('owner-col-1')).rejects.toThrow(
        /PRIVATE_MOCK_AUTH_ROOT_INVALID/
      );
      expect(requestJson).toHaveBeenCalledTimes(1);
    }
  );

  it('PATCH body root type is http:beforeRequest, never bare beforeRequest', async () => {
    const requestJson = vi.fn(async (request: { method?: string; path?: string; body?: unknown }) => {
      if (request.method === 'get') {
        return collectionRoot([]);
      }
      return rootPatchResponse(request.body);
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
    await assets.configurePrivateMockRuntimeAuth('owner-col-1');
    const patch = requestJson.mock.calls.find(([request]) => request.method === 'patch')?.[0];
    const bodyScripts = scriptsAfterRootPatch(patch?.body);
    expect(bodyScripts.map((script) => script.type)).toEqual([PRIVATE_MOCK_AUTH_ROOT_TYPE]);
    expect(JSON.stringify(patch?.body)).not.toMatch(/"type"\s*:\s*"beforeRequest"/);
    expect(PRIVATE_MOCK_AUTH_ROOT_TYPE).toBe('http:beforeRequest');
  });

  it('createEnvironment returns the owner-prefixed public uid built from the import response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValue(
        jsonResponse({ data: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', owner: '10490519' } })
      );
    const { assets } = buildClient(fetchImpl);
    // bare model id from sync import -> public uid mock/monitor accept
    await expect(assets.createEnvironment('ws-1', 'e', [])).resolves.toBe(ENV_PUBLIC_UID);
    const env = parseEnvelope(fetchImpl.mock.calls[1]);
    expect(env.service).toBe('sync');
    expect(env.path).toBe('/environment/import?workspace=ws-1');
  });

  it('listMocks parses the bare-array mock service response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        { id: 'm1', name: 'a', collection: 'col-1', environment: 'env-1', url: 'https://m1.mock', published: true },
        { id: 'm2', name: 'b', collection: 'col-2', environment: '', url: 'https://m2.mock', published: false }
      ])
    );
    const { assets } = buildClient(fetchImpl);
    const mocks = await assets.listMocks();
    expect(mocks).toEqual([
      { uid: 'm1', name: 'a', collection: 'col-1', mockUrl: 'https://m1.mock', environment: 'env-1', visibility: 'public' },
      { uid: 'm2', name: 'b', collection: 'col-2', mockUrl: 'https://m2.mock', environment: '', visibility: 'private' }
    ]);
    expect(parseEnvelope(fetchImpl.mock.calls[0]).path).toBe('/mocks?workspace=ws-1');
  });

  it('listMocks preserves unknown visibility but rejects malformed envelopes and records', async () => {
    const unknownFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([{ id: 'm1', name: 'a', collection: 'col-1', url: 'https://m1.mock' }])
    );
    await expect(buildClient(unknownFetch).assets.listMocks()).resolves.toEqual([
      { uid: 'm1', name: 'a', collection: 'col-1', mockUrl: 'https://m1.mock', environment: '', visibility: 'unknown' }
    ]);

    const envelopeFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ unexpected: [] }));
    await expect(buildClient(envelopeFetch).assets.listMocks()).rejects.toThrow(
      /CONTRACT_MOCK_RESPONSE_INVALID.*list envelope/
    );

    const recordFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([{ id: 'm1', name: 'a', collection: 'col-1', published: true }])
    );
    await expect(buildClient(recordFetch).assets.listMocks()).rejects.toThrow(
      /CONTRACT_MOCK_RESPONSE_INVALID.*URL/
    );
  });

  it('findMockByCollection matches the public uid the mock list echoes', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([{ id: 'm1', name: 'a', collection: PUBLIC_UID, url: 'https://m1.mock', published: true }])
    );
    const { assets } = buildClient(fetchImpl);
    await expect(assets.findMockByCollection(PUBLIC_UID, '', 'a')).resolves.toEqual({
      uid: 'm1',
      name: 'a',
      collection: PUBLIC_UID,
      environment: '',
      mockUrl: 'https://m1.mock',
      visibility: 'public'
    });
  });

  it('createMonitor sends the jobTemplates schema (flat collection uid + full envelope) and parses data.id', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValue(
        jsonResponse({ meta: { action: 'create' }, data: { id: 'mon-uuid', name: 'mon' } })
      );
    const { assets } = buildClient(fetchImpl);

    const uid = await assets.createMonitor('ws-1', 'mon', PUBLIC_UID, ENV_PUBLIC_UID, '0 5 * * 1');
    expect(uid).toBe('mon-uuid');

    const env = parseEnvelope(fetchImpl.mock.calls[1]);
    expect(env.service).toBe('monitors');
    expect(env.path).toBe('/jobTemplates?workspace=ws-1');
    expect(env.body).toEqual({
      name: 'mon',
      collection: PUBLIC_UID,
      active: true,
      options: { strictSSL: false, followRedirects: true, requestTimeout: null, requestDelay: 0 },
      notifications: { onFailure: [], onError: [] },
      retry: {},
      schedule: { cronPattern: '0 5 * * 1', timeZone: 'UTC' },
      distribution: null,
      environment: ENV_PUBLIC_UID
    });
  });

  it('createMonitor sends an inactive body without schedule when cron is empty', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValue(jsonResponse({ data: { id: 'mon-uuid' } }));
    const { assets } = buildClient(fetchImpl);
    await assets.createMonitor('ws-1', 'mon', PUBLIC_UID, '');
    const body = parseEnvelope(fetchImpl.mock.calls[1]).body as Record<string, unknown>;
    expect(body.environment).toBeUndefined();
    expect(body.active).toBe(false);
    expect(body.schedule).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('0 0 * * 0');
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

  it('findMonitorByCollection reads the workspace-scoped jobTemplates route', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: [{ id: 'mon1', name: 'm', active: true, collection: PUBLIC_UID }] })
    );
    const { assets } = buildClient(fetchImpl);
    await expect(assets.findMonitorByCollection(PUBLIC_UID, '', 'm')).resolves.toEqual({
      uid: 'mon1',
      name: 'm'
    });
    expect(parseEnvelope(fetchImpl.mock.calls[0]).path).toBe('/jobTemplates?workspace=ws-1&_etc=true');
  });

  it('monitorExists returns false only when the explicit monitor lookup is a 404', async () => {
    const requestJson = vi.fn().mockRejectedValue(
      new HttpError({
        method: 'GET',
        url: 'https://bifrost.example.com/ws/proxy',
        status: 404,
        statusText: 'Not Found',
        responseBody: '{"error":{"message":"not found"}}'
      })
    );
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws-1' });

    await expect(assets.monitorExists('missing-monitor')).resolves.toBe(false);
    expect(requestJson).toHaveBeenCalledWith({
      service: 'monitors', method: 'get', path: '/jobTemplates/missing-monitor', query: { _etc: 'true' }
    });
  });

  it.each(['../whoami', 'id?_etc=false', 'id%2Fjobs', 'id&admin=true'])(
    'rejects unsafe monitor path segments before transport: %s',
    async (uid) => {
      const requestJson = vi.fn();
      const assets = new PostmanGatewayAssetsClient({
        gateway: { requestJson } as never,
        workspaceId: 'ws-1'
      });

      await expect(assets.monitorExists(uid)).rejects.toThrow(/safe path segment/);
      await expect(assets.runMonitor(uid)).rejects.toThrow(/safe path segment/);
      expect(requestJson).not.toHaveBeenCalled();
    }
  );

  it('rejects unsafe spec path segments before transport', async () => {
    const requestJson = vi.fn();
    const assets = new PostmanGatewayAssetsClient({
      gateway: { requestJson } as never,
      workspaceId: 'ws-1'
    });

    await expect(assets.deleteSpec('../victim')).rejects.toThrow(/safe path segment/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it.each([
    new HttpError({
      method: 'GET', url: 'https://bifrost.example.com/ws/proxy', status: 403,
      statusText: 'Forbidden', responseBody: '{"error":{"message":"forbidden"}}'
    }),
    new HttpError({
      method: 'GET', url: 'https://bifrost.example.com/ws/proxy', status: 500,
      statusText: 'Internal Server Error', responseBody: '{"error":{"message":"server error"}}'
    }),
    new Error('transport failed'),
    new SyntaxError('Unexpected token in monitor response')
  ])('monitorExists rethrows untrusted lookup failures', async (error) => {
    const requestJson = vi.fn().mockRejectedValue(error);
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws-1' });

    await expect(assets.monitorExists('untrusted-monitor')).rejects.toBe(error);
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

  const COLLECTION_BARE_ID = '12345678-abcd-ef01-2345-678901234567';
  const ESOCKET_500_BODY =
    '{"error":{"name":"serverError","details":"ESOCKETTIMEDOUT","source":"downstream"}}';
  const populatedCollection = (id = COLLECTION_BARE_ID) => ({
    info: {
      name: 'Payments',
      _postman_id: id,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    item: []
  });

  it('getCollection makes one retry-free populated Sync read for the full public UID', async () => {
    const requestJson = vi.fn(async (request: { path: string }) => {
      void request;
      return { data: populatedCollection() };
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.getCollection(PUBLIC_UID)).resolves.toEqual(populatedCollection());

    expect(requestJson).toHaveBeenCalledExactlyOnceWith({
      service: 'sync',
      method: 'get',
      path: `/collection/${PUBLIC_UID}`,
      query: { populate: 'true', format: '2.1.0', uid: 'false' },
      retry: 'none',
      fallback: 'none'
    });
    expect(requestJson.mock.calls.some(([request]) => String(request.path).includes('/export'))).toBe(false);
  });

  it.each([
    ['missing data', {}],
    ['non-object data', { data: [] }],
    ['missing info', { data: { item: [] } }],
    ['wrong schema', { data: { ...populatedCollection(), info: { ...populatedCollection().info, schema: 'https://example.test/v2' } } }],
    ['malformed item tree', { data: { ...populatedCollection(), item: [{ name: 'bad', item: 'not-an-array' }] } }],
    ['foreign identity', { data: populatedCollection('ffffffff-ffff-ffff-ffff-ffffffffffff') }]
  ])('getCollection rejects %s after one populated Sync read', async (_label, response) => {
    const requestJson = vi.fn(async () => response);
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.getCollection(PUBLIC_UID)).rejects.toThrow(/COLLECTION_SNAPSHOT_INVALID/);
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('getCollection surfaces a Sync 500 after exactly one request with no export fallback', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(JSON.parse(ESOCKET_500_BODY), { status: 500 })
    );
    const { assets } = buildClient(fetchImpl, { accessToken: 'tok-current' });

    await expect(assets.getCollection(PUBLIC_UID)).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parseEnvelope(fetchImpl.mock.calls[0]!)).toMatchObject({
      service: 'sync',
      method: 'get',
      path: `/collection/${PUBLIC_UID}`,
      query: { populate: 'true', format: '2.1.0', uid: 'false' }
    });
    expect(JSON.stringify(parseEnvelope(fetchImpl.mock.calls[0]!))).not.toContain('/export');
  });

  it('getCollection rejects a bare collection model ID before transport', async () => {
    const requestJson = vi.fn();
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.getCollection(COLLECTION_BARE_ID)).rejects.toThrow(/COLLECTION_ROOT_UID_REQUIRED/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('getCollection rejects unsafe UID values containing slash, query, or control characters before transport', async () => {
    const unsafe = [
      'owner-abc/def-1234-5678-90ab-cdef',
      'owner-abc?def-1234-5678-90ab-cdef',
      'owner-abc#def-1234-5678-90ab-cdef',
      `owner-abc\x00def-1234-5678-90ab-cdef`
    ];
    for (const uid of unsafe) {
      const requestJson = vi.fn();
      const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
      await expect(assets.getCollection(uid)).rejects.toThrow(/COLLECTION_ROOT_UID_INVALID/);
      expect(requestJson).not.toHaveBeenCalled();
    }
  });

  it('getCollection rejects backslash, percent-encoding, whitespace, ampersand, equals, and newline inputs before transport', async () => {
    const unsafe = [
      'owner-abc\\def-1234-5678-90ab-cdef',
      'owner-abc%2Fdef-1234-5678-90ab-cdef',
      'owner-abc def-1234-5678-90ab-cdef',
      'owner-abc\tdef-1234-5678-90ab-cdef',
      'owner-abc\ndef-1234-5678-90ab-cdef',
      'owner-abc&def-1234-5678-90ab-cdef',
      'owner-abc=def-1234-5678-90ab-cdef'
    ];
    for (const uid of unsafe) {
      const requestJson = vi.fn();
      const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
      await expect(assets.getCollection(uid)).rejects.toThrow(/COLLECTION_ROOT_UID_INVALID/);
      expect(requestJson).not.toHaveBeenCalled();
    }
  });

  it('getCollection error does not echo the raw unsafe UID value', async () => {
    const requestJson = vi.fn();
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
    const unsafe = 'owner-abc/def-1234-5678-90ab-cdef';
    await expect(assets.getCollection(unsafe)).rejects.toThrow(/COLLECTION_ROOT_UID_INVALID/);
    try {
      await assets.getCollection(unsafe);
    } catch (error) {
      expect(String(error)).not.toContain('abc/def');
    }
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('configurePrivateMockRuntimeAuth rejects backslash, percent-encoding, whitespace, ampersand, equals, and newline inputs before transport', async () => {
    const unsafe = [
      'owner-abc\\def-1234-5678-90ab-cdef',
      'owner-abc%2Fdef-1234-5678-90ab-cdef',
      'owner-abc def-1234-5678-90ab-cdef',
      'owner-abc\tdef-1234-5678-90ab-cdef',
      'owner-abc\ndef-1234-5678-90ab-cdef',
      'owner-abc&def-1234-5678-90ab-cdef',
      'owner-abc=def-1234-5678-90ab-cdef'
    ];
    for (const uid of unsafe) {
      const requestJson = vi.fn();
      const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
      await expect(assets.configurePrivateMockRuntimeAuth(uid)).rejects.toThrow(/COLLECTION_ROOT_UID_INVALID/);
      expect(requestJson).not.toHaveBeenCalled();
    }
  });

  it('configurePrivateMockRuntimeAuth error does not echo the raw unsafe UID value', async () => {
    const requestJson = vi.fn();
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });
    const unsafe = 'owner-abc/def-1234-5678-90ab-cdef';
    await expect(assets.configurePrivateMockRuntimeAuth(unsafe)).rejects.toThrow(/COLLECTION_ROOT_UID_INVALID/);
    try {
      await assets.configurePrivateMockRuntimeAuth(unsafe);
    } catch (error) {
      expect(String(error)).not.toContain('abc/def');
    }
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('configurePrivateMockRuntimeAuth sends the full UID to root GET/PATCH and disables retries', async () => {
    const requestJson = vi.fn(async (
      request: { method: string; path: string; body?: unknown },
      options?: { retryTransient?: boolean }
    ) => {
      if (options?.retryTransient !== false) {
        throw new Error('root operations must explicitly disable transient retries');
      }
      if (request.method === 'get' && request.path === `/v3/collections/${PUBLIC_UID}`) {
        return collectionRoot([]);
      }
      if (request.method === 'patch' && request.path === `/v3/collections/${PUBLIC_UID}`) {
        return rootPatchResponse(request.body);
      }
      throw new Error(`unexpected call: ${request.method} ${request.path}`);
    });
    const assets = new PostmanGatewayAssetsClient({ gateway: { requestJson } as never, workspaceId: 'ws' });

    await expect(assets.configurePrivateMockRuntimeAuth(PUBLIC_UID)).resolves.toBe(1);

    const paths = requestJson.mock.calls.map(([request]) => request.path);
    expect(paths).toEqual([
      `/v3/collections/${PUBLIC_UID}`,
      `/v3/collections/${PUBLIC_UID}`
    ]);
    expect(requestJson.mock.calls.map((call) => call[1])).toEqual([
      { retryTransient: false },
      { retryTransient: false }
    ]);
  });

  it('deleteCollection succeeds after a transient Bifrost 500 ESOCKETTIMEDOUT', async () => {
    const requestJson = vi
      .fn()
      .mockRejectedValueOnce(bifrostDeleteHttpError(500, ESOCKET_500_BODY))
      .mockResolvedValueOnce({});
    const assets = new PostmanGatewayAssetsClient({
      gateway: { requestJson } as never,
      workspaceId: 'ws',
      sleep: async () => undefined
    });

    await expect(assets.deleteCollection(PUBLIC_UID)).resolves.toBeUndefined();
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requestJson.mock.calls[0][0]).toEqual({
      service: 'collection',
      method: 'delete',
      path: `/v3/collections/${COLLECTION_BARE_ID}`
    });
    expect(requestJson.mock.calls[1][0]).toEqual(requestJson.mock.calls[0][0]);
  });

  it('deleteCollection exhausts the bounded transient retry budget then fails', async () => {
    const requestJson = vi
      .fn()
      .mockRejectedValue(bifrostDeleteHttpError(500, ESOCKET_500_BODY));
    const assets = new PostmanGatewayAssetsClient({
      gateway: { requestJson } as never,
      workspaceId: 'ws',
      sleep: async () => undefined
    });

    await expect(assets.deleteCollection(PUBLIC_UID)).rejects.toMatchObject({
      name: 'HttpError',
      status: 500
    });
    expect(requestJson).toHaveBeenCalledTimes(5);
  });

  it('deleteCollection treats 404 as idempotent success', async () => {
    const requestJson = vi
      .fn()
      .mockRejectedValueOnce(bifrostDeleteHttpError(404, '{"error":{"code":"RESOURCE_NOT_FOUND"}}'));
    const assets = new PostmanGatewayAssetsClient({
      gateway: { requestJson } as never,
      workspaceId: 'ws',
      sleep: async () => undefined
    });

    await expect(assets.deleteCollection(PUBLIC_UID)).resolves.toBeUndefined();
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('deleteCollection does not retry ordinary non-transient 4xx', async () => {
    const requestJson = vi
      .fn()
      .mockRejectedValueOnce(bifrostDeleteHttpError(403, '{"error":{"message":"forbidden"}}'));
    const assets = new PostmanGatewayAssetsClient({
      gateway: { requestJson } as never,
      workspaceId: 'ws',
      sleep: async () => undefined
    });

    await expect(assets.deleteCollection(PUBLIC_UID)).rejects.toMatchObject({
      name: 'HttpError',
      status: 403
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });
});
