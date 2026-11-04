import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { getInput, resolveInputs } from '../src/index.js';

const base = {
  INPUT_PROJECT_NAME: 'synthetic-project', INPUT_WORKSPACE_ID: 'synthetic-workspace',
  INPUT_MOCK_VISIBILITY: 'public', INPUT_ENVIRONMENTS_JSON: '["prod"]'
};

describe('API key policy input alias redaction', () => {
  it.each([
    ['deny', 'synthetic-sensitive-alias\n::error::forged'],
    ['synthetic-sensitive-normalized', 'allow'],
    ['allow', 'deny']
  ])('rejects conflicting aliases with a fixed error', (normalized, runner) => {
    const env = { ...base, INPUT_API_KEY_CREATION: normalized, 'INPUT_API-KEY-CREATION': runner };
    for (const run of [() => getInput('api-key-creation', env), () => resolveInputs(env)]) {
      let message = '';
      try { run(); } catch (error) { message = (error as Error).message; }
      expect(message).toBe('Conflicting api-key-creation input aliases; supply one consistent policy value.');
      expect(message).not.toContain('synthetic-sensitive');
      expect(message).not.toContain('forged');
    }
  });

  it.each([
    [{}, 'allow'],
    [{ INPUT_API_KEY_CREATION: 'deny' }, 'deny'],
    [{ 'INPUT_API-KEY-CREATION': 'deny' }, 'deny'],
    [{ INPUT_API_KEY_CREATION: ' deny ', 'INPUT_API-KEY-CREATION': 'deny' }, 'deny'],
    [{ INPUT_API_KEY_CREATION: '', 'INPUT_API-KEY-CREATION': 'deny' }, 'deny']
  ])('retains legacy/default and compatible alias semantics', (extra, expected) => {
    expect(resolveInputs({ ...base, ...extra }).apiKeyCreation).toBe(expected);
  });

  it('preserves unrelated getInput conflict diagnostics', () => {
    expect(() => getInput('project-name', { INPUT_PROJECT_NAME: 'one', 'INPUT_PROJECT-NAME': 'two' }))
      .toThrow('INPUT_PROJECT_NAME="one"');
  });

  it('runs the actual bundle probe in both CI lanes after the Ubuntu bundle', () => {
    const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
    const gate = workflow.jobs.gate.steps;
    const bundle = gate.findIndex((step: { run?: string }) => step.run === 'npm run bundle');
    const checks = gate.findIndex((step: { run?: string }) => step.run?.includes('run packaged-policy npm run test:packaged-credential-policy'));
    expect(bundle).toBeGreaterThanOrEqual(0);
    expect(checks).toBeGreaterThan(bundle);
    expect(workflow.jobs.windows.steps.some((step: { run?: string }) => step.run === 'npm run test:packaged-credential-policy')).toBe(true);
  });
});
