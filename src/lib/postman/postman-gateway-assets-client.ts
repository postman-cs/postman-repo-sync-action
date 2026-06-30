import type { AccessTokenGatewayClient } from './gateway-client.js';
import { HttpError } from '../http-error.js';
import { retry } from '../retry.js';

type JsonRecord = Record<string, unknown>;

/**
 * Access-token-primary asset client for the routes whose gateway shapes were
 * locked by a live probe against the sandbox (see scripts/live-auth-probe.ts and
 * live-write-probe.ts — spec-generated collection + sync env, not pre-existing
 * workspace list entries):
 *
 *   - `mock` service: POST/GET/DELETE /mocks (bare body, bare-array list,
 *     bare object with `id` + `url`).
 *   - `monitorsV2` service: POST/GET/DELETE /monitors and POST /monitors/:id/run
 *     ({ name, type:'collection-based', collection:{ id }, schedule?:{ cronPattern,
 *     timeZone } } -> { meta, data:{ id, ... } }; list -> { data:[...] }).
 *
 * These gateway services proxy to monitoring-api / mock-api and use a bare-uuid
 * id namespace (the public REST API returns prefixed 45-char uids). Within one
 * run the routing facade is internally consistent: create, list, exists, run,
 * and find all go through this client, so the persisted ids round-trip.
 *
 * Routes the probe proved unavailable through this bifrost — the `environment`
 * service (invalidServiceError) and the v2 `collection` reads by public uid
 * (RESOURCE_NOT_FOUND) — are NOT wired here. Collection reads use the verified
 * `GET /v3/collections/:id/export` v3 endpoint (`getCollection`); environment
 * reads/updates use the `sync` service. PMAK is never used for any asset op.
 */
export class PostmanGatewayAssetsClient {
  private readonly gateway: AccessTokenGatewayClient;
  private readonly workspaceId: string;

  constructor(options: { gateway: AccessTokenGatewayClient; workspaceId: string }) {
    this.gateway = options.gateway;
    this.workspaceId = String(options.workspaceId || '').trim();
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

  private idOf(record: JsonRecord | null): string {
    if (!record) return '';
    const id = record.uid ?? record.id;
    return typeof id === 'string' ? id.trim() : String(id ?? '').trim();
  }

  /**
   * Reduce a Postman public uid (`<owner>-<uuid>`, 6 hyphen groups) to the bare
   * model id (`<uuid>`, 5 groups). The gateway mock/monitor services proxy to
   * mock-api / monitoring-api, whose ACS permission lookup keys off the model id
   * the app sends (postman-app MockCreateContainer GETs the collection and uses
   * `.id`; data/collections uid-helper `decomposeUID` drops the owner prefix).
   * Passing the public uid straight through makes the lookup miss and the create
   * 403 ("request access from the collection editor"). Bare ids and other shapes
   * pass through unchanged so the helper is idempotent.
   */
  private toModelId(uid: string): string {
    const trimmed = String(uid ?? '').trim();
    const parts = trimmed.split('-');
    // `decomposeUID` drops the owner prefix when there are >= 6 hyphen groups
    // (`<owner>-<uuid>`); bare ids and other shapes pass through unchanged so
    // the helper is idempotent.
    return parts.length >= 6 ? parts.slice(1).join('-') : trimmed;
  }

  private isTransient(error: unknown): boolean {
    return error instanceof HttpError && (error.status === 429 || error.status >= 500);
  }

  // --- environments (service: sync) ---
  //
  // Verified live (scripts/live-gateway-probe.ts, 2026-06-30): the env service
  // proxied through this bifrost is `sync`, NOT `environment` (which answered
  // invalidServiceError). Import needs a client-generated id; list is POST (not
  // GET); get-one is the sync subpath.

  /**
   * Create/upsert an environment through the sync service.
   * POST /environment/import?workspace=:ws { id:<uuid>, name, values } -> { data:{ uid } }.
   * The id is generated once and reused across retries so the import is
   * idempotent (a retry upserts the same environment instead of duplicating it).
   */
  async createEnvironment(
    workspaceId: string,
    name: string,
    values: Array<{ key: string; value: string; type?: string; enabled?: boolean }>
  ): Promise<string> {
    const ws = workspaceId || this.workspaceId;
    const id = crypto.randomUUID();
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
    const response = await retry(
      () =>
        this.gateway.requestJson<JsonRecord>({
          service: 'sync',
          method: 'post',
          path: `/environment/import?workspace=${ws}`,
          body
        }),
      { maxAttempts: 5, delayMs: 2000, backoffMultiplier: 2, maxDelayMs: 15000, shouldRetry: (e) => this.isTransient(e) }
    );
    const uid = this.idOf(this.dataOf(response));
    if (!uid) {
      throw new Error('Environment import did not return a UID');
    }
    return uid;
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
      { maxAttempts: 5, delayMs: 2000, backoffMultiplier: 2, maxDelayMs: 15000, shouldRetry: (e) => this.isTransient(e) }
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
    const response = await this.gateway.requestJson<JsonRecord>({
      service: 'sync',
      method: 'post',
      path: `/list/environment?workspace=${ws}`
    });
    const items = Array.isArray(response?.data) ? (response.data as unknown[]) : [];
    return items
      .map((raw) => this.asRecord(raw))
      .filter((e): e is JsonRecord => e !== null)
      .map((e) => ({ name: String(e.name ?? ''), uid: this.idOf(e) }));
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
    const collection = this.toModelId(collectionUid);
    const environment = this.toModelId(environmentUid);
    const body: JsonRecord = {
      name,
      collection,
      private: false,
      ...(environment ? { environment } : {})
    };
    const response = await retry(
      () =>
        this.gateway.requestJson<JsonRecord>({
          service: 'mock',
          method: 'post',
          path: `/mocks?workspace=${ws}`,
          body
        }),
      { maxAttempts: 5, delayMs: 2000, backoffMultiplier: 2, maxDelayMs: 15000, shouldRetry: (e) => this.isTransient(e) }
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
    collectionUid: string
  ): Promise<{ uid: string; mockUrl: string } | null> {
    const mocks = await this.listMocks();
    // The gateway list returns bare model ids; the caller passes a public uid.
    // Compare on the model id so rediscovery works regardless of which id-space
    // each side is in.
    const want = this.toModelId(collectionUid);
    const match = mocks.find((m) => this.toModelId(m.collection) === want);
    return match ? { uid: match.uid, mockUrl: match.mockUrl } : null;
  }

  // --- monitors (service: monitorsV2) ---

  async createMonitor(
    workspaceId: string,
    name: string,
    collectionUid: string,
    environmentUid: string,
    cronSchedule?: string
  ): Promise<string> {
    const ws = workspaceId || this.workspaceId;
    const effectiveCron = cronSchedule && cronSchedule.trim() ? cronSchedule.trim() : '0 0 * * 0';
    const collectionId = this.toModelId(collectionUid);
    const environmentId = this.toModelId(environmentUid);
    const body: JsonRecord = {
      name,
      type: 'collection-based',
      collection: { id: collectionId },
      schedule: { cronPattern: effectiveCron, timeZone: 'UTC' },
      ...(environmentId ? { environment: { id: environmentId } } : {})
    };
    const response = await retry(
      () =>
        this.gateway.requestJson<JsonRecord>({
          service: 'monitorsV2',
          method: 'post',
          path: `/monitors?workspace=${ws}`,
          body
        }),
      { maxAttempts: 5, delayMs: 2000, backoffMultiplier: 2, maxDelayMs: 15000, shouldRetry: (e) => this.isTransient(e) }
    );
    const uid = this.idOf(this.dataOf(response));
    if (!uid) {
      throw new Error('Monitor create did not return a UID');
    }
    return uid;
  }

  async listMonitors(): Promise<
    Array<{ uid: string; name: string; active: boolean; collectionUid: string; environmentUid: string }>
  > {
    const response = await this.gateway.requestJson<JsonRecord>({
      service: 'monitorsV2',
      method: 'get',
      path: `/monitors?workspace=${this.workspaceId}`
    });
    const data = response?.data;
    const items = Array.isArray(data) ? data : [];
    return items
      .map((raw) => this.asRecord(raw))
      .filter((m): m is JsonRecord => m !== null)
      .map((m) => {
        const collection = this.asRecord(m.collection);
        const environment = this.asRecord(m.environment);
        return {
          uid: this.idOf(m),
          name: String(m.name ?? ''),
          active: m.active !== false,
          collectionUid: collection ? String(collection.id ?? '') : String(m.collection ?? ''),
          environmentUid: environment ? String(environment.id ?? '') : String(m.environment ?? '')
        };
      });
  }

  async monitorExists(uid: string): Promise<boolean> {
    try {
      await this.gateway.requestJson<JsonRecord>({
        service: 'monitorsV2',
        method: 'get',
        path: `/monitors/${this.toModelId(uid)}`
      });
      return true;
    } catch {
      return false;
    }
  }

  async findMonitorByCollection(
    collectionUid: string
  ): Promise<{ uid: string; name: string } | null> {
    const monitors = await this.listMonitors();
    const want = this.toModelId(collectionUid);
    const match = monitors.find((m) => this.toModelId(m.collectionUid) === want);
    return match ? { uid: match.uid, name: match.name } : null;
  }

  async runMonitor(uid: string): Promise<void> {
    await this.gateway.requestJson<JsonRecord>({
      service: 'monitorsV2',
      method: 'post',
      path: `/monitors/${uid}/run`
    });
  }
}
