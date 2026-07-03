import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  createExecutionPlan,
  postmanRepoSyncActionContract
} from '../src/contracts.js';
import { resolveInputs } from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '..');
const packageManifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8')
) as {
  main: string;
  scripts: { build: string };
};

describe('postman-repo-sync-action contract', () => {
  it('keeps the action surface in kebab-case with bifrost as the default backend', () => {
    expect(postmanRepoSyncActionContract.defaults.integrationBackend).toBe('bifrost');

    expect(Object.keys(postmanRepoSyncActionContract.inputs)).toEqual([
      'generate-ci-workflow',
      'ci-workflow-path',
      'project-name',
      'workspace-id',
      'baseline-collection-id',
      'monitor-type',
      'smoke-collection-id',
      'contract-collection-id',
      'collection-sync-mode',
      'spec-sync-mode',
      'release-label',
      'monitor-id',
      'mock-url',
      'monitor-cron',
      'environments-json',
      'git-provider',
      'ado-token',
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
      'team-id',
      'credential-preflight',
      'github-token',
      'gh-fallback-token',
      'org-mode',
      'ci-workflow-base64',
      'ssl-client-cert',
      'ssl-client-key',
      'ssl-client-passphrase',
      'ssl-extra-ca-certs',
      'spec-id',
      'spec-path',
      'postman-region',
      'postman-stack'
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

  it('exposes credential-preflight as an optional kebab-case input defaulting to warn', () => {
    expect('credential-preflight').toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

    const definition = postmanRepoSyncActionContract.inputs['credential-preflight'];
    expect(definition).toBeDefined();
    expect(definition.required).toBe(false);
    expect(definition.default).toBe('warn');
    expect(definition.allowedValues).toEqual(['enforce', 'warn']);

    const actionYaml = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { required?: boolean; default?: string }>;
    };
    expect(actionYaml.inputs['credential-preflight']?.required).toBe(false);
    expect(actionYaml.inputs['credential-preflight']?.default).toBe('warn');

    expect(resolveInputs({ INPUT_PROJECT_NAME: 'core-payments' }).credentialPreflight).toBe(
      'warn'
    );
    expect(
      resolveInputs({
        INPUT_PROJECT_NAME: 'core-payments',
        INPUT_CREDENTIAL_PREFLIGHT: 'enforce'
      }).credentialPreflight
    ).toBe('enforce');
    expect(() =>
      resolveInputs({
        INPUT_PROJECT_NAME: 'core-payments',
        INPUT_CREDENTIAL_PREFLIGHT: 'off'
      })
    ).toThrow(/Unsupported credential-preflight/);
    expect(() =>
      resolveInputs({
        INPUT_PROJECT_NAME: 'core-payments',
        INPUT_CREDENTIAL_PREFLIGHT: 'sometimes'
      })
    ).toThrow(/Unsupported credential-preflight/);
  });

  it('resolves Azure DevOps provider defaults from pipeline environment', () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'core-payments',
      BUILD_REPOSITORY_URI: 'git@ssh.dev.azure.com:v3/postman/CSE/repo-sync-demo',
      BUILD_REPOSITORY_NAME: 'repo-sync-demo',
      BUILD_SOURCEBRANCH: 'refs/heads/feature/ado-sync',
      BUILD_SOURCEBRANCHNAME: 'ado-sync',
      BUILD_SOURCEVERSION: 'abc123',
      SYSTEM_ACCESSTOKEN: 'system-access-token'
    });

    expect(inputs.provider).toBe('azure-devops');
    expect(inputs.repoUrl).toBe('https://dev.azure.com/postman/CSE/_git/repo-sync-demo');
    expect(inputs.repository).toBe('repo-sync-demo');
    expect(inputs.currentRef).toBe('refs/heads/feature/ado-sync');
    expect(inputs.githubRefName).toBe('ado-sync');
    expect(inputs.adoToken).toBe('system-access-token');
    expect(inputs.ciWorkflowPath).toBe('azure-pipelines.yml');
  });

  it('documents current behavior and current-ref push semantics', () => {
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');

    expect(readme).toContain('Commit generated files and push them back to the current checked out ref.');
    expect(readme).toContain('multi-file YAML exports under `postman/collections/`');
    expect(readme).toContain('`.postman/resources.yaml` with local-to-cloud resource mappings.');
    expect(readme).toContain('For existing repositories that already own their CI workflow, disable workflow generation');
    expect(readme).toContain('Use this for customer-managed PR workflows.');
  });

  it('keeps action metadata aligned with the contract surface', () => {
    const actionYaml = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { default?: string }>;
      outputs: Record<string, unknown>;
      runs: { using: string; main: string };
    };

    expect(actionYaml.runs).toEqual({
      using: 'node24',
      main: 'dist/action.cjs'
    });
    expect(packageManifest.main).toBe('dist/index.cjs');
    expect(packageManifest.scripts.build).toContain('src/index.ts --bundle');
    expect(packageManifest.scripts.build).toContain('--outfile=dist/index.cjs');
    expect(packageManifest.scripts.build).toContain('src/main.ts --bundle');
    expect(packageManifest.scripts.build).toContain('--outfile=dist/action.cjs');

    expect(Object.keys(actionYaml.inputs)).toEqual(
      Object.keys(postmanRepoSyncActionContract.inputs)
    );
    expect(Object.keys(actionYaml.outputs)).toEqual(
      Object.keys(postmanRepoSyncActionContract.outputs)
    );

    expect(actionYaml.inputs['integration-backend']?.default).toBeUndefined();
    expect(actionYaml.inputs['workspace-link-enabled']?.default).toBe('true');
    expect(actionYaml.inputs['environment-sync-enabled']?.default).toBe('true');
    expect(actionYaml.inputs['artifact-dir']?.default).toBe('postman');
    expect(actionYaml.inputs['repo-write-mode']?.default).toBe('commit-and-push');
    expect(actionYaml.inputs['postman-region']?.default).toBe('us');
    expect(actionYaml.inputs['postman-stack']?.default).toBe('prod');
    expect(actionYaml.inputs['team-id']?.default).toBe('');
    expect(postmanRepoSyncActionContract.inputs['postman-region'].allowedValues).toEqual(['us', 'eu']);
    expect(postmanRepoSyncActionContract.inputs['postman-stack'].allowedValues).toEqual(['prod', 'beta']);
  });

  it('documents marketplace-ready credential and support surfaces', () => {
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    const credentials = readFileSync(resolve(repoRoot, 'docs/credentials.md'), 'utf8');
    const artifactLayout = readFileSync(resolve(repoRoot, 'docs/artifact-layout.md'), 'utf8');
    const cli = readFileSync(resolve(repoRoot, 'docs/cli.md'), 'utf8');
    const publicDocs = [readme, credentials, artifactLayout, cli].join('\n');

    expect(readme).toContain('postman-region: us');
    expect(readme).toContain('Postman API Onboarding suite');
    expect(readme).toContain('[Security](SECURITY.md)');
    expect(readme).toContain('[Support](SUPPORT.md)');
    expect(readme).toContain('[Release policy](RELEASE_POLICY.md)');
    expect(readme).not.toMatch(/preview/i);
    expect(publicDocs).not.toMatch(/\binternal\b/i);

    expect(credentials).toContain('postman-cs/postman-resolve-service-token-action@v1');
    expect(credentials).toContain('Legacy fallback');
    expect(credentials).toContain('non-service-account access token');
    expect(credentials).not.toContain('`off` skips');
    expect(credentials).not.toContain('browser');

    expect(artifactLayout).toContain('The generated files are intended to be committed');
    expect(cli).toContain('--postman-region us');

    expect(existsSync(resolve(repoRoot, 'SECURITY.md'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'SUPPORT.md'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'RELEASE_POLICY.md'))).toBe(true);
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
        currentRef: 'release/customer-onboarding',
        githubHeadRef: 'ignored/head',
        githubRefName: 'ignored/ref'
      }).resolvedCurrentRef
    ).toBe('release/customer-onboarding');

    expect(
      createExecutionPlan({
        repoWriteMode: 'none',
        githubRefName: 'feature/no-push'
      }).resolvedCurrentRef
    ).toBe('');
  });
});
