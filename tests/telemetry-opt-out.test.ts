import { describe, expect, it, vi } from 'vitest';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';

describe('telemetry opt-out suppresses transport', () => {
  it.each([
    { POSTMAN_ACTIONS_TELEMETRY: 'off' },
    { DO_NOT_TRACK: '1' }
  ])('does not call transport when %o after team id + emitCompletion', (optOut) => {
    const transport = vi.fn();
    const telemetry = createTelemetryContext({
      action: 'postman-repo-sync-action',
      env: optOut,
      transport: transport as unknown as typeof fetch
    });

    telemetry.setTeamId('10490519');
    telemetry.emitCompletion('success');

    expect(transport).not.toHaveBeenCalled();
  });
});
