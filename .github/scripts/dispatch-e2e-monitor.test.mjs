/* global AbortController, DOMException */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_DISPATCH_TIMEOUT_MS,
  REDACTED_TOKEN_MARKER,
  buildDispatchPayload,
  dispatchE2eMonitor
} from './dispatch-e2e-monitor.mjs';

const SENTINEL_TOKEN = 'sentinel-token-never-log-me';

const baseEnv = {
  E2E_DISPATCH_TOKEN: SENTINEL_TOKEN,
  GITHUB_REPOSITORY: 'postman-cs/postman-repo-sync-action',
  E2E_GATE_REF: 'v2.1.10',
  E2E_GATE_SUITE: 'smoke'
};

test('buildDispatchPayload pins central main and the exact released input ref', () => {
  assert.deepEqual(buildDispatchPayload('postman-repo-sync-action', 'v2.1.10', 'smoke'), {
    ref: 'main',
    inputs: { action: 'postman-repo-sync-action', ref: 'v2.1.10', suite: 'smoke' }
  });
  assert.throws(() => buildDispatchPayload('action', 'v1.0.0', 'fast'), /smoke or full/);
});

test('dispatchE2eMonitor posts once with exact payload, supplied abort signal, and notice side effect', async () => {
  const calls = [];
  const notices = [];
  const controller = new AbortController();
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 204 };
  };

  await dispatchE2eMonitor({
    env: baseEnv,
    fetchImpl,
    abortSignal: controller.signal,
    log: (message) => notices.push(message)
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/workflows/e2e.yml/dispatches'
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${SENTINEL_TOKEN}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(calls[0].init.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ref: 'main',
    inputs: {
      action: 'postman-repo-sync-action',
      ref: 'v2.1.10',
      suite: 'smoke'
    }
  });
  assert.equal(notices.length, 1);
  assert.equal(
    notices[0],
    '::notice::Dispatched asynchronous e2e smoke monitor for postman-repo-sync-action@v2.1.10'
  );
  assert.doesNotMatch(notices[0], new RegExp(SENTINEL_TOKEN));
  assert.equal(DEFAULT_DISPATCH_TIMEOUT_MS, 30_000);
});

test('dispatchE2eMonitor rejects an invalid suite before fetch', async () => {
  let called = 0;
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: { ...baseEnv, E2E_GATE_SUITE: 'fast' },
        fetchImpl: async () => {
          called += 1;
          return { ok: true, status: 204 };
        }
      }),
    /smoke or full/
  );
  assert.equal(called, 0);
});

test('dispatchE2eMonitor throws status-only HTTP errors without disclosing the token', async () => {
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: baseEnv,
        fetchImpl: async () => ({ ok: false, status: 502 })
      }),
    (error) => {
      assert.equal(String(error.message), 'e2e monitor dispatch failed with HTTP 502');
      assert.doesNotMatch(String(error.message), new RegExp(SENTINEL_TOKEN));
      return true;
    }
  );
});

test('dispatchE2eMonitor surfaces network/abort failure without disclosing the token', async () => {
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: baseEnv,
        timeoutMs: 1,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              'abort',
              () => {
                reject(init.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
              },
              { once: true }
            );
          })
      }),
    (error) => {
      assert.match(String(error.message), /e2e monitor dispatch failed:/);
      assert.doesNotMatch(String(error.message), new RegExp(SENTINEL_TOKEN));
      assert.equal(error.cause, undefined);
      return true;
    }
  );
});

test('dispatchE2eMonitor redacts token-bearing transport errors without preserving cause', async () => {
  const hostileMessage = `fetch failed: Authorization Bearer ${SENTINEL_TOKEN} refused; retry with ${SENTINEL_TOKEN}`;
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: baseEnv,
        fetchImpl: async () => {
          throw new Error(hostileMessage);
        }
      }),
    (error) => {
      assert.match(String(error.message), /e2e monitor dispatch failed:/);
      assert.match(String(error.message), new RegExp(REDACTED_TOKEN_MARKER.replace(/[[\]]/g, '\\$&')));
      assert.doesNotMatch(String(error.message), new RegExp(SENTINEL_TOKEN));
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error.stack ?? ''), new RegExp(SENTINEL_TOKEN));
      return true;
    }
  );
});

test('dispatchE2eMonitor rejects missing required env without leaking a token', async () => {
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: { E2E_DISPATCH_TOKEN: SENTINEL_TOKEN },
        fetchImpl: async () => ({ ok: true, status: 204 })
      }),
    (error) => {
      assert.match(String(error.message), /E2E_DISPATCH_TOKEN, E2E_GATE_REF, and GITHUB_REPOSITORY are required/);
      assert.doesNotMatch(String(error.message), new RegExp(SENTINEL_TOKEN));
      return true;
    }
  );
});
