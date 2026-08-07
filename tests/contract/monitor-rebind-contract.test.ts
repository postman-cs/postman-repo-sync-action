/**
 * WS5 state-machine exhaustion: monitor rebind, driven through the REAL
 * runAction composition root against a stateful monitors workspace.
 *
 * `tests/monitor-rebind.test.ts` already pins `rebindMonitorByName` at the unit
 * level against a hand-rolled fetch that answers each call in isolation. That
 * proves the request ledger but not the RESULTING WORKSPACE: a stateless stub
 * happily reports a stale monitor that was already deleted, and a create that
 * never landed. This suite closes that gap by making the fake authoritative for
 * monitor state -- create and delete actually mutate a workspace -- so every
 * case asserts the final set of monitors, not just the calls made to get there.
 *
 * The state machine has four reachable outcomes for a same-name monitor:
 *
 *   bound-to-current    discovery wins on the full (collection, environment,
 *                       name) triple; nothing is written
 *   rebindable          exactly one same-name monitor on this environment with
 *                       a stale collection; replace it (create, then delete)
 *   cross-environment   a same-name monitor exists on a DIFFERENT environment;
 *                       never rebind across environments, create alongside
 *   ambiguous           several same-name monitors on this environment; refuse
 *                       to guess and fail the run with NOTHING written
 *
 * The ambiguous row is the reason this lane exists. Choosing a monitor by
 * guessing would silently repoint someone else's monitor, and a create-then-
 * bail would orphan a duplicate; the contract is that an ambiguous rebind is
 * fatal and leaves the workspace byte-identical to how it was found.
 *
 * The monitors slice lives here rather than in `platform-fake.ts` because it is
 * installed through that fake's documented `override` seam, which runs before
 * service dispatch. That keeps this state machine owned by the suite that
 * asserts it and keeps the shared fake free of single-suite state.
 */
import { describe, expect, it } from 'vitest';

import { createPlatform, json, type PlatformOptions } from './platform-fake.js';
import { runContractAction, type ContractRunResult } from './harness.js';
import { CASSETTE_ENV } from './cassette-scenario.js';

/** Identity the action derives from the inputs below; probed, not assumed. */
const WORKSPACE = 'ws-contract';
const MONITOR_NAME = 'core-payments - Smoke Monitor';
const CURRENT_COLLECTION = '12345678-col-smoke';
const STALE_COLLECTION = '12345678-col-smoke-previous';
const PROD_ENV = '12345678-env-prod-uid';
const OTHER_ENV = '12345678-env-staging-uid';

interface MonitorRecord {
  id: string;
  name: string;
  collection: string;
  environment: string;
  active: boolean;
  cronPattern?: string;
}

interface MonitorWorkspace {
  /** Install into `PlatformOptions.override`. */
  handle: NonNullable<PlatformOptions['override']>;
  /** Current workspace contents, ordered by creation. */
  snapshot(): MonitorRecord[];
  /** Ordered write ledger: `create:<id>` / `delete:<id>` / `run:<id>`. */
  mutations: string[];
}

/**
 * A monitors workspace that actually holds state.
 *
 * Fail-closed by construction: any `monitors` request this router does not
 * model throws and names the unmatched request, so a production call that
 * drifts onto a new monitors route surfaces as a hard failure here instead of
 * silently collecting a permissive `{data:{}}`.
 */
function createMonitorWorkspace(seed: MonitorRecord[]): MonitorWorkspace {
  const records: MonitorRecord[] = seed.map((record) => ({ ...record }));
  const mutations: string[] = [];
  let created = 0;

  const toWire = (record: MonitorRecord) => ({
    id: record.id,
    uid: record.id,
    name: record.name,
    active: record.active,
    collection: record.collection,
    environment: record.environment,
    ...(record.cronPattern ? { schedule: { cronPattern: record.cronPattern, timeZone: 'UTC' } } : {})
  });

  const handle: NonNullable<PlatformOptions['override']> = ({ proxy }) => {
    if (proxy?.service !== 'monitors') return undefined;
    const { method, path } = proxy;
    const [rawPath, rawQuery = ''] = path.split('?');
    const query = new URLSearchParams(rawQuery);
    const segments = rawPath!.split('/').filter(Boolean);

    // GET /jobTemplates?workspace=<ws>&_etc=true -- workspace-scoped list.
    if (method === 'get' && segments.length === 1 && segments[0] === 'jobTemplates') {
      if (query.get('workspace') !== WORKSPACE) {
        throw new Error(
          `Fail-closed monitors fake: list scoped to unexpected workspace ${String(query.get('workspace'))} (expected ${WORKSPACE})`
        );
      }
      return json({ data: records.map(toWire) });
    }

    // GET /jobTemplates/<id>?_etc=true -- existence probe; 404 means "absent".
    if (method === 'get' && segments.length === 2 && segments[0] === 'jobTemplates') {
      const found = records.find((record) => record.id === segments[1]);
      return found ? json({ data: toWire(found) }) : json({ error: { message: 'not found' } }, 404);
    }

    // POST /jobTemplates?workspace=<ws> -- create.
    if (method === 'post' && segments.length === 1 && segments[0] === 'jobTemplates') {
      const body = (proxy.body ?? {}) as Record<string, unknown>;
      const schedule = (body.schedule ?? {}) as Record<string, unknown>;
      // Preserves the id the committed cassette and cassette-replay assert on.
      const id = `monitor-${123 + created}`;
      created += 1;
      records.push({
        id,
        name: String(body.name ?? ''),
        collection: String(body.collection ?? ''),
        environment: String(body.environment ?? ''),
        active: body.active !== false,
        cronPattern: schedule.cronPattern ? String(schedule.cronPattern) : undefined
      });
      mutations.push(`create:${id}`);
      return json({ data: { id, uid: id } });
    }

    // DELETE /jobTemplates/<id>
    if (method === 'delete' && segments.length === 2 && segments[0] === 'jobTemplates') {
      const index = records.findIndex((record) => record.id === segments[1]);
      if (index === -1) return json({ error: { message: 'not found' } }, 404);
      records.splice(index, 1);
      mutations.push(`delete:${segments[1]}`);
      return json({ data: { id: segments[1] } });
    }

    // POST /jobTemplates/<id>/jobs -- one-shot run.
    if (method === 'post' && segments.length === 3 && segments[0] === 'jobTemplates' && segments[2] === 'jobs') {
      mutations.push(`run:${segments[1]}`);
      return json({ data: { id: segments[1] } });
    }

    throw new Error(`Fail-closed monitors fake: unmatched request monitors ${method.toUpperCase()} ${path}`);
  };

  return { handle, snapshot: () => records.map((record) => ({ ...record })), mutations };
}

function baseInputs(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'project-name': 'core-payments',
    'workspace-id': WORKSPACE,
    'baseline-collection-id': '12345678-col-baseline',
    'smoke-collection-id': CURRENT_COLLECTION,
    'postman-api-key': 'pmak-test',
    'postman-access-token': 'access-token-test',
    'environments-json': '["prod"]',
    'env-runtime-urls-json': '{"prod":"https://api.example.com"}',
    'repo-write-mode': 'none',
    'generate-ci-workflow': 'false',
    'workspace-link-enabled': 'false',
    'environment-sync-enabled': 'false',
    'mock-visibility': 'public',
    ...overrides
  };
}

async function runWithMonitors(
  seed: MonitorRecord[],
  inputs: Record<string, string> = {}
): Promise<{ result: ContractRunResult; workspace: MonitorWorkspace }> {
  const workspace = createMonitorWorkspace(seed);
  const platform = createPlatform({ org: true, override: workspace.handle });
  const result = await runContractAction({
    inputs: baseInputs(inputs),
    env: CASSETTE_ENV,
    fetchImpl: platform.fetch
  });
  return { result, workspace };
}

function staleMonitor(overrides: Partial<MonitorRecord> = {}): MonitorRecord {
  return {
    id: 'mon-stale',
    name: MONITOR_NAME,
    collection: STALE_COLLECTION,
    environment: PROD_ENV,
    active: true,
    ...overrides
  };
}

describe('monitor rebind: unambiguous replacement binds the exact target', () => {
  it('replaces the sole stale same-name monitor and leaves exactly one bound to the current collection', async () => {
    const { result, workspace } = await runWithMonitors([staleMonitor()]);

    expect(result.error).toBeUndefined();

    // Exact rebind target: the replacement, not the stale monitor, is adopted.
    expect(result.outputs['monitor-id']).toBe('monitor-123');

    const final = workspace.snapshot();
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      id: 'monitor-123',
      name: MONITOR_NAME,
      collection: CURRENT_COLLECTION,
      environment: PROD_ENV
    });
    // The stale monitor is gone -- no orphan left behind.
    expect(final.some((record) => record.id === 'mon-stale')).toBe(false);
  });

  it('creates the replacement BEFORE deleting the stale monitor', async () => {
    const { workspace } = await runWithMonitors([staleMonitor()]);

    // Ordering is the safety property: a delete-first implementation that then
    // failed to create would leave the workspace with no monitor at all.
    const writes = workspace.mutations.filter((entry) => entry.startsWith('create:') || entry.startsWith('delete:'));
    expect(writes).toEqual(['create:monitor-123', 'delete:mon-stale']);
  });

  it('carries the configured cron onto the replacement', async () => {
    const { workspace } = await runWithMonitors([staleMonitor()], { 'monitor-cron': '0 */6 * * *' });

    const final = workspace.snapshot();
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ collection: CURRENT_COLLECTION, active: true, cronPattern: '0 */6 * * *' });
  });

  it('reports the replacement in the run log naming both monitor ids', async () => {
    const { result } = await runWithMonitors([staleMonitor()]);

    const replaced = result.infos.find((line) => line.includes('Replaced stale monitor'));
    expect(replaced).toBeDefined();
    expect(replaced).toContain('mon-stale');
    expect(replaced).toContain('monitor-123');
    expect(replaced).toContain(STALE_COLLECTION);
  });
});

describe('monitor rebind: ambiguity fails closed', () => {
  const ambiguousSeed: MonitorRecord[] = [
    staleMonitor({ id: 'mon-a' }),
    staleMonitor({ id: 'mon-b' })
  ];

  it('refuses to guess when several same-name monitors share the environment', async () => {
    const { result } = await runWithMonitors(ambiguousSeed);

    expect(result.error).toBeDefined();
    const message = String((result.error as Error).message);
    expect(message).toContain('Monitor discovery');
    expect(message).toContain('Multiple monitors match');
    expect(message).toContain('mon-a');
    expect(message).toContain('mon-b');
  });

  it('writes NOTHING when the rebind is ambiguous', async () => {
    const { workspace } = await runWithMonitors(ambiguousSeed);

    // Fail-closed means no partial mutation: the create-before-delete sequence
    // must not have started, so the workspace is exactly as it was found.
    expect(workspace.mutations.filter((entry) => !entry.startsWith('run:'))).toEqual([]);
    expect(workspace.snapshot()).toEqual(ambiguousSeed);
  });

  it('names the environments carrying same-name monitors so the operator can disambiguate', async () => {
    const { result } = await runWithMonitors([
      staleMonitor({ id: 'mon-a' }),
      staleMonitor({ id: 'mon-b' }),
      staleMonitor({ id: 'mon-c', environment: OTHER_ENV })
    ]);

    const message = String((result.error as Error).message);
    expect(message).toContain('Same-name monitor(s) also exist on environment(s)');
    expect(message).toContain(PROD_ENV);
    expect(message).toContain(OTHER_ENV);
  });

  it('fails at discovery, not rebind, when several monitors match the full triple', async () => {
    // `findMonitorByCollection` runs first and applies the same exact-match
    // rule, so duplicates already bound to the CURRENT collection are fatal
    // one step earlier. Both guards must hold; neither may fall through.
    const seed = [
      staleMonitor({ id: 'mon-a', collection: CURRENT_COLLECTION }),
      staleMonitor({ id: 'mon-b', collection: CURRENT_COLLECTION })
    ];
    const { result, workspace } = await runWithMonitors(seed);

    expect(result.error).toBeDefined();
    const message = String((result.error as Error).message);
    expect(message).toContain('Monitor discovery');
    expect(message).toContain('Multiple monitors match');
    expect(workspace.mutations.filter((entry) => !entry.startsWith('run:'))).toEqual([]);
    expect(workspace.snapshot()).toEqual(seed);
  });

  it('fails at discovery when one current and one stale monitor share the requested name and environment', async () => {
    const seed = [
      staleMonitor({ id: 'mon-current', collection: CURRENT_COLLECTION }),
      staleMonitor({ id: 'mon-stale', collection: STALE_COLLECTION })
    ];
    const { result, workspace } = await runWithMonitors(seed);

    expect(result.error).toBeDefined();
    const message = String((result.error as Error).message);
    expect(message).toContain('Monitor discovery');
    expect(message).toContain('Multiple monitors match');
    expect(message).toContain('mon-current');
    expect(message).toContain('mon-stale');
    expect(message).toContain(PROD_ENV);
    expect(workspace.mutations.filter((entry) => !entry.startsWith('run:'))).toEqual([]);
    expect(workspace.snapshot()).toEqual(seed);
  });
});

describe('monitor rebind: cross-environment monitors are never rebound', () => {
  it('leaves a same-name monitor on another environment untouched and creates alongside it', async () => {
    const foreign = staleMonitor({ id: 'mon-other-env', environment: OTHER_ENV });
    const { result, workspace } = await runWithMonitors([foreign]);

    expect(result.error).toBeUndefined();

    const final = workspace.snapshot();
    expect(final).toHaveLength(2);

    // The foreign-environment monitor is byte-identical to the seed.
    expect(final.find((record) => record.id === 'mon-other-env')).toEqual(foreign);

    // A fresh monitor was created for the requested environment.
    const created = final.find((record) => record.id === 'monitor-123');
    expect(created).toMatchObject({
      name: MONITOR_NAME,
      collection: CURRENT_COLLECTION,
      environment: PROD_ENV
    });
    expect(result.outputs['monitor-id']).toBe('monitor-123');
    expect(workspace.mutations).not.toContain('delete:mon-other-env');
  });
});

describe('monitor rebind: an already-bound monitor is reused without writes', () => {
  it('adopts the existing monitor and creates no duplicate', async () => {
    const bound = staleMonitor({ id: 'mon-current', collection: CURRENT_COLLECTION });
    const { result, workspace } = await runWithMonitors([bound]);

    expect(result.error).toBeUndefined();
    expect(result.outputs['monitor-id']).toBe('mon-current');

    // Discovery wins on the full triple, so rebind is never reached and the
    // workspace is unchanged apart from the one-shot run.
    expect(workspace.mutations.filter((entry) => !entry.startsWith('run:'))).toEqual([]);
    expect(workspace.snapshot()).toEqual([bound]);
  });
});

describe('monitor rebind: identical assertions through the shared fail-closed router', () => {
  /**
   * The cases above install a monitors slice through the `override` seam, which
   * short-circuits BEFORE the shared router's route table. That is the right
   * boundary for owning this state machine, but on its own it would leave the
   * router's own monitors routes -- notably DELETE /jobTemplates/{id} and
   * GET /jobTemplates/{id} -- declared but never exercised, because a rebind is
   * the only flow that reaches them.
   *
   * These cases therefore re-run the same state machine against the SHARED
   * router via `existingMonitors`, with the same assertions, so both transports
   * are held to one contract and the router's monitors routes are proven on the
   * real code path.
   */
  async function runOnSharedRouter(existingMonitors: PlatformOptions['existingMonitors']) {
    const platform = createPlatform({ org: true, existingMonitors });
    const result = await runContractAction({
      inputs: baseInputs(),
      env: CASSETTE_ENV,
      fetchImpl: platform.fetch
    });
    return { result, platform };
  }

  it('replaces the sole stale same-name monitor, leaving exactly one on the current collection', async () => {
    const { result, platform } = await runOnSharedRouter([
      { id: 'mon-stale', name: MONITOR_NAME, collection: STALE_COLLECTION, environment: PROD_ENV }
    ]);

    expect(result.error).toBeUndefined();
    expect(result.outputs['monitor-id']).toBe('monitor-123');

    const final = platform.state.monitors;
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      id: 'monitor-123',
      name: MONITOR_NAME,
      collection: CURRENT_COLLECTION,
      environment: PROD_ENV
    });

    // Proves the router's DELETE /jobTemplates/{id} route ran and was accepted.
    expect(platform.state.deletionLedger).toEqual([
      expect.objectContaining({ service: 'monitors', id: 'mon-stale', status: 200 })
    ]);
  });

  it('refuses to guess and writes nothing when several same-name monitors share the environment', async () => {
    const seed = [
      { id: 'mon-a', name: MONITOR_NAME, collection: STALE_COLLECTION, environment: PROD_ENV },
      { id: 'mon-b', name: MONITOR_NAME, collection: STALE_COLLECTION, environment: PROD_ENV }
    ];
    const { result, platform } = await runOnSharedRouter(seed);

    expect(result.error).toBeDefined();
    const message = String((result.error as Error).message);
    expect(message).toContain('Monitor discovery');
    expect(message).toContain('Multiple monitors match');

    // Same fail-closed guarantee as the override transport: nothing created,
    // nothing deleted, both seeded monitors intact.
    expect(platform.state.deletionLedger).toEqual([]);
    expect(platform.state.monitors.map((monitor) => monitor.id).sort()).toEqual(['mon-a', 'mon-b']);
    expect(platform.state.monitors.every((monitor) => monitor.collection === STALE_COLLECTION)).toBe(true);
  });

  it('never rebinds across environments', async () => {
    const { result, platform } = await runOnSharedRouter([
      { id: 'mon-other-env', name: MONITOR_NAME, collection: STALE_COLLECTION, environment: OTHER_ENV }
    ]);

    expect(result.error).toBeUndefined();
    expect(platform.state.deletionLedger).toEqual([]);

    const final = platform.state.monitors;
    expect(final).toHaveLength(2);
    expect(final.find((monitor) => monitor.id === 'mon-other-env')).toMatchObject({
      collection: STALE_COLLECTION,
      environment: OTHER_ENV
    });
    expect(final.find((monitor) => monitor.id === 'monitor-123')).toMatchObject({
      collection: CURRENT_COLLECTION,
      environment: PROD_ENV
    });
  });

  it('adopts an already-bound monitor without creating a duplicate', async () => {
    const { result, platform } = await runOnSharedRouter([
      { id: 'mon-current', name: MONITOR_NAME, collection: CURRENT_COLLECTION, environment: PROD_ENV }
    ]);

    expect(result.error).toBeUndefined();
    expect(result.outputs['monitor-id']).toBe('mon-current');
    expect(platform.state.monitors).toHaveLength(1);
    expect(platform.state.deletionLedger).toEqual([]);
  });

  it('surfaces a rejected stale-monitor deletion and reports both monitors left behind', async () => {
    /**
     * Ownership-verified deletion: the stale monitor belongs to another user, so
     * the DELETE is refused with 403. Because the replacement is created BEFORE
     * the delete -- the ordering that keeps a failed create from leaving the
     * workspace monitor-less -- a refused delete necessarily leaves BOTH
     * monitors in place. The run must fail loudly rather than report success
     * over a duplicated monitor.
     */
    const { result, platform } = await runOnSharedRouter([
      { id: 'mon-foreign', name: MONITOR_NAME, collection: STALE_COLLECTION, environment: PROD_ENV, ownerId: 99999999 }
    ]);

    expect(result.error).toBeDefined();
    expect(String((result.error as Error).message)).toContain('Monitor rebind');

    expect(platform.state.deletionLedger).toEqual([
      expect.objectContaining({ service: 'monitors', id: 'mon-foreign', status: 403 })
    ]);
    expect(platform.state.monitors.map((monitor) => monitor.id).sort()).toEqual(['mon-foreign', 'monitor-123']);
  });
});

describe('monitor rebind: the monitors fake is fail-closed', () => {
  it('throws and names an unmatched monitors request instead of answering permissively', () => {
    const workspace = createMonitorWorkspace([]);

    expect(() =>
      workspace.handle({
        url: 'https://bifrost.test/ws/proxy',
        method: 'POST',
        proxy: { service: 'monitors', method: 'patch', path: '/jobTemplates/mon-1' }
      })
    ).toThrow(/Fail-closed monitors fake: unmatched request monitors PATCH \/jobTemplates\/mon-1/);
  });

  it('rejects a list scoped to a workspace the run does not own', () => {
    const workspace = createMonitorWorkspace([]);

    expect(() =>
      workspace.handle({
        url: 'https://bifrost.test/ws/proxy',
        method: 'POST',
        proxy: { service: 'monitors', method: 'get', path: '/jobTemplates?workspace=ws-someone-else&_etc=true' }
      })
    ).toThrow(/list scoped to unexpected workspace ws-someone-else/);
  });

  it('defers every non-monitors service to the shared platform fake', () => {
    const workspace = createMonitorWorkspace([]);

    expect(
      workspace.handle({
        url: 'https://bifrost.test/ws/proxy',
        method: 'POST',
        proxy: { service: 'mock', method: 'get', path: '/mocks' }
      })
    ).toBeUndefined();
  });
});
