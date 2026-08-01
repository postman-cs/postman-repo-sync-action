import { describe, expect, it } from 'vitest';

import { createProbeReceiptEmitter } from '../scripts/live-github-dispatch-probe-support.js';

const token = 'ghp+receipt /:@?%#[]';
const encodedToken = encodeURIComponent(token);
const credentialUrl = new URL('https://github.com/');
credentialUrl.username = 'x-access-token';
credentialUrl.password = token;
const urlUserinfoToken = credentialUrl.password;
const tokenRepresentations = [token, encodedToken, urlUserinfoToken];

describe('live GitHub dispatch probe receipts', () => {
  it('masks raw, percent-encoded, and URL-userinfo tokens on stdout/info receipts', () => {
    const stdout: string[] = [];
    const emitter = createProbeReceiptEmitter([token]);
    const message = `info raw=${token}; encoded=${encodedToken}; url-userinfo=${urlUserinfoToken}`;

    const emitted = emitter.emit(message, (receipt) => stdout.push(receipt));

    expect(stdout).toEqual([emitted]);
    expect(emitter.emitted).toEqual([emitted]);
    expect(emitted).toContain('[REDACTED]');
    expect(emitted.match(/\[REDACTED\]/g)).toHaveLength(3);
    for (const representation of tokenRepresentations) {
      expect(emitted).not.toContain(representation);
    }
    expect(emitter.check()).toEqual({ safe: true, remainingSecretRepresentations: [] });
  });

  it('masks raw, percent-encoded, and URL-userinfo tokens on stderr/error receipts', () => {
    const stderr: string[] = [];
    const emitter = createProbeReceiptEmitter([token]);
    const message = `error raw=${token}; encoded=${encodedToken}; url-userinfo=${urlUserinfoToken}`;

    const emitted = emitter.emit(message, (receipt) => stderr.push(receipt));

    expect(stderr).toEqual([emitted]);
    expect(emitter.emitted).toEqual([emitted]);
    expect(emitted).toContain('[REDACTED]');
    expect(emitted.match(/\[REDACTED\]/g)).toHaveLength(3);
    for (const representation of tokenRepresentations) {
      expect(emitted).not.toContain(representation);
    }
    expect(emitter.check()).toEqual({ safe: true, remainingSecretRepresentations: [] });
  });
});
