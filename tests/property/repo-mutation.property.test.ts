/**
 * WS8 property suite: repo-mutation path and ref seams.
 *
 * 1. `normalizeStagePaths` (exercised through `RepoMutationService.commitAndPush`,
 *    which invokes it before any git subprocess) rejects EVERY absolute,
 *    parent-traversing, control-character-bearing, or `:`-prefixed path.
 * 2. `resolveCurrentRef` never launders a tag or PR ref into a branch name:
 *    for every context the result is either empty or a plain branch name that
 *    never carries a `refs/` prefix, and tag/pull refs can never be returned.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  RepoMutationService,
  resolveCurrentRef,
  type CommitAndPushOptions,
  type ExecuteFn
} from '../../src/lib/github/repo-mutation.js';

const NUM_RUNS = 1000;

const neverExecute: ExecuteFn = async () => {
  throw new Error('execute must not be reached for rejected stage paths');
};

function commitOptions(stagePaths: string[]): CommitAndPushOptions {
  return {
    repoWriteMode: 'commit-only',
    currentRef: 'refs/heads/main',
    githubHeadRef: '',
    githubRefName: 'main',
    stagePaths,
    committerName: 'test',
    committerEmail: 'test@example.com'
  } as CommitAndPushOptions;
}

const service = new RepoMutationService({
  execute: neverExecute,
  repository: 'owner/repo'
});

const safeSegment = fc
  .stringMatching(/^[A-Za-z0-9._-]{1,12}$/)
  .filter((segment) => segment !== '..' && segment !== '.');

const relativePath = fc
  .array(safeSegment, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join('/'));

const controlChar = fc
  .integer({ min: 0, max: 31 })
  .map((code) => String.fromCharCode(code));

describe('normalizeStagePaths properties via commitAndPush (WS8)', () => {
  it('rejects every POSIX-absolute path', async () => {
    await fc.assert(
      fc.asyncProperty(relativePath, async (rest) => {
        await expect(
          service.commitAndPush(commitOptions([`/${rest}`]))
        ).rejects.toThrow(/Unsafe git stage path/);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('rejects every Windows-absolute path', async () => {
    const driveLetter = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
    await fc.assert(
      fc.asyncProperty(driveLetter, relativePath, async (drive, rest) => {
        for (const candidate of [`${drive}:\\${rest}`, `\\\\server\\${rest}`]) {
          await expect(
            service.commitAndPush(commitOptions([candidate]))
          ).rejects.toThrow(/Unsafe git stage path/);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('rejects every path containing a .. segment', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(safeSegment, { minLength: 0, maxLength: 3 }),
        fc.array(safeSegment, { minLength: 0, maxLength: 3 }),
        async (before, after) => {
          const candidate = [...before, '..', ...after].join('/');
          await expect(
            service.commitAndPush(commitOptions([candidate]))
          ).rejects.toThrow(/Unsafe git stage path/);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('rejects every path bearing a control character', async () => {
    await fc.assert(
      fc.asyncProperty(relativePath, controlChar, fc.nat({ max: 10 }), async (base, ctl, at) => {
        const index = Math.min(at, base.length);
        const candidate = `${base.slice(0, index)}${ctl}${base.slice(index)}`;
        // A control char that trims away entirely (e.g. leading \t alone) still
        // leaves the raw-path check to fire; empty-after-trim entries are
        // skipped by contract, so keep a non-empty visible body.
        await expect(
          service.commitAndPush(commitOptions([candidate]))
        ).rejects.toThrow(/Unsafe git stage path/);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('rejects every :-prefixed path', async () => {
    await fc.assert(
      fc.asyncProperty(relativePath, async (rest) => {
        await expect(
          service.commitAndPush(commitOptions([`:${rest}`]))
        ).rejects.toThrow(/Unsafe git stage path/);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});

describe('resolveCurrentRef properties (WS8)', () => {
  const refFragment = fc.stringMatching(/^[A-Za-z0-9._/-]{1,24}$/);
  const branchName = fc.stringMatching(/^[A-Za-z0-9._-]{1,20}(\/[A-Za-z0-9._-]{1,20})?$/);

  const anyRef = fc.oneof(
    fc.constant(''),
    branchName,
    branchName.map((name) => `refs/heads/${name}`),
    refFragment.map((name) => `refs/tags/${name}`),
    fc.nat({ max: 9999 }).map((n) => `refs/pull/${n}/merge`),
    refFragment.map((name) => `refs/${name}`)
  );

  const contextArb = fc.record({
    repoWriteMode: fc.constantFrom('none', 'commit-only', 'commit-and-push'),
    currentRef: anyRef,
    githubHeadRef: anyRef,
    githubRefName: anyRef
  });

  it('never returns a refs/-prefixed value for any context', () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        const resolved = resolveCurrentRef(context as Parameters<typeof resolveCurrentRef>[0]);
        expect(resolved.startsWith('refs/')).toBe(false);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('never launders a tag ref into the resolved branch', () => {
    fc.assert(
      fc.property(refFragment, (tagName) => {
        const resolved = resolveCurrentRef({
          repoWriteMode: 'commit-and-push',
          currentRef: `refs/tags/${tagName}`,
          githubHeadRef: '',
          githubRefName: ''
        });
        expect(resolved).toBe('');
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('resolves PR merge refs from the head ref alone, never the pull ref', () => {
    fc.assert(
      fc.property(fc.nat({ max: 9999 }), branchName, (prNumber, headBranch) => {
        const resolved = resolveCurrentRef({
          repoWriteMode: 'commit-and-push',
          currentRef: `refs/pull/${prNumber}/merge`,
          githubHeadRef: headBranch,
          githubRefName: `${prNumber}/merge`
        });
        expect(resolved).toBe(headBranch);
        expect(resolved.includes('refs/pull')).toBe(false);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('returns empty for every non-push write mode', () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        fc.pre(context.repoWriteMode !== 'commit-and-push');
        expect(resolveCurrentRef(context as Parameters<typeof resolveCurrentRef>[0])).toBe('');
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
