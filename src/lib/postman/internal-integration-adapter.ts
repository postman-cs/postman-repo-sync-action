import { HttpError } from '../http-error.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';

export interface GovernanceAssociation {
  envUid: string;
  systemEnvId: string;
}

export interface InternalIntegrationAdapterOptions {
  accessToken: string;
  backend: string;
  bifrostBaseUrl?: string;
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

/**
 * Pull the owning workspace id out of a Bifrost duplicate-link error body.
 * The current shape is {error:{name:'invalidParamError',message:'File system
 * with this repo and path already exists',meta:{workspaceId:'...'}}}; legacy
 * 'projectAlreadyConnected' bodies carry no workspace id and yield undefined.
 */
function extractDuplicateWorkspaceId(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: { meta?: { workspaceId?: unknown } };
      meta?: { workspaceId?: unknown };
    };
    const candidate =
      parsed?.error?.meta?.workspaceId ?? parsed?.meta?.workspaceId;
    return typeof candidate === 'string' && candidate.trim()
      ? candidate.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

class BifrostInternalIntegrationAdapter implements InternalIntegrationAdapter {
  private readonly accessToken: string;
  private readonly bifrostBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly orgMode: boolean;
  private readonly teamId: string;
  private readonly workerBaseUrl: string;

  constructor(options: InternalIntegrationAdapterOptions) {
    this.accessToken = String(options.accessToken || '').trim();
    this.bifrostBaseUrl = String(
      options.bifrostBaseUrl || POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl
    ).replace(/\/+$/, '');
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
    const url = `${this.bifrostBaseUrl}/ws/proxy`;
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
      // Handle Bifrost duplicate-link errors as idempotent success when the
      // same repo is already connected. Both the legacy ('invalidParamError' +
      // 'already exists') and current ('projectAlreadyConnected') error shapes
      // are treated as expected re-link attempts.
      if (response.status === 400) {
        const body = await response.text();
        const isDuplicate =
          (body.includes('invalidParamError') && body.includes('already exists')) ||
          body.includes('projectAlreadyConnected');
        if (isDuplicate) {
          // The duplicate error carries the workspace that holds the existing
          // filesystem record (error.meta.workspaceId). When that workspace is
          // not the one being linked, this is a stale record (typically left
          // behind by a deleted workspace; the record survives deletion and
          // keeps the repo+path pair reserved), so the workspace being linked
          // ends up with no link at all. Swallowing that case reports a link
          // that does not exist; fail loudly instead.
          const existingWorkspaceId = extractDuplicateWorkspaceId(body);
          if (existingWorkspaceId && existingWorkspaceId !== workspaceId) {
            throw new Error(
              `Repository is already linked to workspace ${existingWorkspaceId}, ` +
                `so Bifrost refused the link to workspace ${workspaceId}. ` +
                'If that workspace was deleted, its filesystem record still ' +
                'reserves this repo and path; disconnect the stale link ' +
                '(restore the old workspace and disconnect the repository, or ' +
                'have a team admin remove it) and re-run.'
            );
          }
          return;
        }
      }
      throw await HttpError.fromResponse(response, {
        method: 'POST',
        requestHeaders: headers,
        secretValues: [this.accessToken],
        url
      });
    }
  }

  async createApiKey(name: string): Promise<string> {
    const url = `${this.bifrostBaseUrl}/ws/proxy`;
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

    const data = await response.json() as { apikey?: { key?: string } };
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
