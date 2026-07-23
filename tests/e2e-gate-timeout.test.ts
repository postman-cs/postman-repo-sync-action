import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const monitorScript = readFileSync(join(process.cwd(), '.github/scripts/dispatch-e2e-monitor.mjs'), 'utf8');

describe('asynchronous e2e monitor dispatch', () => {
  it('bounds the one-shot dispatch with AbortSignal and forbids poll/wait helpers', () => {
    expect(monitorScript).toContain('actions/workflows/e2e.yml/dispatches');
    expect(monitorScript).toContain("ref: 'main'");
    expect(monitorScript).toContain('AbortSignal.timeout');
    expect(monitorScript).toContain('DEFAULT_DISPATCH_TIMEOUT_MS');
    expect(monitorScript).not.toContain('waitForTerminalRun');
    expect(monitorScript).not.toContain('waitForMatchingRun');
    expect(monitorScript).not.toContain('DEFAULT_POLL_SECONDS');
    expect(monitorScript).not.toContain('setInterval');
    expect(monitorScript).not.toContain('gate_required');
  });
});
