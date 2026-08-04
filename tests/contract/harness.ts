/**
 * Shared scaffolding for the repo-sync contract lane: drives the REAL runAction
 * composition root (input resolution -> preflight -> credential resolution ->
 * createRepoSyncDependencies -> runRepoSync) with a stubbed global fetch, a
 * disposable cwd, and neutralized ambient credentials.
 *
 * The only fake is the transport. No production seam is mocked, so the Bifrost
 * /ws/proxy envelope and the org-mode sub-team header are exercised for real.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

import { createExecStub, NEUTRALIZED_ENV_VARS } from './platform-fake.js';

// Preserve the real event-loop yield and clock before Vitest replaces the
// timer globals; every wall-clock decision below has to survive fake time.
const realSetImmediate = setImmediate;
const realDateNow = Date.now;

/**
 * Wall-clock settle budget for fake-timer flushing on hosted full flows (real
 * filesystem + git + transport work runs far slower under CI contention than
 * locally). Together with FAKE_TIMER_CLEANUP_GRACE_MS this must finish strictly
 * inside vitest's CI test timeout so deadline failures still restore real
 * timers and cwd instead of being killed mid-flush.
 */
export const FAKE_TIMER_SETTLE_DEADLINE_MS = 25_000;
/** Real-timer grace after the settle deadline before surfacing a timeout. */
export const FAKE_TIMER_CLEANUP_GRACE_MS = 4_000;

export interface RunWithFakeTimersOptions {
  /** Wall-clock budget for fake-timer flushing; defaults to FAKE_TIMER_SETTLE_DEADLINE_MS. */
  settleDeadlineMs?: number;
  /** Real-timer grace after the settle deadline before failing; defaults to FAKE_TIMER_CLEANUP_GRACE_MS. */
  cleanupGraceMs?: number;
}

async function yieldRealEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => realSetImmediate(resolve));
}

async function waitForPendingCleanup<T>(
  pending: Promise<T>,
  isSettled: () => boolean,
  cleanupGraceMs: number
): Promise<void> {
  if (isSettled()) {
    return;
  }
  const cleanupDeadline = realDateNow() + cleanupGraceMs;
  while (!isSettled() && realDateNow() < cleanupDeadline) {
    await Promise.resolve();
    await yieldRealEventLoopTurn();
  }
  if (isSettled()) {
    return;
  }
  await Promise.race([
    pending.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => realSetImmediate(resolve))
  ]);
}

/**
 * Run action work under vitest fake timers, advancing ONE timer at a time
 * (retry backoffs, generation poll sleeps, identity-settle windows) until the
 * run settles. Production converge sleeps stay real outside tests.
 *
 * Fake timers do not advance libuv, so every pass also yields a real
 * event-loop turn: filesystem/transport work an action awaits between sleeps
 * can only complete on a real turn. Termination is a wall-clock deadline, not
 * a flush-pass count — a pass count cannot distinguish "still waiting on slow
 * real I/O" from "stuck in a recursive timer chain", and burns the budget at
 * CPU speed while the action is merely blocked on I/O.
 */
export async function runWithFakeTimers<T>(
  fn: () => Promise<T>,
  options: RunWithFakeTimersOptions = {}
): Promise<T> {
  const settleDeadlineMs = options.settleDeadlineMs ?? FAKE_TIMER_SETTLE_DEADLINE_MS;
  const cleanupGraceMs = options.cleanupGraceMs ?? FAKE_TIMER_CLEANUP_GRACE_MS;
  const settleDeadline = realDateNow() + settleDeadlineMs;
  const previousCwd = process.cwd();

  let settled: { value: T } | { error: unknown } | undefined;
  let pending: Promise<T> | undefined;
  let pendingCleanupAttempted = false;
  let result!: T;
  let completed = false;
  let primaryError: unknown;
  let hasPrimaryError = false;

  try {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));

    try {
      pending = Promise.resolve(fn());
    } catch (error) {
      settled = { error };
    }
    // Observe rejection immediately so a settle-timeout cannot leave the
    // original action promise as an unhandled rejection.
    if (pending) {
    void pending.then(
      (value) => {
        settled = { value };
      },
      (error) => {
        settled = { error };
      }
    );
    }

    while (!settled && realDateNow() < settleDeadline) {
      await vi.advanceTimersToNextTimerAsync();
      // Yield microtasks so `settled` can flip between bounded timer steps.
      await Promise.resolve();
      await yieldRealEventLoopTurn();
    }

    if (!settled) {
      vi.useRealTimers();
      pendingCleanupAttempted = true;
      await waitForPendingCleanup(pending!, () => settled !== undefined, cleanupGraceMs);
    if (!settled) {
      throw new Error(
          `Fake timer settle deadline exceeded after ${settleDeadlineMs}ms (+${cleanupGraceMs}ms cleanup grace): action promise did not settle`
      );
    }
    }

    if ('error' in settled) {
      throw settled.error;
    }
    result = settled.value;
    completed = true;
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    try {
      vi.useRealTimers();
      try {
        if (pending && !settled && !pendingCleanupAttempted) {
          await waitForPendingCleanup(pending, () => settled !== undefined, cleanupGraceMs);
        }
      } catch (error) {
        if (!hasPrimaryError) {
          hasPrimaryError = true;
          primaryError = error;
        }
      }
    } catch (error) {
      if (!hasPrimaryError) {
        hasPrimaryError = true;
        primaryError = error;
      }
    } finally {
      try {
        process.chdir(previousCwd);
      } catch (error) {
        if (!hasPrimaryError) {
          hasPrimaryError = true;
          primaryError = error;
        }
      }
    }
  }

  if (hasPrimaryError) {
    throw primaryError;
  }
  if (!completed) {
    throw new Error('Fake timer harness: action promise did not settle');
  }
  return result;
}

export interface ContractCoreLike {
  getInput(name: string, options?: { required?: boolean }): string;
  info(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
  setOutput(name: string, value: string): void;
  setSecret(secret: string): void;
}

export interface ContractRunResult {
  outputs: Record<string, string>;
  infos: string[];
  warnings: string[];
  error?: unknown;
}

export interface ContractRunOptions {
  inputs: Record<string, string>;
  fetchImpl: typeof fetch;
  /** Env applied after the neutralization sweep. */
  env?: Record<string, string>;
}

/**
 * Deterministic `crypto.randomUUID`, restarted for every run.
 *
 * The environment-import body carries a client-generated uuid, and a cassette
 * key includes a digest of the request body, so a random uuid would make the
 * recorded key unmatchable on replay. Production reads the GLOBAL `crypto`
 * (no `node:crypto` import), so this has to be a global stub rather than a
 * module mock.
 */
function createDeterministicCrypto(): Crypto {
  let next = 0;
  const real = globalThis.crypto;
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'randomUUID') {
        return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/**
 * Run the real repo-sync Action root against the supplied transport inside a
 * disposable working directory. Modules are reset first because a sibling suite
 * hoists a file-level mock of the Bifrost adapter; this lane must always get the
 * real adapter.
 */
export async function runContractAction(options: ContractRunOptions): Promise<ContractRunResult> {
  vi.doUnmock('../../src/lib/postman/internal-integration-adapter.js');
  vi.resetModules();
  const { runAction } = await import('../../src/index.js');
  const { __resetIdentityMemo } = await import('../../src/lib/postman/credential-identity.js');

  const testDir = mkdtempSync(join(tmpdir(), 'repo-sync-cassette-'));
  const previousCwd = process.cwd();

  __resetIdentityMemo();
  for (const name of NEUTRALIZED_ENV_VARS) {
    vi.stubEnv(name, '');
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    vi.stubEnv(name, value);
  }
  vi.stubGlobal('fetch', options.fetchImpl);
  vi.stubGlobal('crypto', createDeterministicCrypto());
  process.chdir(testDir);

  const outputs: Record<string, string> = {};
  const infos: string[] = [];
  const warnings: string[] = [];
  const core: ContractCoreLike = {
    getInput: (name: string, opts?: { required?: boolean }) => {
      const value = options.inputs[name] ?? '';
      if (opts?.required && !value) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    },
    info: (message: string) => {
      infos.push(message);
    },
    warning: (message: string) => {
      warnings.push(message);
    },
    setFailed: () => {},
    setOutput: (name: string, value: string) => {
      outputs[name] = value;
    },
    setSecret: () => {}
  };

  let error: unknown;
  try {
    await runWithFakeTimers(() => runAction(core, createExecStub()));
  } catch (caught) {
    error = caught;
  } finally {
    process.chdir(previousCwd);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    __resetIdentityMemo();
    rmSync(testDir, { recursive: true, force: true });
  }

  return { outputs, infos, warnings, error };
}
