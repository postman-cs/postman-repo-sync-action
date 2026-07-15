import { describe, expect, it } from 'vitest';

import { renderAssetMarker, type AssetMarker } from '../src/lib/repo/branch-decision.js';
import {
  decideRetention,
  looksGenerated,
  renderGcSummary,
  runPreviewGc,
  type GcCandidate,
  type GcContext
} from '../src/lib/repo/preview-gc.js';

const NOW = new Date('2026-07-14T12:00:00Z');
const REPO = 'https://github.com/acme/payments';

function marker(overrides: Partial<AssetMarker> = {}): AssetMarker {
  return {
    repo: REPO,
    rawBranch: 'feature/payments',
    sanitizedBranch: 'feature-payments',
    role: 'preview',
    headSha: 'deadbeef',
    createdAt: '2026-07-01T00:00:00Z',
    lastSyncedAt: '2026-07-10T00:00:00Z',
    expiresAt: '2026-08-09T00:00:00Z',
    ...overrides
  };
}

function candidate(overrides: Partial<GcCandidate> = {}): GcCandidate {
  return {
    kind: 'environment',
    uid: 'env-1',
    name: 'core-payments @feature-payments - dev',
    description: renderAssetMarker(marker()),
    ...overrides
  };
}

function context(overrides: Partial<GcContext> = {}): GcContext {
  return {
    repo: REPO,
    now: NOW,
    branchExists: () => 'unknown',
    ...overrides
  };
}

describe('retention state machine (plan §6.5 case table)', () => {
  it('branch deleted → delete (rule 1: branch deletion is authoritative)', () => {
    const decision = decideRetention(candidate(), context({ branchExists: () => 'deleted' }));
    expect(decision.action).toBe('delete');
    expect(decision.branchProbe).toBe('deleted');
  });

  it('branch alive → retain even when the PR closed (rule 2)', () => {
    const decision = decideRetention(
      candidate({ description: renderAssetMarker(marker({ prNumber: 42 })) }),
      context({ branchExists: () => 'exists' })
    );
    expect(decision.action).toBe('retain');
  });

  it('branch existence unknown + TTL expired → delete (rule 3: TTL of last resort)', () => {
    const decision = decideRetention(
      candidate({ description: renderAssetMarker(marker({ expiresAt: '2026-07-01T00:00:00Z' })) }),
      context()
    );
    expect(decision.action).toBe('delete');
    expect(decision.branchProbe).toBe('skipped');
  });

  it('branch existence unknown + TTL live → retain (degraded mode keeps assets)', () => {
    const decision = decideRetention(candidate(), context());
    expect(decision.action).toBe('retain');
    expect(decision.branchProbe).toBe('skipped');
  });

  it('force-push/rebase (refreshed lastSyncedAt/expiresAt) → retained while branch lives', () => {
    const decision = decideRetention(
      candidate({ description: renderAssetMarker(marker({ expiresAt: '2026-12-31T00:00:00Z' })) }),
      context({ branchExists: () => 'exists' })
    );
    expect(decision.action).toBe('retain');
  });

  it('name reuse: marker generation newer than the trigger → retain (rule 4)', () => {
    const decision = decideRetention(
      candidate({ description: renderAssetMarker(marker({ createdAt: '2026-07-13T00:00:00Z' })) }),
      context({ branchExists: () => 'deleted', triggerGeneration: new Date('2026-07-12T00:00:00Z') })
    );
    expect(decision.action).toBe('retain');
    expect(decision.reason).toContain('name reuse');
  });

  it('stranger (no marker, non-generated name) → never delete, never audit', () => {
    const decision = decideRetention(
      candidate({ description: 'hand-made environment', name: 'My Environment' }),
      context({ branchExists: () => 'deleted' })
    );
    expect(decision.action).toBe('stranger');
  });

  it('generated-looking name with lost marker → orphan-audit, never delete (R18c)', () => {
    const decision = decideRetention(
      candidate({ description: 'marker got edited away', name: 'core-payments @feature-x - dev' }),
      context({ branchExists: () => 'deleted' })
    );
    expect(decision.action).toBe('orphan-audit');
  });

  it('marker for another repo → valid stranger, not an orphan (R18c scope)', () => {
    const decision = decideRetention(
      candidate({ description: renderAssetMarker(marker({ repo: 'https://github.com/acme/other' })) }),
      context({ branchExists: () => 'deleted' })
    );
    expect(decision.action).toBe('stranger');
  });

  it('active channel set → retained (channels are never TTL-swept), survives develop→main merge', () => {
    const decision = decideRetention(
      candidate({ description: renderAssetMarker(marker({ role: 'channel', rawBranch: 'develop' })) }),
      context({ branchExists: () => 'exists' })
    );
    expect(decision.action).toBe('retain');
    expect(decision.reason).toContain('channel');
  });

  it('retired channel set inside deleteAfter → retained; past deleteAfter → deleted', () => {
    const retired = (deleteAfter: string) =>
      candidate({
        description: renderAssetMarker(
          marker({ role: 'channel', retirementReason: 'mapping-removed', retirementDetectedAt: '2026-07-01T00:00:00Z', deleteAfter })
        )
      });
    expect(decideRetention(retired('2026-08-01T00:00:00Z'), context()).action).toBe('retain');
    expect(decideRetention(retired('2026-07-10T00:00:00Z'), context()).action).toBe('delete');
  });

  it('manual --branch scope deletes only that branch', () => {
    const ctx = context({ onlyBranch: 'feature/payments', branchExists: () => 'exists' });
    expect(decideRetention(candidate(), ctx).action).toBe('delete');
    const other = candidate({ description: renderAssetMarker(marker({ rawBranch: 'feature/other', sanitizedBranch: 'feature-other' })) });
    expect(decideRetention(other, ctx).action).toBe('retain');
  });

  it('manual --all-previews deletes previews but never strangers or channels', () => {
    const ctx = context({ allPreviews: true, branchExists: () => 'exists' });
    expect(decideRetention(candidate(), ctx).action).toBe('delete');
    expect(decideRetention(candidate({ description: undefined, name: 'Hand Env' }), ctx).action).toBe('stranger');
    expect(
      decideRetention(candidate({ description: renderAssetMarker(marker({ role: 'channel' })) }), ctx).action
    ).toBe('retain');
  });
});

describe('looksGenerated', () => {
  it('matches preview suffix and channel prefix, rejects plain names', () => {
    expect(looksGenerated('core-payments @feature-x')).toBe(true);
    expect(looksGenerated('[DEV] core-payments')).toBe(true);
    expect(looksGenerated('core-payments')).toBe(false);
  });
});

describe('runPreviewGc', () => {
  it('deletes only marker-owned matching assets and reports the rest', async () => {
    const deleted: string[] = [];
    const summary = await runPreviewGc({
      context: context({ branchExists: () => 'deleted' }),
      candidates: [
        candidate({ uid: 'env-1' }),
        candidate({ uid: 'env-2', description: undefined, name: 'Hand Env' }),
        candidate({ uid: 'env-3', description: 'lost', name: 'core-payments @feature-x - dev' })
      ],
      deleters: { environment: async (uid) => { deleted.push(uid); } }
    });
    expect(deleted).toEqual(['env-1']);
    expect(summary.counts).toMatchObject({ delete: 1, stranger: 1, 'orphan-audit': 1, errors: 0 });
  });

  it('dry run decides but deletes nothing', async () => {
    const deleted: string[] = [];
    const summary = await runPreviewGc({
      context: context({ branchExists: () => 'deleted' }),
      candidates: [candidate()],
      deleters: { environment: async (uid) => { deleted.push(uid); } },
      dryRun: true
    });
    expect(deleted).toEqual([]);
    expect(summary.counts.delete).toBe(1);
    expect(summary.entries[0].deleted).toBeUndefined();
  });

  it('per-asset delete failure is recorded, never thrown (sweep keeps its clock)', async () => {
    const summary = await runPreviewGc({
      context: context({ branchExists: () => 'deleted' }),
      candidates: [candidate({ uid: 'env-bad' }), candidate({ uid: 'env-good' })],
      deleters: {
        environment: async (uid) => {
          if (uid === 'env-bad') throw new Error('403 forbidden');
        }
      }
    });
    expect(summary.counts.errors).toBe(1);
    expect(summary.entries[0].error).toContain('403');
    expect(summary.entries[1].deleted).toBe(true);
  });

  it('degraded summary flags branch probes skipped while TTL-expired assets still process', async () => {
    const summary = await runPreviewGc({
      context: context(),
      candidates: [
        candidate({ description: renderAssetMarker(marker({ expiresAt: '2026-07-01T00:00:00Z' })) })
      ],
      deleters: { environment: async () => undefined },
      degraded: true
    });
    expect(summary.degraded).toBe(true);
    expect(summary.counts.delete).toBe(1);
    const rendered = renderGcSummary(summary);
    expect(rendered).toContain('degraded');
    expect(rendered).toContain('deleted=1');
  });
});
