import type { AccessTokenGatewayClient } from './gateway-client.js';
import { HttpError } from '../http-error.js';
import { retry, sleep as defaultSleep } from '../retry.js';

type JsonRecord = Record<string, unknown>;

const MAX_CREATE_FLIGHTS = 256;
interface CreateFlight {
  fingerprint: string;
  promise: Promise<unknown>;
}
const createFlights = new Map<string, CreateFlight>();

export interface PostmanGatewayAssetsClientOptions {
  gateway: AccessTokenGatewayClient;
  workspaceId: string;
  /** Injectable sleep for reconcile polling (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Bounded discovery polls after an ambiguous create response. Default 3. */
  reconcileAttempts?: number;
  /** Delay between reconcile polls in ms. Default 500. */
  reconcileDelayMs?: number;
}

/**
 * Access-token-primary asset client for the routes whose gateway shapes were
 * locked by a live probe against the sandbox (see scripts/live-auth-probe.ts and
 * live-write-probe.ts — spec-generated collection + sync env, not pre-existing
 * workspace list entries):
 *
 *   - `mock` service: POST/GET/DELETE /mocks (bare body `{ name, collection,
 *     private, environment? }`, bare-array or `{data:[...]}` list, bare object
 *     with `id` + `url`).
 *   - `monitors` service — collection-based monitors are jobTemplates, NOT the
 *     `monitorsV2` uptime path: POST /jobTemplates (body `{ name, collection,
 *     options, notifications, retry, schedule, distribution, environment? }` ->
 *     `{ meta, data:{ id, ... } }`), GET /jobTemplates?workspace=&_etc=true ->
 *     `{ data:[...] }`, GET /collections/:collectionUid/jobTemplates?_etc=true
 *     (monitors for one collection), POST /jobTemplates/:id/jobs (run).
 *
 * Both services proxy to mock-api / monitoring-api, which key collection access
 * off the PUBLIC uid (`<owner>-<uuid>`), exactly as the public REST API — NOT the
 * bare model id. Live-verified 2026-06-30: mock/monitor create with the public
 * uid -> 200/201; with the bare model id -> 403 ("request access from the
 * collection editor" / "need read access to this collection"). So `collection`
 * is the public uid passed straight through, as a flat string (never `{ id }`).
 *
 * Routes the probe proved unavailable through this bifrost — the `environment`
 * service (invalidServiceError) and the v2 `collection` reads by public uid
 * (RESOURCE_NOT_FOUND) — are NOT wired here. Collection reads use the verified
 * `GET /v3/collections/:id/export` v3 endpoint (`getCollection`); environment
 * reads/updates use the `sync` service. PMAK is never used for any asset op.
 *
 * Create operations submit once and reconcile via live discovery on ambiguous
 * responses. Blind transport retries are reserved for safe reads. Per-process
 * single-flight keys (`workspace + kind + identity`) collapse overlapping
 * creates in one process; cross-process races remain a residual API limit.
 */
export class PostmanGatewayAssetsClient {
  private readonly gateway: AccessTokenGatewayClient;
  private readonly workspaceId: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly reconcileAttempts: number;
  private readonly reconcileDelayMs: number;

  constructor(options: PostmanGatewayAssetsClientOptions) {
    this.gateway = options.gateway;
    this.workspaceId = String(options.workspaceId || '').trim();
    this.sleep = options.sleep ?? defaultSleep;
    this.reconcileAttempts = Math.max(1, options.reconcileAttempts ?? 3);
    this.reconcileDelayMs = Math.max(0, options.reconcileDelayMs ?? 500);
  }

  private asRecord(value: unknown): JsonRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as JsonRecord;
  }

  /** monitorsV2/mock create responses nest the entity under `data`, or return it bare. */
  private dataOf(envelope: JsonRecord | null): JsonRecord | null {
    if (!envelope) return null;
    return this.asRecord(envelope.data) ?? envelope;
  }

  /** Native Spec Hub tags attach to the latest changelog group. */
  async tagSpecVersion(specId: string, name: string): Promise<{ id: string; name: string }> {
    const trimmed = name.trim().slice(0, 255);
    const response = await this.gateway.requestJson<JsonRecord>({
      service: 'specification', method: 'post', path: `/specifications/${specId}/tags`, body: { name: trimmed }
    });
    const record = this.dataOf(response) ?? {};
    return { id: String(record.id ?? '').trim(), name: String(record.name ?? trimmed).trim() };
  }

  async listSpecVersionTags(specId: string): Promise<Array<{ id: string; name: string }>> {
    const response = await this.gateway.requestJson<JsonRecord>({
      service: 'specification', method: 'get', path: `/specifications/${specId}/tags`, query: { limit: '50' }
    });
    const data = Array.isArray(response?.data) ? response.data : [];
    return data.map((entry) => this.asRecord(entry))
      .filter((entry): entry is JsonRecord => entry !== null)
      .map((entry) => ({ id: String(entry.id ?? '').trim(), name: String(entry.name ?? '').trim() }))
      .filter((entry) => entry.id || entry.name);
  }

  private idOf(record: JsonRecord | null): string {
    if (!record) return '';
    const id = record.uid ?? record.id;
    return typeof id === 'string' ? id.trim() : String(id ?? '').trim();
  }

  /**
   * Reduce a Postman public uid (`<owner>-<uuid>`, 6 hyphen groups) to the bare
   * model id (`<uuid>`, 5 groups), mirroring `decomposeUID`. Used ONLY for the
   * bare-id namespaces: the `sync` environment routes (`/environment/:id/...`)
   * and the entity-id GETs (mock/jobTemplate ids are already bare uuids, so this
   * is a no-op there). It is NOT applied to collection references on mock/monitor
   * create — those key off the full public uid (see class doc). Bare ids and
   * other shapes pass through unchanged so the helper is idempotent.
   */
  private toModelId(uid: string): string {
    const trimmed = String(uid ?? '').trim();
    const parts = trimmed.split('-');
    return parts.length >= 6 ? parts.slice(1).join('-') : trimmed;
  }

  private isAmbiguousCreateOutcome(error: unknown): boolean {
    if (error instanceof HttpError) {
      return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    return error instanceof Error;
  }

  private isRetryableIdempotentWriteOutcome(error: unknown): boolean {
    if (error instanceof HttpError) {
      return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    return error instanceof Error;
  }

  private selectExactMatch<T extends { uid: string }>(
    kind: 'environment' | 'mock' | 'monitor',
    identity: string,
    matches: T[]
  ): T | null {
    if (matches.length > 1) {
      const ids = matches.map((match) => match.uid).join(', ');
      throw new Error(
        `Multiple ${kind}s match ${identity}: ${ids}. Refusing to choose one; remove duplicates or pass an explicit asset ID.`
      );
    }
    return matches[0] ?? null;
  }

  private async singleFlight<T>(
    key: string,
    fingerprint: string,
    kind: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const existing = createFlights.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(`Incompatible concurrent ${kind} create for ${key}`);
      }
      return existing.promise as Promise<T>;
    }
    if (createFlights.size >= MAX_CREATE_FLIGHTS) {
      throw new Error(`Too many concurrent Postman asset creates (limit ${MAX_CREATE_FLIGHTS})`);
    }
    const pending = operation().finally(() => {
      if (createFlights.get(key)?.promise === pending) {
        createFlights.delete(key);
      }
    });
    createFlights.set(key, { fingerprint, promise: pending });
    return pending;
  }

  private async discoverAfterAmbiguousCreate<T>(
    discover: () => Promise<T | null>,
    error: unknown
  ): Promise<T | null> {
    if (!this.isAmbiguousCreateOutcome(error)) {
      return null;
    }
    for (let attempt = 0; attempt < this.reconcileAttempts; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(this.reconcileDelayMs);
      }
      const found = await discover();
      if (found) {
        return found;
      }
    }
    return null;
  }

  private publicEnvironmentUid(data: JsonRecord | null, bareId: string): string {
    const owner = String(data?.owner ?? '').trim();
    return owner && !bareId.startsWith(`${owner}-`) ? `${owner}-${bareId}` : bareId;
  }

  // --- environments (service: sync) ---
  //
  // Verified live (scripts/live-gateway-probe.ts, 2026-06-30): the env service
  // proxied through this bifrost is `sync`, NOT `environment` (which answered
  // invalidServiceError). Import needs a client-generated id; list is POST (not
  // GET); get-one is the sync subpath.

  /**
   * Create/upsert an environment through the sync service.
   * POST /environment/import?workspace=:ws { id:<uuid>, name, values } ->
   * { data:{ id:<bare uuid>, owner } }. The id is generated once for the
   * operation. Unsafe creates submit once (no blind retry); on an ambiguous
   * response the client discovers by exact workspace-scoped name before
   * failing.
   *
   * Returns the PUBLIC uid (`<owner>-<uuid>`), not the bare model id the sync
   * import echoes: mock/monitor create reference the environment by its public
   * uid (live-verified 2026-06-30 — the bare id 403s mock / 400s monitor
   * "environment is not a valid ID"), matching what `/list/environment` returns.
   * The sync read/update routes re-derive the bare id via `toModelId`.
   */
  async createEnvironment(
    workspaceId: string,
    name: string,
    values: Array<{ key: string; value: string; type?: string; enabled?: boolean }>
  ): Promise<string> {
    const ws = workspaceId || this.workspaceId;
    const envName = String(name ?? '').trim();
    const flightKey = `environment:${ws}:${envName}`;
    const normalizedValues = values.map((v) => ({
      key: v.key,
      value: v.value,
      type: v.type ?? 'default',
      enabled: v.enabled ?? true
    }));
    return this.singleFlight(flightKey, JSON.stringify(normalizedValues), 'environment', async () => {
      const existing = await this.findEnvironmentByName(ws, envName);
      if (existing?.uid) {
        await this.updateEnvironment(existing.uid, envName, values);
        return existing.uid;
      }

      const id = crypto.randomUUID();
      const body: JsonRecord = {
        id,
        name: envName,
        values: normalizedValues
      };

      try {
        const response = await this.gateway.requestJson<JsonRecord>(
          {
            service: 'sync',
            method: 'post',
            path: `/environment/import?workspace=${ws}`,
            body
          },
          { retryTransient: false }
        );
        const data = this.dataOf(response);
        const bareId = this.idOf(data);
        if (!bareId) {
          throw new Error('Environment import did not return a UID');
        }
        return this.publicEnvironmentUid(data, bareId);
      } catch (error) {
        const adopted = await this.discoverAfterAmbiguousCreate(async () => {
          const match = await this.findEnvironmentByName(ws, envName);
          return match?.uid ?? null;
        }, error);
        if (adopted) {
          await this.updateEnvironment(adopted, envName, values);
          return adopted;
        }
        throw error;
      }
    });
  }

  /**
   * Update an existing environment through the sync service.
   * `PUT /environment/:uid` (service `sync`) is the verified update route
   * (live-probed 2026-06-30: 200 with `meta.action: "update"`). Import is
   * create-only — importing an existing model id 400s with `instanceFoundError`
   * — so updates must go through PUT, not import-upsert. The path uid is the
   * environment's bare model id (the public uid's tail); the body carries the
   * new name/values.
   */
  async updateEnvironment(
    uid: string,
    name: string,
    values: Array<{ key: string; value: string; type?: string; enabled?: boolean }>
  ): Promise<void> {
    const id = this.toModelId(uid);
    const body: JsonRecord = {
      id,
      name,
      values: values.map((v) => ({
        key: v.key,
        value: v.value,
        type: v.type ?? 'default',
        enabled: v.enabled ?? true
      }))
    };
    await retry(
      () =>
        this.gateway.requestJson<JsonRecord>({
          service: 'sync',
          method: 'put',
          path: `/environment/${id}`,
          body
        }),
      { maxAttempts: 5, delayMs: 2000, backoffMultiplier: 2, maxDelayMs: 15000, shouldRetry: (e) => this.isRetryableIdempotentWriteOutcome(e) }
    );
  }

  /**
   * Fetch one environment's data through the sync service.
   * GET /environment/:uid/sync?since_id=0 -> { entities:[{ data }] }; the env body
   * is the first entity's `data` (mirrors the PMAK client's `environment` object).
   */
  async getEnvironment(uid: string): Promise<unknown> {
    const response = await this.gateway.requestJson<JsonRecord>({
      service: 'sync',
      method: 'get',
      path: `/environment/${this.toModelId(uid)}/sync?since_id=0`
    });
    const entities = Array.isArray(response?.entities) ? (response.entities as unknown[]) : [];
    const first = this.asRecord(entities[0]);
    return first?.data ?? null;
  }

  /**
   * List environments in a workspace through the sync service.
   * POST /list/environment?workspace=:ws -> { data:[...] } (LIST is POST, not GET).
   */
  async listEnvironments(workspaceId: string): Promise<Array<{ name: string; uid: string }>> {
    const ws = workspaceId || this.workspaceId;
    const response = await this.gateway.requestJson<JsonRecord>(
      {
        service: 'sync',
        method: 'post',
        path: `/list/environment?workspace=${ws}`
      },
      { retryTransient: true }
    );
    const items = Array.isArray(response?.data) ? (response.data as unknown[]) : [];
    return items
      .map((raw) => this.asRecord(raw))
      .filter((e): e is JsonRecord => e !== null)
      .map((e) => {
        const bareOrPublic = this.idOf(e);
        return {
          name: String(e.name ?? ''),
          uid: this.publicEnvironmentUid(e, bareOrPublic)
        };
      });
  }

  /** Exact name match within a workspace. Prefer tracked UIDs before calling. */
  async findEnvironmentByName(
    workspaceId: string,
    name: string
  ): Promise<{ uid: string; name: string } | null> {
    const want = String(name ?? '').trim();
    if (!want) {
      return null;
    }
    const environments = await this.listEnvironments(workspaceId);
    const matches = environments.filter((entry) => entry.name === want);
    const match = this.selectExactMatch(
      'environment',
      `workspace ${workspaceId} and name "${want}"`,
      matches
    );
    return match?.uid ? { uid: match.uid, name: match.name } : null;
  }

  // --- collection read (service: collection, v3 export) ---
  //
  // The gateway `collection` service does NOT serve spec-generated uids on the
  // v2 `/collections/:uid` path (404 RESOURCE_NOT_FOUND, live-probed). It DOES
  // serve `GET /v3/collections/:id/export`, which returns the canonical v3
  // collection IR (`{ data: { collection: { ... } } }`). That v3 IR is fed
  // straight to `convertAndSplitV3Collection` — never round-tripped back to v2.
  // Both the full public uid and the bare model id are accepted on the path.

  /**
   * Fetch a collection's v3 IR through the gateway v3 export endpoint.
   * Returns the `data.collection` object (canonical v3 shape with `$kind`
   * discriminators, `items`, `variables`, `references`). Caller writes it to
   * disk via `convertAndSplitV3Collection`. PMAK is never used for collection
   * reads.
   */
  async getCollection(uid: string): Promise<unknown> {
    const id = this.toModelId(uid);
    const response = await this.gateway.requestJson<JsonRecord>({
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${id}/export`
    });
    const data = this.asRecord(response?.data);
    return data?.collection ?? null;
  }

  // --- mocks (service: mock) ---

  async createMock(
    workspaceId: string,
    name: string,
    collectionUid: string,
    environmentUid: string
  ): Promise<{ uid: string; url: string }> {
    const ws = workspaceId || this.workspaceId;
    const mockName = String(name ?? '').trim();
    const collection = String(collectionUid ?? '').trim();
    const environment = String(environmentUid ?? '').trim();
    const flightKey = `mock:${ws}:${collection}:${environment}:${mockName}`;
    return this.singleFlight(flightKey, flightKey, 'mock', async () => {
      const existing = await this.findMockByCollection(collection, environment, mockName);
      if (existing) {
        return { uid: existing.uid, url: existing.mockUrl };
      }

      const body: JsonRecord = {
        name: mockName,
        collection,
        private: false,
        ...(environment ? { environment } : {})
      };

      try {
        const response = await this.gateway.requestJson<JsonRecord>(
          {
            service: 'mock',
            method: 'post',
            path: `/mocks?workspace=${ws}`,
            body
          },
          { retryTransient: false }
        );
        const record = this.dataOf(response);
        const uid = this.idOf(record);
        if (!uid) {
          throw new Error('Mock create did not return a UID');
        }
        return {
          uid,
          url: String(record?.url ?? record?.mockUrl ?? '').trim()
        };
      } catch (error) {
        const adopted = await this.discoverAfterAmbiguousCreate(
          () => this.findMockByCollection(collection, environment, mockName),
          error
        );
        if (adopted) {
          return { uid: adopted.uid, url: adopted.mockUrl };
        }
        throw error;
      }
    });
  }

  async listMocks(): Promise<
    Array<{ uid: string; name: string; collection: string; mockUrl: string; environment: string }>
  > {
    const response = await this.gateway.requestJson<unknown>({
      service: 'mock',
      method: 'get',
      path: `/mocks?workspace=${this.workspaceId}`
    });
    const items = Array.isArray(response)
      ? response
      : Array.isArray(this.asRecord(response)?.data)
        ? ((this.asRecord(response) as JsonRecord).data as unknown[])
        : [];
    return items
      .map((raw) => this.asRecord(raw))
      .filter((m): m is JsonRecord => m !== null)
      .map((m) => ({
        uid: this.idOf(m),
        name: String(m.name ?? ''),
        collection: String(m.collection ?? ''),
        mockUrl: String(m.url ?? m.mockUrl ?? ''),
        environment: String(m.environment ?? '')
      }));
  }

  /**
   * Delete an environment through the sync service (GC path). The path id is
   * the bare model id (public uid tail), mirroring updateEnvironment.
   */
  async deleteEnvironment(uid: string): Promise<void> {
    await this.gateway.requestJson<JsonRecord>({
      service: 'sync',
      method: 'delete',
      path: `/environment/${this.toModelId(uid)}`
    });
  }

  /** Delete a mock server (GC path). */
  async deleteMock(uid: string): Promise<void> {
    await this.gateway.requestJson<JsonRecord>({
      service: 'mock',
      method: 'delete',
      path: `/mocks/${this.toModelId(uid)}`
    });
  }

  /** Delete a collection-based monitor (jobTemplate) (GC path). */
  async deleteMonitor(uid: string): Promise<void> {
    await this.gateway.requestJson<JsonRecord>({
      service: 'monitors',
      method: 'delete',
      path: `/jobTemplates/${this.toModelId(uid)}`
    });
  }

  async mockExists(uid: string): Promise<boolean> {
    try {
      await this.gateway.requestJson<JsonRecord>({
        service: 'mock',
        method: 'get',
        path: `/mocks/${this.toModelId(uid)}`
      });
      return true;
    } catch {
      return false;
    }
  }

  async findMockByCollection(
    collectionUid: string,
    environmentUid: string,
    name: string
  ): Promise<{ uid: string; mockUrl: string } | null> {
    const mocks = await this.listMocks();
    // Both sides are public uids (`<owner>-<uuid>`): the mock list echoes the
    // `collection` uid it was created with, and the caller passes the same uid.
    const want = String(collectionUid ?? '').trim();
    const environment = String(environmentUid ?? '').trim();
    const mockName = String(name ?? '').trim();
    const matches = mocks.filter((mock) =>
      mock.collection === want &&
      mock.environment === environment &&
      mock.name === mockName
    );
    const match = this.selectExactMatch(
      'mock',
      `workspace ${this.workspaceId}, name "${mockName}", collection ${want}, and environment ${environment || '(none)'}`,
      matches
    );
    return match ? { uid: match.uid, mockUrl: match.mockUrl } : null;
  }

  // --- monitors (service: monitors; collection-based = jobTemplates) ---

  /** Map raw jobTemplate records to the facade shape; `collection` is a flat public uid. */
  private mapJobTemplates(items: unknown[]): Array<{
    uid: string;
    name: string;
    active: boolean;
    collectionUid: string;
    environmentUid: string;
  }> {
    return items
      .map((raw) => this.asRecord(raw))
      .filter((m): m is JsonRecord => m !== null)
      .map((m) => ({
        uid: this.idOf(m),
        name: String(m.name ?? ''),
        active: m.active !== false,
        collectionUid: String(m.collection ?? ''),
        environmentUid: String(m.environment ?? '')
      }));
  }

  async createMonitor(
    workspaceId: string,
    name: string,
    collectionUid: string,
    environmentUid: string,
    cronSchedule?: string
  ): Promise<string> {
    const ws = workspaceId || this.workspaceId;
    const effectiveCron = cronSchedule && cronSchedule.trim() ? cronSchedule.trim() : '0 0 * * 0';
    const monitorName = String(name ?? '').trim();
    const collection = String(collectionUid ?? '').trim();
    const environment = String(environmentUid ?? '').trim();
    const flightKey = `monitor:${ws}:${collection}:${environment}:${monitorName}`;
    return this.singleFlight(flightKey, effectiveCron, 'monitor', async () => {
      const existing = await this.findMonitorByCollection(collection, environment, monitorName);
      if (existing?.uid) {
        return existing.uid;
      }

      // Canonical app `constructMonitor` body (MonitorFormComponent): `collection`
      // is the flat public uid, and the request carries the full options/notifications/
      // retry/distribution envelope monitoring-api validates against.
      const body: JsonRecord = {
        name: monitorName,
        collection,
        options: { strictSSL: false, followRedirects: true, requestTimeout: null, requestDelay: 0 },
        notifications: { onFailure: [], onError: [] },
        retry: {},
        schedule: { cronPattern: effectiveCron, timeZone: 'UTC' },
        distribution: null,
        ...(environment ? { environment } : {})
      };

      try {
        const response = await this.gateway.requestJson<JsonRecord>(
          {
            service: 'monitors',
            method: 'post',
            path: `/jobTemplates?workspace=${ws}`,
            body
          },
          { retryTransient: false }
        );
        const uid = this.idOf(this.dataOf(response));
        if (!uid) {
          throw new Error('Monitor create did not return a UID');
        }
        return uid;
      } catch (error) {
        const adopted = await this.discoverAfterAmbiguousCreate(
          () => this.findMonitorByCollection(collection, environment, monitorName),
          error
        );
        if (adopted?.uid) {
          return adopted.uid;
        }
        throw error;
      }
    });
  }

  async listMonitors(): Promise<
    Array<{ uid: string; name: string; active: boolean; collectionUid: string; environmentUid: string }>
  > {
    // `_etc=true` exposes the `_health` projection; the monitors land under `data`.
    const response = await this.gateway.requestJson<JsonRecord>({
      service: 'monitors',
      method: 'get',
      path: `/jobTemplates?workspace=${this.workspaceId}&_etc=true`
    });
    const data = response?.data;
    return this.mapJobTemplates(Array.isArray(data) ? data : []);
  }

  async monitorExists(uid: string): Promise<boolean> {
    try {
      await this.gateway.requestJson<JsonRecord>({
        service: 'monitors',
        method: 'get',
        path: `/jobTemplates/${uid}?_etc=true`
      });
      return true;
    } catch {
      return false;
    }
  }

  async findMonitorByCollection(
    collectionUid: string,
    environmentUid: string,
    name: string
  ): Promise<{ uid: string; name: string } | null> {
    // The workspace-scoped job-template list carries collection, environment,
    // and name, so discovery can enforce the complete reusable identity.
    const want = String(collectionUid ?? '').trim();
    const environment = String(environmentUid ?? '').trim();
    const monitorName = String(name ?? '').trim();
    const monitors = await this.listMonitors();
    const matches = monitors.filter((monitor) =>
      monitor.collectionUid === want &&
      monitor.environmentUid === environment &&
      monitor.name === monitorName
    );
    const match = this.selectExactMatch(
      'monitor',
      `workspace ${this.workspaceId}, name "${monitorName}", collection ${want}, and environment ${environment || '(none)'}`,
      matches
    );
    return match?.uid ? { uid: match.uid, name: match.name } : null;
  }

  async runMonitor(uid: string): Promise<void> {
    await this.gateway.requestJson<JsonRecord>(
      {
        service: 'monitors',
        method: 'post',
        path: `/jobTemplates/${uid}/jobs`
      },
      { retryTransient: false }
    );
  }
}
