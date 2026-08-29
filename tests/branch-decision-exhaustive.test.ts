/**
 * WS5 state-machine exhaustion: the branch-decision classifier.
 *
 * `resolveBranchDecision` is the sole gate that decides whether a run may write
 * canonical assets, a parallel channel set, a TTL preview set, or nothing at
 * all. A hole in that table is a silent write to the wrong asset set, so this
 * suite enumerates the FULL cartesian product of its decision axes rather than
 * sampling representative rows, and requires every tuple to resolve to exactly
 * one tier.
 *
 * ## Axes
 *
 * The plan states the tuple as `strategy x refKind x isForkPr x head==canonical`.
 * Two refinements are required to make the tuple actually determining -- without
 * them the "one tier per tuple" claim is false, not merely unproven:
 *
 * 1. `head==canonical` must be three-valued, not boolean. `resolveBranchDecision`
 *    tests `!identity.headBranch` in the same guard as tag/unknown refKinds, so
 *    an ABSENT head branch and a head branch that merely DIFFERS from canonical
 *    take different exits. Under `preview` they land on different tiers
 *    (`gated` vs `preview`), so collapsing them into one boolean makes the
 *    projection map one tuple onto two tiers.
 * 2. Channel rules are a decision axis. `matchChannel` runs between the
 *    canonical check and the strategy check, so the same
 *    `strategy x refKind x isForkPr x head` tuple yields `channel` or
 *    `preview`/`gated` depending on whether a rule matches the head branch.
 *    `parseChannelRules` injects `release/*=RC` unconditionally, so this is the
 *    default production configuration, not an exotic one.
 *
 * The full space is therefore `strategy(3) x refKind(4) x isForkPr(2) x
 * head(3) x channels(3)` = 216 tuples. 24 of those are structurally
 * unrealizable (channel rules cannot match a head branch that does not exist)
 * and are registered explicitly, leaving 192 realizable tuples.
 *
 * ## What "exactly one tier" is proven to mean
 *
 * Every realizable tuple is evaluated through several DISTINCT realizations
 * that vary every field the tuple does not pin -- provider, raw ref, head sha,
 * PR context, whether canonical came from the explicit input or the provider
 * default, and the branch name itself. A tuple passes only when:
 *
 *   - every realization returns the same tier      (never 2+ tiers)
 *   - that tier equals an INDEPENDENT oracle       (never 0 / never drifted)
 *
 * The oracle is transcribed from the documented contract in `branch-decision.ts`
 * rather than derived from the implementation, so an implementation change that
 * silently re-routes a tuple turns this suite red.
 */
import { describe, expect, it } from 'vitest';

import {
  ContractError,
  resolveBranchDecision,
  type BranchDecision,
  type BranchIdentity,
  type BranchStrategy,
  type BranchTier,
  type ChannelRule,
  type IdentityProvider,
  type RefKind,
  type ResolveDecisionOptions
} from '../src/lib/repo/branch-decision.js';

const STRATEGIES: BranchStrategy[] = ['legacy', 'publish-gate', 'preview'];
const REF_KINDS: RefKind[] = ['default-branch', 'branch', 'tag', 'unknown'];
const FORK_STATES = [false, true] as const;

/**
 * Head-branch position relative to the canonical branch.
 *
 * `absent` is a first-class value because `resolveBranchDecision` short-circuits
 * on `!identity.headBranch`, not on inequality.
 */
type HeadAxis = 'equals-canonical' | 'differs' | 'absent';
const HEAD_AXES: HeadAxis[] = ['equals-canonical', 'differs', 'absent'];

/** Channel-rule configuration relative to the head branch. */
type ChannelAxis = 'none' | 'no-match' | 'matches-head';
const CHANNEL_AXES: ChannelAxis[] = ['none', 'no-match', 'matches-head'];

interface Tuple {
  strategy: BranchStrategy;
  refKind: RefKind;
  isForkPr: boolean;
  head: HeadAxis;
  channels: ChannelAxis;
}

const CANONICAL = 'main';

function tupleKey(tuple: Tuple): string {
  return [tuple.strategy, tuple.refKind, `fork=${tuple.isForkPr}`, `head=${tuple.head}`, `channels=${tuple.channels}`].join(
    ' | '
  );
}

function cartesianProduct(): Tuple[] {
  const tuples: Tuple[] = [];
  for (const strategy of STRATEGIES) {
    for (const refKind of REF_KINDS) {
      for (const isForkPr of FORK_STATES) {
        for (const head of HEAD_AXES) {
          for (const channels of CHANNEL_AXES) {
            tuples.push({ strategy, refKind, isForkPr, head, channels });
          }
        }
      }
    }
  }
  return tuples;
}

/**
 * A tuple is unrealizable exactly when it asks for channel rules that match a
 * head branch that does not exist. Nothing else in the space is contradictory.
 */
function unrealizableReason(tuple: Tuple): string | null {
  if (tuple.head === 'absent' && tuple.channels === 'matches-head') {
    return 'channel rules cannot match the head branch when there is no head branch';
  }
  return null;
}

/**
 * Independent oracle, transcribed from the tier contract documented at the top
 * of `branch-decision.ts`:
 *
 *   legacy   branch-blind pre-v2 behavior for non-fork runs
 *   gated    tag/unknown refs and missing head branches are never write-eligible;
 *            every fork PR under every strategy; also every
 *            non-canonical branch under publish-gate
 *   canonical the head branch IS the canonical branch (same-repo head only)
 *   channel  a channel rule claims the head branch (same-repo head only)
 *   preview  any other branch under preview
 *
 * Ordering matters and is part of the contract: the ref-kind guard precedes the
 * fork gate, which precedes the canonical check, which precedes channel
 * matching. A fork head can never reach a write-eligible tier.
 */
function expectedTier(tuple: Tuple): BranchTier {
  if (tuple.isForkPr) return 'gated';
  if (tuple.strategy === 'legacy') return 'legacy';
  if (tuple.refKind === 'tag' || tuple.refKind === 'unknown' || tuple.head === 'absent') return 'gated';
  if (tuple.head === 'equals-canonical') return 'canonical';
  if (tuple.channels === 'matches-head') return 'channel';
  if (tuple.strategy === 'preview') return 'preview';
  return 'gated';
}

interface Realization {
  label: string;
  options: ResolveDecisionOptions;
}

/** Head-branch names used for the `differs` axis; shape variety is deliberate. */
const DIFFERING_BRANCHES = [
  'feature/payments',
  'dependabot/npm_and_yarn/undici-8.8.0',
  'fix-1',
  `long/${'x'.repeat(120)}`
];

function headBranchFor(tuple: Tuple, variantIndex: number): string | undefined {
  if (tuple.head === 'absent') return undefined;
  if (tuple.head === 'equals-canonical') return CANONICAL;
  return DIFFERING_BRANCHES[variantIndex % DIFFERING_BRANCHES.length];
}

/**
 * Build the channel rule set for a realization.
 *
 * `no-match` deliberately carries the real-world default rules
 * (`develop=DEV, staging=STAGE, release/*=RC`) rather than an empty list, so a
 * matcher that started claiming unrelated branches would be caught.
 */
function channelsFor(axis: ChannelAxis, headBranch: string | undefined, variantIndex: number): ChannelRule[] {
  const defaults: ChannelRule[] = [
    { pattern: 'develop', code: 'DEV' },
    { pattern: 'staging', code: 'STAGE' },
    { pattern: 'release/*', code: 'RC' }
  ];
  if (axis === 'none') return [];
  if (axis === 'no-match') return defaults;
  if (!headBranch) {
    throw new Error('channelsFor("matches-head") requires a head branch; unrealizable tuples must be filtered first');
  }
  // Alternate between an exact-name rule and a prefix glob so both matcher
  // branches in `matchChannel` are exercised across realizations.
  const useGlob = variantIndex % 2 === 1 && headBranch.length > 3;
  const rule: ChannelRule = useGlob
    ? { pattern: `${headBranch.slice(0, 3)}*`, code: 'GLOB' }
    : { pattern: headBranch, code: 'EXACT' };
  return [...defaults, rule];
}

const PROVIDERS: IdentityProvider[] = ['github', 'gitlab', 'bitbucket', 'azure-devops', 'unknown'];

/**
 * Every realization honestly instantiates the tuple while varying each field the
 * tuple does not pin. `canonicalSource` matters: resolving canonical from the
 * explicit input while the provider default says something else is a real,
 * reachable configuration (`canonical-branch: trunk` on a repo whose default
 * branch is `main`), and it is the only way `refKind === 'default-branch'` can
 * coexist with a head branch that is not canonical.
 */
function realizationsFor(tuple: Tuple): Realization[] {
  const realizations: Realization[] = [];
  for (let variantIndex = 0; variantIndex < 4; variantIndex += 1) {
    const headBranch = headBranchFor(tuple, variantIndex);
    const provider = PROVIDERS[variantIndex % PROVIDERS.length]!;
    const canonicalFromInput = variantIndex % 2 === 0;
    const isPrContext = variantIndex % 2 === 1;

    const identity: BranchIdentity = {
      provider,
      headBranch,
      rawRef:
        tuple.refKind === 'tag'
          ? `refs/tags/v1.${variantIndex}.0`
          : tuple.refKind === 'unknown'
            ? `refs/pull/${variantIndex + 1}/merge`
            : (headBranch ?? undefined),
      // When canonical comes from the explicit input, the provider default is a
      // DIFFERENT branch, proving the input wins and that a decision is never
      // taken against the provider default behind the input's back.
      defaultBranch: canonicalFromInput ? 'provider-default-branch' : CANONICAL,
      refKind: tuple.refKind,
      isPrContext,
      isForkPr: tuple.isForkPr,
      headSha: variantIndex % 3 === 0 ? undefined : `${'0'.repeat(35)}${variantIndex}`
    };

    realizations.push({
      label: `variant${variantIndex}[provider=${provider},canonical=${canonicalFromInput ? 'input' : 'provider-default'},head=${String(headBranch)}]`,
      options: {
        strategy: tuple.strategy,
        identity,
        canonicalBranch: canonicalFromInput ? CANONICAL : undefined,
        channels: channelsFor(tuple.channels, headBranch, variantIndex)
      }
    });
  }
  return realizations;
}

const ALL_TUPLES = cartesianProduct();
const REALIZABLE = ALL_TUPLES.filter((tuple) => unrealizableReason(tuple) === null);
const UNREALIZABLE = ALL_TUPLES.filter((tuple) => unrealizableReason(tuple) !== null);

describe('branch decision: exhaustive tuple table', () => {
  it('enumerates the complete cartesian product with no duplicates and no omissions', () => {
    const expectedCount =
      STRATEGIES.length * REF_KINDS.length * FORK_STATES.length * HEAD_AXES.length * CHANNEL_AXES.length;
    expect(expectedCount).toBe(216);
    expect(ALL_TUPLES).toHaveLength(expectedCount);
    expect(new Set(ALL_TUPLES.map(tupleKey)).size).toBe(expectedCount);

    // The realizable/unrealizable split must account for every tuple; a tuple
    // may never be quietly dropped from the table.
    expect(REALIZABLE.length + UNREALIZABLE.length).toBe(expectedCount);
    expect(UNREALIZABLE).toHaveLength(24);
    expect(REALIZABLE).toHaveLength(192);
    for (const tuple of UNREALIZABLE) {
      expect(unrealizableReason(tuple)).toBe(
        'channel rules cannot match the head branch when there is no head branch'
      );
    }
  });

  it.each(REALIZABLE.map((tuple) => [tupleKey(tuple), tuple] as const))(
    'resolves exactly one tier: %s',
    (_key, tuple) => {
      const observed = realizationsFor(tuple).map((realization) => ({
        label: realization.label,
        decision: resolveBranchDecision(realization.options)
      }));

      // Never zero: every realization must return a decision carrying a tier
      // from the declared union.
      const tiers: BranchTier[] = ['canonical', 'channel', 'preview', 'gated', 'legacy'];
      for (const { label, decision } of observed) {
        expect(decision, `${tupleKey(tuple)} / ${label} produced no decision`).toBeTruthy();
        expect(tiers, `${tupleKey(tuple)} / ${label} produced tier ${decision.tier}`).toContain(decision.tier);
      }

      // Never 2+: the tuple, not the realization, decides the tier.
      const distinct = [...new Set(observed.map(({ decision }) => decision.tier))];
      expect(
        distinct,
        `${tupleKey(tuple)} mapped to ${distinct.length} tiers across realizations: ${observed
          .map(({ label, decision }) => `${label}=>${decision.tier}`)
          .join(', ')}`
      ).toHaveLength(1);

      // Matches the independent contract oracle, so a re-route is red.
      expect(distinct[0], `${tupleKey(tuple)} drifted from the documented contract`).toBe(expectedTier(tuple));
    }
  );

  it('reaches every declared tier, so the oracle is not degenerate', () => {
    const reached = new Set<BranchTier>();
    for (const tuple of REALIZABLE) {
      reached.add(resolveBranchDecision(realizationsFor(tuple)[0]!.options).tier);
    }
    expect([...reached].sort()).toEqual(['canonical', 'channel', 'gated', 'legacy', 'preview']);
  });

  it('is deterministic: the same options resolve identically on repeat evaluation', () => {
    for (const tuple of REALIZABLE) {
      for (const realization of realizationsFor(tuple)) {
        const first = resolveBranchDecision(realization.options);
        const second = resolveBranchDecision(realization.options);
        expect(second, `${tupleKey(tuple)} / ${realization.label} is not deterministic`).toEqual(first);
      }
    }
  });
});

describe('branch decision: per-tier structural invariants across the whole table', () => {
  function decisionsFor(predicate: (tuple: Tuple) => boolean): Array<{ tuple: Tuple; decision: BranchDecision }> {
    return REALIZABLE.filter(predicate).flatMap((tuple) =>
      realizationsFor(tuple).map((realization) => ({ tuple, decision: resolveBranchDecision(realization.options) }))
    );
  }

  it('sets the channel rule if and only if the tier is channel', () => {
    for (const { tuple, decision } of decisionsFor(() => true)) {
      if (decision.tier === 'channel') {
        expect(decision.channel, `${tupleKey(tuple)} is channel tier without a channel rule`).toBeTruthy();
        expect(decision.channel!.code).toMatch(/^[A-Z][A-Z0-9_-]{0,15}$/);
      } else {
        expect(decision.channel, `${tupleKey(tuple)} is ${decision.tier} tier but carries a channel rule`).toBeUndefined();
      }
    }
  });

  it('always resolves a canonical branch under every non-legacy tier', () => {
    for (const { tuple, decision } of decisionsFor((tuple) => tuple.strategy !== 'legacy')) {
      expect(decision.canonicalBranch, `${tupleKey(tuple)} resolved no canonical branch`).toBe(CANONICAL);
    }
  });

  it('echoes the requested strategy and the supplied identity unchanged', () => {
    for (const { tuple, decision } of decisionsFor(() => true)) {
      expect(decision.strategy).toBe(tuple.strategy);
      expect(decision.identity.refKind).toBe(tuple.refKind);
      expect(decision.identity.isForkPr).toBe(tuple.isForkPr);
    }
  });

  it('always carries a non-empty reason string', () => {
    for (const { tuple, decision } of decisionsFor(() => true)) {
      expect(decision.reason.trim().length, `${tupleKey(tuple)} produced an empty reason`).toBeGreaterThan(0);
    }
  });

  it('never grants canonical tier to a tag or unknown ref, even with a canonical-named head', () => {
    // Defense in depth: `resolveBranchIdentity` never emits a tag with a head
    // branch, but `resolveBranchDecision` is a public export that takes an
    // arbitrary identity, so the guard must hold on hand-built input too.
    const tagLike = decisionsFor(
      (tuple) => (tuple.refKind === 'tag' || tuple.refKind === 'unknown') && tuple.head === 'equals-canonical'
    );
    expect(tagLike.length).toBeGreaterThan(0);

    const canonicalEscapes = tagLike.filter(({ decision }) => decision.tier === 'canonical');
    expect(canonicalEscapes, 'a tag/unknown ref reached canonical tier').toHaveLength(0);

    // Under a non-legacy strategy the only permitted exit is `gated`; `legacy`
    // is branch-blind by contract and short-circuits before the ref-kind guard.
    const nonLegacyEscapes = tagLike.filter(
      ({ tuple, decision }) => tuple.strategy !== 'legacy' && decision.tier !== 'gated'
    );
    expect(nonLegacyEscapes, 'a tag/unknown ref escaped the gated exit').toHaveLength(0);
  });
});

describe('branch decision: the plan tuple projects cleanly only with channel rules held non-matching', () => {
  /**
   * The plan words the tuple as `strategy x refKind x isForkPr x head==canonical`.
   * That 4-axis projection IS determining once channel rules are held to a
   * non-matching set -- which is what the two tests below prove and disprove
   * respectively. This is the reason the main table carries the extra axes.
   */
  function projectionKey(tuple: Tuple): string {
    return [tuple.strategy, tuple.refKind, `fork=${tuple.isForkPr}`, `headIsCanonical=${tuple.head === 'equals-canonical'}`].join(
      ' | '
    );
  }

  it('holds one tier per 4-axis tuple once both refinements are applied', () => {
    // Both refinements are required for the projection to be determining:
    // channel rules must not claim the head branch, and the head branch must
    // exist (an absent head and a differing head share `headIsCanonical=false`
    // but take different exits). The two tests below demonstrate each collapse.
    const byProjection = new Map<string, Set<BranchTier>>();
    for (const tuple of REALIZABLE.filter(
      (candidate) => candidate.channels !== 'matches-head' && candidate.head !== 'absent'
    )) {
      const key = projectionKey(tuple);
      const tiers = byProjection.get(key) ?? new Set<BranchTier>();
      for (const realization of realizationsFor(tuple)) {
        tiers.add(resolveBranchDecision(realization.options).tier);
      }
      byProjection.set(key, tiers);
    }

    expect(byProjection.size).toBe(STRATEGIES.length * REF_KINDS.length * FORK_STATES.length * 2);
    const ambiguous = [...byProjection.entries()]
      .filter(([, tiers]) => tiers.size !== 1)
      .map(([key, tiers]) => `${key} -> {${[...tiers].join(', ')}}`);
    expect(ambiguous, 'projection mapped a tuple to zero or several tiers').toEqual([]);
  });

  it('splits once a channel rule claims the head branch, which is why channels is an axis', () => {
    // Same 4-axis tuple, one with matching channel rules and one without.
    const base: Omit<Tuple, 'channels'> = {
      strategy: 'preview',
      refKind: 'branch',
      isForkPr: false,
      head: 'differs'
    };
    const withoutChannel = resolveBranchDecision(realizationsFor({ ...base, channels: 'no-match' })[0]!.options);
    const withChannel = resolveBranchDecision(realizationsFor({ ...base, channels: 'matches-head' })[0]!.options);

    expect(withoutChannel.tier).toBe('preview');
    expect(withChannel.tier).toBe('channel');
  });

  it('splits absent-head from differing-head, which is why head is three-valued', () => {
    const base: Omit<Tuple, 'head'> = {
      strategy: 'preview',
      refKind: 'branch',
      isForkPr: false,
      channels: 'no-match'
    };
    expect(resolveBranchDecision(realizationsFor({ ...base, head: 'differs' })[0]!.options).tier).toBe('preview');
    expect(resolveBranchDecision(realizationsFor({ ...base, head: 'absent' })[0]!.options).tier).toBe('gated');
  });
});

describe('branch decision: unresolved canonical branch is outside the tier table', () => {
  /**
   * The tier table presumes a resolved canonical branch. When neither the input
   * nor the provider exposes one, a non-legacy strategy must fail loud instead
   * of falling into any tier -- guessing `main` would make a fork PR on an
   * unrelated default branch write canonical assets.
   */
  function unresolvedOptions(strategy: BranchStrategy, refKind: RefKind, isForkPr: boolean): ResolveDecisionOptions {
    return {
      strategy,
      identity: {
        provider: 'bitbucket',
        headBranch: refKind === 'tag' || refKind === 'unknown' ? undefined : 'feature/payments',
        rawRef: 'feature/payments',
        defaultBranch: undefined,
        refKind,
        isPrContext: isForkPr,
        isForkPr
      },
      canonicalBranch: undefined,
      channels: []
    };
  }

  it('throws CONTRACT_DEFAULT_BRANCH_UNRESOLVED for non-legacy, non-fork tuples', () => {
    for (const strategy of STRATEGIES.filter((candidate) => candidate !== 'legacy')) {
      for (const refKind of REF_KINDS) {
        for (const isForkPr of FORK_STATES) {
          if (isForkPr) {
            expect(resolveBranchDecision(unresolvedOptions(strategy, refKind, true)).tier).toBe('gated');
            continue;
          }
          let thrown: unknown;
          try {
            resolveBranchDecision(unresolvedOptions(strategy, refKind, isForkPr));
          } catch (error) {
            thrown = error;
          }
          expect(thrown, `${strategy}/${refKind}/fork=${isForkPr} did not fail loud`).toBeInstanceOf(ContractError);
          expect((thrown as ContractError).code).toBe('CONTRACT_DEFAULT_BRANCH_UNRESOLVED');
        }
      }
    }
  });

  it('never throws under legacy and still gates fork contexts', () => {
    for (const refKind of REF_KINDS) {
      for (const isForkPr of FORK_STATES) {
        const decision = resolveBranchDecision(unresolvedOptions('legacy', refKind, isForkPr));
        expect(decision.tier).toBe(isForkPr ? 'gated' : 'legacy');
        expect(decision.canonicalBranch).toBeUndefined();
      }
    }
  });
});

describe('branch decision: fork-PR write gate coverage across the table', () => {
  it('gates every fork PR under every strategy, regardless of channel rules', () => {
    const forkTuples = REALIZABLE.filter((tuple) => tuple.isForkPr);
    expect(forkTuples.length).toBeGreaterThan(0);
    for (const tuple of forkTuples) {
      for (const realization of realizationsFor(tuple)) {
        const decision = resolveBranchDecision(realization.options);
        expect(decision.tier, `${tupleKey(tuple)} let a fork PR reach ${decision.tier}`).toBe('gated');
      }
    }
  });

  it('REGRESSION: a fork PR whose head branch matches a channel rule stays gated', () => {
    /**
     * The fork gate used to sit AFTER channel matching, so a fork branch named
     * `release/anything` classified as channel tier (parseChannelRules always
     * appends `release/*=RC`) and became eligible to write the shared `[RC]`
     * asset set. The gate now precedes the canonical and channel checks; this
     * test pins the closed gap so the ordering cannot silently regress.
     */
    const decision = resolveBranchDecision({
      strategy: 'preview',
      identity: {
        provider: 'github',
        headBranch: 'release/attacker',
        rawRef: 'release/attacker',
        defaultBranch: CANONICAL,
        refKind: 'branch',
        isPrContext: true,
        isForkPr: true
      },
      canonicalBranch: CANONICAL,
      channels: [{ pattern: 'release/*', code: 'RC' }]
    });

    expect(decision.tier).toBe('gated');
    expect(decision.channel).toBeUndefined();
    expect(decision.identity.isForkPr).toBe(true);
  });

  it('REGRESSION: a fork PR whose head branch equals the canonical branch stays gated', () => {
    // A fork can name its head branch anything, including the canonical name.
    // The fork gate precedes the canonical check, so the name grants nothing.
    const decision = resolveBranchDecision({
      strategy: 'preview',
      identity: {
        provider: 'github',
        headBranch: CANONICAL,
        rawRef: CANONICAL,
        defaultBranch: CANONICAL,
        refKind: 'branch',
        isPrContext: true,
        isForkPr: true
      },
      canonicalBranch: CANONICAL,
      channels: []
    });

    expect(decision.tier).toBe('gated');
  });

  it('gates fork PRs identically to non-fork PRs under publish-gate', () => {
    // publish-gate has no fork-specific exit; both fork states must land gated
    // for every non-canonical branch, and the tuple table must agree.
    for (const isForkPr of FORK_STATES) {
      const decision = resolveBranchDecision({
        strategy: 'publish-gate',
        identity: {
          provider: 'github',
          headBranch: 'feature/payments',
          rawRef: 'feature/payments',
          defaultBranch: CANONICAL,
          refKind: 'branch',
          isPrContext: true,
          isForkPr
        },
        canonicalBranch: CANONICAL,
        channels: []
      });
      expect(decision.tier).toBe('gated');
    }
  });
});
