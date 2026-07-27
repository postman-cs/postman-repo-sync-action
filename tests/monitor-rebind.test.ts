import { describe, expect, it, vi } from 'vitest';

import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';

/**
 * The canonical Smoke collection can legitimately change UID (a bootstrap
 * re-import after a stranger/marker miss, or an operator-driven rebuild). The
 * monitor is bound to the OLD collection UID, so a UID-triple-only discovery
 * misses and repo-sync creates a second monitor with the same name on every
 * run, orphaning the previous one. Discovery must fall back to the stable
 * (workspace, name, environment) identity and rebind the existing monitor to
 * the current collection instead of creating a duplicate.
 */

type Envelope = { service: string; method: string; path: string; body?: unknown };

const PUBLIC_UID = '56459175-2ee592aa-4e81-4df4-991b-b9f52d557354';
const STALE_UID = '56459175-b4d955a9-6b45-4fbb-98ed-90b19539786c';
const ENV_UID = '56459175-9bea9e67-6a75-4d9f-bfe1-d7a5a7215d97';
const OTHER_ENV_UID = '56459175-1c2d3e4f-5a6b-7c8d-9e0f-1a2b3c4d5e6f';
const MONITOR_NAME = '[PROJECT] Clean Harbors Drum API - Smoke Monitor';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function parseEnvelope(call: unknown[]): Envelope {
  const init = call[1] as RequestInit;
  const parsed = JSON.parse(String(init.body)) as Envelope;
  return parsed;
}

function buildClient(fetchImpl: typeof fetch) {
  const assets = new PostmanGatewayAssetsClient({
    gateway: {
      requestJson: async (envelope: Envelope) => {
        const response = await fetchImpl('https://gateway.test/invoke', {
          method: 'POST',
          body: JSON.stringify(envelope)
        });
        return (await response.json()) as never;
      }
    } as never,
    workspaceId: 'ws-1',
    sleep: async () => {}
  });
  return { assets };
}

describe('monitor replacement on canonical collection UID change', () => {
  it('creates the replacement before deleting the stale same-name monitor', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const envelope = JSON.parse(String((init as RequestInit).body)) as Envelope;
      if (envelope.method === 'get' && envelope.path.startsWith('/jobTemplates?workspace=')) {
        return jsonResponse({
          data: [
            {
              id: 'mon-existing',
              name: MONITOR_NAME,
              active: true,
              collection: STALE_UID,
              environment: ENV_UID,
              schedule: {
                cronPattern: '0 */6 * * *',
                timeZone: 'America/Chicago'
              },
              notifications: {
                onFailure: true,
                onSuccess: false
              },
              options: {
                followRedirects: true,
                timeout: 30000
              }
            }
          ]
        });
      }
      if (envelope.method === 'post' && envelope.path === '/jobTemplates?workspace=ws-1') {
        return jsonResponse({ data: { id: 'mon-replacement' } });
      }
      return jsonResponse({});
    });

    const { assets } = buildClient(fetchImpl);

    const rebound = await assets.rebindMonitorByName(MONITOR_NAME, PUBLIC_UID, ENV_UID, '0 */6 * * *');

    expect(rebound).toEqual({
      uid: 'mon-replacement',
      previousUid: 'mon-existing',
      previousCollectionUid: STALE_UID
    });

    const creates = fetchImpl.mock.calls
      .map((call) => parseEnvelope(call as unknown[]))
      .filter((envelope) => envelope.method === 'post' && envelope.path.startsWith('/jobTemplates?'));
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body).toMatchObject({
      name: MONITOR_NAME,
      collection: PUBLIC_UID,
      environment: ENV_UID,
      active: true,
      schedule: { cronPattern: '0 */6 * * *', timeZone: 'UTC' }
    });

    const deletes = fetchImpl.mock.calls
      .map((call) => parseEnvelope(call as unknown[]))
      .filter((envelope) => envelope.method === 'delete');
    expect(deletes).toEqual([
      expect.objectContaining({ path: '/jobTemplates/mon-existing' })
    ]);
    const unsupportedUpdates = fetchImpl.mock.calls
      .map((call) => parseEnvelope(call as unknown[]))
      .filter((envelope) => envelope.method === 'put' || envelope.method === 'patch');
    expect(unsupportedUpdates).toHaveLength(0);

    const mutations = fetchImpl.mock.calls
      .map((call) => parseEnvelope(call as unknown[]))
      .filter((envelope) => envelope.method === 'post' || envelope.method === 'delete');
    expect(mutations.map((envelope) => envelope.method)).toEqual(['post', 'delete']);
  });

  it('leaves the stale monitor intact when replacement creation fails', async () => {
    const createError = new Error('Monitoring API rejected replacement creation');
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const envelope = JSON.parse(String((init as RequestInit).body)) as Envelope;
      if (envelope.method === 'get' && envelope.path.startsWith('/jobTemplates?workspace=')) {
        return jsonResponse({
          data: [
            {
              id: 'mon-existing',
              name: MONITOR_NAME,
              active: true,
              collection: STALE_UID,
              environment: ENV_UID
            }
          ]
        });
      }
      if (envelope.method === 'post' && envelope.path === '/jobTemplates?workspace=ws-1') {
        throw createError;
      }
      return jsonResponse({});
    });
    const { assets } = buildClient(fetchImpl);

    await expect(assets.rebindMonitorByName(MONITOR_NAME, PUBLIC_UID, ENV_UID)).rejects.toBe(createError);

    const deletes = fetchImpl.mock.calls
      .map((call) => parseEnvelope(call as unknown[]))
      .filter((envelope) => envelope.method === 'delete');
    expect(deletes).toHaveLength(0);
  });

  it('surfaces stale-monitor deletion failure after creating one replacement', async () => {
    const deleteError = new Error('Monitoring API rejected stale monitor deletion');
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const envelope = JSON.parse(String((init as RequestInit).body)) as Envelope;
      if (envelope.method === 'get' && envelope.path.startsWith('/jobTemplates?workspace=')) {
        return jsonResponse({
          data: [
            {
              id: 'mon-existing',
              name: MONITOR_NAME,
              active: true,
              collection: STALE_UID,
              environment: ENV_UID
            }
          ]
        });
      }
      if (envelope.method === 'post' && envelope.path === '/jobTemplates?workspace=ws-1') {
        return jsonResponse({ data: { id: 'mon-replacement' } });
      }
      if (envelope.method === 'delete' && envelope.path === '/jobTemplates/mon-existing') {
        throw deleteError;
      }
      return jsonResponse({});
    });
    const { assets } = buildClient(fetchImpl);

    await expect(assets.rebindMonitorByName(MONITOR_NAME, PUBLIC_UID, ENV_UID)).rejects.toBe(deleteError);

    const creates = fetchImpl.mock.calls
      .map((call) => parseEnvelope(call as unknown[]))
      .filter((envelope) => envelope.method === 'post' && envelope.path.startsWith('/jobTemplates?'));
    expect(creates).toHaveLength(1);
    const deletes = fetchImpl.mock.calls
      .map((call) => parseEnvelope(call as unknown[]))
      .filter((envelope) => envelope.method === 'delete');
    expect(deletes).toHaveLength(1);
  });

  it('returns null when the monitor is already bound to the current collection', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          {
            id: 'mon-existing',
            name: MONITOR_NAME,
            active: true,
            collection: PUBLIC_UID,
            environment: ENV_UID
          }
        ]
      })
    );
    const { assets } = buildClient(fetchImpl);

    await expect(assets.rebindMonitorByName(MONITOR_NAME, PUBLIC_UID, ENV_UID)).resolves.toBeNull();
  });

  it('refuses to rebind when several same-name monitors match', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          { id: 'mon-a', name: MONITOR_NAME, active: true, collection: STALE_UID, environment: ENV_UID },
          { id: 'mon-b', name: MONITOR_NAME, active: true, collection: STALE_UID, environment: ENV_UID }
        ]
      })
    );
    const { assets } = buildClient(fetchImpl);

    await expect(assets.rebindMonitorByName(MONITOR_NAME, PUBLIC_UID, ENV_UID)).rejects.toThrow(
      /Multiple monitors match/
    );
  });

  it('returns null when no same-name monitor exists', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }));
    const { assets } = buildClient(fetchImpl);

    await expect(assets.rebindMonitorByName(MONITOR_NAME, PUBLIC_UID, ENV_UID)).resolves.toBeNull();
  });

  it('returns null without writing when the same-name monitor is bound to a different environment', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          {
            id: 'mon-existing',
            name: MONITOR_NAME,
            active: true,
            collection: STALE_UID,
            environment: OTHER_ENV_UID
          }
        ]
      })
    );
    const { assets } = buildClient(fetchImpl);

    await expect(assets.rebindMonitorByName(MONITOR_NAME, PUBLIC_UID, ENV_UID)).resolves.toBeNull();

    const writes = fetchImpl.mock.calls
      .map((call) => parseEnvelope(call as unknown[]))
      .filter((envelope) => envelope.method === 'put' || envelope.method === 'patch');
    expect(writes).toHaveLength(0);

    const creates = fetchImpl.mock.calls
      .map((call) => parseEnvelope(call as unknown[]))
      .filter((envelope) => envelope.method === 'post' && envelope.path.startsWith('/jobTemplates?'));
    expect(creates).toHaveLength(0);
  });
});
