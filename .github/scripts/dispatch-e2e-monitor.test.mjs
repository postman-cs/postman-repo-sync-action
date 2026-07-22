import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';

import {
  buildCorrelationId,
  buildDispatchInputs,
  normalizeRunDetails,
  normalizeSuite
} from './dispatch-e2e-monitor.mjs';

test('normalizes smoke/full suite and rejects unknown values', () => {
  assert.equal(normalizeSuite(undefined), 'smoke');
  assert.equal(normalizeSuite(''), 'smoke');
  assert.equal(normalizeSuite(' smoke '), 'smoke');
  assert.equal(normalizeSuite('full'), 'full');
  assert.throws(() => normalizeSuite('fast'), /E2E_GATE_SUITE must be smoke or full/);
});

test('buildDispatchInputs carries legacy-compatible monitor fields', () => {
  assert.deepEqual(
    buildDispatchInputs({
      action: 'postman-repo-sync-action',
      refName: 'v2.1.10',
      correlationId: 'corr-123',
      failureInjection: '',
      suite: 'smoke'
    }),
    {
      action: 'postman-repo-sync-action',
      ref: 'v2.1.10',
      gate_correlation_id: 'corr-123',
      failure_injection: '',
      suite: 'smoke'
    }
  );
});

test('buildCorrelationId creates a stable run-scoped identifier', () => {
  assert.equal(
    buildCorrelationId({
      repository: 'postman-cs/postman-repo-sync-action',
      runId: '12345',
      runAttempt: '2',
      refName: 'v2.1.10'
    }),
    'postman-cs-postman-repo-sync-action-12345-2-v2.1.10'
  );
});

test('normalizes dispatch response run details when present', () => {
  assert.deepEqual(
    normalizeRunDetails({
      workflow_run_id: 456,
      run_url: 'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/runs/456',
      html_url: 'https://github.com/postman-cs/postman-actions-e2e/actions/runs/456'
    }),
    {
      id: 456,
      url: 'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/runs/456',
      htmlUrl: 'https://github.com/postman-cs/postman-actions-e2e/actions/runs/456'
    }
  );

  assert.equal(normalizeRunDetails(null), null);
});

test('monitor dispatch module has no wait/poll/backoff/timeout contract surface', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./dispatch-e2e-monitor.mjs', import.meta.url), 'utf8')
  );
  assert.equal(source.includes('DEFAULT_TIMEOUT_SECONDS'), false);
  assert.equal(source.includes('DEFAULT_POLL_SECONDS'), false);
  assert.equal(source.includes('transientBackoffMs'), false);
  assert.equal(source.includes('waitForMatchingRun'), false);
  assert.equal(source.includes('waitForTerminalRun'), false);
  assert.equal(source.includes('setTimeout'), false);
  assert.equal(source.includes('return_run_details'), false);
  assert.match(source, /await fetch\(/);
});
