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
    await runAction(core, createExecStub());
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
