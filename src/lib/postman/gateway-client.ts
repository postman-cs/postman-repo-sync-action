import { HttpError } from '../http-error.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';
import type { SecretMasker } from '../secrets.js';
import { createSecretMasker } from '../secrets.js';
import type { AccessTokenProvider } from './token-provider.js';
import { fullJitterDelayMs, parseRetryAfterMs } from '../retry.js';
import {
  defaultPostmanAppVersionProvider,
  type PostmanAppVersionProvider
} from './app-version.js';

export type GatewayMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface GatewayRequest {
  service: string;
  method: GatewayMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Extra route-specific headers (e.g. x-app-version, X-Entity-Type). */
  headers?: Record<string, string>;
  /** Cold `/_api` fallback eligibility. `'auto'` opts an unsafe mutation in
   * (only valid after the caller has reconciled and knows the create is
   * absent); safe requests always fall back, unsafe requests never do unless
   * `'auto'` is set. */
  fallback?: 'auto' | 'none';
}

export interface AccessTokenGatewayClientOptions {
  tokenProvider: AccessTokenProvider;
  bifrostBaseUrl?: string;
  teamId?: string;
  orgMode?: boolean;
  fetchImpl?: typeof fetch;
  secretMasker?: SecretMasker;
  /** Max transient (5xx / network) retries per request (default 3). */
  maxRetries?: number;
  /** Cold fallback base URL for one last-ditch attempt after the primary
   * budget is exhausted on a transient failure (e.g. the app's `/_api` alias).
   * Only used when the request would otherwise throw a transient error; the
   * fallback is a single serial attempt, never hedged in parallel. Disabled
   * when unset or when POSTMAN_ITEM_CREATE_FALLBACK=off. */
  fallbackBaseUrl?: string;
  /** Base backoff in ms; attempt n waits baseDelayMs * 2^(n-1) (default 400). */
  retryBaseDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  appVersionProvider?: PostmanAppVersionProvider;
  requestTimeoutMs?: number;
  retryMaxDelayMs?: number;
  randomImpl?: () => number;
}

function isExpiredAuthError(status: number, body: string): boolean {
  return (
    status === 401 ||
    body.includes('UNAUTHENTICATED') ||
    body.includes('authenticationError')
  );
}

/**
 * Transient downstream failures the gateway surfaces intermittently (Bifrost
 * proxy read timeouts, gateway 5xx, and statusless transport failures). Safe
 * reads retry these with backoff.
 * Unsafe creates opt out via `{ retryTransient: false }` and reconcile through
 * live discovery instead of re-POSTing — an `ESOCKETTIMEDOUT` after accept can
 * otherwise duplicate mocks/monitors. The large v3 collection export read is
 * the observed safe-read trigger.
 */
function isRetryableSafeReadResponse(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generic access-token gateway client.
 *
 * Sends the app's `POST {bifrost}/ws/proxy` envelope
 * (`{ service, method, path, query?, body? }`) authenticated with
 * `x-access-token` read live from the {@link AccessTokenProvider} (so a
 * re-minted token propagates without reconstruction), plus `x-entity-team-id`
 * only in org-mode. This is the single place token refresh is wired: a 401 /
 * UNAUTHENTICATED / authenticationError triggers one single-flight re-mint and
 * one retry; a second failure surfaces an HttpError with secrets redacted.
 */
export class AccessTokenGatewayClient {
  private readonly tokenProvider: AccessTokenProvider;
  private readonly bifrostBaseUrl: string;
  private teamId: string;
  private orgMode: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly secretMasker: SecretMasker;
  private readonly maxRetries: number;
  private readonly fallbackBaseUrl?: string;
  private readonly retryBaseDelayMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly appVersionProvider: PostmanAppVersionProvider;
  private readonly requestTimeoutMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly randomImpl: () => number;

  constructor(options: AccessTokenGatewayClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.bifrostBaseUrl = String(
      options.bifrostBaseUrl || POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl
    ).replace(/\/+$/, '');
    this.teamId = String(options.teamId || '').trim();
    this.orgMode = options.orgMode ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([this.tokenProvider.current()]);
    this.maxRetries = options.maxRetries ?? 3;
    const fallbackEnv = typeof process !== 'undefined' ? process.env?.POSTMAN_ITEM_CREATE_FALLBACK : undefined;
    this.fallbackBaseUrl =
      fallbackEnv === 'off' ? undefined : options.fallbackBaseUrl?.replace(/\/+$/, '');
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 400;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.appVersionProvider = options.appVersionProvider ?? defaultPostmanAppVersionProvider;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 5_000;
    this.randomImpl = options.randomImpl ?? Math.random;
  }

  configureTeamContext(teamId: string, orgMode: boolean): void {
    this.teamId = String(teamId || '').trim();
    this.orgMode = orgMode;
  }

  private async buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const appVersion = await this.appVersionProvider.get();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-access-token': this.tokenProvider.current(),
      ...(extra || {}),
      ...(appVersion ? { 'x-app-version': appVersion } : {})
    };
    if (this.teamId && this.orgMode) {
      headers['x-entity-team-id'] = this.teamId;
    }
    return headers;
  }

  private async send(request: GatewayRequest, baseUrl?: string): Promise<Response> {
    const url = `${baseUrl ?? this.bifrostBaseUrl}/ws/proxy`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try { return await this.fetchImpl(url, {
      method: 'POST',
      headers: await this.buildHeaders(request.headers),
      signal: controller.signal,
      body: JSON.stringify({
        service: request.service,
        method: request.method,
        path: request.path,
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(request.body !== undefined ? { body: request.body } : {})
      })
    }); } finally { clearTimeout(timer); }
  }

  /**
   * One cold, serial attempt against the fallback base URL after the primary
   * budget is exhausted on a transient failure. Never hedged in parallel with
   * the primary; only fires when the request would otherwise throw. Callers
   * with `retryTransient: false` still reconcile first — the fallback attempt
   * here is the resend, so it is only used for requests whose mutation is
   * known idempotent or already reconciled by the caller's adopt-on-ambiguous
   * loop.
   */
  private async tryFallback(request: GatewayRequest): Promise<Response | null> {
    if (!this.fallbackBaseUrl) return null;
    try {
      return await this.send(request, this.fallbackBaseUrl);
    } catch {
      return null;
    }
  }

  /**
   * Run the fallback attempt and classify its response the same way the
   * primary path would. Returns the success response, or null when the
   * fallback also failed transiently (caller then throws the original error).
   * Non-transient fallback failures (4xx) surface as their own HttpError since
   * they are the freshest authoritative answer.
   */
  private fallbackEligible(request: GatewayRequest, retryTransient: boolean): boolean {
    if (request.fallback === 'none') return false;
    if (!this.fallbackBaseUrl) return false;
    return retryTransient || request.fallback === 'auto';
  }

  private async attemptFallback(
    request: GatewayRequest,
    retryTransient: boolean
  ): Promise<Response | null> {
    if (!this.fallbackEligible(request, retryTransient)) return null;
    const response = await this.tryFallback(request);
    if (!response) return null;
    if (response.ok) return response;
    const body = await response.text().catch(() => '');
    if (isRetryableSafeReadResponse(response.status)) return null;
    throw this.toHttpError(request, response, body);
  }

  /**
   * Send a gateway request, refreshing the token once on an auth failure and
   * optionally retrying transient downstream failures (5xx / Bifrost read
   * timeouts) with exponential backoff. Safe reads keep transient retries;
   * unsafe creates pass `{ retryTransient: false }` and reconcile after an
   * ambiguous response instead of re-POSTing. Auth refresh remains independent
   * of the transient-retry budget.
   */
  async request(
    request: GatewayRequest,
    options: { retryTransient?: boolean } = {}
  ): Promise<Response> {
    const retryTransient = options.retryTransient ?? request.method === 'get';
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.send(request);
      } catch (error) {
        if (retryTransient && attempt < this.maxRetries) {
          const delay = this.retryDelayMs(attempt);
          attempt += 1;
          await this.sleepImpl(delay);
          continue;
        }
        const fallbackResponse = await this.attemptFallback(request, retryTransient);
        if (fallbackResponse) return fallbackResponse;
        throw error;
      }
      if (response.ok) {
        const okBody = await response.text().catch(() => '');
        const inner = this.innerStatus(okBody);
        if (inner !== undefined) {
          if (retryTransient && this.isTransient(inner, okBody) && attempt < this.maxRetries) {
            await this.sleepImpl(this.retryDelayMs(attempt)); attempt += 1; continue;
          }
          throw this.toInnerHttpError(request, inner, okBody);
        }
        return this.rebuildResponse(response, okBody);
      }

      const body = await response.text().catch(() => '');
      if (isExpiredAuthError(response.status, body) && this.tokenProvider.canRefresh()) {
        await this.tokenProvider.refresh();
        response = await this.send(request);
        if (response.ok) {
          return response;
        }
        const retryBody = await response.text().catch(() => '');
        throw this.toHttpError(request, response, retryBody);
      }

      if (
        retryTransient &&
        this.isTransient(response.status, body) &&
        attempt < this.maxRetries
      ) {
        const delay = this.retryDelayMs(attempt, parseRetryAfterMs(response.headers.get('retry-after')));
        attempt += 1;
        await this.sleepImpl(delay);
        continue;
      }

      const fallbackResponse = await this.attemptFallback(request, retryTransient);
      if (fallbackResponse) return fallbackResponse;
      throw this.toHttpError(request, response, body);
    }
  }

  private retryDelayMs(attempt: number, retryAfter?: number): number {
    return retryAfter === undefined ? fullJitterDelayMs(attempt, this.retryBaseDelayMs, this.retryMaxDelayMs, this.randomImpl) : Math.min(this.retryMaxDelayMs, retryAfter);
  }
  private isTransient(status: number, body: string): boolean {
    return status === 408 || status === 429 || status >= 500 || /ESOCKETTIMEDOUT|ETIMEDOUT|ECONNRESET|serverError|downstream/.test(body);
  }
  private innerStatus(body: string): number | undefined {
    try { const value = JSON.parse(body) as Record<string, unknown>; const status = Number(value.status ?? value.statusCode); return value.error || value.success === false || status >= 400 ? (status >= 400 ? status : 502) : undefined; } catch { return undefined; }
  }
  private rebuildResponse(response: Response, body: string): Response {
    return new Response([204,205,304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  /** Send a gateway request and parse the JSON body, or null when empty. */
  async requestJson<T = Record<string, unknown>>(
    request: GatewayRequest,
    options: { retryTransient?: boolean } = {}
  ): Promise<T | null> {
    const response = await this.request(request, options);
    const text = await response.text().catch(() => '');
    if (!text.trim()) {
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  /**
   * Enumerate org-mode sub-teams (squads) for `orgTeamId` via the `ums` service.
   * Route: `GET /api/teams/:orgTeamId/squads?settings=true&userRoles=true`
   * (live-proven 200 for org-mode service-account tokens 2026-06-30). This is
   * the access-token equivalent of PMAK `GET /teams`: a 200 with a non-empty
   * squad list means the parent account is org-mode; a non-org team answers
   * `400 "Squad feature is not available for your team."` (mirrors the legacy
   * PMAK non-org 400). `orgTeamId` is `session.identity.team` from iapub
   * `/api/sessions/current`. The team id rides in the path; `x-entity-team-id`
   * is omitted (Bifrost infers team context from the access token), so call
   * this with a gateway client constructed `orgMode: false`. Throws HttpError
   * on non-2xx — the caller interprets the 400 as the expected non-org signal.
   */
  async getSquads(
    orgTeamId: string
  ): Promise<Array<{ id: string; name: string; organizationId?: string }>> {
    const teamId = encodeURIComponent(String(orgTeamId || '').trim());
    const payload = await this.requestJson<{ data?: unknown }>({
      service: 'ums',
      method: 'get',
      path: `/api/teams/${teamId}/squads?settings=true&userRoles=true`
    });
    const squads = Array.isArray(payload?.data) ? payload.data : [];
    return squads
      .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && 'id' in s && s.id != null)
      .map((s) => ({
        id: String(s.id),
        name: String(s.name ?? ''),
        ...((s.organizationId ?? null) != null ? { organizationId: String(s.organizationId) } : {})
      }));
  }

  private toHttpError(
    request: GatewayRequest,
    response: Response,
    body: string
  ): HttpError {
    return new HttpError({
      method: request.method.toUpperCase(),
      url: `${this.bifrostBaseUrl}/ws/proxy (${request.service}: ${request.method} ${request.path})`,
      status: response.status,
      statusText: response.statusText,
      requestHeaders: {
        'Content-Type': 'application/json',
        'x-access-token': this.tokenProvider.current(),
        ...(request.headers || {}),
        ...(this.teamId && this.orgMode ? { 'x-entity-team-id': this.teamId } : {})
      },
      responseBody: this.secretMasker(body),
      secretValues: [this.tokenProvider.current()]
    });
  }
  private toInnerHttpError(request: GatewayRequest, status: number, body: string): HttpError {
    return new HttpError({ method: request.method.toUpperCase(), url: `${this.bifrostBaseUrl}/ws/proxy (${request.service}: ${request.method} ${request.path}) [inner]`, status, statusText: 'Inner Error', requestHeaders: { 'x-access-token': this.tokenProvider.current() }, responseBody: this.secretMasker(body), secretValues: [this.tokenProvider.current()] });
  }
}
