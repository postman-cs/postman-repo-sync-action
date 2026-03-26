import { HttpError } from '../http-error.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';

type EnvironmentValue = {
  key: string;
  type: string;
  value: string;
};

type FetchResult = Record<string, any> | null;

export interface PostmanAssetsClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  secretMasker?: SecretMasker;
}

export class PostmanAssetsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PostmanAssetsClientOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.baseUrl = String(options.baseUrl || 'https://api.getpostman.com').replace(
      /\/+$/,
      ''
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    void (options.secretMasker ?? createSecretMasker([this.apiKey]));
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
      return (await response.json()) as Record<string, any>;
    } catch {
      return null;
    }
  }

  async createEnvironment(
    workspaceId: string,
    name: string,
    values: EnvironmentValue[]
  ): Promise<string> {
    const response = await this.request(`/environments?workspace=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({
        environment: {
          name,
          values
        }
      })
    });

    const uid = String(response?.environment?.uid || '').trim();
    if (!uid) {
      throw new Error('Environment create did not return a UID');
    }
    return uid;
  }

  async updateEnvironment(
    uid: string,
    name: string,
    values: EnvironmentValue[]
  ): Promise<void> {
    await this.request(`/environments/${uid}`, {
      method: 'PUT',
      body: JSON.stringify({
        environment: {
          name,
          values
        }
      })
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
    const response = await this.request(`/monitors?workspace=${workspaceId}`, {
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

    const uid = String(response?.monitor?.uid || '').trim();
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
    const response = await this.request(`/mocks?workspace=${workspaceId}`, {
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

    const uid = String(response?.mock?.uid || '').trim();
    if (!uid) {
      throw new Error('Mock create did not return a UID');
    }

    return {
      uid,
      url:
        String(response?.mock?.mockUrl || '').trim() ||
        String(response?.mock?.config?.serverResponseId || '').trim()
    };
  }

  async getCollection(uid: string): Promise<any> {
    const response = await this.request(`/collections/${uid}`);
    return response?.collection;
  }

  async getEnvironment(uid: string): Promise<any> {
    const response = await this.request(`/environments/${uid}`);
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
    } catch (e) {
      // ignore
    }
    return undefined;
  }

  async getTeams(): Promise<Array<{ id: number; name: string; handle: string; organizationId?: number }>> {
    const data = await this.request('/teams');
    const teams = data?.data ?? [];
    return Array.isArray(teams)
      ? teams
          .filter((t: any) => t?.id && t?.name)
          .map((t: any) => ({
            id: Number(t.id),
            name: String(t.name),
            handle: String(t.handle || ''),
            ...(t.organizationId != null ? { organizationId: Number(t.organizationId) } : {})
          }))
      : [];
  }

  async listMonitors(): Promise<Array<{uid: string; name: string; active: boolean; collectionUid: string; environmentUid: string}>> {
    const response = await this.request('/monitors');
    const monitors = response?.monitors ?? [];
    return Array.isArray(monitors)
      ? monitors
          .filter((m: any) => m?.uid)
          .map((m: any) => ({
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
          .filter((m: any) => m?.uid)
          .map((m: any) => ({
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
