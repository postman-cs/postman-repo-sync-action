import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createPlatform,
  isModeledRepoSyncFakeRoute,
  REPO_SYNC_FAKE_ROUTES
} from './platform-fake.js';

interface ProxyRequest {
  service: string;
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, unknown>;
}

interface ManifestRoute {
  service: string;
  method: string;
  path: string;
  classification: string;
}

async function proxy(
  platform: ReturnType<typeof createPlatform>,
  request: ProxyRequest
): Promise<Response> {
  return platform.fetch(`${platform.hosts.bifrost}/ws/proxy`, {
    method: 'POST',
    body: JSON.stringify(request)
  });
}

function cassetteRoute(key: string): { service: string; method: string; path: string } {
  const proxyMatch = /^proxy:([^ ]+) ([A-Z]+) ([^ #]+)/.exec(key);
  if (proxyMatch) {
    return { service: proxyMatch[1]!, method: proxyMatch[2]!, path: proxyMatch[3]! };
  }
  const directMatch = /^([A-Z]+) (https:\/\/[^ #]+)/.exec(key);
  if (!directMatch) throw new Error(`Unparseable cassette key: ${key}`);
  const url = new URL(directMatch[2]!);
  const service =
    url.hostname === 'api.getpostman.com'
      ? 'postman-api'
      : url.hostname === 'iapub.postman.co'
        ? 'iapub'
        : url.hostname;
  return { service, method: directMatch[1]!, path: `${url.pathname}${url.search}` };
}

describe('contract: platform fake routing', () => {
  it('fails loudly when proxied traffic does not match a modeled route', async () => {
    const platform = createPlatform();

    await expect(
      platform.fetch(`${platform.hosts.bifrost}/ws/proxy`, {
        method: 'POST',
        body: JSON.stringify({
          service: 'mock',
          method: 'PATCH',
          path: '/mocks/unmodeled'
        })
      })
    ).rejects.toThrow(
      /Unmatched repo-sync platform fake request: mock PATCH \/mocks\/unmodeled.*Nearest modeled route:/s
    );
  });

  it('fails loudly on unknown services and methods', async () => {
    const platform = createPlatform();

    await expect(
      proxy(platform, { service: 'unknown-service', method: 'get', path: '/mocks' })
    ).rejects.toThrow(/Unmatched repo-sync platform fake request: unknown-service GET \/mocks/);

    await expect(
      proxy(platform, { service: 'mock', method: 'put', path: '/mocks' })
    ).rejects.toThrow(/Unmatched repo-sync platform fake request: mock PUT \/mocks/);
  });

  it('rejects query and body shape drift on otherwise known routes', async () => {
    const platform = createPlatform();

    await expect(
      proxy(platform, {
        service: 'mock',
        method: 'get',
        path: '/mocks?workspace=ws-contract&unexpected=true'
      })
    ).rejects.toThrow(/query or body shape did not match/);

    await expect(
      proxy(platform, {
        service: 'monitors',
        method: 'post',
        path: '/jobTemplates?workspace=ws-contract',
        body: []
      })
    ).rejects.toThrow(/query or body shape did not match/);
  });

  it('models every manifest-simulated route and every committed cassette route', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, 'route-manifest.json'), 'utf8')
    ) as { routes: ManifestRoute[] };
    const simulated = manifest.routes.filter((route) => route.classification === 'simulated');
    expect(simulated).toHaveLength(11);
    expect(
      simulated.filter(
        (route) => !isModeledRepoSyncFakeRoute(route.service, route.method, route.path)
      )
    ).toEqual([]);

    const cassette = JSON.parse(
      readFileSync(join(import.meta.dirname, 'cassettes', 'repo-sync-wire.json'), 'utf8')
    ) as { interactions: Array<{ key: string }> };
    const cassetteRoutes = cassette.interactions.map((interaction) => cassetteRoute(interaction.key));
    expect(
      cassetteRoutes.filter(
        (route) => !isModeledRepoSyncFakeRoute(route.service, route.method, route.path)
      )
    ).toEqual([]);
    expect(REPO_SYNC_FAKE_ROUTES.length).toBeGreaterThanOrEqual(simulated.length);
  });

  it('paginates list state with opaque cursors', async () => {
    const platform = createPlatform({
      pageSize: 1,
      existingMocks: [
        { id: 'mock-a', name: 'A', collection: 'col-a', environment: 'env-a' },
        { id: 'mock-b', name: 'B', collection: 'col-b', environment: 'env-b' },
        { id: 'mock-c', name: 'C', collection: 'col-c', environment: 'env-c' }
      ]
    });

    const first = (await (
      await proxy(platform, { service: 'mock', method: 'get', path: '/mocks?workspace=ws-contract' })
    ).json()) as { data: Array<{ id: string }>; meta: { cursor: { next: string } } };
    const second = (await (
      await proxy(platform, {
        service: 'mock',
        method: 'get',
        path: '/mocks?workspace=ws-contract',
        query: { cursor: first.meta.cursor.next }
      })
    ).json()) as { data: Array<{ id: string }>; meta: { cursor: { next: string } } };
    const third = (await (
      await proxy(platform, {
        service: 'mock',
        method: 'get',
        path: '/mocks?workspace=ws-contract',
        query: { cursor: second.meta.cursor.next }
      })
    ).json()) as { data: Array<{ id: string }>; meta: { cursor: { next: string } } };

    expect([...first.data, ...second.data, ...third.data].map((entry) => entry.id)).toEqual([
      'mock-a',
      'mock-b',
      'mock-c'
    ]);
    expect(first.meta.cursor.next).not.toBe('');
    expect(second.meta.cursor.next).not.toBe(first.meta.cursor.next);
    expect(third.meta.cursor.next).toBe('');
    expect(platform.state.paginationCursorsIssued).toBe(2);
  });

  it('rejects malformed, mismatched, and expired list cursors', async () => {
    const platform = createPlatform();
    const opaqueCursor = (payload: string) => Buffer.from(payload, 'utf8').toString('base64url');
    const cases = [
      { name: 'malformed base64 payload', cursor: 'not-a-valid-cursor', error: 'Invalid mock-list cursor' },
      { name: 'malformed JSON payload', cursor: opaqueCursor('{not-json'), error: 'Invalid mock-list cursor' },
      {
        name: 'wrong cursor kind',
        cursor: opaqueCursor('{"kind":"monitor-list","sequence":1,"offset":0}'),
        error: 'Invalid mock-list cursor'
      },
      {
        name: 'non-integer offset',
        cursor: opaqueCursor('{"kind":"mock-list","sequence":1,"offset":1.5}'),
        error: 'Invalid mock-list cursor'
      },
      {
        name: 'negative offset',
        cursor: opaqueCursor('{"kind":"mock-list","sequence":1,"offset":-1}'),
        error: 'Invalid mock-list cursor'
      },
      {
        name: 'unknown snapshot',
        cursor: opaqueCursor('{"kind":"mock-list","sequence":999,"offset":0}'),
        error: 'Expired mock-list cursor'
      }
    ];

    for (const testCase of cases) {
      await expect(
        proxy(platform, {
          service: 'mock',
          method: 'get',
          path: '/mocks?workspace=ws-contract',
          query: { cursor: testCase.cursor }
        })
      ).rejects.toThrow(testCase.error);
    }
  });

  it('models populated Sync reads while collection root/PATCH routes require public UIDs', async () => {
    const bareId = '6b9b8a7c-1111-4222-8333-444455556666';
    const publicUid = `132319-${bareId}`;
    const platform = createPlatform({
      existingCollections: [{ id: bareId, ownerId: 132319 }]
    });

    const deniedRootGet = await proxy(platform, {
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${bareId}`
    });
    expect(deniedRootGet.status).toBe(403);

    // Bare PATCH is denied.
    const deniedPatch = await proxy(platform, {
      service: 'collection',
      method: 'patch',
      path: `/v3/collections/${bareId}`,
      body: [{ op: 'add', path: '/scripts', value: [] }]
    });
    expect(deniedPatch.status).toBe(403);
    await expect(deniedPatch.json()).resolves.toEqual({
      error: {
        code: 'FORBIDDEN',
        message: `Access to the requested resource "${bareId}" has been denied`
      }
    });

    // Public-UID populated Sync GET succeeds and projects a full v2.1 model.
    const allowedGet = await proxy(platform, {
      service: 'sync',
      method: 'get',
      path: `/collection/${publicUid}`,
      query: { populate: 'true', format: '2.1.0', uid: 'false' }
    });
    expect(allowedGet.status).toBe(200);
    await expect(allowedGet.json()).resolves.toMatchObject({
      data: {
        info: {
          name: 'baseline',
          _postman_id: bareId,
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
        },
        item: []
      }
    });

    const allowedRootGet = await proxy(platform, {
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${publicUid}`
    });
    expect(allowedRootGet.status).toBe(200);
    await expect(allowedRootGet.json()).resolves.toMatchObject({ data: { id: publicUid } });

    // Public-UID PATCH succeeds and persists scripts.
    const scripts = [{ type: 'http:beforeRequest', code: 'console.log("hook")', language: 'text/javascript' }];
    const allowedPatch = await proxy(platform, {
      service: 'collection',
      method: 'patch',
      path: `/v3/collections/${publicUid}`,
      body: [
        { op: 'test', path: '/scripts', value: [] },
        { op: 'add', path: '/scripts/-', value: scripts[0] }
      ]
    });
    expect(allowedPatch.status).toBe(200);
    await expect(allowedPatch.json()).resolves.toMatchObject({
      data: { id: publicUid, scripts }
    });

    // Subsequent public root GET readback contains the persisted scripts.
    const readback = await proxy(platform, {
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${publicUid}`
    });
    const body = (await readback.json()) as { data: { scripts: unknown } };
    expect(body.data.scripts).toEqual(scripts);
  });

  it('returns 403 instead of deleting a collection owned by another user', async () => {
    const platform = createPlatform({
      userId: 123,
      existingCollections: [{ id: '999-foreign', ownerId: 999 }]
    });

    const denied = await proxy(platform, {
      service: 'collection',
      method: 'delete',
      path: '/v3/collections/999-foreign'
    });
    expect(denied.status).toBe(403);
    expect(platform.state.collections.map((entry) => entry.id)).toContain('999-foreign');
    expect(platform.state.deletionLedger).toEqual([
      { service: 'collection', id: '999-foreign', status: 403 }
    ]);
  });
});
