import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

describe('live e2e tiering contract', () => {
  it('keeps live sandbox work off PRs and as a post-publish monitor on immutable releases', () => {
    expect(existsSync(join(process.cwd(), '.github/workflows/live-e2e.yml'))).toBe(false);
    expect(releaseWorkflow).not.toContain('live-e2e-gate:');
    expect(releaseWorkflow).not.toContain('gate_required');
    expect(releaseWorkflow).not.toContain('wait-for-e2e-gate.mjs');
    expect(releaseWorkflow).toContain('dispatch-live-monitor:');
    expect(releaseWorkflow).toContain('E2E_GATE_SUITE: smoke');
    expect(releaseWorkflow).toContain('node .github/scripts/dispatch-e2e-monitor.mjs');
    expect(releaseWorkflow).toContain('continue-on-error: true');
  });

  it('keeps publication independent of the live monitor outcome', () => {
    expect(releaseWorkflow).toMatch(/^ {2}publish:\n(?:.*\n)*? {4}needs: validate$/m);
    expect(releaseWorkflow).not.toContain('needs.live-e2e-gate');
    expect(releaseWorkflow).toContain('dispatch-live-monitor:');
    expect(releaseWorkflow).toContain('needs.publish.result == \'success\'');
    // Alias must not wait on the monitor job.
    const aliasIdx = releaseWorkflow.indexOf('  advance-major-alias:');
    expect(aliasIdx).toBeGreaterThan(-1);
    const aliasBlock = releaseWorkflow.slice(aliasIdx);
    expect(aliasBlock).toContain('- validate');
    expect(aliasBlock).toContain('- publish');
    expect(aliasBlock).not.toContain('dispatch-live-monitor');
  });
});
