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
      );
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
    ).resolves.toBe('mon-123');
  });
});

describe('discovery and validation methods', () => {
  it('listMonitors returns parsed array', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        monitors: [
          { uid: 'm1', name: 'Smoke Mon', active: true, collectionUid: 'col-1', environmentUid: 'env-1', owner: 123 }
        ]
      })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const result = await client.listMonitors();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ uid: 'm1', name: 'Smoke Mon', active: true, collectionUid: 'col-1', environmentUid: 'env-1' });
  });

  it('listMocks returns parsed array', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        mocks: [
          { uid: 'mock-1', name: 'API Mock', collection: 'col-1', mockUrl: 'https://mock.pstmn.io', environment: 'env-1' }
        ]
      })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const result = await client.listMocks();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ uid: 'mock-1', name: 'API Mock', collection: 'col-1', mockUrl: 'https://mock.pstmn.io', environment: 'env-1' });
  });

  it('monitorExists returns true for 200', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ monitor: { uid: 'm1' } })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    await expect(client.monitorExists('m1')).resolves.toBe(true);
  });

  it('monitorExists returns false for 404', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('not found', { status: 404 })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    await expect(client.monitorExists('deleted-id')).resolves.toBe(false);
  });

  it('mockExists returns true for 200', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ mock: { uid: 'mock-1' } })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    await expect(client.mockExists('mock-1')).resolves.toBe(true);
  });

  it('mockExists returns false for 404', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('not found', { status: 404 })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    await expect(client.mockExists('deleted-id')).resolves.toBe(false);
  });

  it('findMonitorByCollection returns matching monitor', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        monitors: [
          { uid: 'm1', name: 'Wrong', active: true, collectionUid: 'other-col', environmentUid: 'env-1' },
          { uid: 'm2', name: 'Right', active: true, collectionUid: 'target-col', environmentUid: 'env-1' }
        ]
      })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    await expect(client.findMonitorByCollection('target-col')).resolves.toEqual({ uid: 'm2', name: 'Right' });
  });

  it('findMonitorByCollection returns null when no match', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ monitors: [{ uid: 'm1', name: 'Mon', active: true, collectionUid: 'other', environmentUid: 'e1' }] })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    await expect(client.findMonitorByCollection('missing')).resolves.toBeNull();
  });

  it('findMockByCollection returns matching mock', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        mocks: [
          { uid: 'mock-1', name: 'M', collection: 'target-col', mockUrl: 'https://mock.pstmn.io', environment: '' }
        ]
      })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    await expect(client.findMockByCollection('target-col')).resolves.toEqual({ uid: 'mock-1', mockUrl: 'https://mock.pstmn.io' });
  });

  it('createMonitor without cron creates then disables', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ monitor: { uid: 'mon-new' } }))
      .mockResolvedValueOnce(jsonResponse({ monitor: { uid: 'mon-new', active: false } }));
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const uid = await client.createMonitor('ws-1', 'Monitor', 'col-1', 'env-1');
    expect(uid).toBe('mon-new');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const putCall = fetchImpl.mock.calls[1];
    expect(putCall?.[0]).toContain('/monitors/mon-new');
    expect(putCall?.[1]?.method).toBe('PUT');
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({ monitor: { active: false } });
  });

  it('createMonitor with cron does not disable', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({ monitor: { uid: 'mon-cron' } })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const uid = await client.createMonitor('ws-1', 'Monitor', 'col-1', 'env-1', '0 */6 * * *');
    expect(uid).toBe('mon-cron');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('getTeams', () => {
  it('returns teams with organizationId parsed from API response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          { id: 1, name: 'Team Alpha', handle: 'alpha', organizationId: 100 },
          { id: 2, name: 'Team Beta', handle: 'beta', organizationId: 100 },
          { id: 3, name: 'Team Gamma', handle: 'gamma', organizationId: 200 }
        ]
      })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const result = await client.getTeams();
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: 1, name: 'Team Alpha', handle: 'alpha', organizationId: 100 });
    expect(result[1]).toEqual({ id: 2, name: 'Team Beta', handle: 'beta', organizationId: 100 });
    expect(result[2]).toEqual({ id: 3, name: 'Team Gamma', handle: 'gamma', organizationId: 200 });
  });

  it('returns empty array when teams list is empty', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: [] })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const result = await client.getTeams();
    expect(result).toEqual([]);
  });

  it('filters out teams missing id or name', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          { id: 1, name: 'Valid Team', handle: 'valid' },
          { id: null, name: 'Missing ID', handle: 'no-id' },
          { name: 'Missing ID 2', handle: 'no-id-2' },
          { id: 4, name: '', handle: 'empty-name' }
        ]
      })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const result = await client.getTeams();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });
});

describe('getMe', () => {
  it('returns user object with teamId from API', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        user: {
          id: 'user-123',
          name: 'Test User',
          teamId: 12345
        }
      })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const result = await client.getMe();
    expect(result).toEqual({
      user: { id: 'user-123', name: 'Test User', teamId: 12345 }
    });
  });

  it('returns null when response has no body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const result = await client.getMe();
    expect(result).toBeNull();
  });
});
