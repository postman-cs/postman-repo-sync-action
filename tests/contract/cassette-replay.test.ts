/**
 * Cross-action cassette replay: repo-sync drives its REAL runAction composition
 * root offline from a committed cassette through the SAME shared transport
 * bootstrap uses (`@postman-cse/automation-core/cassette`), with zero live
 * transport.
 *
 * "Zero live transport" is structural. The only fetch the run can see is
 * `createReplayFetch` over a committed JSON file, and that transport is
 * fail-closed: an unknown interaction key or an exhausted queue throws with the
 * recorded key inventory. A production change that reaches for a route this
 * cassette never recorded fails here instead of escaping to the network.
 *
 * Regenerate with `npm run record:cassettes`.
 */
import { describe, expect, it } from 'vitest';
import { createReplayFetch } from '@postman-cse/automation-core/cassette';

import { runContractAction, type ContractRunResult } from './harness.js';
import { createPlatform } from './platform-fake.js';
import {
  CASSETTE_ENV,
  countKeys,
  isRepeatableRead,
  readCassette,
  REPO_SYNC_CASSETTE
} from './cassette-scenario.js';

function expectScenarioOutputs(result: ContractRunResult): void {
  expect(result.error).toBeUndefined();
  expect(result.outputs['mock-url']).toBe('https://mock-123.mock.pstmn.io');
  expect(result.outputs['monitor-id']).toBe('monitor-123');
  const environmentUids = JSON.parse(result.outputs['environment-uids-json'] || '{}') as Record<
    string,
    string
  >;
  expect(environmentUids.prod).toBe('12345678-env-prod-uid');
}

describe('contract: repo-sync cassette replay (offline)', () => {
  it(REPO_SYNC_CASSETTE.description, async () => {
    const cassette = readCassette(REPO_SYNC_CASSETTE.name);
    expect(cassette.version).toBe(2);
    expect(cassette.interactions.length).toBeGreaterThan(5);

    let replayedCalls = 0;
    const replay = createReplayFetch(structuredClone(cassette));
    const countedReplay = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      replayedCalls += 1;
      return replay(input, init);
    }) as typeof fetch;

    const result = await runContractAction({
      inputs: REPO_SYNC_CASSETTE.inputs,
      env: CASSETTE_ENV,
      fetchImpl: countedReplay
    });

    const platform = createPlatform(REPO_SYNC_CASSETTE.fake);
    const fakeResult = await runContractAction({
      inputs: REPO_SYNC_CASSETTE.inputs,
      env: CASSETTE_ENV,
      fetchImpl: platform.fetch
    });

    // The exact same assertions must hold against the stateful fake and the
    // sampled cassette. This prevents either proof surface from drifting weaker.
    expectScenarioOutputs(result);
    expectScenarioOutputs(fakeResult);
    expect(fakeResult.outputs).toMatchObject({
      'mock-url': result.outputs['mock-url'],
      'monitor-id': result.outputs['monitor-id'],
      'environment-uids-json': result.outputs['environment-uids-json']
    });

    // Every byte of platform state this run observed came from the cassette.
    expect(replayedCalls).toBeGreaterThan(5);
  }, 120_000);

  it('pins the wire contract the replayed run depends on', () => {
    const keys = readCassette(REPO_SYNC_CASSETTE.name).interactions.map(
      (interaction) => interaction.key
    );

    // Org-mode detection, then every asset op on the access-token gateway.
    expect(countKeys(keys, 'proxy:ums GET /api/teams/')).toBeGreaterThanOrEqual(1);
    expect(keys.some((key) => key.startsWith('proxy:sync POST') && key.includes('/environment/import'))).toBe(true);
    expect(keys.some((key) => key.startsWith('proxy:mock POST /mocks'))).toBe(true);
    expect(keys.some((key) => key.startsWith('proxy:monitors POST /jobTemplates'))).toBe(true);

    // Asset mutation never runs on a PMAK: the only direct PMAK route is the
    // read-only /me preflight, and nothing is created through the public API.
    const directKeys = keys.filter((key) => !key.startsWith('proxy:'));
    for (const key of directKeys) {
      expect(key).toMatch(
        /^(GET https:\/\/api\.getpostman\.com\/me|GET https:\/\/iapub\.postman\.co\/api\/sessions\/current|POST https:\/\/api\.getpostman\.com\/service-account-tokens)/
      );
    }
  });

  it('keeps every interaction one-shot except the allowlisted constant reads', () => {
    const repeating = readCassette(REPO_SYNC_CASSETTE.name)
      .interactions.filter((interaction) => interaction.repeatLast)
      .map((interaction) => interaction.key);
    expect(repeating.filter((key) => !isRepeatableRead(key))).toEqual([]);
  });

  it('never leaks a credential into the committed fixture', () => {
    const serialized = JSON.stringify(readCassette(REPO_SYNC_CASSETTE.name));
    for (const secret of REPO_SYNC_CASSETTE.secrets) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/PMAK-/i);
  });
});
