import * as core from '@actions/core';
import { fileURLToPath } from 'node:url';

import {
  createExecutionPlan,
  postmanRepoSyncActionContract
} from './contracts.js';

function parseBooleanInput(value: string, defaultValue: boolean): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();

  if (!normalized) {
    return defaultValue;
  }

  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export async function run(): Promise<void> {
  const plan = createExecutionPlan({
    integrationBackend: core.getInput('integration-backend'),
    workspaceLinkEnabled: parseBooleanInput(
      core.getInput('workspace-link-enabled'),
      postmanRepoSyncActionContract.defaults.workspaceLinkEnabled
    ),
    environmentSyncEnabled: parseBooleanInput(
      core.getInput('environment-sync-enabled'),
      postmanRepoSyncActionContract.defaults.environmentSyncEnabled
    ),
    repoWriteMode:
      core.getInput('repo-write-mode') ||
      postmanRepoSyncActionContract.defaults.repoWriteMode,
    currentRef: core.getInput('current-ref'),
    githubHeadRef: process.env.GITHUB_HEAD_REF,
    githubRefName: process.env.GITHUB_REF_NAME
  });

  core.info(`${postmanRepoSyncActionContract.name}: Phase 1 contract scaffold`);
  core.info(`Integration backend: ${plan.integrationBackend}`);
  core.info(`Workspace link status: ${plan.workspaceLinkStatus}`);
  core.info(`Environment sync status: ${plan.environmentSyncStatus}`);
  core.info(`Repo write mode: ${plan.repoWriteMode}`);

  if (
    plan.repoWriteMode === 'commit-and-push' &&
    !plan.resolvedCurrentRef
  ) {
    core.warning(
      'push-changes=true but no current ref was resolved from current-ref, GITHUB_HEAD_REF, or GITHUB_REF_NAME'
    );
  }

  core.setOutput('integration-backend', plan.integrationBackend);
  core.setOutput('resolved-current-ref', plan.resolvedCurrentRef);
  core.setOutput('workspace-link-status', plan.workspaceLinkStatus);
  core.setOutput('environment-sync-status', plan.environmentSyncStatus);
  core.setOutput('environment-uids-json', plan.outputs['environment-uids-json']);
  core.setOutput('mock-url', plan.outputs['mock-url']);
  core.setOutput('monitor-id', plan.outputs['monitor-id']);
  core.setOutput('repo-sync-summary-json', plan.outputs['repo-sync-summary-json']);
  core.setOutput('commit-sha', plan.outputs['commit-sha']);
}

const entrypoint = process.argv[1];
const currentModulePath = fileURLToPath(import.meta.url);

if (entrypoint && currentModulePath === entrypoint) {
  run().catch((error: unknown) => {
    if (error instanceof Error) {
      core.setFailed(error.message);
      return;
    }

    core.setFailed(String(error));
  });
}
