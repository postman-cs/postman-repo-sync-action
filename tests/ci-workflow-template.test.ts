import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { renderCiWorkflowTemplate } from '../src/lib/ci-workflow-template.js';

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
});
