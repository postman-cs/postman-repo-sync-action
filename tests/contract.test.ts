import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  createExecutionPlan,
  postmanRepoSyncActionContract
} from '../src/contracts.js';

const repoRoot = resolve(import.meta.dirname, '..');

describe('postman-repo-sync-action contract', () => {
  it('keeps the open-alpha surface in kebab-case with bifrost as the default backend', () => {
    expect(postmanRepoSyncActionContract.defaults.integrationBackend).toBe('bifrost');

    expect(Object.keys(postmanRepoSyncActionContract.inputs)).toEqual([
      'generate-ci-workflow',
      'ci-workflow-path',
      'project-name',
      'collection-sync-mode',
      'spec-sync-mode',
      'release-label',
      'set-as-current',
      'workspace-id',
      'baseline-collection-id',
      'monitor-type',
      'smoke-collection-id',
      'contract-collection-id',
      'monitor-id',
      'mock-url',
      'monitor-cron',
      'environments-json',
      'repo-url',
      'integration-backend',
      'workspace-link-enabled',
      'environment-sync-enabled',
      'system-env-map-json',
      'environment-uids-json',
      'env-runtime-urls-json',
      'artifact-dir',
      'repo-write-mode',
      'current-ref',
      'committer-name',
      'committer-email',
      'postman-api-key',
      'postman-access-token',
      'github-token',
      'gh-fallback-token',
      'github-auth-mode',
      'org-mode',
      'ci-workflow-base64'
    ]);

    expect(Object.keys(postmanRepoSyncActionContract.outputs)).toEqual([
      'integration-backend',
      'resolved-current-ref',
      'workspace-link-status',
      'environment-sync-status',
      'environment-uids-json',
      'mock-url',
      'monitor-id',
      'repo-sync-summary-json',
      'commit-sha'
    ]);
  });

  it('documents retained and removed finalize behavior plus current-ref push semantics', () => {
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');

    expect(readme).toContain('push them back to the current checked out ref');

    for (const retainedBehavior of postmanRepoSyncActionContract.behavior.retainedFromFinalize) {
      expect(readme).toContain(retainedBehavior);
    }

    for (const removedBehavior of postmanRepoSyncActionContract.behavior.removedFromFinalize) {
      expect(readme).toContain(removedBehavior);
    }
  });

  it('keeps action metadata aligned with the contract surface', () => {
    const actionYaml = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { default?: string }>;
      outputs: Record<string, unknown>;
      runs: { using: string; main: string };
    };

    expect(actionYaml.runs).toEqual({
      using: 'node20',
      main: 'dist/index.cjs'
    });

    expect(Object.keys(actionYaml.inputs)).toEqual(
      Object.keys(postmanRepoSyncActionContract.inputs)
    );
    expect(Object.keys(actionYaml.outputs)).toEqual(
      Object.keys(postmanRepoSyncActionContract.outputs)
    );

    expect(actionYaml.inputs['integration-backend']?.default).toBe('bifrost');
    expect(actionYaml.inputs['collection-sync-mode']?.default).toBe('reuse');
    expect(actionYaml.inputs['spec-sync-mode']?.default).toBe('update');
    expect(actionYaml.inputs['set-as-current']?.default).toBe('true');
    expect(actionYaml.inputs['workspace-link-enabled']?.default).toBe('true');
    expect(actionYaml.inputs['environment-sync-enabled']?.default).toBe('true');
    expect(actionYaml.inputs['artifact-dir']?.default).toBe('postman');
    expect(actionYaml.inputs['repo-write-mode']?.default).toBe('commit-and-push');
  });

  it('resolves push targets from current-ref semantics instead of hardcoding main', () => {
    expect(
      createExecutionPlan({
        repoWriteMode: 'commit-and-push',
        githubHeadRef: 'beta/sync-docs',
        githubRefName: 'main'
      })
    ).toMatchObject({
      integrationBackend: 'bifrost',
      resolvedCurrentRef: 'beta/sync-docs',
      workspaceLinkStatus: 'planned',
      environmentSyncStatus: 'planned'
    });

    expect(
      createExecutionPlan({
        repoWriteMode: 'commit-and-push',
        currentRef: 'release/public-open-alpha',
        githubHeadRef: 'ignored/head',
        githubRefName: 'ignored/ref'
      }).resolvedCurrentRef
    ).toBe('release/public-open-alpha');

    expect(
      createExecutionPlan({
        repoWriteMode: 'none',
        githubRefName: 'feature/no-push'
      }).resolvedCurrentRef
    ).toBe('');
  });
});
