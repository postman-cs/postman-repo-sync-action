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

import { parseAssetMarker, parseChannelRules, type AssetMarker } from './branch-decision.js';
import { load as loadYaml } from 'js-yaml';
import {
  runPreviewGc,
  clearChannelRetirement,
  stampChannelRetirement,
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
  updateEnvironment(uid: string, name: string, values: Array<{ key: string; value: string; enabled: boolean; type: string }>): Promise<void>;
  listMocks(): Promise<Array<{ uid: string; name: string; collection: string; mockUrl: string; environment: string }>>;
  listMonitors(): Promise<Array<{ uid: string; name: string; active: boolean; collectionUid: string; environmentUid: string }>>;
  listSpecifications(workspaceId: string): Promise<Array<{ uid: string; name: string }>>;
  getSpecContent(uid: string): Promise<string | undefined>;
  listSpecCollections(uid: string): Promise<Array<{ uid: string; name: string }>>;
  listCollections(workspaceId: string): Promise<Array<{ uid: string; name: string }>>;
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
  previewTtlDays?: number;
  channels?: string;
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

function environmentValues(envelope: unknown): Array<{ key: string; value: string; enabled: boolean; type: string }> {
  const record = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : null;
  const data = record && typeof record.data === 'object' && record.data !== null
    ? record.data as Record<string, unknown>
    : record;
  const values = data && Array.isArray(data.values) ? data.values : [];
  return values.map((raw) => {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
      key: String(value.key ?? ''),
      value: String(value.value ?? ''),
      enabled: value.enabled !== false,
      type: String(value.type ?? 'default')
    };
  });
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

const BARE_COLLECTION_MODEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_COLLECTION_MODEL_ID = /^\d+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SAFE_COLLECTION_ID = /^[A-Za-z0-9._~-]+$/;

/**
 * Join collection-service inventory rows to mock/monitor/spec relation UIDs.
 * Production may expose the same model as a bare UUID in one service and an
 * owner-prefixed public UID in another, so normalize only those two proven
 * forms. Other safe opaque IDs retain exact, case-sensitive identity.
 */
function normalizedCollectionIdentity(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value || value === '.' || value === '..' || !SAFE_COLLECTION_ID.test(value)) return undefined;
  const publicMatch = PUBLIC_COLLECTION_MODEL_ID.exec(value);
  if (publicMatch) return publicMatch[1].toLowerCase();
  if (BARE_COLLECTION_MODEL_ID.test(value)) return value.toLowerCase();
  return value;
}

type CollectionInventoryEntry = { uid: string; name: string };

/** Validate the complete snapshot before it can authorize any deletion. */
function indexCollectionInventory(rows: unknown): Map<string, CollectionInventoryEntry[]> {
  if (!Array.isArray(rows)) throw new Error('COLLECTION_INVENTORY_INVALID');
  const index = new Map<string, CollectionInventoryEntry[]>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('COLLECTION_INVENTORY_INVALID');
    }
    const record = raw as Record<string, unknown>;
    const identity = normalizedCollectionIdentity(record.uid);
    const uid = typeof record.uid === 'string' ? record.uid.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!identity || !uid || !name) throw new Error('COLLECTION_INVENTORY_INVALID');
    const matches = index.get(identity) ?? [];
    matches.push({ uid, name });
    index.set(identity, matches);
  }
  return index;
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
  let collectionInventory: Map<string, CollectionInventoryEntry[]> | undefined;
  try {
    collectionInventory = indexCollectionInventory(await postman.listCollections(workspaceId));
  } catch {
    // Missing/malformed/incomplete inventory can never authorize collection or
    // parent-spec deletion. Other independently marked asset kinds may still
    // take part in the sweep.
    collectionInventory = undefined;
  }
  const resolveGeneratedCollection = (uid: string): CollectionInventoryEntry | undefined => {
    const identity = normalizedCollectionIdentity(uid);
    if (!identity || !collectionInventory) return undefined;
    const matches = collectionInventory.get(identity) ?? [];
    if (matches.length !== 1) return undefined;
    const match = matches[0];
    return isGcCandidateName(match.name) ? match : undefined;
  };
  const discoveredCollectionIdentities = new Set<string>();

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
  const ownedCollections = new Map<string, { marker: AssetMarker }>();
  for (const mock of mocks.filter((entry) => isGcCandidateName(entry.name))) {
    const marker = candidates.find((entry) => entry.kind === 'environment' && entry.uid === mock.environment)?.marker;
    if (marker && mock.collection) ownedCollections.set(mock.collection, { marker });
  }
  for (const monitor of monitors.filter((entry) => isGcCandidateName(entry.name))) {
    const marker = candidates.find((entry) => entry.kind === 'environment' && entry.uid === monitor.environmentUid)?.marker;
    if (marker && monitor.collectionUid) ownedCollections.set(monitor.collectionUid, { marker });
  }
  for (const [uid, collection] of ownedCollections) {
    const resolved = resolveGeneratedCollection(uid);
    const identity = normalizedCollectionIdentity(resolved?.uid);
    if (resolved && identity && !discoveredCollectionIdentities.has(identity)) {
      candidates.push({ kind: 'collection', uid: resolved.uid, name: resolved.name, marker: collection.marker });
      discoveredCollectionIdentities.add(identity);
    }
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
    if (marker) {
      const linkedCandidates: GcCandidate[] = [];
      let relationsResolved = true;
      try {
        const relations = await postman.listSpecCollections(spec.uid);
        if (relations.length === 0) relationsResolved = false;
        for (const collection of relations) {
          const relationIdentity = normalizedCollectionIdentity(collection.uid);
          if (!relationIdentity) {
            relationsResolved = false;
            continue;
          }
          if (discoveredCollectionIdentities.has(relationIdentity)) continue;
          const resolved = resolveGeneratedCollection(collection.uid);
          const resolvedIdentity = normalizedCollectionIdentity(resolved?.uid);
          if (!resolved || !resolvedIdentity || resolvedIdentity !== relationIdentity) {
            relationsResolved = false;
            continue;
          }
          linkedCandidates.push({ kind: 'collection', uid: resolved.uid, name: resolved.name, marker });
        }
      } catch {
        relationsResolved = false;
      }
      if (!relationsResolved) {
        // Never delete a parent when its relation set cannot be resolved to
        // independently identified generated collections. A later sweep can
        // retry without orphaning a child after a partial inventory read.
        continue;
      }
      candidates.push({ kind: 'spec', uid: spec.uid, name: spec.name, marker });
      for (const collection of linkedCandidates) {
        const identity = normalizedCollectionIdentity(collection.uid);
        if (!identity || discoveredCollectionIdentities.has(identity)) continue;
        candidates.push(collection);
        discoveredCollectionIdentities.add(identity);
      }
    } else {
      candidates.push({ kind: 'spec', uid: spec.uid, name: spec.name, marker });
    }
  }

  return candidates;
}

export async function runGc(options: GcRunOptions): Promise<GcSummary> {
  const now = options.now ?? new Date();
  const log = options.log ?? (() => undefined);

  const candidates = await collectGcCandidates(options.postman, options.workspaceId);

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
  const channelRules = options.channels === undefined ? undefined : parseChannelRules(options.channels);
  const channelMapped = channelRules
    ? (rawBranch: string): boolean => channelRules.some((rule) =>
        rule.pattern.endsWith('*')
          ? rawBranch.startsWith(rule.pattern.slice(0, -1))
          : rawBranch === rule.pattern
      )
    : undefined;
  const channelCode = channelRules
    ? (rawBranch: string): string | undefined => channelRules.find((rule) =>
        rule.pattern.endsWith('*')
          ? rawBranch.startsWith(rule.pattern.slice(0, -1))
          : rawBranch === rule.pattern
      )?.code
    : undefined;

  // The environment is the durable marker surface for a channel set. Once it
  // carries retirement state, use that state for every same-branch asset so
  // specs/collections/mocks/monitors converge on deleteAfter in later sweeps.
  const retiredChannels = candidates
    .filter((candidate) => candidate.kind === 'environment' && candidate.marker?.role === 'channel' && candidate.marker.retirementReason)
    .map((candidate) => candidate.marker!);
  for (const candidate of candidates) {
    const marker = candidate.marker;
    if (!marker || marker.role !== 'channel' || marker.retirementReason) continue;
    const retired = retiredChannels.find((entry) => entry.repo === marker.repo && entry.rawBranch === marker.rawBranch);
    if (retired) candidate.marker = retired;
  }

  return runPreviewGc({
    context: {
      repo: options.repo,
      now,
      branchExists,
      channelMapped,
      channelCode,
      onlyBranch: options.onlyBranch,
      allPreviews: options.allPreviews,
      triggerGeneration: now
    },
    candidates,
    deleters: {
      environment: (uid) => options.postman.deleteEnvironment(uid),
      mock: (uid) => options.postman.deleteMock(uid),
      monitor: (uid) => options.postman.deleteMonitor(uid),
      collection: (uid) => options.postman.deleteCollection(uid),
      spec: (uid) => options.postman.deleteSpec(uid)
    },
    retirers: {
      environment: async (candidate, reason) => {
        if (!candidate.marker) return;
        const envelope = await options.postman.getEnvironment(candidate.uid);
        const values = environmentValues(envelope);
        const retired = stampChannelRetirement(
          candidate.marker,
          reason,
          now,
          options.previewTtlDays ?? 30
        );
        const markerValue = values.find((value) => value.key === GC_MARKER_ENV_KEY);
        if (markerValue) markerValue.value = JSON.stringify(retired);
        else values.push({ key: GC_MARKER_ENV_KEY, value: JSON.stringify(retired), enabled: true, type: 'default' });
        await options.postman.updateEnvironment(candidate.uid, candidate.name, values);
      },
      restoreEnvironment: async (candidate) => {
        if (!candidate.marker) return;
        const envelope = await options.postman.getEnvironment(candidate.uid);
        const values = environmentValues(envelope);
        const restored = clearChannelRetirement(candidate.marker);
        const markerValue = values.find((value) => value.key === GC_MARKER_ENV_KEY);
        if (markerValue) markerValue.value = JSON.stringify(restored);
        await options.postman.updateEnvironment(candidate.uid, candidate.name, values);
      }
    },
    degraded,
    dryRun: options.dryRun,
    log
  });
}
