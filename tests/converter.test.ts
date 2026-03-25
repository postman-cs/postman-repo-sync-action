import { describe, expect, it } from 'vitest';

import {
  MAX_PATH_SEGMENT_CHARS,
  sanitizePathSegment
} from '../src/postman-v3/converter.js';

describe('sanitizePathSegment', () => {
  it('truncates long request names to avoid ENAMETOOLONG on export', () => {
    const long = 'x'.repeat(500);
    const out = sanitizePathSegment(long, 'fallback');
    expect(out.length).toBe(MAX_PATH_SEGMENT_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('truncates GoodLeap-style OpenAPI summaries used as Postman request names', () => {
    const endSession =
      'End the current AAT session and clean up any artifacts. This should be called at the end of an AAT test to ensure that the session is properly closed and data is cleaned up. If no AAT test is running, it will simply return a message indicating that there is no session to end.';
    const endAll =
      'End all tests that are currently running in AAT and purge their data. This is a safety measure in case something goes wrong and tests are left running, which can cause issues for other tests and data pollution. This can be hooked into a pipeline that runs periodically to ensure a clean state in AAT.';
    expect(endSession.length).toBeGreaterThan(255);
    expect(endAll.length).toBeGreaterThan(255);
    for (const raw of [endSession, endAll]) {
      const out = sanitizePathSegment(raw, 'fallback');
      expect(out.length).toBe(MAX_PATH_SEGMENT_CHARS);
      expect(out.endsWith('…')).toBe(true);
    }
  });

  it('preserves short names', () => {
    expect(sanitizePathSegment('List pets', 'fallback')).toBe('List pets');
  });
});
