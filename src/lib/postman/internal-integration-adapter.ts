import { HttpError } from '../http-error.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';

export interface GovernanceAssociation {
  envUid: string;
  systemEnvId: string;
}

export interface InternalIntegrationAdapterOptions {
  accessToken: string;
  backend: string;
  fetchImpl?: typeof fetch;
  orgMode?: boolean;
  secretMasker?: SecretMasker;
  teamId: string;
  workerBaseUrl?: string;
}

export interface InternalIntegrationAdapter {
  associateSystemEnvironments(
    workspaceId: string,
    associations: GovernanceAssociation[]
  ): Promise<void>;
  connectWorkspaceToRepository(
    workspaceId: string,
    repoUrl: string
  ): Promise<void>;
  createApiKey(
    name: string
  ): Promise<string>;
}

class BifrostInternalIntegrationAdapter implements InternalIntegrationAdapter {
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly orgMode: boolean;
  private readonly teamId: string;
  private readonly workerBaseUrl: string;

  constructor(options: InternalIntegrationAdapterOptions) {
    this.accessToken = String(options.accessToken || '').trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.orgMode = options.orgMode ?? false;
    this.teamId = String(options.teamId || '').trim();
    this.workerBaseUrl = String(
      options.workerBaseUrl ||
        'https://catalog-admin.postman-account2009.workers.dev'
    ).replace(/\/+$/, '');
    void (options.secretMasker ?? createSecretMasker([this.accessToken]));
  }

  /** Build Bifrost proxy headers. Only includes x-entity-team-id for org-mode teams. */
  private bifrostHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-access-token': this.accessToken
    };
    if (this.teamId && this.orgMode) {
      headers['x-entity-team-id'] = this.teamId;
    }
    return headers;
  }

  async associateSystemEnvironments(
    workspaceId: string,
    associations: GovernanceAssociation[]
  ): Promise<void> {
    if (associations.length === 0) {
      return;
    }

    const response = await this.fetchImpl(
      `${this.workerBaseUrl}/api/internal/system-envs/associate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          associations: associations.map((entry) => ({
            env_uid: entry.envUid,
            system_env_id: entry.systemEnvId
          }))
        })
      }
    );

    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method: 'POST',
        requestHeaders: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        secretValues: [this.accessToken],
        url: `${this.workerBaseUrl}/api/internal/system-envs/associate`
      });
    }
  }

  async connectWorkspaceToRepository(
    workspaceId: string,
    repoUrl: string
  ): Promise<void> {
    const url = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';
    const payload = {
      service: 'workspaces',
      method: 'POST',
      path: `/workspaces/${workspaceId}/filesystem`,
      body: {
        path: '/',
        repo: repoUrl,
        versionControl: true
      }
    };

    const headers = this.bifrostHeaders();

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method: 'POST',
        requestHeaders: headers,
        secretValues: [this.accessToken],
        url
      });
    }
  }

  async createApiKey(name: string): Promise<string> {
    const url = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';
    const headers = this.bifrostHeaders();

    const payload = {
      service: 'identity',
      method: 'POST',
      path: '/api/keys',
      body: { apikey: { name, type: 'v2' } }
    };

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method: 'POST',
        requestHeaders: headers,
        secretValues: [this.accessToken],
        url
      });
    }

    const data = await response.json() as any;
    if (!data?.apikey?.key) {
      throw new Error(`Failed to extract API key from Bifrost response: ${JSON.stringify(data)}`);
    }

    return data.apikey.key;
  }
}

export function createInternalIntegrationAdapter(
  options: InternalIntegrationAdapterOptions
): InternalIntegrationAdapter {
  if (options.backend !== 'bifrost') {
    const masker =
      options.secretMasker ?? createSecretMasker([options.accessToken]);
    throw new Error(
      masker(`Unsupported integration backend: ${String(options.backend || '')}`)
    );
  }

  return new BifrostInternalIntegrationAdapter(options);
}
