import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const monitorScript = readFileSync(join(process.cwd(), '.github/scripts/dispatch-e2e-monitor.mjs'), 'utf8');

describe('e2e monitor dispatch contract', () => {
  it('posts a single native-fetch dispatch with legacy-compatible inputs', () => {
    expect(monitorScript).toContain('await fetch(');
    expect(monitorScript).toContain('method: \'POST\'');
    expect(monitorScript).toContain('gate_correlation_id: correlationId');
    expect(monitorScript).toContain('ref: refName');
    expect(monitorScript).toContain('suite');
    expect(monitorScript).toContain("action,");
  });

  it('does not wait, poll, back off, or timeout after dispatch', () => {
    expect(monitorScript).not.toContain('DEFAULT_TIMEOUT_SECONDS');
    expect(monitorScript).not.toContain('DEFAULT_POLL_SECONDS');
    expect(monitorScript).not.toContain('TRANSIENT_BACKOFF');
    expect(monitorScript).not.toContain('waitForMatchingRun');
    expect(monitorScript).not.toContain('waitForTerminalRun');
    expect(monitorScript).not.toContain('setTimeout');
    expect(monitorScript).not.toContain('pollGet');
  });
});
