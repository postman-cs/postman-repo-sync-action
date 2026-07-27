import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Source-level guard on the canonical dispatcher. Behavioural coverage lives in
// .github/scripts/dispatch-e2e-monitor.test.mjs (node:test); this file only
// pins the shape the release workflow depends on.
const monitorScript = readFileSync(
  join(process.cwd(), '.github/scripts/dispatch-e2e-monitor.mjs'),
  'utf8'
);
const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

describe('asynchronous e2e monitor dispatch', () => {
  it('targets the workflow_dispatch endpoint the e2e listener actually serves', () => {
    // e2e.yml is `on: workflow_dispatch`. A repository_dispatch with a
    // non-matching event_type returns HTTP 204 and is silently dropped, which
    // would make a green release job report coverage that never ran.
    expect(monitorScript).toContain('actions/workflows/');
    expect(monitorScript).toContain('/dispatches');
    expect(monitorScript).toContain("DEFAULT_E2E_WORKFLOW = 'e2e.yml'");
    expect(monitorScript).toContain("DEFAULT_E2E_REPOSITORY = 'postman-cs/postman-actions-e2e'");
    expect(monitorScript).not.toContain('event_type');
    expect(monitorScript).not.toContain('client_payload');
  });

  it('sends the four inputs the listener reads', () => {
    expect(monitorScript).toContain('gate_correlation_id');
    expect(monitorScript).toContain('suite');
    expect(monitorScript).toContain('buildDispatchInputs');
    expect(monitorScript).toContain("DEFAULT_E2E_WORKFLOW_REF = 'main'");
  });

  it('bounds the one-shot dispatch with AbortSignal and forbids poll/wait helpers', () => {
    expect(monitorScript).toContain('AbortSignal.timeout');
    expect(monitorScript).toContain('DEFAULT_DISPATCH_TIMEOUT_MS');
    expect(monitorScript).not.toContain('waitForTerminalRun');
    expect(monitorScript).not.toContain('waitForMatchingRun');
    expect(monitorScript).not.toContain('DEFAULT_POLL_SECONDS');
    expect(monitorScript).not.toContain('setInterval');
    expect(monitorScript).not.toContain('gate_required');
  });

  it('never lets the dispatch token reach an error string', () => {
    expect(monitorScript).toContain('redactTokenOccurrences');
    expect(monitorScript).toContain('REDACTED_TOKEN_MARKER');
  });

  it('is invoked post-publish as a non-blocking observer with the release tag pinned', () => {
    expect(releaseWorkflow).toMatch(
      /dispatch-live-monitor:[\s\S]*?continue-on-error: true/
    );
    expect(releaseWorkflow).toContain('E2E_GATE_REF:');
    expect(releaseWorkflow).toContain('node .github/scripts/dispatch-e2e-monitor.mjs');
  });
});
