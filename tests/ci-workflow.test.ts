import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

function namedStep(workflow: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = workflow.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

describe('CI workflow dist/pack race contract', () => {
  it('gates immutable dist on Linux and Windows', () => {
    // Regression for the parallel race where `npm run verify:dist` deleted
    // dist/ while packaging tests ran `npm pack`.
    expect(ciWorkflow).toMatch(/run: npm run bundle[\s\S]*?- name: Run gates/);
    expect(ciWorkflow).not.toMatch(/run: npm run build/);
    expect(ciWorkflow.match(/npm run typecheck/g) ?? []).toHaveLength(2);

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
    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    expect(runGates).toContain('wait -n -p finished_pid');

    const upload = namedStep(ciWorkflow, 'Upload expected dist on mismatch');
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
    expect(ciWorkflow).toContain('name: Windows gate');
    expect(ciWorkflow).toContain('runs-on: windows-latest');
  });
});

describe('live e2e tiering contract', () => {
  it('keeps live sandbox work off PRs and dispatches a post-publish monitor', () => {
    expect(existsSync(join(process.cwd(), '.github/workflows/live-e2e.yml'))).toBe(false);
    expect(releaseWorkflow).toContain('dispatch-live-monitor:');
    expect(releaseWorkflow).toContain('E2E_GATE_SUITE: smoke');
    expect(releaseWorkflow).toContain('node .github/scripts/dispatch-e2e-monitor.mjs');
    expect(releaseWorkflow).not.toContain('live-e2e-gate:');
    expect(releaseWorkflow).not.toContain('wait-for-e2e-gate.mjs');
  });
});
