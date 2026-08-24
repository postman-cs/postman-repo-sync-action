import { configDefaults, defineConfig } from 'vitest/config';

// Hosted CI runners run the contract lane under heavy contention: full
// runAction flows that take tens of milliseconds locally can take many seconds
// there. The fake-timer harness bounds itself by wall clock
// (FAKE_TIMER_SETTLE_DEADLINE_MS + FAKE_TIMER_CLEANUP_GRACE_MS) so it can fail
// with restored timers and cwd; this timeout has to stay strictly larger than
// that budget, which tests/contract/harness.test.ts asserts. Local runs keep
// vitest's strict default so a real slowdown still surfaces as a failure.
const CI_TIMEOUT_MS = 30_000;

const windowsCwdSensitiveTests = [
  'tests/repo-sync-action.test.ts',
  'tests/contract/credential-matrix.test.ts',
  'tests/contract/cassette-replay.test.ts',
  'tests/contract/harness.test.ts',
  'tests/contract/monitor-rebind-contract.test.ts',
  'tests/contract/private-mock-branch-contract.test.ts',
  'tests/cli.test.ts',
  'tests/path-sandboxing.test.ts',
  'tests/create-reconciliation.test.ts',
  'tests/durable-environment-integration.test.ts',
  'tests/branch-aware-sync.test.ts',
  'tests/logging.test.ts',
  'tests/private-mock-wiring-contract.test.ts',
  'tests/secrets-resolver-provider.test.ts',
  'tests/credential-slot-preservation.test.ts'
];

const testEnvironment = {
  environment: 'node',
  // Telemetry is fire-and-forget; keep it disabled in unit tests so no run
  // ever attempts a network call. Enabled-path tests pass an explicit env.
  env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
  ...(process.env.CI ? { testTimeout: CI_TIMEOUT_MS, hookTimeout: CI_TIMEOUT_MS } : {})
} as const;

export default defineConfig({
  test:
    process.platform === 'win32'
      ? {
          projects: [
            {
              test: {
                name: 'windows-cwd-sensitive',
                ...testEnvironment,
                pool: 'forks',
                maxWorkers: 1,
                isolate: false,
                sequence: { groupOrder: 1 },
                include: windowsCwdSensitiveTests
              }
            },
            {
              test: {
                name: 'windows-fast',
                ...testEnvironment,
                pool: 'threads',
                include: ['tests/**/*.test.ts'],
                exclude: [...configDefaults.exclude, 'tests/emulator/**', ...windowsCwdSensitiveTests]
              }
            }
          ]
        }
      : {
          environment: 'node',
          // Telemetry is fire-and-forget; keep it disabled in unit tests so no run
          // ever attempts a network call. Enabled-path tests pass an explicit env.
          env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
          ...(process.env.CI ? { testTimeout: CI_TIMEOUT_MS, hookTimeout: CI_TIMEOUT_MS } : {}),
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'tests/emulator/**']
        }
});
