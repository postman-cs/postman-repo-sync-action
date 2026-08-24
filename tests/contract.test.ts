import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  createExecutionPlan,
  postmanRepoSyncActionContract,
  type PrebuiltCollectionEntry,
  type PrebuiltCollectionRole,
  type PrebuiltCollectionsManifest
} from '../src/contracts.js';
import { resolveInputs } from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '..');
const packageManifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8')
) as {
  main: string;
  scripts: {
    build: string;
    bundle?: string;
    'verify:dist'?: string;
    'verify:dist:shape'?: string;
    'verify:dist:parity'?: string;
    'verify:dist:assert'?: string;
  };
};

describe('postman-repo-sync-action contract', () => {
  it('keeps the action surface in kebab-case with bifrost as the default backend', () => {
    expect(postmanRepoSyncActionContract.defaults.integrationBackend).toBe('bifrost');

    expect(Object.keys(postmanRepoSyncActionContract.inputs)).toEqual([
      'generate-ci-workflow',
      'ci-workflow-path',
      'ci-runner-os',
      'project-name',
      'workspace-id',
      'baseline-collection-id',
      'monitor-type',
      'smoke-collection-id',
      'contract-collection-id',
      'onboarding-scope',
      'prebuilt-collections-json',
      'collection-sync-mode',
      'spec-sync-mode',
      'release-label',
      'monitor-id',
      'mock-url',
      'mock-visibility',
      'mock-environment-enabled',
      'monitor-cron',
      'environments-json',
      'durable-environments-json',
      'durable-environment-policy',
      'durable-environment-operation',
      'durable-environment-uids-json',
      'durable-project-key',
      'durable-state-ref',
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
      'secrets-resolver',
      'credential-preflight',
      'branch-strategy',
      'canonical-branch',
      'channels',
      'preview-ttl',
      'github-token',
      'gh-fallback-token',
      'org-mode',
      'ci-workflow-base64',
      'ssl-client-cert',
      'ssl-client-key',
      'ssl-client-passphrase',
        'ssl-extra-ca-certs',
        'spec-id',
        'spec-content-changed',
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
      'durable-environment-result-json',
      'durable-environment-definition-digest',
      'durable-environment-uids-json',
      'mock-url',
      'mock-visibility',
      'mock-auth-required',
      'mock-environment-uid',
      'mock-environment-status',
      'monitor-id',
      'repo-sync-summary-json',
      'commit-sha',
      'sync-status',
      'branch-decision',
      'spec-version-tag',
      'spec-version-url'
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

  it('declares the opt-in durable environment contract without changing legacy defaults', () => {
    const expected = {
      'durable-environments-json': { default: '[]', allowedValues: undefined },
      'durable-environment-policy': {
        default: 'create-only',
        allowedValues: ['create-only', 'refresh']
      },
      'durable-environment-operation': {
        default: 'off',
        allowedValues: ['off', 'plan', 'apply']
      },
      'durable-environment-uids-json': { default: '{}', allowedValues: undefined },
      'durable-project-key': { default: '', allowedValues: undefined },
      'durable-state-ref': { default: '', allowedValues: undefined }
    } as const;

    const actionYaml = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { required?: boolean; default?: string; description?: string }>;
    };

    for (const [name, definition] of Object.entries(expected)) {
      const contractInput = postmanRepoSyncActionContract.inputs[name];
      expect(contractInput.required).toBe(false);
      expect(contractInput.default).toBe(definition.default);
      expect(contractInput.allowedValues).toEqual(definition.allowedValues);
      expect(actionYaml.inputs[name]).toMatchObject({
        required: false,
        default: definition.default
      });
    }

    expect(postmanRepoSyncActionContract.inputs['environments-json'].default).toBe('["prod"]');
    expect(actionYaml.inputs['environments-json']?.default).toBe('["prod"]');
    expect(postmanRepoSyncActionContract.inputs['environments-json'].description).toContain(
      'slug strings'
    );
    expect(postmanRepoSyncActionContract.inputs['environments-json'].description)
      .not.toContain('rich definitions');
    expect(actionYaml.inputs['environments-json']?.description).toBe(
      postmanRepoSyncActionContract.inputs['environments-json'].description
    );
    expect(postmanRepoSyncActionContract.inputs['durable-state-ref'].description).toContain(
      'resolved canonical-branch value'
    );
  });

  it('does not parse dormant durable inputs until plan or apply is selected', () => {
    expect(() => resolveInputs({
      INPUT_PROJECT_NAME: 'core-payments',
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'off',
      INPUT_DURABLE_ENVIRONMENTS_JSON: 'not-json',
      INPUT_DURABLE_ENVIRONMENT_POLICY: 'not-a-policy',
      INPUT_DURABLE_ENVIRONMENT_UIDS_JSON: 'not-json'
    })).not.toThrow();
    expect(() => resolveInputs({
      INPUT_PROJECT_NAME: 'core-payments',
      INPUT_DURABLE_ENVIRONMENT_OPERATION: 'plan',
      INPUT_DURABLE_ENVIRONMENTS_JSON: 'not-json'
    })).toThrow(/durable-environments-json must contain valid JSON/);
  });

  it('defaults mock visibility to private while preserving an explicit public opt-out', () => {
    const definition = postmanRepoSyncActionContract.inputs['mock-visibility'];
    expect(definition.default).toBe('private');
    expect(definition.allowedValues).toEqual(['public', 'private']);

    const actionYaml = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { default?: string }>;
    };
    expect(actionYaml.inputs['mock-visibility']?.default).toBe('private');
    expect(resolveInputs({ INPUT_PROJECT_NAME: 'core-payments' }).mockVisibility).toBe('private');
    expect(
      resolveInputs({
        INPUT_PROJECT_NAME: 'core-payments',
        INPUT_MOCK_VISIBILITY: 'public'
      }).mockVisibility
    ).toBe('public');
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
    expect(inputs.ciRunnerOs).toBe('linux');
  });

  it('accepts an explicit Windows CI runner without changing the Linux default', () => {
    expect(resolveInputs({ INPUT_PROJECT_NAME: 'core-payments' }).ciRunnerOs).toBe('linux');
    expect(
      resolveInputs({
        INPUT_PROJECT_NAME: 'core-payments',
        INPUT_CI_RUNNER_OS: 'windows'
      }).ciRunnerOs
    ).toBe('windows');
    expect(() =>
      resolveInputs({
        INPUT_PROJECT_NAME: 'core-payments',
        INPUT_CI_RUNNER_OS: 'solaris'
      })
    ).toThrow(/ci-runner-os/);
  });

  it('documents current behavior and current-ref push semantics', () => {
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');

    expect(readme).toContain('Commit generated files and push them back to the current checked out ref.');
    expect(readme).toContain('multi-file YAML exports under `postman/collections/`');
    expect(readme).toContain('`.postman/resources.yaml` with local-to-cloud resource mappings.');
    expect(readme).toContain('For existing repositories that already own their CI workflow, disable workflow generation');
    expect(readme).toContain('Use this for customer-managed PR workflows.');
  });

  it('documents the canonical Collection v3 artifact and state-v3 layouts', () => {
    const artifactLayout = readFileSync(resolve(repoRoot, 'docs/artifact-layout.md'), 'utf8');

    expect(artifactLayout).toContain('`.resources/definition.yaml`');
    expect(artifactLayout).toContain('`$kind:`');
    expect(artifactLayout).toContain('legacy `collection.yaml`');
    expect(artifactLayout).toContain('version: 3');
    expect(artifactLayout).toContain('`canonical.collections`');
    expect(artifactLayout).toContain('`canonical.environments`');
    expect(artifactLayout).toContain('`canonical.specs`');
    expect(artifactLayout).not.toContain('localResources');
    expect(artifactLayout).not.toContain('cloudResources');
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
    expect(packageManifest.scripts.bundle).toContain('src/index.ts --bundle');
    expect(packageManifest.scripts.bundle).toContain('--outfile=dist/index.cjs');
    expect(packageManifest.scripts.bundle).toContain('src/main.ts --bundle');
    expect(packageManifest.scripts.bundle).toContain('--outfile=dist/action.cjs');
    expect(packageManifest.scripts.bundle).toContain('--banner:js="#!/usr/bin/env node"');
    expect(packageManifest.scripts.bundle).toContain("process.platform!=='win32'");
    expect(packageManifest.scripts.bundle).toContain("chmodSync('dist/cli.cjs',0o755)");
    expect(packageManifest.scripts.build).toBe('npm run typecheck && npm run bundle');
    expect(packageManifest.scripts['verify:dist:shape']).toBe('node scripts/verify-dist-artifact.mjs');
    expect(packageManifest.scripts['verify:dist:parity']).toBe(
      'git diff --ignore-space-at-eol --text --exit-code -- dist'
    );
    expect(packageManifest.scripts['verify:dist:assert']).toBe(
      'npm run verify:dist:shape && npm run verify:dist:parity'
    );
    expect(packageManifest.scripts['verify:dist']).toBe('npm run build && npm run verify:dist:assert');

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
    // "preview" is a shipped branch-strategy mode (branch-aware sync); only
    // pre-release phrasing stays banned from marketplace docs.
    expect(readme).not.toMatch(/preview feature|public preview|private preview|in preview/i);
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

    expect(
      createExecutionPlan({
        repoWriteMode: 'commit-and-push',
        currentRef: 'refs/tags/v1.2.3',
        githubRefName: 'v1.2.3'
      }).resolvedCurrentRef
    ).toBe('');

    expect(
      createExecutionPlan({
        repoWriteMode: 'commit-and-push',
        currentRef: 'refs/heads/refs/tags/v1.2.3'
      }).resolvedCurrentRef
    ).toBe('');

    expect(
      createExecutionPlan({
        repoWriteMode: 'commit-and-push',
        currentRef: 'refs/heads/refs/pull/42/merge'
      }).resolvedCurrentRef
    ).toBe('');

    expect(
      createExecutionPlan({
        repoWriteMode: 'commit-and-push',
        currentRef: 'refs/pull/42/merge',
        githubHeadRef: 'refs/heads/feature/customer-sync',
        githubRefName: '42/merge'
      }).resolvedCurrentRef
    ).toBe('feature/customer-sync');

    expect(
      createExecutionPlan({
        repoWriteMode: 'commit-and-push',
        currentRef: 'refs/pull/42/merge',
        githubHeadRef: 'refs/tags/v1.2.3',
        githubRefName: 'feature/customer-sync'
      }).resolvedCurrentRef
    ).toBe('');

    expect(
      createExecutionPlan({
        repoWriteMode: 'commit-and-push',
        githubRefName: '42/merge'
      }).resolvedCurrentRef
    ).toBe('');
  });

  it('defines prebuilt-collections-json semantic contract schema and default behavior', () => {
    const inputDef = postmanRepoSyncActionContract.inputs['prebuilt-collections-json'];
    const contractsSource = readFileSync(resolve(repoRoot, 'src/contracts.ts'), 'utf8');
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    expect(inputDef).toBeDefined();
    expect(inputDef.required).toBe(false);
    expect(inputDef.default).toBe('');

    const actionYaml = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { required?: boolean; default?: string; description?: string }>;
    };
    const actionInput = actionYaml.inputs['prebuilt-collections-json'];
    expect(actionInput?.required).toBe(false);
    expect(actionInput?.default).toBe('');
    expect(actionInput?.description).toBe(inputDef.description);

    // Verify descriptions contain semantic schema elements and no arbitrary cap language.
    expect(inputDef.description).toContain('baseline, smoke, or contract roles');
    expect(inputDef.description).toContain('confined repo-relative path');
    expect(inputDef.description).toContain(
      'SHA-256 artifact digest of the on-disk v3 collection tree (sorted relative-path + NUL + bytes + NUL)'
    );
    expect(inputDef.description).toContain(
      'optional payloadDigest field is the semantic v2 payload digest carried for provenance (format-validated only, not the reuse gate)'
    );
    expect(contractsSource).toContain(
      'SHA-256 digest of the canonical v2 payload (optional; format-validated provenance only, not the reuse gate)'
    );
    expect(contractsSource).not.toContain('payload (optional; verified when present)');
    expect(actionInput?.description).toContain(
      'payloadDigest field is the semantic v2 payload digest carried for provenance (format-validated only, not the reuse gate)'
    );
    expect(readme).toContain(
      'payloadDigest field is the semantic v2 payload digest carried for provenance (format-validated only, not the reuse gate)'
    );
    expect(inputDef.description).toContain('canonical cloud ID');
    expect(inputDef.description).not.toMatch(/depth|length|threshold|limit|cap/i);

    // Verify schema type compatibility
    const entry: PrebuiltCollectionEntry = {
      role: 'baseline',
      collectionPath: 'postman/collections/baseline',
      cloudId: '12345678-baseline-id',
      artifactDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    };
    const validRoles: PrebuiltCollectionRole[] = ['baseline', 'smoke', 'contract'];
    expect(validRoles).toContain(entry.role);

    const manifestArray: PrebuiltCollectionsManifest = [entry];
    const manifestObject: PrebuiltCollectionsManifest = {
      schemaVersion: 1,
      collections: [entry]
    };
    expect(manifestArray).toBeDefined();
    expect(manifestObject).toBeDefined();

    // Standalone behavior absent input unchanged
    const plan = createExecutionPlan();
    expect(plan.outputs).toBeDefined();
  });

  it('defaults onboarding scope to full and supports a spec-only opt-in', () => {
    const inputDef = postmanRepoSyncActionContract.inputs['onboarding-scope'];
    const actionYaml = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { required?: boolean; default?: string }>;
    };

    expect(inputDef).toMatchObject({
      required: false,
      default: 'full',
      allowedValues: ['full', 'spec-only']
    });
    expect(actionYaml.inputs['onboarding-scope']).toMatchObject({
      required: false,
      default: 'full'
    });
    expect(resolveInputs({}).onboardingScope).toBe('full');
    expect(resolveInputs({ INPUT_ONBOARDING_SCOPE: 'spec-only' }).onboardingScope).toBe('spec-only');
    expect(() =>
      resolveInputs({ INPUT_ONBOARDING_SCOPE: 'specs-only' })
    ).toThrow('onboarding-scope must be either full or spec-only');
  });
});
