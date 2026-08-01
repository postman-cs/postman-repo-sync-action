/**
 * WS8 property suite: the branch-decision classifier is TOTAL and
 * DETERMINISTIC.
 *
 * The exhaustive example suite enumerates the finite tuple space; these
 * properties pin the infinite remainder (arbitrary branch names, canonical
 * inputs, channel rule sets): every input either resolves to exactly one of
 * the five tiers or throws the single contracted error, and re-resolving the
 * same input always yields a deep-equal decision.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ContractError,
  resolveBranchDecision,
  serializeBranchDecision,
  type BranchIdentity,
  type ChannelRule,
  type ResolveDecisionOptions
} from '../../src/lib/repo/branch-decision.js';

const NUM_RUNS = 1000;

const TIERS = ['canonical', 'channel', 'preview', 'gated', 'legacy'] as const;

const branchName = fc.oneof(
  fc.constant(undefined),
  fc.stringMatching(/^[A-Za-z0-9._-]{1,20}(\/[A-Za-z0-9._-]{1,20}){0,2}$/)
);

const identityArb: fc.Arbitrary<BranchIdentity> = fc.record({
  provider: fc.constantFrom('github', 'gitlab', 'bitbucket', 'azure-devops', 'unknown'),
  headBranch: branchName,
  rawRef: fc.oneof(fc.constant(undefined), fc.string({ maxLength: 40 })),
  defaultBranch: branchName,
  refKind: fc.constantFrom('default-branch', 'branch', 'tag', 'unknown'),
  isPrContext: fc.boolean(),
  isForkPr: fc.boolean(),
  headSha: fc.oneof(
    fc.constant(undefined),
    fc.stringMatching(/^[0-9a-f]{7,40}$/)
  )
});

const channelRuleArb: fc.Arbitrary<ChannelRule> = fc.record({
  pattern: fc.oneof(
    fc.stringMatching(/^[A-Za-z0-9._-]{1,16}$/),
    fc.stringMatching(/^[A-Za-z0-9._-]{1,12}\/\*$/)
  ),
  code: fc.stringMatching(/^[A-Z][A-Z0-9_-]{0,15}$/)
});

const optionsArb: fc.Arbitrary<ResolveDecisionOptions> = fc.record({
  strategy: fc.constantFrom('legacy', 'publish-gate', 'preview'),
  identity: identityArb,
  canonicalBranch: fc.oneof(
    fc.constant(undefined),
    fc.constant(''),
    fc.constant('   '),
    fc.stringMatching(/^[A-Za-z0-9._-]{1,20}$/)
  ),
  channels: fc.oneof(
    fc.constant(undefined),
    fc.array(channelRuleArb, { maxLength: 4 })
  )
});

function resolveOrError(options: ResolveDecisionOptions):
  | { kind: 'decision'; value: ReturnType<typeof resolveBranchDecision> }
  | { kind: 'error'; code: string } {
  try {
    return { kind: 'decision', value: resolveBranchDecision(options) };
  } catch (error) {
    if (error instanceof ContractError) {
      return { kind: 'error', code: error.code };
    }
    throw error;
  }
}

describe('resolveBranchDecision properties (WS8)', () => {
  it('is total: every input yields exactly one tier or the contracted error', () => {
    fc.assert(
      fc.property(optionsArb, (options) => {
        const outcome = resolveOrError(options);
        if (outcome.kind === 'error') {
          expect(outcome.code).toBe('CONTRACT_DEFAULT_BRANCH_UNRESOLVED');
          // The error is only reachable for non-legacy strategies with no
          // resolvable canonical branch.
          expect(options.strategy).not.toBe('legacy');
          return;
        }
        expect(TIERS).toContain(outcome.value.tier);
        expect(typeof outcome.value.reason).toBe('string');
        expect(outcome.value.reason.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('is deterministic: identical inputs resolve to deep-equal decisions', () => {
    fc.assert(
      fc.property(optionsArb, (options) => {
        const first = resolveOrError(options);
        const second = resolveOrError(options);
        expect(second).toEqual(first);
        if (first.kind === 'decision' && second.kind === 'decision') {
          expect(serializeBranchDecision(second.value)).toBe(
            serializeBranchDecision(first.value)
          );
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('legacy strategy always resolves to the legacy tier and never throws', () => {
    fc.assert(
      fc.property(optionsArb, (options) => {
        const outcome = resolveOrError({ ...options, strategy: 'legacy' });
        expect(outcome.kind).toBe('decision');
        if (outcome.kind === 'decision') {
          expect(outcome.value.tier).toBe('legacy');
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('a fork PR can never claim a write-eligible tier', () => {
    fc.assert(
      fc.property(optionsArb, (options) => {
        const forked: ResolveDecisionOptions = {
          ...options,
          identity: { ...options.identity, isForkPr: true }
        };
        const outcome = resolveOrError(forked);
        if (outcome.kind === 'decision' && forked.strategy !== 'legacy') {
          expect(['gated']).toContain(outcome.value.tier);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
