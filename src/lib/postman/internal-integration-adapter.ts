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
}

class BifrostInternalIntegrationAdapter implements InternalIntegrationAdapter {
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly teamId: string;
  private readonly workerBaseUrl: string;

  constructor(options: InternalIntegrationAdapterOptions) {
    this.accessToken = String(options.accessToken || '').trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.teamId = String(options.teamId || '').trim();
    this.workerBaseUrl = String(
      options.workerBaseUrl ||
        'https://catalog-admin.postman-account2009.workers.dev'
    ).replace(/\/+$/, '');
    void (options.secretMasker ?? createSecretMasker([this.accessToken]));
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

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-access-token': this.accessToken,
        'x-entity-team-id': this.teamId
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method: 'POST',
        requestHeaders: {
          'Content-Type': 'application/json',
          'x-access-token': this.accessToken,
          'x-entity-team-id': this.teamId
        },
        secretValues: [this.accessToken],
        url
      });
    }
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
