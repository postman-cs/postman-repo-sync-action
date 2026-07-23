export type PmakDiagnosticKind = 'personal' | 'service-account' | 'invalid' | 'inconclusive';
export interface PmakDiagnosticResult { kind: PmakDiagnosticKind; status?: number; payload?: Record<string, unknown> }
export interface InspectPmakIdentityOptions {
  apiBaseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; mode?: 'diagnostic' | 'preflight';
}

const memo = new Map<string, Promise<PmakDiagnosticResult>>();
const normalize = (value: string) => new URL(value.trim()).toString().replace(/\/+$/, '');

export function __resetPmakDiagnosticMemo(): void { memo.clear(); }
export function maskPmakDiagnostic(message: string, secrets: readonly (string | undefined)[]): string {
  let masked = String(message);
  for (const secret of secrets) if (secret) masked = masked.split(secret).join('***');
  return Array.from(masked, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
  }).join('').replace(/\s+/g, ' ').trim();
}
export function formatRejectedMint(original: string, result: PmakDiagnosticResult): string {
  const teamId = typeof (result.payload?.user as Record<string, unknown> | undefined)?.teamId === 'number' ? ` (team ${(result.payload?.user as Record<string, unknown>).teamId})` : '';
  if (result.kind === 'personal') return `Personal API key detected, cannot mint a service-account access token${teamId}.`;
  if (result.kind === 'service-account') return `The postman-api-key authenticates (GET /me OK) but was rejected by POST /service-account-tokens${teamId} and lacks permission to mint access tokens.`;
  if (result.kind === 'invalid') return 'The postman-api-key is invalid, disabled, or expired.';
  return original;
}
export async function inspectPmakIdentity(options: InspectPmakIdentityOptions): Promise<PmakDiagnosticResult> {
  const apiBaseUrl = normalize(options.apiBaseUrl);
  const key = `${apiBaseUrl}\u0000${options.apiKey}`;
  let pending = memo.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const timeout = AbortSignal.timeout(options.timeoutMs ?? 2_000);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const response = await (options.fetchImpl ?? fetch)(`${apiBaseUrl}/me`, { method: 'GET', headers: { 'X-Api-Key': options.apiKey }, signal });
        if (response.status === 401 || response.status === 403) return { kind: 'invalid', status: response.status };
        if (!response.ok) return { kind: 'inconclusive', status: response.status };
        const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
        const user = payload?.user;
        if (!user || typeof user !== 'object' || Array.isArray(user)) return { kind: 'inconclusive', payload };
        const record = user as Record<string, unknown>;
        if (typeof record.username === 'string' && record.username || typeof record.email === 'string' && record.email) return { kind: 'personal', status: response.status, payload };
        if (('username' in record) && ('email' in record) && (record.username == null || record.username === '') && (record.email == null || record.email === '')) return { kind: 'service-account', status: response.status, payload };
        return { kind: 'inconclusive', payload };
      } catch { return { kind: 'inconclusive' }; }
    })();
    memo.set(key, pending);
  }
  const result = await pending;
  if (options.mode === 'preflight' && result.kind === 'inconclusive') memo.delete(key);
  return result;
}
