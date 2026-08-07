/**
 * The repo-sync cassette scenario, declared once and consumed twice: the
 * recorder writes `cassettes/<name>.json` from the platform fake, and the replay
 * suite drives the SAME production composition root offline from that committed
 * file with zero live transport.
 *
 * This is the cross-action half of the shared cassette transport: repo-sync and
 * bootstrap both replay through `@postman-cse/automation-core/cassette`, so one
 * wire-contract format covers both actions.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Cassette } from '@postman-cse/automation-core/cassette';

import type { PlatformOptions } from './platform-fake.js';

const CASSETTE_DIR = resolve(import.meta.dirname, 'cassettes');

export function cassettePath(name: string): string {
  return resolve(CASSETTE_DIR, `${name}.json`);
}

export function readCassette(name: string): Cassette {
  return JSON.parse(readFileSync(cassettePath(name), 'utf8')) as Cassette;
}

/**
 * Constant reads whose call COUNT is not reproducible: they are issued
 * concurrently with other preflight work and in-flight-deduped, so whether a
 * second caller hits the memo or issues its own request depends on interleaving,
 * and replay resolves faster than the fake. Their responses carry no cursor and
 * no state, so repeating them cannot mask a missing interaction.
 *
 * Everything else stays one-shot: mutations, paginated lists, and any route whose
 * response advances state must fail closed on a duplicated or dropped call.
 */
const REPEATABLE_READ_PREFIXES = [
  'proxy:ums GET /api/teams/',
  'GET https://api.getpostman.com/me',
  'GET https://iapub.postman.co/api/sessions/current'
] as const;

export function isRepeatableRead(key: string): boolean {
  return REPEATABLE_READ_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function applyRepeatableReads(cassette: Cassette): Cassette {
  for (const interaction of cassette.interactions) {
    if (isRepeatableRead(interaction.key)) interaction.repeatLast = true;
  }
  return cassette;
}

/**
 * `recordedAt` is provenance metadata, not wire contract, and the recorder stamps
 * it from the wall clock. Pinning it keeps a re-record with no behavior change a
 * zero-diff operation, and matches the value the live-capture sanitizer emits.
 */
const NORMALIZED_RECORDED_AT = '2000-01-01T00:00:00.000Z';

export function stableCassetteText(cassette: Cassette): string {
  return `${JSON.stringify({ ...cassette, recordedAt: NORMALIZED_RECORDED_AT }, null, 2)}\n`;
}

export interface RepoSyncCassetteScenario {
  name: string;
  description: string;
  inputs: Record<string, string>;
  fake: PlatformOptions;
  /** Secret literals that must never survive into the committed cassette. */
  secrets: string[];
}

/**
 * Ambient env for record and replay alike. The app-version provider is a
 * module-level singleton that memoizes its first resolution for the process
 * lifetime, so whether its probe lands in a cassette would otherwise depend on
 * test order; `off` is the provider's own documented opt-out.
 */
export const CASSETTE_ENV: Record<string, string> = {
  POSTMAN_GATEWAY_APP_VERSION: 'off'
};

const ACCESS_TOKEN = 'access-token-test';
const PMAK = 'pmak-test';

/**
 * An org-mode run with both credentials. It covers the surface repo-sync is
 * uniquely responsible for: environment import through the Sync service, mock
 * create, and monitor job-template create, all on the access-token gateway with
 * the org sub-team header. Repo and CI-workflow writes are disabled so the run
 * has no git, `gh`, or workflow-file side effects.
 */
export const REPO_SYNC_CASSETTE: RepoSyncCassetteScenario = {
  name: 'repo-sync-wire',
  description:
    'Org-mode, both credentials: environments, mock, and monitor are provisioned through the access-token gateway and every call replays from the cassette.',
  inputs: {
    'project-name': 'core-payments',
    'workspace-id': 'ws-contract',
    'baseline-collection-id': '12345678-col-baseline',
    'smoke-collection-id': '12345678-col-smoke',
    'postman-api-key': PMAK,
    'postman-access-token': ACCESS_TOKEN,
    'environments-json': '["prod"]',
    'env-runtime-urls-json': '{"prod":"https://api.example.com"}',
    'repo-write-mode': 'none',
    'generate-ci-workflow': 'false',
    'workspace-link-enabled': 'false',
    'environment-sync-enabled': 'false',
    'mock-visibility': 'public'
  },
  fake: { org: true },
  secrets: [PMAK, ACCESS_TOKEN, 'access-token-minted', 'pmak-generated']
};

/** Count recorded interaction keys whose prefix matches. */
export function countKeys(keys: readonly string[], prefix: string): number {
  return keys.filter((key) => key.startsWith(prefix)).length;
}
