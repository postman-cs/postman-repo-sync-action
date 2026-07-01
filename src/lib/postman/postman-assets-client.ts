import { HttpError } from '../http-error.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';

type FetchResult = Record<string, unknown> | null;

export interface PostmanAssetsClientOptions {
  apiKey: string;
  baseUrl?: string;
  secretMasker?: SecretMasker;
  fetchImpl?: typeof fetch;
}

/**
 * Minimal PMAK client retained ONLY for the read-only `GET /me` credential-validity
 * check that gates the CI-key reuse-vs-mint decision (feeding the sanctioned
 * `postman login --with-api-key` in the generated CI workflow). It performs NO asset
 * operation — every Postman asset op runs through PostmanGatewayAssetsClient on the
 * access-token gateway. Do not add asset methods here.
 */
export class PostmanAssetsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PostmanAssetsClientOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.baseUrl = String(options.baseUrl || POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl).replace(
      /\/+$/,
      ''
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    void (options.secretMasker ?? createSecretMasker([this.apiKey]));
  }

  private async request(path: string, init: RequestInit = {}): Promise<FetchResult> {
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

  /** Read-only credential-validity check (feeds the CI-key reuse-vs-mint decision). */
  async getMe(): Promise<Record<string, unknown> | null> {
    return this.request('/me', { method: 'GET' }) as Promise<Record<string, unknown> | null>;
  }
}
