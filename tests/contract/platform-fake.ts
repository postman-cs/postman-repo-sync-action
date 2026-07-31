/**
 * In-memory Postman/Bifrost transport for repo-sync contract tests.
 *
 * Serves the wire shapes the production clients parse -- mint, PMAK /me, iapub
 * session, and the Bifrost /ws/proxy envelope for ums/sync/mock/monitors/
 * collection/identity/workspaces -- parametrized over org vs non-org accounts,
 * prod vs beta stacks, and per-test failure injection.
 *
 * Shared by the org x credential matrix and by the cassette replay lane, so both
 * assert against one transport instead of two drifting copies.
 */
import { vi } from 'vitest';

import type { ExecLike } from '../../src/index.js';

export const HOSTS = {
  prod: {
    api: 'https://api.getpostman.com',
    bifrost: 'https://bifrost-premium-https-v4.gw.postman.com',
    iapub: 'https://iapub.postman.co'
  },
  beta: {
    api: 'https://api.getpostman-beta.com',
    bifrost: 'https://bifrost-https-v4.gw.postman-beta.com',
    iapub: 'https://iapub.postman.co'
  }
} as const;

/** Ambient credentials/tokens every contract run must blank before it starts. */
export const NEUTRALIZED_ENV_VARS = [
  'POSTMAN_API_KEY',
  'POSTMAN_ACCESS_TOKEN',
  'POSTMAN_TEAM_ID',
  'POSTMAN_WORKSPACE_TEAM_ID',
  'GITHUB_TOKEN',
  'GH_FALLBACK_TOKEN'
];

export const DEFAULT_SQUAD = { id: 132319, name: 'CSE v12', handle: 'cse-v12', organizationId: 13347347 };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

export function createExecStub(): ExecLike {
  return {
    getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  };
}

export interface PlatformOptions {
  org?: boolean;
  stack?: 'prod' | 'beta';
  squads?: unknown[];
  /** Team id in the session identity. Default: org 13347347, non-org 10490519. */
  teamId?: number;
  override?: (ctx: {
    url: string;
    method: string;
    init?: RequestInit;
    proxy?: { service: string; method: string; path: string; body?: unknown };
  }) => Response | undefined;
}

export function createPlatform(options: PlatformOptions = {}) {
  const org = options.org ?? false;
  const stack = options.stack ?? 'prod';
  const hosts = HOSTS[stack];
  const teamId = options.teamId ?? (org ? 13347347 : 10490519);
  const squads = options.squads ?? (org ? [DEFAULT_SQUAD] : []);

  const events: string[] = [];
  let mockCreated = false;
  let monitorCreated = false;
  let mintCount = 0;

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    events.push(`fetch:${method} ${url}`);

    let proxy: { service: string; method: string; path: string; body?: unknown } | undefined;
    if (url === `${hosts.bifrost}/ws/proxy`) {
      const payload = JSON.parse(String(init?.body ?? '{}'));
      proxy = {
        service: String(payload.service ?? ''),
        method: String(payload.method ?? 'get').toLowerCase(),
        path: String(payload.path ?? ''),
        body: payload.body
      };
      events.push(`proxy:${proxy.service} ${proxy.method.toUpperCase()} ${proxy.path}`);
    }

    const custom = options.override?.({ url, method, init, proxy });
    if (custom) return custom;

    // Direct endpoints.
    if (url === `${hosts.api}/service-account-tokens` && method === 'POST') {
      mintCount += 1;
      return json({ access_token: 'access-token-minted' });
    }
    if (url === `${hosts.api}/me`) {
      return json({
        user: {
          id: 12345678,
          fullName: 'Ada Lovelace',
          teamId,
          teamName: org ? 'field-services-v12-demo' : 'jared-demo',
          teamDomain: org ? 'field-services-v12-demo' : 'jared-demo'
        }
      });
    }
    if (url === `${hosts.iapub}/api/sessions/current`) {
      return json({
        identity: { team: teamId, domain: org ? 'field-services-v12-demo' : 'jared-demo' },
        data: { user: { id: 555, roles: ['admin'] } },
        consumerType: 'service_account'
      });
    }
    if (url.startsWith('https://dl.pstmn.io/')) {
      return json({ version: '12.0.0' });
    }

    // Bifrost /ws/proxy envelope.
    if (proxy) {
      const { service: svc, method: pmethod, path: ppath } = proxy;

      if (svc === 'ums' && /\/squads/.test(ppath)) {
        if (!org) return json({ error: { message: 'Squad feature is not available for your team.' } }, 400);
        return json({ data: squads });
      }

      if (svc === 'sync') {
        if (pmethod === 'post' && ppath.includes('/environment/import')) {
          return json({ data: { id: 'env-prod-uid', owner: '12345678' } });
        }
        if (pmethod === 'post' && ppath.includes('/list/environment')) {
          return json({ data: [] });
        }
        if (pmethod === 'get' && /\/environment\/[^/]+\/sync/.test(ppath)) {
          return json({ entities: [{ data: { id: 'env-prod', name: 'core-payments - prod', values: [] } }] });
        }
        return json({ data: { ok: true } });
      }

      if (svc === 'mock') {
        if (pmethod === 'get' && /\/mocks(\?|\/)/.test(ppath)) {
          return json({ data: [] });
        }
        if (pmethod === 'post' && ppath.startsWith('/mocks')) {
          mockCreated = true;
          const body = (proxy.body ?? {}) as Record<string, unknown>;
          return json({ data: {
            id: 'mock-123',
            name: String(body.name ?? ''),
            collection: String(body.collection ?? ''),
            environment: String(body.environment ?? ''),
            url: 'https://mock-123.mock.pstmn.io',
            published: true
          } });
        }
        return json({ data: {} });
      }

      if (svc === 'monitors') {
        if (pmethod === 'get' && /\/jobTemplates/.test(ppath)) {
          return json({ data: [] });
        }
        if (pmethod === 'post' && ppath.startsWith('/jobTemplates')) {
          monitorCreated = true;
          return json({ data: { id: 'monitor-123', uid: 'monitor-123' } });
        }
        return json({ data: {} });
      }

      if (svc === 'collection') {
        if (pmethod === 'get' && /\/export$/.test(ppath)) {
          return json({ data: { collection: { info: { name: 'baseline' }, item: [] } } });
        }
        return json({ data: {} });
      }

      if (svc === 'identity' && pmethod === 'post' && ppath === '/api/keys') {
        return json({ apikey: { key: 'pmak-generated' } });
      }

      if (svc === 'workspaces') {
        if (pmethod === 'get' && /\/filesystem(?:\?|$)/.test(ppath)) return json({ data: null });
        return json({ data: {} });
      }

      return json({ data: { ok: true } });
    }

    throw new Error(`Unrouted fetch in repo-sync contract test: ${method} ${url}`);
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    events,
    hosts,
    state: {
      get mockCreated() {
        return mockCreated;
      },
      get monitorCreated() {
        return monitorCreated;
      },
      get mintCount() {
        return mintCount;
      }
    }
  };
}
