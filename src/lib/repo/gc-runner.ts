/**
 * GC orchestrator (PRD R18a/R18b): provider-neutral `gc` command body.
 *
 * Credential contract (R18b): Postman inventory/deletion uses the minted
 * Postman access token (the injected client); branch existence uses the
 * provider's ambient git credential via ONE `git ls-remote --heads origin`
 * inventory per sweep. The Postman token performs no git-provider reads.
 * With the git credential absent/denied, branch-existence decisions are
 * skipped (degraded) and TTL-expired assets are still processed.
 */

import { parseAssetMarker, type AssetMarker } from './branch-decision.js';
import { load as loadYaml } from 'js-yaml';
import {
  runPreviewGc,
  type BranchExistence,
  type GcCandidate,
  type GcSummary
} from './preview-gc.js';

export const GC_MARKER_ENV_KEY = 'x-pm-onboarding';

export interface GcExec {
  getExecOutput(
    commandLine: string,
    args?: string[],
    options?: { ignoreReturnCode?: boolean; cwd?: string }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface GcPostmanClient {
  listEnvironments(workspaceId: string): Promise<Array<{ name: string; uid: string }>>;
  getEnvironment(uid: string): Promise<unknown>;
  listMocks(): Promise<Array<{ uid: string; name: string; collection: string; mockUrl: string; environment: string }>>;
  listMonitors(): Promise<Array<{ uid: string; name: string; active: boolean; collectionUid: string; environmentUid: string }>>;
  listSpecifications(workspaceId: string): Promise<Array<{ uid: string; name: string }>>;
  getSpecContent(uid: string): Promise<string | undefined>;
  deleteEnvironment(uid: string): Promise<void>;
  deleteMock(uid: string): Promise<void>;
  deleteMonitor(uid: string): Promise<void>;
  deleteCollection(uid: string): Promise<void>;
  deleteSpec(uid: string): Promise<void>;
}

export interface GcRunOptions {
  workspaceId: string;
  /** Normalized repo identity (marker.repo must match). */
  repo: string;
  postman: GcPostmanClient;
  exec: GcExec;
  onlyBranch?: string;
  allPreviews?: boolean;
  dryRun?: boolean;
  now?: Date;
  log?: (message: string) => void;
}

/**
 * One `git ls-remote --heads origin` inventory per sweep. Returns undefined
 * when the remote is unreachable or the credential is denied (degraded mode).
 */
export async function inventoryRemoteBranches(exec: GcExec): Promise<Set<string> | undefined> {
  try {
    const result = await exec.getExecOutput('git', ['ls-remote', '--heads', 'origin'], {
      ignoreReturnCode: true
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const branches = new Set<string>();
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/\trefs\/heads\/(.+)$/);
      if (match) branches.add(match[1].trim());
    }
    return branches;
  } catch {
    return undefined;
  }
}

function markerFromEnvironment(envelope: unknown): AssetMarker | undefined {
  const record = envelope && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : null;
  const data = record && typeof record.data === 'object' && record.data !== null
    ? (record.data as Record<string, unknown>)
    : record;
  const values = data && Array.isArray(data.values) ? (data.values as Array<Record<string, unknown>>) : [];
  for (const value of values) {
    if (String(value?.key ?? '') === GC_MARKER_ENV_KEY) {
      return parseAssetMarker(`${GC_MARKER_ENV_KEY}: ${String(value?.value ?? '')}`);
    }
  }
  return undefined;
}

function markerFromSpecContent(content: string | undefined): AssetMarker | undefined {
  if (!content) return undefined;
  try {
    const parsed = loadYaml(content) as Record<string, unknown> | undefined;
    const marker = parsed?.['x-postman-onboarding'];
    return marker && typeof marker === 'object'
      ? parseAssetMarker(`${GC_MARKER_ENV_KEY}: ${JSON.stringify(marker)}`)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Preview suffix / channel prefix filter: only OUR generated-name shapes are GC candidates. */
function isGcCandidateName(name: string): boolean {
  return / @[A-Za-z0-9._-]+/.test(name) || /^\[[A-Z][A-Z0-9]*\] /.test(name);
}

/**
 * Build candidates from the workspace inventory. Only generated-name shapes
 * enter the candidate list at all — everything else in the workspace is
 * invisible to GC by construction (delete scope is minimal).
 */
export async function collectGcCandidates(
  postman: GcPostmanClient,
  workspaceId: string
): Promise<GcCandidate[]> {
  const candidates: GcCandidate[] = [];

  const environments = await postman.listEnvironments(workspaceId);
  for (const env of environments) {
    if (!isGcCandidateName(env.name)) continue;
    let marker: AssetMarker | undefined;
    try {
      marker = markerFromEnvironment(await postman.getEnvironment(env.uid));
    } catch {
      marker = undefined;
    }
    candidates.push({ kind: 'environment', uid: env.uid, name: env.name, marker });
  }

  const mocks = await postman.listMocks();
  for (const mock of mocks) {
    if (!isGcCandidateName(mock.name)) continue;
    // Mocks carry no description surface through this client: inherit the
    // marker from the matching environment when one exists (same asset set).
    const envMatch = candidates.find(
      (entry) => entry.kind === 'environment' && entry.uid === mock.environment
    );
    candidates.push({ kind: 'mock', uid: mock.uid, name: mock.name, marker: envMatch?.marker });
  }

  const monitors = await postman.listMonitors();
  for (const monitor of monitors) {
    if (!isGcCandidateName(monitor.name)) continue;
    const envMatch = candidates.find(
      (entry) => entry.kind === 'environment' && entry.uid === monitor.environmentUid
    );
    candidates.push({ kind: 'monitor', uid: monitor.uid, name: monitor.name, marker: envMatch?.marker });
  }

  // Mocks and monitors refer to the generated baseline/smoke collections. They
  // do not expose a durable description field, so inherit the proven marker
  // from their branch-scoped environment and collect each owned collection once.
  const ownedCollections = new Map<string, { name: string; marker?: AssetMarker }>();
  for (const mock of mocks) {
    const marker = candidates.find((entry) => entry.kind === 'environment' && entry.uid === mock.environment)?.marker;
    if (marker && mock.collection) ownedCollections.set(mock.collection, { name: `${mock.name} collection`, marker });
  }
  for (const monitor of monitors) {
    const marker = candidates.find((entry) => entry.kind === 'environment' && entry.uid === monitor.environmentUid)?.marker;
    if (marker && monitor.collectionUid) ownedCollections.set(monitor.collectionUid, { name: `${monitor.name} collection`, marker });
  }
  for (const [uid, collection] of ownedCollections) {
    candidates.push({ kind: 'collection', uid, name: collection.name, marker: collection.marker });
  }

  const specifications = await postman.listSpecifications(workspaceId);
  for (const spec of specifications) {
    if (!isGcCandidateName(spec.name)) continue;
    let marker: AssetMarker | undefined;
    try {
      marker = markerFromSpecContent(await postman.getSpecContent(spec.uid));
    } catch {
      marker = undefined;
    }
    candidates.push({ kind: 'spec', uid: spec.uid, name: spec.name, marker });
  }

  return candidates;
}

export async function runGc(options: GcRunOptions): Promise<GcSummary> {
  const now = options.now ?? new Date();
  const log = options.log ?? (() => undefined);

  const remoteBranches = options.onlyBranch || options.allPreviews
    ? undefined // manual scopes never probe: the operator's word is the trigger
    : await inventoryRemoteBranches(options.exec);
  const degraded = remoteBranches === undefined && !options.onlyBranch && !options.allPreviews;
  if (degraded) {
    log('gc: branch inventory unavailable (credential absent/denied?) — degraded sweep, TTL only');
  }

  const branchExists = (rawBranch: string): BranchExistence => {
    if (!remoteBranches) return 'unknown';
    return remoteBranches.has(rawBranch) ? 'exists' : 'deleted';
  };

  const candidates = await collectGcCandidates(options.postman, options.workspaceId);

  return runPreviewGc({
    context: {
      repo: options.repo,
      now,
      branchExists,
      onlyBranch: options.onlyBranch,
      allPreviews: options.allPreviews
    },
    candidates,
    deleters: {
      environment: (uid) => options.postman.deleteEnvironment(uid),
      mock: (uid) => options.postman.deleteMock(uid),
      monitor: (uid) => options.postman.deleteMonitor(uid),
      collection: (uid) => options.postman.deleteCollection(uid),
      spec: (uid) => options.postman.deleteSpec(uid)
    },
    degraded,
    dryRun: options.dryRun,
    log
  });
}
