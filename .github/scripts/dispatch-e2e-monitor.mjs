/* global AbortSignal, console, fetch, process */
import { pathToFileURL } from 'node:url';

export const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

const DISPATCH_URL =
  'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/workflows/e2e.yml/dispatches';
const GITHUB_API_VERSION = '2026-03-10';

export function buildDispatchPayload(action, ref, suite) {
  if (!['smoke', 'full'].includes(suite)) throw new Error(`E2E_GATE_SUITE must be smoke or full; got ${suite}`);
  return { ref: 'main', inputs: { action, ref, suite } };
}

/**
 * One-shot POST that dispatches the central e2e workflow on `main` with the
 * exact immutable release ref in inputs. Bounded by AbortSignal.timeout; no
 * polling, retry, or terminal-run wait.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   abortSignal?: AbortSignal,
 *   log?: (...args: unknown[]) => void
 * }} [options]
 */
export async function dispatchE2eMonitor({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS,
  abortSignal,
  log = console.log.bind(console)
} = {}) {
  const token = env.E2E_DISPATCH_TOKEN;
  const ref = env.E2E_GATE_REF;
  const action = env.GITHUB_REPOSITORY?.split('/').at(-1);
  if (!token || !ref || !action) {
    throw new Error('E2E_DISPATCH_TOKEN, E2E_GATE_REF, and GITHUB_REPOSITORY are required');
  }
  const suite = env.E2E_GATE_SUITE ?? 'smoke';
  const payload = buildDispatchPayload(action, ref, suite);
  const signal = abortSignal ?? AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(DISPATCH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      body: JSON.stringify(payload),
      signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`e2e monitor dispatch failed: ${message}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`e2e monitor dispatch failed with HTTP ${response.status}`);
  }
  log(`::notice::Dispatched asynchronous e2e smoke monitor for ${action}@${ref}`);
}

async function main() {
  await dispatchE2eMonitor();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
