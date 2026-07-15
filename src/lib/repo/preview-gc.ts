/**
 * Preview/channel GC — retention state machine (plan §6.5, PRD R17-R18c).
 *
 * Deletion decision, in order:
 *   1. Branch deletion is authoritative: provider branch-delete hook or lazy
 *      branch-existence sweep -> delete preview assets.
 *   2. PR-close is only a GC *candidate*: the close hook must verify the head
 *      branch is actually gone before deleting (one branch backs many PRs).
 *   3. Sliding TTL is the contract of last resort (`expiresAt`, refreshed on
 *      every successful upsert) — the only mechanism needing zero provider
 *      credentials.
 *   4. sha/createdAt check is name-reuse safety ONLY — never delete a marker
 *      whose generation is newer than the branch state being GC'd. NO
 *      merge-base/ancestry logic anywhere (squash merges make ancestry-based
 *      merged-detection impossible by design).
 *
 * Guards: delete only assets carrying our marker AND matching repo. No marker
 * -> stranger -> never delete; surfaced via orphan audit only. Channel sets
 * with `retirementReason: 'mapping-removed'` survive until `deleteAfter`.
 */

import { parseAssetMarker, type AssetMarker } from './branch-decision.js';

export type GcAssetKind = 'environment' | 'mock' | 'monitor' | 'collection' | 'spec';

export interface GcCandidate {
  kind: GcAssetKind;
  uid: string;
  name: string;
  /** Description text that may carry the x-pm-onboarding marker. */
  description?: string;
  /** Marker already parsed by the caller (e.g. from an environment value). */
  marker?: AssetMarker;
}

export type BranchExistence = 'exists' | 'deleted' | 'unknown';

export interface GcContext {
  /** Normalized repo identity this run GCs for (marker.repo must match). */
  repo: string;
  /** now() for TTL/deleteAfter checks. */
  now: Date;
  /** Branch existence prober; 'unknown' when the provider credential is absent/denied. */
  branchExists: (rawBranch: string) => BranchExistence;
  /** Manual scope: only this branch (cli.cjs gc --branch <name>). */
  onlyBranch?: string;
  /** Manual scope: every preview regardless of branch state (cli.cjs gc --all-previews). */
  allPreviews?: boolean;
  /**
   * Name-reuse safety: the newest generation the GC trigger knows about.
   * A marker with createdAt AFTER this instant belongs to a recreated branch
   * and must never be deleted by this trigger.
   */
  triggerGeneration?: Date;
}

export type GcAction = 'delete' | 'retain' | 'stranger' | 'orphan-audit';

export interface GcDecision {
  action: GcAction;
  reason: string;
  /** 'skipped' when the branch probe was unavailable (degraded mode). */
  branchProbe?: BranchExistence | 'skipped';
}

/** Looks like one of our generated preview/channel names (` @slug` / `[CODE] `). */
export function looksGenerated(name: string): boolean {
  return / @[A-Za-z0-9._-]+/.test(name) || /^\[[A-Z][A-Z0-9]*\] /.test(name);
}

export function resolveMarker(candidate: GcCandidate): AssetMarker | undefined {
  return candidate.marker ?? parseAssetMarker(candidate.description);
}

/**
 * The retention state machine. Pure: all IO (marker parse, branch probe
 * results, clocks) arrives through the candidate and context.
 */
export function decideRetention(candidate: GcCandidate, context: GcContext): GcDecision {
  const marker = resolveMarker(candidate);

  if (!marker) {
    // Stranger: never delete. Orphan-audit only when the NAME looks like one of
    // ours with a lost/invalid marker (R18c scope: generated-name candidates).
    if (looksGenerated(candidate.name)) {
      return { action: 'orphan-audit', reason: 'generated-looking name with missing or invalid marker' };
    }
    return { action: 'stranger', reason: 'no marker; not our asset' };
  }

  if (marker.repo !== context.repo) {
    // Valid stranger from another repo — not an orphan (R18c).
    return { action: 'stranger', reason: `marker repo ${marker.repo} does not match ${context.repo}` };
  }

  // Name-reuse safety (rule 4): never delete a newer generation than the
  // trigger knows about (deleted-then-recreated branch names).
  if (context.triggerGeneration && marker.createdAt) {
    const created = new Date(marker.createdAt);
    if (!Number.isNaN(created.getTime()) && created.getTime() > context.triggerGeneration.getTime()) {
      return { action: 'retain', reason: 'marker generation is newer than the GC trigger (name reuse)' };
    }
  }

  // Channel retirement (plan §6.6): retired sets survive until deleteAfter.
  if (marker.role === 'channel') {
    if (marker.retirementReason && marker.deleteAfter) {
      const deleteAfter = new Date(marker.deleteAfter);
      if (!Number.isNaN(deleteAfter.getTime()) && context.now.getTime() >= deleteAfter.getTime()) {
        return { action: 'delete', reason: `retired channel set past deleteAfter (${marker.retirementReason})` };
      }
      return { action: 'retain', reason: 'retired channel set inside deleteAfter window' };
    }
    return { action: 'retain', reason: 'active channel set (channels are never TTL-swept)' };
  }

  // Manual scopes.
  if (context.onlyBranch !== undefined) {
    if (marker.rawBranch !== context.onlyBranch && marker.sanitizedBranch !== context.onlyBranch) {
      return { action: 'retain', reason: 'outside manual --branch scope' };
    }
    return { action: 'delete', reason: `manual gc --branch ${context.onlyBranch}` };
  }
  if (context.allPreviews) {
    return { action: 'delete', reason: 'manual gc --all-previews' };
  }

  // Rule 1: branch deletion is authoritative.
  const existence = context.branchExists(marker.rawBranch);
  if (existence === 'exists') {
    return { action: 'retain', reason: 'branch still exists', branchProbe: 'exists' };
  }
  if (existence === 'deleted') {
    return { action: 'delete', reason: 'branch deleted', branchProbe: 'deleted' };
  }

  // Rule 3: TTL of last resort (degraded mode: probe unavailable).
  if (marker.expiresAt) {
    const expires = new Date(marker.expiresAt);
    if (!Number.isNaN(expires.getTime()) && context.now.getTime() >= expires.getTime()) {
      return { action: 'delete', reason: 'sliding TTL expired', branchProbe: 'skipped' };
    }
  }
  return { action: 'retain', reason: 'branch existence unknown and TTL not expired', branchProbe: 'skipped' };
}

export interface GcSummaryEntry {
  kind: GcAssetKind;
  uid: string;
  name: string;
  action: GcAction;
  reason: string;
  deleted?: boolean;
  error?: string;
}

export interface GcSummary {
  repo: string;
  scannedAt: string;
  degraded: boolean;
  counts: Record<GcAction, number> & { errors: number };
  entries: GcSummaryEntry[];
}

export interface GcDeleters {
  environment?: (uid: string) => Promise<void>;
  mock?: (uid: string) => Promise<void>;
  monitor?: (uid: string) => Promise<void>;
  collection?: (uid: string) => Promise<void>;
  spec?: (uid: string) => Promise<void>;
}

export interface RunPreviewGcOptions {
  context: GcContext;
  candidates: GcCandidate[];
  deleters: GcDeleters;
  /** True when the provider credential was absent/denied (summary flag). */
  degraded?: boolean;
  /** Dry run: decide + report, delete nothing. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

/**
 * Execute one GC pass. Never throws for per-asset failures: each failed delete
 * is recorded on the summary and the pass continues (the sweep is the retention
 * executor; one bad asset must not wedge the clock for the rest).
 */
export async function runPreviewGc(options: RunPreviewGcOptions): Promise<GcSummary> {
  const { context, candidates, deleters, dryRun } = options;
  const log = options.log ?? (() => undefined);
  const summary: GcSummary = {
    repo: context.repo,
    scannedAt: context.now.toISOString(),
    degraded: Boolean(options.degraded),
    counts: { delete: 0, retain: 0, stranger: 0, 'orphan-audit': 0, errors: 0 },
    entries: []
  };

  for (const candidate of candidates) {
    const decision = decideRetention(candidate, context);
    const entry: GcSummaryEntry = {
      kind: candidate.kind,
      uid: candidate.uid,
      name: candidate.name,
      action: decision.action,
      reason: decision.reason
    };
    summary.counts[decision.action] += 1;

    if (decision.action === 'delete' && !dryRun) {
      const remove = deleters[candidate.kind];
      if (!remove) {
        entry.error = `no deleter wired for kind ${candidate.kind}`;
        summary.counts.errors += 1;
      } else {
        try {
          await remove(candidate.uid);
          entry.deleted = true;
          log(`gc: deleted ${candidate.kind} ${candidate.name} (${candidate.uid}) — ${decision.reason}`);
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
          summary.counts.errors += 1;
          log(`gc: FAILED deleting ${candidate.kind} ${candidate.name} (${candidate.uid}): ${entry.error}`);
        }
      }
    } else if (decision.action === 'delete' && dryRun) {
      log(`gc (dry-run): would delete ${candidate.kind} ${candidate.name} (${candidate.uid}) — ${decision.reason}`);
    }

    summary.entries.push(entry);
  }

  return summary;
}

/** Human-readable job summary block (provider log section). */
export function renderGcSummary(summary: GcSummary): string {
  const lines: string[] = [];
  lines.push(`Preview GC summary for ${summary.repo} at ${summary.scannedAt}${summary.degraded ? ' (degraded: branch probes skipped)' : ''}`);
  lines.push(
    `  deleted=${summary.counts.delete} retained=${summary.counts.retain} strangers=${summary.counts.stranger} orphans=${summary.counts['orphan-audit']} errors=${summary.counts.errors}`
  );
  for (const entry of summary.entries) {
    if (entry.action === 'retain' || entry.action === 'stranger') continue;
    const status = entry.error ? `ERROR: ${entry.error}` : entry.deleted ? 'deleted' : entry.action;
    lines.push(`  [${entry.kind}] ${entry.name} (${entry.uid}): ${status} — ${entry.reason}`);
  }
  return lines.join('\n');
}
