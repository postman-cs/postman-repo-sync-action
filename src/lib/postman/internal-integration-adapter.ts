import { HttpError } from '../http-error.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';
import { getMemoizedSessionIdentity } from './credential-identity.js';
import { adviseFromHttpError, type ErrorAdviceContext } from './error-advice.js';

export interface GovernanceAssociation {
  envUid: string;
  systemEnvId: string;
}

export interface InternalIntegrationAdapterOptions {
  accessToken: string;
  /**
   * Live token accessor. When present, the adapter reads the access token
   * through it on every request instead of capturing `accessToken`, so a
   * mid-run single-flight re-mint (AccessTokenProvider) propagates to the
   * governance / workspace-link / identity Bifrost calls. Defaults to the
   * static `accessToken` when omitted.
   */
  getAccessToken?: () => string;
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
  private readonly getAccessToken?: () => string;
  private readonly bifrostBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly orgMode: boolean;
  private readonly secretMasker: SecretMasker;
  private readonly teamId: string;
  private readonly workerBaseUrl: string;

  constructor(options: InternalIntegrationAdapterOptions) {
    this.accessToken = String(options.accessToken || '').trim();
    this.getAccessToken = options.getAccessToken;
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
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([this.accessToken]);
  }

  /** Live access token: re-minted value when a provider accessor is wired, else the captured one. */
  private currentToken(): string {
    return this.getAccessToken ? String(this.getAccessToken() || '').trim() : this.accessToken;
  }

  /** Build Bifrost proxy headers. Only includes x-entity-team-id for org-mode teams. */
  private bifrostHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-access-token': this.currentToken()
    };
    if (this.teamId && this.orgMode) {
      headers['x-entity-team-id'] = this.teamId;
    }
    return headers;
  }

  /** Reactive error-advice context, enriched with the preflight session memo when present. */
  private adviceContext(operation: string): ErrorAdviceContext {
    const session = getMemoizedSessionIdentity();
    return {
      operation,
      hasAccessToken: Boolean(this.currentToken()),
      sessionTeamId: session?.teamId,
      sessionRoles: session?.roles,
      sessionConsumerType: session?.consumerType,
      explicitTeamId: this.teamId || undefined,
      mask: this.secretMasker
    };
  }

  async associateSystemEnvironments(
    workspaceId: string,
    associations: GovernanceAssociation[]
  ): Promise<void> {
    if (associations.length === 0) {
      return;
    }

    const token = this.currentToken();
    const response = await this.fetchImpl(
      `${this.workerBaseUrl}/api/internal/system-envs/associate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
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
      const httpErr = await HttpError.fromResponse(response, {
        method: 'POST',
        requestHeaders: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        secretValues: [token],
        url: `${this.workerBaseUrl}/api/internal/system-envs/associate`
      });
      const advised = adviseFromHttpError(
        httpErr,
        this.adviceContext('system environment association')
      );
      throw advised ?? httpErr;
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
      let consumedBody: string | undefined;
      if (response.status === 400) {
        const body = await response.text();
        consumedBody = body;
        const isDuplicate =
          (body.includes('invalidParamError') && body.includes('already exists')) ||
          body.includes('projectAlreadyConnected');
        if (isDuplicate) {
          // The duplicate error carries the workspace that holds the existing
          // filesystem record (error.meta.workspaceId). Filesystem records are
          // deleted together with their workspace, so a conflicting record
          // means the other workspace still exists. In org-mode teams it is
          // commonly a personal-visibility workspace created by a run that was
          // missing workspace-team-id, which most credentials cannot see.
          // Swallowing that case reports a link that does not exist; fail
          // loudly with whatever identity can be resolved.
          const existingWorkspaceId = extractDuplicateWorkspaceId(body);
          if (existingWorkspaceId && existingWorkspaceId !== workspaceId) {
            throw new Error(
              await this.describeWorkspaceLinkConflict(existingWorkspaceId, workspaceId, repoUrl)
            );
          }
          return;
        }
      }
      const httpErr = await HttpError.fromResponse(response, {
        method: 'POST',
        requestHeaders: headers,
        secretValues: [this.currentToken()],
        url,
        ...(consumedBody !== undefined ? { responseBody: consumedBody } : {})
      });
      const advised = adviseFromHttpError(
        httpErr,
        this.adviceContext('workspace repository linking')
      );
      throw advised ?? httpErr;
    }
  }

  /**
   * Build the failure message for a duplicate-link conflict. Looks the owning
   * workspace up through the same Bifrost proxy credentials as the connect
   * attempt, so the outcome doubles as a visibility probe: a 403 means the
   * workspace exists for someone else (personal visibility or another
   * sub-team), which is the common org-mode failure shape.
   */
  private async describeWorkspaceLinkConflict(
    existingWorkspaceId: string,
    targetWorkspaceId: string,
    repoUrl: string
  ): Promise<string> {
    const base =
      `Repository ${repoUrl} is already linked to workspace ${existingWorkspaceId}, ` +
      `so Bifrost refused the link to workspace ${targetWorkspaceId}.`;
    let lookupStatus = 0;
    let workspaceName = '';
    try {
      const response = await this.fetchImpl(`${this.bifrostBaseUrl}/ws/proxy`, {
        method: 'POST',
        headers: this.bifrostHeaders(),
        body: JSON.stringify({
          service: 'workspaces',
          method: 'GET',
          path: `/workspaces/${existingWorkspaceId}`
        })
      });
      lookupStatus = response.status;
      if (response.ok) {
        const parsed = (await response.json()) as {
          data?: { name?: unknown };
          error?: { name?: unknown };
        };
        if (typeof parsed?.data?.name === 'string' && parsed.data.name) {
          workspaceName = parsed.data.name;
        } else if (parsed?.error) {
          // The proxy can wrap upstream errors in a 200 envelope.
          lookupStatus = 403;
        }
      }
    } catch {
      // Network failure during the lookup; fall through to the generic text.
    }

    if (workspaceName) {
      return (
        `${base} That workspace is "${workspaceName}" ` +
        `(https://go.postman.co/workspace/${existingWorkspaceId}). ` +
        `To reuse it, pass workspace-id: ${existingWorkspaceId} or set the ` +
        'POSTMAN_WORKSPACE_ID repository variable to it. To link this workspace ' +
        `instead, disconnect the repository from "${workspaceName}" in Workspace ` +
        'Settings or delete that workspace (deleting a workspace also removes ' +
        'its repository link record), then re-run.'
      );
    }
    if (lookupStatus === 401 || lookupStatus === 403) {
      return (
        `${base} That workspace exists but is invisible to the credentials this ` +
        'action runs with. This usually means an org-mode onboarding run created ' +
        'it without workspace-team-id, leaving it with personal visibility that ' +
        'hides it from teammates, other API keys, and the API Catalog; it may ' +
        'also belong to another sub-team. Ask whoever created it (or a team ' +
        'admin) to disconnect the repository from that workspace or delete it ' +
        '(deleting a workspace also removes its repository link record), then ' +
        're-run.'
      );
    }
    if (lookupStatus === 404) {
      return (
        `${base} That workspace looks recently deleted; its repository link ` +
        'record is removed with it. Re-run, and contact Postman support if the ' +
        'conflict persists.'
      );
    }
    return (
      `${base} Details for that workspace could not be resolved with these ` +
      'credentials. Disconnect the repository from it or delete that workspace ' +
      '(deleting a workspace also removes its repository link record) and ' +
      're-run; if it is invisible to you, ask its creator or a team admin.'
    );
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
      const httpErr = await HttpError.fromResponse(response, {
        method: 'POST',
        requestHeaders: headers,
        secretValues: [this.currentToken()],
        url
      });
      const advised = adviseFromHttpError(httpErr, this.adviceContext('API key generation'));
      throw advised ?? httpErr;
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
