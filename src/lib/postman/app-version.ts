const UPDATE_URL = 'https://dl.pstmn.io/update/status?currentVersion=12.0.0&platform=osx_arm64';
const FLOOR_VERSION = '12.0.0';
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PostmanAppVersionProviderOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export class PostmanAppVersionProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private pending?: Promise<string | undefined>;

  constructor(options: PostmanAppVersionProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  }

  async get(): Promise<string | undefined> {
    if (process.env.POSTMAN_GATEWAY_APP_VERSION === 'off') return undefined;
    this.pending ??= this.resolve();
    return this.pending;
  }

  private async resolve(): Promise<string> {
    try {
      const response = await this.fetchImpl(UPDATE_URL, {
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
      if (!response.ok) return FLOOR_VERSION;
      const payload = await response.json() as { version?: unknown };
      const version = typeof payload.version === 'string' ? payload.version : '';
      return VERSION_PATTERN.test(version) ? version : FLOOR_VERSION;
    } catch {
      return FLOOR_VERSION;
    }
  }
}

export const defaultPostmanAppVersionProvider = new PostmanAppVersionProvider();
