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

type FakeBodyShape = 'none' | 'record' | 'array';

/**
 * Bare collection model id (no owner prefix). Live-proven 2026-08-03: the
 * collection-service ROOT routes fail closed on bare ids — GET/PATCH
 * /v3/collections/:id return 403 FORBIDDEN unless the full owner-prefixed
 * public UID is sent. Populated Sync reads also receive the public UID so the
 * fake can verify identity is preserved across the action boundary.
 */
const BARE_COLLECTION_MODEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RepoSyncFakeRoute {
  service: string;
  method: string;
  path: string;
  query?: readonly string[];
  requiredQuery?: readonly string[];
  body: FakeBodyShape;
}

export const REPO_SYNC_FAKE_ROUTES: readonly RepoSyncFakeRoute[] = [
  { service: 'postman-api', method: 'POST', path: '/service-account-tokens', body: 'record' },
  { service: 'postman-api', method: 'GET', path: '/me', body: 'none' },
  { service: 'iapub', method: 'GET', path: '/api/sessions/current', body: 'none' },
  { service: 'dl.pstmn.io', method: 'GET', path: '/update/status', query: ['currentVersion', 'platform'], body: 'none' },
  { service: 'ums', method: 'GET', path: '/api/teams/{param}/squads', query: ['settings', 'userRoles'], requiredQuery: ['settings', 'userRoles'], body: 'none' },
  { service: 'sync', method: 'POST', path: '/environment/import', query: ['workspace'], requiredQuery: ['workspace'], body: 'record' },
  { service: 'sync', method: 'POST', path: '/list/environment', query: ['cursor', 'workspace'], requiredQuery: ['workspace'], body: 'none' },
  { service: 'sync', method: 'GET', path: '/environment/{param}/sync', query: ['since_id'], requiredQuery: ['since_id'], body: 'none' },
  { service: 'sync', method: 'GET', path: '/collection/{param}', query: ['populate', 'format', 'uid'], requiredQuery: ['populate', 'format', 'uid'], body: 'none' },
  { service: 'sync', method: 'PUT', path: '/environment/{param}', body: 'record' },
  { service: 'sync', method: 'DELETE', path: '/environment/{param}', body: 'none' },
  { service: 'collection', method: 'GET', path: '/v3/collections', query: ['cursor', 'workspace'], requiredQuery: ['workspace'], body: 'none' },
  { service: 'collection', method: 'GET', path: '/v3/collections/{param}', body: 'none' },
  { service: 'collection', method: 'PATCH', path: '/v3/collections/{param}', body: 'array' },
  { service: 'collection', method: 'DELETE', path: '/v3/collections/{param}', body: 'none' },
  { service: 'mock', method: 'GET', path: '/mocks', query: ['cursor', 'workspace'], requiredQuery: ['workspace'], body: 'none' },
  { service: 'mock', method: 'POST', path: '/mocks', query: ['workspace'], requiredQuery: ['workspace'], body: 'record' },
  { service: 'mock', method: 'GET', path: '/mocks/{param}', body: 'none' },
  { service: 'mock', method: 'DELETE', path: '/mocks/{param}', body: 'none' },
  { service: 'monitors', method: 'GET', path: '/jobTemplates', query: ['_etc', 'cursor', 'workspace'], requiredQuery: ['workspace'], body: 'none' },
  { service: 'monitors', method: 'POST', path: '/jobTemplates', query: ['workspace'], requiredQuery: ['workspace'], body: 'record' },
  { service: 'monitors', method: 'GET', path: '/jobTemplates/{param}', query: ['_etc'], body: 'none' },
  { service: 'monitors', method: 'DELETE', path: '/jobTemplates/{param}', body: 'none' },
  { service: 'monitors', method: 'POST', path: '/jobTemplates/{param}/jobs', body: 'none' },
  { service: 'identity', method: 'POST', path: '/api/keys', body: 'record' },
  { service: 'workspaces', method: 'GET', path: '/workspaces/filesystem', query: ['path', 'repo'], requiredQuery: ['path', 'repo'], body: 'none' },
  { service: 'workspaces', method: 'GET', path: '/workspaces/{param}', body: 'none' },
  { service: 'workspaces', method: 'POST', path: '/workspaces/{param}/filesystem', body: 'record' }
] as const;

interface ModeledRequest {
  service: string;
  method: string;
  pathname: string;
  rawPath: string;
  query: Record<string, string>;
  body: unknown;
}

function normalizePathname(pathname: string): string {
  const withSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

function routePattern(path: string): RegExp {
  const escaped = normalizePathname(path)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{param\\\}/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

function parsePathAndQuery(
  rawPath: string,
  explicitQuery?: Record<string, unknown>
): { pathname: string; query: Record<string, string> } {
  const parsed = new URL(rawPath, 'https://repo-sync-fake.invalid');
  const query: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) query[key] = value;
  for (const [key, value] of Object.entries(explicitQuery ?? {})) query[key] = String(value);
  return { pathname: normalizePathname(parsed.pathname), query };
}

function bodyMatches(shape: FakeBodyShape, body: unknown): boolean {
  if (shape === 'none') return body === undefined || body === null;
  if (shape === 'array') return Array.isArray(body);
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

function queryMatches(route: RepoSyncFakeRoute, query: Record<string, string>): boolean {
  const allowed = new Set(route.query ?? []);
  if (Object.keys(query).some((key) => !allowed.has(key))) return false;
  return (route.requiredQuery ?? []).every((key) => query[key] !== undefined && query[key] !== '');
}

function routeDistance(route: RepoSyncFakeRoute, request: ModeledRequest): number {
  let score = route.service === request.service ? 0 : 100;
  score += route.method === request.method ? 0 : 25;
  const routeSegments = normalizePathname(route.path).split('/');
  const requestSegments = request.pathname.split('/');
  score += Math.abs(routeSegments.length - requestSegments.length) * 5;
  for (let index = 0; index < Math.min(routeSegments.length, requestSegments.length); index += 1) {
    if (routeSegments[index] !== '{param}' && routeSegments[index] !== requestSegments[index]) score += 1;
  }
  return score;
}

function assertModeledRequest(request: ModeledRequest): RepoSyncFakeRoute {
  const pathMatches = REPO_SYNC_FAKE_ROUTES.filter(
    (route) =>
      route.service === request.service &&
      route.method === request.method &&
      routePattern(route.path).test(request.pathname)
  );
  const matched = pathMatches.find(
    (route) => queryMatches(route, request.query) && bodyMatches(route.body, request.body)
  );
  if (matched) return matched;
  const nearest = [...REPO_SYNC_FAKE_ROUTES].sort(
    (left, right) => routeDistance(left, request) - routeDistance(right, request)
  )[0];
  const query = new URLSearchParams(request.query).toString();
  const reason = pathMatches.length > 0
    ? 'query or body shape did not match'
    : 'service, method, or path did not match';
  throw new Error(
    `Unmatched repo-sync platform fake request: ${request.service} ${request.method} ${request.rawPath}` +
      `${query && !request.rawPath.includes('?') ? `?${query}` : ''}. ` +
      `Nearest modeled route: ${nearest?.service ?? '(none)'} ${nearest?.method ?? ''} ${nearest?.path ?? ''} (${reason})`
  );
}

export function isModeledRepoSyncFakeRoute(
  service: string,
  method: string,
  path: string
): boolean {
  const pathname = parsePathAndQuery(path).pathname;
  return REPO_SYNC_FAKE_ROUTES.some(
    (route) =>
      route.service === service &&
      route.method === method.toUpperCase() &&
      routePattern(route.path).test(pathname)
  );
}

export interface OwnedResourceSeed {
  id: string;
  ownerId?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function scriptsToV2Events(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const script = record(candidate);
    if (!script || typeof script.code !== 'string') return [];
    const rawType = String(script.type ?? '').replace(/^http:/, '');
    const listen = rawType === 'beforeRequest'
      ? 'prerequest'
      : rawType === 'afterResponse'
        ? 'test'
        : '';
    if (!listen) return [];
    return [{
      listen,
      script: {
        type: typeof script.language === 'string' ? script.language : 'text/javascript',
        exec: [script.code]
      }
    }];
  });
}

function v3ItemToV2(value: unknown): Record<string, unknown> {
  const item = record(value) ?? {};
  const children = Array.isArray(item.items)
    ? item.items
    : Array.isArray(item.children)
      ? item.children
      : undefined;
  if (children) {
    return {
      id: item.id,
      name: String(item.name ?? ''),
      item: children.map(v3ItemToV2),
      event: scriptsToV2Events(item.scripts)
    };
  }
  return {
    id: item.id,
    name: String(item.name ?? ''),
    request: {
      method: String(item.method ?? 'GET'),
      url: item.url ?? 'https://example.test'
    },
    response: [],
    event: scriptsToV2Events(item.scripts)
  };
}

function populatedSyncSnapshot(
  source: Record<string, unknown>,
  modelId: string
): Record<string, unknown> {
  const v2Info = record(source.info);
  if (v2Info && Array.isArray(source.item)) {
    return {
      ...structuredClone(source),
      info: {
        ...v2Info,
        name: String(v2Info.name ?? source.name ?? 'baseline'),
        _postman_id: modelId,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      }
    };
  }
  return {
    info: {
      name: String(source.name ?? 'baseline'),
      _postman_id: modelId,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    item: (Array.isArray(source.items) ? source.items : []).map(v3ItemToV2),
    event: scriptsToV2Events(source.scripts)
  };
}

export interface EnvironmentSeed extends OwnedResourceSeed {
  name: string;
  values?: unknown[];
}

export interface MockSeed extends OwnedResourceSeed {
  name: string;
  collection: string;
  environment: string;
  url?: string;
  published?: boolean;
}

export interface MonitorSeed extends OwnedResourceSeed {
  name: string;
  collection: string;
  environment: string;
  active?: boolean;
}

export interface PlatformOptions {
  org?: boolean;
  stack?: 'prod' | 'beta';
  squads?: unknown[];
  /** Team id in the session identity. Default: org 13347347, non-org 10490519. */
  teamId?: number;
  userId?: number;
  pageSize?: number;
  existingEnvironments?: EnvironmentSeed[];
  existingMocks?: MockSeed[];
  existingMonitors?: MonitorSeed[];
  existingCollections?: Array<OwnedResourceSeed & { collection?: Record<string, unknown> }>;
  override?: (ctx: {
    url: string;
    method: string;
    init?: RequestInit;
    proxy?: { service: string; method: string; path: string; body?: unknown; query?: Record<string, unknown> };
  }) => Response | undefined;
}

export function createPlatform(options: PlatformOptions = {}) {
  const org = options.org ?? false;
  const stack = options.stack ?? 'prod';
  const hosts = HOSTS[stack];
  const teamId = options.teamId ?? (org ? 13347347 : 10490519);
  const userId = options.userId ?? 12345678;
  const squads = options.squads ?? (org ? [DEFAULT_SQUAD] : []);
  const pageSize =
    typeof options.pageSize === 'number' && Number.isInteger(options.pageSize) && options.pageSize > 0
      ? options.pageSize
      : Number.POSITIVE_INFINITY;

  const events: string[] = [];
  let mockCreated = false;
  let monitorCreated = false;
  let mintCount = 0;
  let paginationCursorsIssued = 0;
  const deletionLedger: Array<{ service: string; id: string; status: number }> = [];
  const environments = new Map(
    (options.existingEnvironments ?? []).map((entry) => [
      entry.id,
      { ...entry, ownerId: entry.ownerId ?? userId, values: entry.values ?? [] }
    ])
  );
  const mocks = new Map(
    (options.existingMocks ?? []).map((entry) => [
      entry.id,
      {
        ...entry,
        ownerId: entry.ownerId ?? userId,
        url: entry.url ?? `https://${entry.id}.mock.pstmn.io`,
        published: entry.published ?? true
      }
    ])
  );
  const monitors = new Map(
    (options.existingMonitors ?? []).map((entry) => [
      entry.id,
      { ...entry, ownerId: entry.ownerId ?? userId, active: entry.active ?? true }
    ])
  );
  const collections = new Map(
    (options.existingCollections ?? []).map((entry) => [
      entry.id,
      {
        id: entry.id,
        ownerId: entry.ownerId ?? userId,
        collection: entry.collection ?? { info: { name: 'baseline' }, item: [] }
      }
    ])
  );
  const pageSnapshots = new Map<string, unknown[]>();
  let pageSequence = 0;

  function encodeCursor(kind: string, sequence: number, offset: number): string {
    return Buffer.from(JSON.stringify({ kind, sequence, offset }), 'utf8').toString('base64url');
  }

  function decodeCursor(kind: string, cursor: string): { snapshotKey: string; offset: number } {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        kind?: unknown;
        sequence?: unknown;
        offset?: unknown;
      };
      if (
        decoded.kind !== kind ||
        !Number.isInteger(decoded.sequence) ||
        !Number.isInteger(decoded.offset) ||
        Number(decoded.offset) < 0
      ) {
        throw new Error('cursor payload mismatch');
      }
      return {
        snapshotKey: `${kind}:${Number(decoded.sequence)}`,
        offset: Number(decoded.offset)
      };
    } catch (error) {
      throw new Error(`Invalid ${kind} cursor supplied to repo-sync platform fake`, { cause: error });
    }
  }

  function paginate<T>(
    kind: string,
    cursor: string,
    createRows: () => T[]
  ): { data: T[]; nextCursor: string } {
    let snapshotKey: string;
    let offset: number;
    if (cursor) {
      ({ snapshotKey, offset } = decodeCursor(kind, cursor));
      if (!pageSnapshots.has(snapshotKey)) {
        throw new Error(`Expired ${kind} cursor supplied to repo-sync platform fake`);
      }
    } else {
      pageSequence += 1;
      snapshotKey = `${kind}:${pageSequence}`;
      offset = 0;
      pageSnapshots.set(snapshotKey, createRows());
    }
    const rows = pageSnapshots.get(snapshotKey) as T[];
    const data = rows.slice(offset, offset + pageSize);
    const nextOffset = offset + data.length;
    const nextCursor = nextOffset < rows.length
      ? encodeCursor(kind, Number(snapshotKey.split(':').pop()), nextOffset)
      : '';
    if (nextCursor) paginationCursorsIssued += 1;
    else pageSnapshots.delete(snapshotKey);
    return { data, nextCursor };
  }

  function resolveOwned<T extends { id: string; ownerId: number }>(
    resources: Map<string, T>,
    candidate: string
  ): T | undefined {
    return [...resources.values()].find(
      (resource) =>
        resource.id === candidate ||
        resource.id.endsWith(candidate) ||
        candidate.endsWith(resource.id)
    );
  }

  function deleteOwned<T extends { id: string; ownerId: number }>(
    service: string,
    resources: Map<string, T>,
    candidate: string
  ): Response {
    const resource = resolveOwned(resources, candidate);
    if (!resource) {
      deletionLedger.push({ service, id: candidate, status: 404 });
      return json({ error: 'missing' }, 404);
    }
    if (resource.ownerId !== userId) {
      deletionLedger.push({ service, id: resource.id, status: 403 });
      return json({ error: 'forbidden owner' }, 403);
    }
    resources.delete(resource.id);
    deletionLedger.push({ service, id: resource.id, status: 200 });
    return json({ data: { deleted: resource.id } });
  }

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    events.push(`fetch:${method} ${url}`);

    let proxy: { service: string; method: string; path: string; body?: unknown; query?: Record<string, unknown> } | undefined;
    if (url === `${hosts.bifrost}/ws/proxy`) {
      const payload = JSON.parse(String(init?.body ?? '{}'));
      proxy = {
        service: String(payload.service ?? ''),
        method: String(payload.method ?? 'get').toLowerCase(),
        path: String(payload.path ?? ''),
        body: payload.body,
        ...(payload.query ? { query: payload.query as Record<string, unknown> } : {})
      };
      events.push(`proxy:${proxy.service} ${proxy.method.toUpperCase()} ${proxy.path}`);
    }

    let request: ModeledRequest;
    if (proxy) {
      const parsed = parsePathAndQuery(proxy.path, proxy.query);
      request = {
        service: proxy.service,
        method: proxy.method.toUpperCase(),
        pathname: parsed.pathname,
        rawPath: proxy.path,
        query: parsed.query,
        body: proxy.body
      };
    } else {
      const parsedUrl = new URL(url);
      let body: unknown;
      if (init?.body !== undefined && init.body !== null) {
        try {
          body = JSON.parse(String(init.body));
        } catch {
          body = Symbol('invalid-json-body');
        }
      }
      const service =
        parsedUrl.origin === hosts.api
          ? 'postman-api'
          : parsedUrl.origin === hosts.iapub
            ? 'iapub'
            : parsedUrl.hostname === 'dl.pstmn.io'
              ? 'dl.pstmn.io'
              : parsedUrl.hostname;
      request = {
        service,
        method,
        pathname: normalizePathname(parsedUrl.pathname),
        rawPath: `${parsedUrl.pathname}${parsedUrl.search}`,
        query: Object.fromEntries(parsedUrl.searchParams),
        body
      };
    }
    assertModeledRequest(request);

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
          id: userId,
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
      const svc = proxy.service;
      const pmethod = proxy.method;
      const ppath = request.pathname;
      const query = request.query;

      if (svc === 'ums' && /\/squads/.test(ppath)) {
        if (!org) return json({ error: { message: 'Squad feature is not available for your team.' } }, 400);
        return json({ data: squads });
      }

      if (svc === 'sync') {
        if (pmethod === 'get' && /\/collection\/[^/]+$/.test(ppath)) {
          if (
            query.populate !== 'true' ||
            query.format !== '2.1.0' ||
            query.uid !== 'false'
          ) {
            throw new Error('Populated Sync collection read used the wrong projection query');
          }
          const candidate = ppath.split('/').pop() || '';
          const resource = resolveOwned(collections, candidate);
          // Most focused contract scenarios supply existing collection IDs but
          // do not care about collection state. Model those inputs as an
          // already-existing minimal root, matching the old fake's behavior;
          // stateful collection tests seed an explicit resource instead.
          const candidateParts = candidate.split('-');
          const modelId = candidateParts.length >= 6
            ? candidateParts.slice(1).join('-')
            : candidate;
          return json({
            data: resource
              ? populatedSyncSnapshot(resource.collection, resource.id)
              : populatedSyncSnapshot(
                  { info: { name: 'baseline' }, item: [] },
                  modelId
                )
          });
        }
        if (pmethod === 'post' && ppath === '/environment/import') {
          const body = proxy.body as Record<string, unknown>;
          const requestedId = String(body.id ?? 'env-prod-uid');
          const id = requestedId === '00000000-0000-4000-8000-000000000000'
            ? 'env-prod-uid'
            : requestedId;
          environments.set(id, {
            id,
            ownerId: userId,
            name: String(body.name ?? ''),
            values: Array.isArray(body.values) ? body.values : []
          });
          return json({ data: { id, owner: String(userId) } });
        }
        if (pmethod === 'post' && ppath === '/list/environment') {
          const page = paginate('environment-list', query.cursor ?? '', () =>
            [...environments.values()].map((entry) => ({
              id: entry.id,
              uid: `${entry.ownerId}-${entry.id}`,
              owner: String(entry.ownerId),
              name: entry.name
            }))
          );
          return json({ data: page.data, meta: { cursor: { next: page.nextCursor } } });
        }
        if (pmethod === 'get' && /\/environment\/[^/]+\/sync/.test(ppath)) {
          const candidate = ppath.split('/')[2] || '';
          const environment = resolveOwned(environments, candidate);
          if (!environment) return json({ error: 'missing' }, 404);
          return json({
            entities: [{
              data: {
                id: environment.id,
                name: environment.name,
                values: environment.values
              }
            }]
          });
        }
        if (pmethod === 'put' && /\/environment\/[^/]+$/.test(ppath)) {
          const candidate = ppath.split('/').pop() || '';
          const environment = resolveOwned(environments, candidate);
          if (!environment) return json({ error: 'missing' }, 404);
          const body = proxy.body as Record<string, unknown>;
          environment.name = String(body.name ?? environment.name);
          environment.values = Array.isArray(body.values) ? body.values : environment.values;
          return json({ data: { id: environment.id } });
        }
        if (pmethod === 'delete' && /\/environment\/[^/]+$/.test(ppath)) {
          return deleteOwned('sync', environments, ppath.split('/').pop() || '');
        }
      }

      if (svc === 'mock') {
        if (pmethod === 'get' && ppath === '/mocks') {
          const page = paginate('mock-list', query.cursor ?? '', () => [...mocks.values()].map((entry) => ({
            id: entry.id,
            uid: entry.id,
            name: entry.name,
            collection: entry.collection,
            environment: entry.environment,
            url: entry.url,
            published: entry.published
          })));
          return json({ data: page.data, meta: { cursor: { next: page.nextCursor } } });
        }
        if (pmethod === 'get' && /\/mocks\/[^/]+$/.test(ppath)) {
          const resource = resolveOwned(mocks, ppath.split('/').pop() || '');
          return resource
            ? json({ data: {
                id: resource.id,
                name: resource.name,
                collection: resource.collection,
                environment: resource.environment,
                url: resource.url
              } })
            : json({ error: 'missing' }, 404);
        }
        if (pmethod === 'post' && ppath === '/mocks') {
          mockCreated = true;
          const body = (proxy.body ?? {}) as Record<string, unknown>;
          const resource = {
            id: 'mock-123',
            ownerId: userId,
            name: String(body.name ?? ''),
            collection: String(body.collection ?? ''),
            environment: String(body.environment ?? ''),
            url: 'https://mock-123.mock.pstmn.io',
            published: body.private !== true
          };
          mocks.set(resource.id, resource);
          return json({ data: {
            id: resource.id,
            name: resource.name,
            collection: resource.collection,
            environment: resource.environment,
            url: resource.url,
            published: resource.published
          } });
        }
        if (pmethod === 'delete' && /\/mocks\/[^/]+$/.test(ppath)) {
          return deleteOwned('mock', mocks, ppath.split('/').pop() || '');
        }
      }

      if (svc === 'monitors') {
        if (pmethod === 'get' && ppath === '/jobTemplates') {
          const page = paginate('monitor-list', query.cursor ?? '', () => [...monitors.values()].map((entry) => ({
            id: entry.id,
            uid: entry.id,
            name: entry.name,
            active: entry.active,
            collection: entry.collection,
            environment: entry.environment
          })));
          return json({ data: page.data, meta: { cursor: { next: page.nextCursor } } });
        }
        if (pmethod === 'get' && /\/jobTemplates\/[^/]+$/.test(ppath)) {
          const resource = resolveOwned(monitors, ppath.split('/').pop() || '');
          return resource
            ? json({ data: {
                id: resource.id,
                uid: resource.id,
                name: resource.name,
                active: resource.active,
                collection: resource.collection,
                environment: resource.environment
              } })
            : json({ error: 'missing' }, 404);
        }
        if (pmethod === 'post' && ppath === '/jobTemplates') {
          monitorCreated = true;
          const body = (proxy.body ?? {}) as Record<string, unknown>;
          const resource = {
            id: 'monitor-123',
            ownerId: userId,
            name: String(body.name ?? ''),
            collection: String(body.collection ?? ''),
            environment: String(body.environment ?? ''),
            active: body.active !== false
          };
          monitors.set(resource.id, resource);
          return json({ data: { id: resource.id, uid: resource.id } });
        }
        if (pmethod === 'post' && /\/jobTemplates\/[^/]+\/jobs$/.test(ppath)) {
          return json({ data: { id: ppath.split('/')[2] } });
        }
        if (pmethod === 'delete' && /\/jobTemplates\/[^/]+$/.test(ppath)) {
          return deleteOwned('monitors', monitors, ppath.split('/').pop() || '');
        }
      }

      if (svc === 'collection') {
        if (pmethod === 'get' && /\/v3\/collections\/[^/]+$/.test(ppath)) {
          const candidate = ppath.split('/').pop() || '';
          if (BARE_COLLECTION_MODEL_ID.test(candidate)) {
            return json(
              {
                error: {
                  code: 'FORBIDDEN',
                  message: `Access to the requested resource "${candidate}" has been denied`
                }
              },
              403
            );
          }
          const resource = resolveOwned(collections, candidate);
          if (!resource) return json({ error: 'missing' }, 404);
          return json({ data: { ...resource.collection, id: candidate } });
        }
        if (pmethod === 'patch' && /\/v3\/collections\/[^/]+$/.test(ppath)) {
          const candidate = ppath.split('/').pop() || '';
          if (BARE_COLLECTION_MODEL_ID.test(candidate)) {
            return json(
              {
                error: {
                  code: 'FORBIDDEN',
                  message: `Access to the requested resource "${candidate}" has been denied`
                }
              },
              403
            );
          }
          const resource = resolveOwned(collections, candidate);
          if (!resource) return json({ error: 'missing' }, 404);
          const patches = Array.isArray(proxy.body) ? proxy.body : [];
          let nextScripts = Array.isArray(resource.collection.scripts)
            ? [...(resource.collection.scripts as unknown[])]
            : [];
          let supported = true;
          for (const entry of patches) {
            const operation = entry as Record<string, unknown>;
            if (operation.op === 'test' && operation.path === '/scripts') {
              if (JSON.stringify(operation.value) !== JSON.stringify(nextScripts)) {
                return json({ error: { code: 'REJECTED_PATCH' } }, 409);
              }
            } else if (operation.op === 'add' && operation.path === '/scripts/-') {
              if (!operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value)) {
                supported = false;
                break;
              }
              nextScripts = [...nextScripts, operation.value];
            } else if (operation.op === 'add' && operation.path === '/scripts') {
              if (!Array.isArray(operation.value)) {
                supported = false;
                break;
              }
              nextScripts = [...operation.value];
            } else {
              supported = false;
              break;
            }
          }
          if (!supported) return json({ error: { code: 'REJECTED_PATCH' } }, 400);
          resource.collection = { ...resource.collection, scripts: nextScripts };
          return json({ data: { ...resource.collection, id: candidate } });
        }
        if (pmethod === 'delete' && /\/v3\/collections\/[^/]+$/.test(ppath)) {
          return deleteOwned('collection', collections, ppath.split('/').pop() || '');
        }
      }

      if (svc === 'identity' && pmethod === 'post' && ppath === '/api/keys') {
        return json({ apikey: { key: 'pmak-generated' } });
      }

      if (svc === 'workspaces') {
        if (pmethod === 'get' && ppath === '/workspaces/filesystem') return json({ data: null });
        if (pmethod === 'get' && /\/workspaces\/[^/]+$/.test(ppath)) {
          return json({ data: { id: ppath.split('/').pop() } });
        }
        if (pmethod === 'post' && /\/workspaces\/[^/]+\/filesystem$/.test(ppath)) {
          return json({ data: { id: ppath.split('/')[2] } });
        }
      }

      throw new Error(
        `Modeled repo-sync platform fake route has no handler: ${svc} ${pmethod.toUpperCase()} ${proxy.path}`
      );
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
      },
      get paginationCursorsIssued() {
        return paginationCursorsIssued;
      },
      get deletionLedger() {
        return deletionLedger.map((entry) => ({ ...entry }));
      },
      get environments() {
        return [...environments.values()].map((entry) => ({ ...entry }));
      },
      get mocks() {
        return [...mocks.values()].map((entry) => ({ ...entry }));
      },
      get monitors() {
        return [...monitors.values()].map((entry) => ({ ...entry }));
      },
      get collections() {
        return [...collections.values()].map((entry) => ({ ...entry }));
      }
    }
  };
}
