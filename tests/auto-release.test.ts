/**
 * Automatic release-cut contract.
 *
 * Pins the invariants whose absence burned immutable release tags: a burnt
 * version number must be skipped rather than reused, and the tag must be
 * created only after the committed release bytes pass every gate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- release tooling is plain ESM, intentionally outside tsconfig source roots
import * as releaseCut from '../scripts/release-cut.mjs';

const parseConventionalBump = releaseCut.parseConventionalBump as (m: string[]) => string | null;
const applyBump = releaseCut.applyBump as (v: string, b: string) => string;
const selectNextVersion = releaseCut.selectNextVersion as (input: {
  current: string;
  bump: string;
  takenTags: string[];
}) => { version: string; skipped: string[] };
const latestReleaseTag = releaseCut.latestReleaseTag as (tags: string[]) => string | null;

const repoRoot = process.cwd();
const autoReleaseWorkflow = readFileSync(
  join(repoRoot, '.github/workflows/auto-release.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const releaseCutSource = readFileSync(join(repoRoot, 'scripts/release-cut.mjs'), 'utf8');
const prePushHook = readFileSync(join(repoRoot, '.githooks/pre-push'), 'utf8');

describe('release version selection', () => {
  it('skips a burnt version instead of reusing it', () => {
    const plan = selectNextVersion({
      current: '2.1.14',
      bump: 'patch',
      takenTags: ['v2.1.14', 'v2.1.15']
    });
    expect(plan.version).toBe('2.1.16');
    expect(plan.skipped).toContain('2.1.15');
  });

  it('never returns a version that is already tagged', () => {
    const taken = ['v2.0.0', 'v2.0.1', 'v2.0.2', 'v2.0.3'];
    const plan = selectNextVersion({ current: '2.0.0', bump: 'patch', takenTags: taken });
    expect(taken).not.toContain(`v${plan.version}`);
    expect(plan.version).toBe('2.0.4');
  });

  it('normalizes accepted zero-patch minor tags', () => {
    expect(latestReleaseTag(['v2.9.9', 'v3.0', 'v3'])).toBe('v3.0');
    expect(
      selectNextVersion({ current: '2.9.9', bump: 'major', takenTags: ['v3.0'] })
    ).toEqual({ version: '3.0.1', skipped: ['3.0.0'] });
  });

  it('maps conventional commits onto semver bumps', () => {
    expect(parseConventionalBump(['feat: add input'])).toBe('minor');
    expect(parseConventionalBump(['fix: correct reconcile'])).toBe('patch');
    expect(parseConventionalBump(['feat!: drop legacy input'])).toBe('major');
    expect(parseConventionalBump(['refactor: x\n\nBREAKING CHANGE: removed'])).toBe('major');
    expect(parseConventionalBump(['feat: a', 'fix: b'])).toBe('minor');
    expect(applyBump('2.1.15', 'minor')).toBe('2.2.0');
  });

  it('does not cut a release for release-plumbing commits alone', () => {
    expect(parseConventionalBump(['chore(release): v2.1.15'])).toBeNull();
    expect(parseConventionalBump(['chore: bump lockfile'])).toBeNull();
    expect(parseConventionalBump(['ci: retune gate queue', 'test: add case'])).toBeNull();
    expect(parseConventionalBump([])).toBeNull();
  });
});

describe('release-cut ordering contract', () => {
  it('creates the tag only after the committed release bytes are verified', () => {
    const tagIndex = releaseCutSource.indexOf("'tag', '-a'");
    const commitIndex = releaseCutSource.indexOf("'commit', '-m'");
    const verifyAfterCommit = releaseCutSource.indexOf('const releaseCommit');
    expect(tagIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeLessThan(verifyAfterCommit);
    expect(verifyAfterCommit).toBeLessThan(tagIndex);
    expect(releaseCutSource.indexOf('assertCommittedDistMatchesSource();')).toBeLessThan(tagIndex);
  });

  it('reads every sha in-process rather than through shell variables', () => {
    expect(releaseCutSource).not.toContain('PREPARE_SHA');
    expect(releaseCutSource).toContain("git(['rev-parse', 'HEAD'])");
  });

  it('rebuilds dist before committing and verifies committed dist before tagging', () => {
    expect(releaseCutSource).toContain("run('npm', ['run', 'bundle'])");
    expect(releaseCutSource).toContain("run('npm', ['run', 'verify:dist'])");
    const rebuild = releaseCutSource.indexOf('rebuildDist();');
    const commit = releaseCutSource.indexOf("'commit', '-m'");
    const assertDist = releaseCutSource.indexOf('assertCommittedDistMatchesSource();');
    const tag = releaseCutSource.indexOf("'tag', '-a'");
    expect(rebuild).toBeGreaterThan(-1);
    expect(rebuild).toBeLessThan(commit);
    expect(commit).toBeLessThan(assertDist);
    expect(assertDist).toBeLessThan(tag);
  });

  it('stages only release paths in the release commit', () => {
    expect(releaseCutSource).toContain("'package.json', 'package-lock.json', 'dist'");
    expect(releaseCutSource).not.toContain('validation/evidence');
  });
});

describe('auto-release workflow', () => {
  it('cuts from main pushes instead of hand-pushed tags', () => {
    expect(autoReleaseWorkflow).toContain('branches: [main]');
    expect(autoReleaseWorkflow).not.toMatch(/on:\n\s+push:\n\s+tags:/);
  });

  it('rejects manually dispatched cuts outside main', () => {
    expect(autoReleaseWorkflow).toContain("if: github.ref == 'refs/heads/main'");
  });

  it('fetches full history and tags so burnt versions are visible', () => {
    expect(autoReleaseWorkflow).toContain('token: ${{ secrets.RELEASE_WORKFLOW_TOKEN }}');
    expect(autoReleaseWorkflow).toContain('fetch-depth: 0');
    expect(autoReleaseWorkflow).toContain('fetch-tags: true');
  });

  it('plans before it cuts and cuts before it pushes', () => {
    const plan = autoReleaseWorkflow.indexOf('name: Plan release');
    const cut = autoReleaseWorkflow.indexOf('name: Cut release');
    const push = autoReleaseWorkflow.indexOf('name: Push release tag');
    expect(plan).toBeGreaterThan(-1);
    expect(plan).toBeLessThan(cut);
    expect(cut).toBeLessThan(push);
  });

  it('pushes only the tag, never a commit onto protected main', () => {
    expect(autoReleaseWorkflow).toContain('git push origin "refs/tags/v${VERSION}"');
    expect(autoReleaseWorkflow).not.toContain('HEAD:${GITHUB_REF_NAME}');
    expect(autoReleaseWorkflow).not.toContain('gh pr create');
  });

  it('starts or recovers release.yml after the tag push', () => {
    const push = autoReleaseWorkflow.indexOf('name: Push release tag');
    const dispatch = autoReleaseWorkflow.indexOf('name: Start or recover release workflow');
    expect(dispatch).toBeGreaterThan(push);
    expect(autoReleaseWorkflow).toContain('require(process.env.PLAN_FILE).previous');
    expect(autoReleaseWorkflow).toContain('gh release view "$TAG"');
    expect(autoReleaseWorkflow).toContain('gh workflow run release.yml --ref "$TAG"');
  });

  it('reconciles the prior incomplete tag before planning another cut', () => {
    const reconcile = autoReleaseWorkflow.indexOf('name: Reconcile prior release');
    const plan = autoReleaseWorkflow.indexOf('name: Plan release');
    expect(reconcile).toBeGreaterThan(-1);
    expect(reconcile).toBeLessThan(plan);
    expect(autoReleaseWorkflow).toContain("git tag --list 'v*'");
    expect(autoReleaseWorkflow).toContain('if ! PACKAGE_VERSION="$(git show');
    expect(autoReleaseWorkflow).toContain('gh run list --workflow release.yml --branch "$TAG"');
    expect(autoReleaseWorkflow).toContain("steps.reconcile.outputs.blocked != 'true'");
    const activeRun = autoReleaseWorkflow.indexOf('gh run list --workflow release.yml');
    expect(autoReleaseWorkflow.indexOf('gh workflow run release.yml', activeRun)).toBeGreaterThan(
      activeRun
    );
  });

  it('recovers alias failures and resumes after a successful release', () => {
    expect(autoReleaseWorkflow).toContain('workflow_run:');
    expect(autoReleaseWorkflow).toContain('workflows: [Release]');
    expect(autoReleaseWorkflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(autoReleaseWorkflow).toContain('git rev-parse --verify "${ALIAS}^{commit}"');
    expect(autoReleaseWorkflow).toContain(
      'CURRENT_VERSION="$(git show "${ALIAS}^{commit}:package.json"'
    );
    expect(autoReleaseWorkflow).toContain('"$LATEST_VERSION" "$CURRENT_VERSION"');
    expect(autoReleaseWorkflow).toContain('git tag -fa "$ALIAS"');
    expect(autoReleaseWorkflow).toContain('git push origin "$ALIAS" --force');
  });

  it('never cancels a cut in flight', () => {
    expect(autoReleaseWorkflow).toContain('cancel-in-progress: false');
  });

  it('writes its plan outside the worktree so the cut sees a clean tree', () => {
    expect(autoReleaseWorkflow).not.toMatch(/tee plan\.json/);
    expect(autoReleaseWorkflow).toContain('PLAN_FILE: ${{ runner.temp }}/plan.json');
  });
});

describe('pre-push tag guard', () => {
  it('rejects hand-pushed immutable release tags', () => {
    expect(prePushHook).toContain('refs/tags/v[0-9]*.[0-9]*');
    expect(prePushHook).toContain('GITHUB_ACTIONS');
    expect(prePushHook).toContain('refusing to push immutable release tag');
  });

  it('exempts the rolling major alias from the immutable-tag guard', () => {
    // v2 matches v[0-9]* but not v[0-9]*.[0-9]* — only dotted semver tags are blocked.
    expect(prePushHook).toMatch(/refs\/tags\/v\[0-9\]\*\.\[0-9\]\*/);
  });

  it('preserves the existing dist staleness check', () => {
    expect(prePushHook).toContain('npm run verify:dist');
    expect(prePushHook).toContain('dist is stale');
  });
});
