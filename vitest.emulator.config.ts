import { defineConfig } from 'vitest/config';

// Emulator lane: real-git smart-HTTP transport proofs for the repo mutation
// service. Runs only via `npm run test:emulator:git` inside the budgeted CI
// lane (or a local operator shell); never part of default `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
    include: ['tests/emulator/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
