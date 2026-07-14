import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const liveE2eWorkflow = readFileSync(join(process.cwd(), '.github/workflows/live-e2e.yml'), 'utf8');

function namedStep(workflow: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = workflow.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

describe('CI workflow dist/pack race contract', () => {
  it('builds dist once before fan-out and keeps the parallel dist gate read-only', () => {
    // Regression for the parallel race where `npm run verify:dist` deleted
    // dist/ while packaging tests ran `npm pack`.
    expect(ciWorkflow).toMatch(/run: npm run build[\s\S]*?- name: Run gates/);
    expect(ciWorkflow.match(/run: npm run build/g) ?? []).toHaveLength(1);

    const runGates = namedStep(ciWorkflow, 'Run gates');
    expect(runGates).toContain('run test');
    expect(runGates).toContain('run dist');
    expect(runGates).toContain('npm run verify:dist:assert');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toContain('rm -rf dist');
    expect(runGates).not.toMatch(/run dist\s+git diff --ignore-space-at-eol --text --exit-code -- dist/);

    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');

    const upload = namedStep(ciWorkflow, 'Upload expected dist on mismatch');
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
  });
});

describe('live e2e PR path filter contract', () => {
  it('limits PR live-e2e to src/dist/action/package/fixtures paths and keeps smoke wiring', () => {
    expect(liveE2eWorkflow).toMatch(/pull_request:[\s\S]*?paths:/);
    expect(liveE2eWorkflow).toContain('src/**');
    expect(liveE2eWorkflow).toContain('dist/**');
    expect(liveE2eWorkflow).toContain('action.yml');
    expect(liveE2eWorkflow).toContain('package*.json');
    expect(liveE2eWorkflow).toContain('fixtures/**');

    // Preserve existing smoke e2e wiring and fork/safety behavior.
    expect(liveE2eWorkflow).toContain('E2E_GATE_SUITE: smoke');
    expect(liveE2eWorkflow).toContain('E2E_GATE_ACTION: postman-repo-sync-action');
    expect(liveE2eWorkflow).toContain('node .github/scripts/wait-for-e2e-gate.mjs');
    expect(liveE2eWorkflow).toContain('github.actor != \'dependabot[bot]\'');
    expect(liveE2eWorkflow).toContain('Require same-repository PR branch');
  });
});
