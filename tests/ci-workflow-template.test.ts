import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  getCiWorkflowTemplate,
  renderCiWorkflowTemplate,
  renderGcWorkflowTemplate
} from '../src/lib/ci-workflow-template.js';

describe('renderCiWorkflowTemplate', () => {
  it('keys concurrency on the resolved head branch rather than the raw merge ref', () => {
    const workflow = renderCiWorkflowTemplate();

    expect(workflow).toContain('group: postman-onboard-${{ github.head_ref || github.ref_name }}');
    expect(workflow).toContain('cancel-in-progress: false');
  });
  it('produces multi-line YAML output with real newlines', () => {
    const ciWorkflow = renderCiWorkflowTemplate();

    // Assert it's not a single-line blob
    const lines = ciWorkflow.split('\n');
    expect(lines.length).toBeGreaterThan(10);
  });

  it('does not contain literal backslash-n escape sequences', () => {
    const ciWorkflow = renderCiWorkflowTemplate();

    // The bug was .join('\\n') which produces the two-character sequence \n
    expect(ciWorkflow).not.toContain('\\n');
  });

  it('produces valid YAML that parses correctly', () => {
    const ciWorkflow = renderCiWorkflowTemplate();

    // This is the real customer-facing correctness assertion
    const parsed = parse(ciWorkflow);

    expect(parsed).toBeTypeOf('object');
    expect(parsed).toHaveProperty('name');
    expect(parsed).toHaveProperty('on');
    expect(parsed).toHaveProperty('jobs');
    expect(parsed.jobs).toHaveProperty('test');
  });

  it('includes all required workflow structure', () => {
    const ciWorkflow = renderCiWorkflowTemplate();
    const parsed = parse(ciWorkflow);

    expect(parsed.name).toBe('CI/CD Pipeline');
    expect(parsed.on).toHaveProperty('push');
    expect(parsed.on).toHaveProperty('pull_request');
    expect(parsed.on).toHaveProperty('schedule');
    expect(parsed.jobs.test).toHaveProperty('runs-on');
    expect(parsed.jobs.test).toHaveProperty('steps');
    expect(parsed.jobs.test.steps.length).toBeGreaterThan(5);
  });

  it('accepts custom postmanCliInstallUrl', () => {
    const customUrl = 'https://example.com/custom-install.sh';
    const ciWorkflow = renderCiWorkflowTemplate({
      postmanCliInstallUrl: customUrl
    });

    expect(ciWorkflow).toContain(customUrl);

    // Verify it still produces valid YAML
    const parsed = parse(ciWorkflow);
    expect(parsed).toHaveProperty('jobs');
  });

  it('uses default install URL when none provided', () => {
    const ciWorkflow = renderCiWorkflowTemplate();

    expect(ciWorkflow).toContain('https://dl-cli.pstmn.io/install/unix.sh');
  });

  it('contains expected CI steps in order', () => {
    const ciWorkflow = renderCiWorkflowTemplate();
    const parsed = parse(ciWorkflow);

    const stepNames = parsed.jobs.test.steps
      .filter((step: { name?: string }) => step.name)
      .map((step: { name: string }) => step.name);

    expect(stepNames).toContain('Install Postman CLI');
    expect(stepNames).toContain('Login to Postman CLI');
    expect(stepNames).toContain('Resolve Postman Resource IDs');
    expect(stepNames).toContain('Decode SSL certificates');
    expect(stepNames).toContain('Run Smoke Tests');
    expect(stepNames).toContain('Run Contract Tests');
  });

  it('routes install URL via env var, not shell interpolation', () => {
    const ciWorkflow = renderCiWorkflowTemplate();
    const parsed = parse(ciWorkflow);

    const installStep = parsed.jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Install Postman CLI'
    );

    expect(installStep).toBeDefined();
    expect(installStep.env).toHaveProperty('POSTMAN_CLI_INSTALL_URL');
    expect(installStep.run).toContain('$POSTMAN_CLI_INSTALL_URL');
    expect(installStep.run).not.toContain('${');
    expect(installStep.run).not.toContain('curl -o-');
    expect(installStep.run).toContain('curl -fsSL');
  });

  it('passes CI_ENVIRONMENT to Postman CLI as key=value', () => {
    const ciWorkflow = renderCiWorkflowTemplate();

    expect(ciWorkflow).toContain(
      '--env-var "CI_ENVIRONMENT=${{ vars.CI_ENVIRONMENT || \'Production\' }}"'
    );
    expect(ciWorkflow).not.toContain(
      '--env-var "${{ vars.CI_ENVIRONMENT || \'Production\' }}"'
    );
  });

  it('rejects javascript: pseudo-protocol', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'javascript:alert(1)'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects http:// (non-https)', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'http://dl-cli.pstmn.io/install/unix.sh'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with shell metacharacters: semicolon', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'https://example.com/install.sh; rm -rf /'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with shell metacharacters: double quotes', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'https://example.com/install.sh" && rm -rf /'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with shell metacharacters: backticks', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'https://example.com/install.sh` echo pwned`'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with command substitution: $()', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'https://example.com/install.sh$(whoami)'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with pipe characters', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'https://example.com/install.sh | cat'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('accepts valid https URLs with query parameters', () => {
    const url = 'https://cdn.example.com/path/install.sh?version=1.0&platform=linux';
    const ciWorkflow = renderCiWorkflowTemplate({
      postmanCliInstallUrl: url
    });

    const parsed = parse(ciWorkflow);
    const installStep = parsed.jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Install Postman CLI'
    );

    expect(installStep.env.POSTMAN_CLI_INSTALL_URL).toBe(url);
  });

  it('passes the configured Postman region to generated CLI login', () => {
    const ciWorkflow = renderCiWorkflowTemplate({ postmanRegion: 'eu' });
    const parsed = parse(ciWorkflow);
    const loginStep = parsed.jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Login to Postman CLI'
    );

    expect(loginStep.run).toContain('--region eu');

    const usWorkflow = renderCiWorkflowTemplate({ postmanRegion: 'us' });
    const usLogin = parse(usWorkflow).jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Login to Postman CLI'
    );
    // us is the CLI default and `--region us` is rejected by the Postman CLI, so the
    // generated login omits the flag for us.
    expect(usLogin.run).toContain('postman login --with-api-key');
    expect(usLogin.run).not.toContain('--region');

    expect(() => renderCiWorkflowTemplate({ postmanRegion: 'ap' })).toThrow(/postman-region/);
  });

  it('renders valid Azure DevOps YAML when requested', () => {
    const ciWorkflow = getCiWorkflowTemplate('azure-devops');
    const parsed = parse(ciWorkflow);

    expect(parsed.name).toBeUndefined();
    expect(parsed.trigger.branches.include).toContain('main');
    expect(parsed.schedules[0].always).toBe(true);
    expect(parsed.pool.vmImage).toBe('ubuntu-latest');
    expect(parsed.steps[0]).toMatchObject({
      checkout: 'self',
      persistCredentials: true
    });
    expect(ciWorkflow).toContain('--env-var "CI_ENVIRONMENT=${CI_ENVIRONMENT:-Production}"');
    const decodeStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Decode SSL certificates'
    );
    const smokeStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Run Smoke Tests'
    );
    const contractStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Run Contract Tests'
    );
    const azureScriptBodies = parsed.steps
      .map((step: { script?: string }) => step.script)
      .filter(Boolean)
      .join('\n');
    expect(decodeStep.script).toContain(
      'normalize_azure_optional_var POSTMAN_SSL_EXTRA_CA_CERTS_B64'
    );
    expect(smokeStep.script).toContain('normalize_azure_optional_var CI_ENVIRONMENT');
    expect(smokeStep.script).toContain(
      'normalize_azure_optional_var POSTMAN_SSL_CLIENT_PASSPHRASE'
    );
    expect(contractStep.script).toContain('normalize_azure_optional_var CI_ENVIRONMENT');
    expect(contractStep.script).toContain(
      'normalize_azure_optional_var POSTMAN_SSL_CLIENT_PASSPHRASE'
    );
    expect(smokeStep.script).toContain('postman collection run "$POSTMAN_SMOKE_COLLECTION_UID"');
    expect(smokeStep.script).toContain('-e "$POSTMAN_ENVIRONMENT_UID"');
    expect(contractStep.script).toContain(
      'postman collection run "$POSTMAN_CONTRACT_COLLECTION_UID"'
    );
    expect(contractStep.script).toContain('-e "$POSTMAN_ENVIRONMENT_UID"');
    expect(azureScriptBodies).not.toContain('$(POSTMAN_SSL_EXTRA_CA_CERTS_B64)');
    expect(azureScriptBodies).not.toContain('$(POSTMAN_SSL_CLIENT_PASSPHRASE)');
    expect(azureScriptBodies).not.toContain('$(CI_ENVIRONMENT)');
    expect(azureScriptBodies).not.toContain('$(POSTMAN_SMOKE_COLLECTION_UID)');
    expect(azureScriptBodies).not.toContain('$(POSTMAN_CONTRACT_COLLECTION_UID)');
    expect(azureScriptBodies).not.toContain('$(POSTMAN_ENVIRONMENT_UID)');
  });

  it('normalizes unresolved Azure optional macro values without clearing real values', () => {
    execFileSync('bash', [
      '-lc',
      `
set -euo pipefail
normalize_azure_optional_var() {
  local name="$1"
  local value="\${!name:-}"
  local unresolved_prefix='$'
  unresolved_prefix="\${unresolved_prefix}("
  if [[ "$value" == "$unresolved_prefix"*")" ]]; then
    printf -v "$name" %s ""
  fi
}

CI_ENVIRONMENT='$''(CI_ENVIRONMENT)'
normalize_azure_optional_var CI_ENVIRONMENT
[ -z "$CI_ENVIRONMENT" ]

POSTMAN_SSL_CLIENT_PASSPHRASE='real passphrase'
normalize_azure_optional_var POSTMAN_SSL_CLIENT_PASSPHRASE
[ "$POSTMAN_SSL_CLIENT_PASSPHRASE" = 'real passphrase' ]
`
    ]);
  });

  it('passes the configured Postman region to Azure DevOps CLI login', () => {
    const ciWorkflow = getCiWorkflowTemplate('azure-devops', { postmanRegion: 'eu' });
    const parsed = parse(ciWorkflow);
    const loginStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Login to Postman CLI'
    );

    expect(loginStep.script).toBe('postman login --with-api-key "$POSTMAN_API_KEY" --region eu');

    const usWorkflow = getCiWorkflowTemplate('azure-devops', { postmanRegion: 'us' });
    const usLogin = parse(usWorkflow).steps.find(
      (step: { displayName?: string }) => step.displayName === 'Login to Postman CLI'
    );

    expect(usLogin.script).toBe('postman login --with-api-key "$POSTMAN_API_KEY"');
    expect(() => getCiWorkflowTemplate('azure-devops', { postmanRegion: 'ap' })).toThrow(
      /postman-region/
    );
  });
});

describe('renderGcWorkflowTemplate', () => {
  it('emits a dedicated marker-guarded GitHub GC workflow with lifecycle triggers', () => {
    const workflow = renderGcWorkflowTemplate();

    expect(parse(workflow)).toMatchObject({ name: 'Postman Preview GC' });
    expect(workflow).toContain('delete:');
    expect(workflow).toContain('types: [closed]');
    expect(workflow).toContain('cron: "0 2 * * *"');
    expect(workflow).toContain('cli.cjs gc');
    expect(workflow).toContain('gc-summary-json');
  });
});
