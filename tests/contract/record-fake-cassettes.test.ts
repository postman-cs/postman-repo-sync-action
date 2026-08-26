/**
 * Deterministic cassette generator for repo-sync, not a gate.
 *
 *   npm run record:cassettes
 *
 * Skipped unless RECORD_FAKE_CASSETTES=1 so `npm test` never rewrites committed
 * fixtures. Emits the same cassette format as bootstrap and as a live
 * `record-live` capture, so a sanitized sandbox recording can replace this file
 * without touching the replay suite.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEmptyCassette,
  createRecordingFetch
} from '@postman-cs/automation-core/cassette';

import { createSecretMasker } from '../../src/lib/secrets.js';
import { createPlatform } from './platform-fake.js';
import { runContractAction } from './harness.js';
import {
  applyRepeatableReads,
  CASSETTE_ENV,
  cassettePath,
  REPO_SYNC_CASSETTE,
  stableCassetteText
} from './cassette-scenario.js';

const ENABLED = process.env.RECORD_FAKE_CASSETTES === '1';

describe.skipIf(!ENABLED)('record: repo-sync wire cassette', () => {
  it(`records ${REPO_SYNC_CASSETTE.name}`, async () => {
    const cassette = createEmptyCassette();
    const platform = createPlatform(REPO_SYNC_CASSETTE.fake);
    const recording = createRecordingFetch(
      platform.fetch,
      cassette,
      createSecretMasker(REPO_SYNC_CASSETTE.secrets)
    );

    const result = await runContractAction({
      inputs: REPO_SYNC_CASSETTE.inputs,
      env: CASSETTE_ENV,
      fetchImpl: recording
    });

    // Only commit a cassette whose captured run was correct.
    expect(result.error).toBeUndefined();
    expect(platform.state.mockCreated).toBe(true);
    expect(platform.state.monitorCreated).toBe(true);
    expect(cassette.interactions.length).toBeGreaterThan(5);

    const target = cassettePath(REPO_SYNC_CASSETTE.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, stableCassetteText(applyRepeatableReads(cassette)));
  }, 120_000);
});
