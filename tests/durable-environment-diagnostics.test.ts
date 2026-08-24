import { describe, expect, it } from 'vitest';

import { toDurableEnvironmentBoundaryError } from '../src/lib/postman/durable-environment-diagnostics.js';

describe('durable environment diagnostics', () => {
  it('projects arbitrary provider text into a capped single-line non-echoing error', () => {
    const canary = 'provider-secret-canary';
    const projected = toDurableEnvironmentBoundaryError(
      new Error(`${canary}\r\n${'x'.repeat(10_000)}\u2028second line`)
    );

    expect(projected.code).toBe('DURABLE_ENVIRONMENT_OPERATION_FAILED');
    expect(projected.message).not.toContain(canary);
    expect(projected.message).not.toMatch(/[\r\n\u2028\u2029]/u);
    expect(projected.message.length).toBeLessThanOrEqual(450);
  });
});
