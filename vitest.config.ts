import { configDefaults, defineConfig } from 'vitest/config';

const windowsCwdSensitiveTests = [
  'tests/repo-sync-action.test.ts',
  'tests/contract/credential-matrix.test.ts',
  'tests/cli.test.ts',
  'tests/path-sandboxing.test.ts',
  'tests/create-reconciliation.test.ts',
  'tests/branch-aware-sync.test.ts'
];

const testEnvironment = {
  environment: 'node',
  // Telemetry is fire-and-forget; keep it disabled in unit tests so no run
  // ever attempts a network call. Enabled-path tests pass an explicit env.
  env: { POSTMAN_ACTIONS_TELEMETRY: 'off' }
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
                include: windowsCwdSensitiveTests
              }
            },
            {
              test: {
                name: 'windows-fast',
                ...testEnvironment,
                pool: 'threads',
                include: ['tests/**/*.test.ts'],
                exclude: [...configDefaults.exclude, ...windowsCwdSensitiveTests]
              }
            }
          ]
        }
      : {
          environment: 'node',
          // Telemetry is fire-and-forget; keep it disabled in unit tests so no run
          // ever attempts a network call. Enabled-path tests pass an explicit env.
          env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
          include: ['tests/**/*.test.ts']
        }
});
