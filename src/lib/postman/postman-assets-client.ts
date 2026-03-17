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
    cron?: string
  ): Promise<{ uid: string; type: 'cli' | 'cloud' }> {
    const monitor: Record<string, unknown> = {
      name,
      collection: collectionUid,
      environment: environmentUid
    };
    monitor.schedule = { cron: cron || '0 0 * * 0', timezone: 'UTC' };
    const response = await this.request(`/monitors?workspace=${workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({ monitor })
    });

    const uid = String(response?.monitor?.uid || '').trim();
    if (!uid) {
      throw new Error('Monitor create did not return a UID');
    }
    if (!cron) {
      await this.request(`/monitors/${uid}`, {
        method: 'PUT',
        body: JSON.stringify({ monitor: { active: false } })
      }).catch(() => {});
    }
    return { uid, type: cron ? 'cloud' as const : 'cli' as const };
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

  async monitorExists(uid: string): Promise<boolean> {
    try {
      await this.request(`/monitors/${uid}`);
      return true;
    } catch {
      return false;
    }
  }

  async getCollection(uid: string): Promise<any> {
    const response = await this.request(`/collections/${uid}`);
    return response?.collection;
  }

  async getEnvironment(uid: string): Promise<any> {
    const response = await this.request(`/environments/${uid}`);
    return response?.environment;
  }
}
