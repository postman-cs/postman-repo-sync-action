import { HttpError } from '../http-error.js';
import { retry, type RetryOptions } from '../retry.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';

type EnvironmentValue = {
  key: string;
  type: string;
  value: string;
};

type FetchResult = Record<string, unknown> | null;
type CollectionResponse = { collection?: unknown };
type EnvironmentResponse = { environment?: unknown };
type MonitorResponse = { monitor?: { uid?: unknown } };
type MockResponse = {
  mock?: { uid?: unknown; mockUrl?: unknown; config?: { serverResponseId?: unknown } };
};

/**
 * A 429 (throttle) or any 5xx is a transient backend condition worth retrying.
 * A 4xx other than 429 is a client error and is never retried.
 */
function isTransientHttpError(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 429 || error.status >= 500);
}

export interface PostmanAssetsClientOptions {
  apiKey: string;
  baseUrl?: string;
  bifrostBaseUrl?: string;
  fetchImpl?: typeof fetch;
  retrySleep?: (delayMs: number) => Promise<void>;
  secretMasker?: SecretMasker;
}

export class PostmanAssetsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly bifrostBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retrySleep: ((delayMs: number) => Promise<void>) | undefined;

  constructor(options: PostmanAssetsClientOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.baseUrl = String(options.baseUrl || POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl).replace(
      /\/+$/,
      ''
    );
    this.bifrostBaseUrl = String(
      options.bifrostBaseUrl || POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl
    ).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retrySleep = options.retrySleep;
    void (options.secretMasker ?? createSecretMasker([this.apiKey]));
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getBifrostBaseUrl(): string {
    return this.bifrostBaseUrl;
  }

  private async request(
    path: string,
    init: RequestInit = {}
  ): Promise<FetchResult> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
        ...(init.headers || {})
      }
    });

    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method: init.method || 'GET',
        requestHeaders: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
          ...(init.headers || {})
        },
        secretValues: [this.apiKey],
        url
      });
    }

    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Shared retry policy for environment create/update. Mirrors
   * requestWithCollectionRetry's backoff and retries only transient 429/5xx.
   */
  private environmentRetryOptions(): RetryOptions {
    return {
      maxAttempts: 5,
      delayMs: 2000,
      backoffMultiplier: 2,
      maxDelayMs: 15000,
      ...(this.retrySleep ? { sleep: this.retrySleep } : {}),
      shouldRetry: isTransientHttpError
    };
  }

  async listEnvironments(
    workspaceId: string
  ): Promise<Array<{ name: string; uid: string }>> {
    const response = (await this.request(`/environments?workspace=${workspaceId}`)) as
      | { environments?: Array<{ name?: unknown; uid?: unknown }> }
      | null;
    const items = Array.isArray(response?.environments) ? response.environments : [];
    return items.map((item) => ({
      name: String(item?.name ?? '').trim(),
      uid: String(item?.uid ?? '').trim()
    }));
  }

  async createEnvironment(
    workspaceId: string,
    name: string,
    values: EnvironmentValue[]
  ): Promise<string> {
    // Environment creation is a non-idempotent POST. A transient 429/5xx leaves
    // the outcome ambiguous: the environment may already exist server-side. On
    // every retry past the first attempt, reconcile by name within the workspace
    // and adopt an already-created environment instead of POSTing a duplicate.
    const targetName = name.trim();
    let attempted = false;
    return retry(async () => {
      if (attempted) {
        const existingUid = (
          await this.listEnvironments(workspaceId).catch(() => [])
        ).find((environment) => environment.name === targetName)?.uid;
        if (existingUid) {
          return existingUid;
        }
      }
      attempted = true;
      const response = await this.request(`/environments?workspace=${workspaceId}`, {
        method: 'POST',
        body: JSON.stringify({
          environment: {
            name,
            values
          }
        })
      });

      const uid = String(
        (response as { environment?: { uid?: unknown } } | null)?.environment?.uid || ''
      ).trim();
      if (!uid) {
        throw new Error('Environment create did not return a UID');
      }
      return uid;
    }, this.environmentRetryOptions());
  }

  async updateEnvironment(
    uid: string,
    name: string,
    values: EnvironmentValue[]
  ): Promise<void> {
    // PUT is idempotent, so a transient 429/5xx is safe to retry directly.
    await retry(
      () =>
        this.request(`/environments/${uid}`, {
          method: 'PUT',
          body: JSON.stringify({
            environment: {
              name,
              values
            }
          })
        }),
      this.environmentRetryOptions()
    );
  }


  /**
   * Monitor and mock creation reference a collection that may have been
   * created moments earlier; the Postman backend is eventually consistent
   * and can reject the reference with a 400 "Unable to load collection"
   * until the collection becomes visible. Retry only that specific 400 and
   * 429 throttling: both guarantee nothing was created. A 5xx on these
   * non-idempotent creates is ambiguous (the asset may exist server-side),
   * so it is not retried to avoid duplicate mocks and monitors.
   */
  private async requestWithCollectionRetry(
    path: string,
    init: RequestInit
  ): Promise<FetchResult> {
    return retry(() => this.request(path, init), {
      maxAttempts: 5,
      delayMs: 2000,
      backoffMultiplier: 2,
      maxDelayMs: 15000,
      ...(this.retrySleep ? { sleep: this.retrySleep } : {}),
      shouldRetry: (error) => {
        if (!(error instanceof HttpError)) {
          return false;
        }
        if (error.status === 429) {
          return true;
        }
        return (
          error.status === 400 && /unable to load collection/i.test(error.responseBody)
        );
      }
    });
  }

  async createMonitor(
    workspaceId: string,
    name: string,
    collectionUid: string,
    environmentUid: string,
    cronSchedule?: string
  ): Promise<string> {
    const effectiveCron = cronSchedule && cronSchedule.trim() ? cronSchedule.trim() : '0 0 * * 0';
    const response = await this.requestWithCollectionRetry(`/monitors?workspace=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        monitor: {
          name,
          collection: collectionUid,
          environment: environmentUid,
          schedule: {
            cron: effectiveCron,
            timezone: 'UTC'
          }
        }
      })
    });

    const uid = String((response as MonitorResponse | null)?.monitor?.uid || '').trim();
    if (!uid) {
      throw new Error('Monitor create did not return a UID');
    }

    if (!cronSchedule || !cronSchedule.trim()) {
      try {
        await this.request(`/monitors/${uid}`, {
          method: 'PUT',
          body: JSON.stringify({ monitor: { active: false } })
        });
      } catch {
        // best-effort disable; monitor still created
      }
    }

    return uid;
  }

  async createMock(
    workspaceId: string,
    name: string,
    collectionUid: string,
    environmentUid: string
  ): Promise<{ uid: string; url: string }> {
    const response = await this.requestWithCollectionRetry(`/mocks?workspace=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        mock: {
          name,
          collection: collectionUid,
          environment: environmentUid,
          private: false
        }
      })
    });

    const uid = String((response as MockResponse | null)?.mock?.uid || '').trim();
    if (!uid) {
      throw new Error('Mock create did not return a UID');
    }

    return {
      uid,
      url:
        String((response as MockResponse | null)?.mock?.mockUrl || '').trim() ||
        String((response as MockResponse | null)?.mock?.config?.serverResponseId || '').trim()
    };
  }

  async getCollection(uid: string): Promise<unknown> {
    const response = await this.request(`/collections/${uid}`) as CollectionResponse | null;
    return response?.collection;
  }

  async getEnvironment(uid: string): Promise<unknown> {
    const response = await this.request(`/environments/${uid}`) as EnvironmentResponse | null;
    return response?.environment;
  }

  async getMe(): Promise<Record<string, unknown> | null> {
    return this.request('/me', { method: 'GET' }) as Promise<Record<string, unknown> | null>;
  }

  async getAutoDerivedTeamId(): Promise<string | undefined> {
    try {
      const data = await this.getMe();
      const user = data?.user;
      if (user && typeof user === 'object' && 'teamId' in user && user.teamId) {
        return String(user.teamId);
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  async getTeams(): Promise<Array<{ id: number; name: string; handle: string; organizationId?: number }>> {
    const data = await this.request('/teams');
    const teams = data?.data ?? [];
    return Array.isArray(teams)
      ? teams
          .filter((t): t is Record<string, unknown> => {
            return (
              typeof t === 'object' &&
              t !== null &&
              'id' in t &&
              t.id != null &&
              'name' in t &&
              String(t.name).trim().length > 0
            );
          })
          .map((t) => ({
            id: Number(t.id),
            name: String(t.name),
            handle: String(t.handle ?? ''),
            ...((t.organizationId ?? null) != null ? { organizationId: Number(t.organizationId) } : {})
          }))
      : [];
  }

  async listMonitors(): Promise<Array<{uid: string; name: string; active: boolean; collectionUid: string; environmentUid: string}>> {
    const response = await this.request('/monitors');
    const monitors = response?.monitors ?? [];
    return Array.isArray(monitors)
      ? monitors
          .filter((m): m is Record<string, unknown> => {
            return typeof m === 'object' && m !== null && 'uid' in m;
          })
          .map((m) => ({
            uid: String(m.uid),
            name: String(m.name ?? ''),
            active: m.active !== false,
            collectionUid: String(m.collectionUid ?? ''),
            environmentUid: String(m.environmentUid ?? '')
          }))
      : [];
  }

  async listMocks(): Promise<Array<{uid: string; name: string; collection: string; mockUrl: string; environment: string}>> {
    const response = await this.request('/mocks');
    const mocks = response?.mocks ?? [];
    return Array.isArray(mocks)
      ? mocks
          .filter((m): m is Record<string, unknown> => {
            return typeof m === 'object' && m !== null && 'uid' in m;
          })
          .map((m) => ({
            uid: String(m.uid),
            name: String(m.name ?? ''),
            collection: String(m.collection ?? ''),
            mockUrl: String(m.mockUrl ?? ''),
            environment: String(m.environment ?? '')
          }))
      : [];
  }

  async monitorExists(uid: string): Promise<boolean> {
    try {
      await this.request(`/monitors/${uid}`);
      return true;
    } catch {
      return false;
    }
  }

  async runMonitor(uid: string): Promise<void> {
    await this.request(`/monitors/${uid}/run`, { method: 'POST' });
  }

  async mockExists(uid: string): Promise<boolean> {
    try {
      await this.request(`/mocks/${uid}`);
      return true;
    } catch {
      return false;
    }
  }

  async findMonitorByCollection(collectionUid: string): Promise<{uid: string; name: string} | null> {
    const monitors = await this.listMonitors();
    const match = monitors.find(m => m.collectionUid === collectionUid);
    return match ? {uid: match.uid, name: match.name} : null;
  }

  async findMockByCollection(collectionUid: string): Promise<{uid: string; mockUrl: string} | null> {
    const mocks = await this.listMocks();
    const match = mocks.find(m => m.collection === collectionUid);
    return match ? {uid: match.uid, mockUrl: match.mockUrl} : null;
  }

}
