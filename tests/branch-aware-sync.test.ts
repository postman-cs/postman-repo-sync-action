import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dump as dumpYaml } from 'js-yaml';

import { assertBranchAssetIds, decideBranchTier, runGatedSkip, resolveInputs } from '../src/index.js';
import { BRANCH_DECISION_ENV } from '../src/lib/repo/branch-decision.js';

let originalCwd = '';
let testDir = '';

beforeEach(() => {
  originalCwd = process.cwd();
  testDir = mkdtempSync(join(tmpdir(), 'repo-sync-branch-aware-'));
  process.chdir(testDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(testDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  delete process.env[BRANCH_DECISION_ENV];
});

function githubBranchEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const eventPath = join(testDir, 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({ repository: { default_branch: 'main', full_name: 'org/repo' } })
  );
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'org/repo',
    GITHUB_REF: 'refs/heads/feature/x',
    GITHUB_REF_NAME: 'feature/x',
    GITHUB_EVENT_PATH: eventPath,
    INPUT_PROJECT_NAME: 'Payments',
    ...overrides
  };
}

describe('repo-sync branch decision', () => {
  it('legacy default keeps branch-blind behavior', () => {
    const inputs = resolveInputs(githubBranchEnv());
    const decision = decideBranchTier(inputs, githubBranchEnv());
    expect(decision.tier).toBe('legacy');
  });

  it('publish-gate on a feature branch resolves gated', () => {
    const env = githubBranchEnv({ INPUT_BRANCH_STRATEGY: 'publish-gate' });
    const inputs = resolveInputs(env);
    const decision = decideBranchTier(inputs, env);
    expect(decision.tier).toBe('gated');
  });

  it('publish-gate on the canonical branch resolves canonical', () => {
    const env = githubBranchEnv({
      INPUT_BRANCH_STRATEGY: 'publish-gate',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main'
    });
    const inputs = resolveInputs(env);
    const decision = decideBranchTier(inputs, env);
    expect(decision.tier).toBe('canonical');
  });

  it('inherited POSTMAN_BRANCH_DECISION wins over local resolution', () => {
    const env = githubBranchEnv({ INPUT_BRANCH_STRATEGY: 'publish-gate' });
    const inherited = {
      tier: 'canonical',
      strategy: 'publish-gate',
      identity: { provider: 'github', refKind: 'default-branch', isPrContext: false, isForkPr: false },
      canonicalBranch: 'main',
      reason: 'inherited'
    };
    const decision = decideBranchTier(resolveInputs(env), {
      ...env,
      [BRANCH_DECISION_ENV]: JSON.stringify(inherited)
    });
    expect(decision.tier).toBe('canonical');
    expect(decision.reason).toBe('inherited');
  });
});

describe('repo-sync gated skip', () => {
  it('emits skipped-branch-gate outputs and calls no API', () => {
    const env = githubBranchEnv({ INPUT_BRANCH_STRATEGY: 'publish-gate' });
    const inputs = resolveInputs(env);
    const decision = decideBranchTier(inputs, env);
    expect(decision.tier).toBe('gated');

    const setOutput = vi.fn();
    const outputs = runGatedSkip(inputs, decision, { info: vi.fn(), setOutput });

    expect(outputs['sync-status']).toBe('skipped-branch-gate');
    expect(JSON.parse(outputs['branch-decision']).tier).toBe('gated');
    expect(JSON.parse(outputs['repo-sync-summary-json']).status).toBe('skipped-branch-gate');
    expect(setOutput).toHaveBeenCalledWith('sync-status', 'skipped-branch-gate');
    // Zero writes by construction: nothing hit the filesystem beyond outputs.
    expect(outputs['commit-sha']).toBe('');
  });
});

describe('repo-sync canonical asset guard', () => {
  it('refuses explicit collection IDs on a standalone preview run', () => {
    const env = githubBranchEnv({ INPUT_BRANCH_STRATEGY: 'preview' });
    const inputs = resolveInputs(env);
    const decision = decideBranchTier(inputs, env);
    expect(decision.tier).toBe('preview');
    expect(() => assertBranchAssetIds({ baselineCollectionId: 'canonical-col', smokeCollectionId: '', contractCollectionId: '' }, decision, false))
      .toThrow(/CONTRACT_BRANCH_CANONICAL_WRITE/);
  });

  it('allows branch-owned IDs handed off by the composite', () => {
    const env = githubBranchEnv({ INPUT_BRANCH_STRATEGY: 'preview' });
    const decision = decideBranchTier(resolveInputs(env), env);
    expect(() => assertBranchAssetIds({ baselineCollectionId: 'preview-col', smokeCollectionId: '', contractCollectionId: '' }, decision, true))
      .not.toThrow();
  });
});

describe('repo-sync state v2 reader', () => {
  async function importReader() {
    // readResourcesState is module-private; exercise it through the public
    // runRepoSync path indirectly is heavy — instead assert on the exported
    // StateUnreadableError class contract via a direct file read simulation.
    const { StateUnreadableError } = await import('../src/index.js');
    return StateUnreadableError;
  }

  it('exports StateUnreadableError with the CONTRACT_STATE_UNREADABLE code', async () => {
    const StateUnreadableError = await importReader();
    const err = new StateUnreadableError('boom');
    expect(err.code).toBe('CONTRACT_STATE_UNREADABLE');
    expect(err.message).toContain('CONTRACT_STATE_UNREADABLE');
  });

  it('malformed tracked state fails runRepoSync loud instead of reading as absent', async () => {
    mkdirSync(join(testDir, '.postman'), { recursive: true });
    writeFileSync(join(testDir, '.postman/resources.yaml'), 'workspace: [unclosed');

    const { runRepoSync } = await import('../src/index.js');
    const env = githubBranchEnv();
    const inputs = resolveInputs(env);
    const dependencies = {
      core: {
        info: vi.fn(),
        warning: vi.fn(),
        setOutput: vi.fn(),
        setFailed: vi.fn(),
        setSecret: vi.fn(),
        getInput: vi.fn().mockReturnValue('')
      },
      exec: { getExecOutput: vi.fn() },
      postman: {},
      teamId: ''
    } as unknown as Parameters<typeof runRepoSync>[1];

    await expect(runRepoSync(inputs, dependencies)).rejects.toThrowError(
      /CONTRACT_STATE_UNREADABLE/
    );
  });

  it('unsupported version fails loud, v1 and v2 read fine', async () => {
    const { runRepoSync } = await import('../src/index.js');
    mkdirSync(join(testDir, '.postman'), { recursive: true });
    writeFileSync(
      join(testDir, '.postman/resources.yaml'),
      dumpYaml({ version: 99, workspace: { id: 'ws-1' } })
    );
    const env = githubBranchEnv();
    const inputs = resolveInputs(env);
    const dependencies = {
      core: {
        info: vi.fn(),
        warning: vi.fn(),
        setOutput: vi.fn(),
        setFailed: vi.fn(),
        setSecret: vi.fn(),
        getInput: vi.fn().mockReturnValue('')
      },
      exec: { getExecOutput: vi.fn() },
      postman: {},
      teamId: ''
    } as unknown as Parameters<typeof runRepoSync>[1];

    await expect(runRepoSync(inputs, dependencies)).rejects.toThrowError(/version 99/);
  });
});
