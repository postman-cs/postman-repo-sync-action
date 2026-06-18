import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  getCiWorkflowTemplate,
  renderCiWorkflowTemplate
} from '../src/lib/ci-workflow-template.js';

describe('renderCiWorkflowTemplate', () => {
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

    expect(parsed.name).toBe('CI/CD Pipeline');
    expect(parsed.trigger.branches.include).toContain('main');
    expect(parsed.pool.vmImage).toBe('ubuntu-latest');
    expect(parsed.steps[0]).toMatchObject({
      checkout: 'self',
      persistCredentials: true
    });
    expect(ciWorkflow).toContain('--env-var "CI_ENVIRONMENT=${CI_ENVIRONMENT:-Production}"');
    expect(ciWorkflow).toContain(
      'if [ "$POSTMAN_SSL_EXTRA_CA_CERTS_B64" = \'$(POSTMAN_SSL_EXTRA_CA_CERTS_B64)\' ]; then'
    );
    expect(ciWorkflow).toContain(
      'if [ "$POSTMAN_SSL_CLIENT_PASSPHRASE" = \'$(POSTMAN_SSL_CLIENT_PASSPHRASE)\' ]; then'
    );
    expect(ciWorkflow).toContain('if [ "$CI_ENVIRONMENT" = \'$(CI_ENVIRONMENT)\' ]; then');
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
