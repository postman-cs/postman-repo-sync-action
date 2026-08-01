import { describe, expect, it, vi } from 'vitest';

import {
  EMULATOR_PROFILE_ENV,
  EMULATOR_PROFILE_NAME,
  ENDPOINT_OVERRIDE_ENV,
  POSTMAN_ENDPOINT_PROFILES,
  resolvePostmanEndpointProfile
} from '../src/lib/postman/base-urls.js';
import { readActionInputs } from '../src/index.js';

function armed(overrides: Record<string, string>): Record<string, string | undefined> {
  return { [EMULATOR_PROFILE_ENV]: EMULATOR_PROFILE_NAME, ...overrides };
}

const COMPLETE_OVERRIDES = {
  [ENDPOINT_OVERRIDE_ENV.apiBaseUrl]: 'http://127.0.0.1:8081/api',
  [ENDPOINT_OVERRIDE_ENV.bifrostBaseUrl]: 'http://127.0.0.1:8082/bifrost',
  [ENDPOINT_OVERRIDE_ENV.fallbackBaseUrl]: 'http://127.0.0.1:8083/fallback',
  [ENDPOINT_OVERRIDE_ENV.iapubBaseUrl]: 'http://127.0.0.1:8084/iapub',
  [ENDPOINT_OVERRIDE_ENV.workerBaseUrl]: 'http://127.0.0.1:8085/worker',
  [ENDPOINT_OVERRIDE_ENV.cliInstallUrl]: 'https://127.0.0.1:8086/install/unix.sh',
  [ENDPOINT_OVERRIDE_ENV.cliWindowsInstallUrl]: 'https://127.0.0.1:8087/install/win64.ps1'
};

describe('repo-sync endpoint profile defaults', () => {
  it('preserves the live prod hosts when the emulator profile is absent', () => {
    expect(resolvePostmanEndpointProfile('prod', 'us', {})).toMatchObject({
      apiBaseUrl: 'https://api.getpostman.com',
      bifrostBaseUrl: 'https://bifrost-premium-https-v4.gw.postman.com',
      fallbackBaseUrl: 'https://go.postman.co/_api',
      iapubBaseUrl: 'https://iapub.postman.co',
      cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh',
      cliWindowsInstallUrl: 'https://dl-cli.pstmn.io/install/win64.ps1',
      workerBaseUrl: 'https://catalog-admin.postman-account2009.workers.dev'
    });
  });

  it('preserves the live beta and EU defaults', () => {
    expect(resolvePostmanEndpointProfile('beta', 'us', {})).toMatchObject({
      apiBaseUrl: 'https://api.getpostman-beta.com',
      bifrostBaseUrl: 'https://bifrost-https-v4.gw.postman-beta.com',
      fallbackBaseUrl: 'https://go.postman-beta.co/_api',
      iapubBaseUrl: 'https://iapub.postman.co'
    });
    expect(resolvePostmanEndpointProfile('prod', 'eu', {}).apiBaseUrl).toBe(
      'https://api.eu.postman.com'
    );
    expect(POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl).toBe('https://api.getpostman.com');
  });

  it('still rejects beta+eu with the emulator armed', () => {
    expect(() => resolvePostmanEndpointProfile('beta', 'eu', armed(COMPLETE_OVERRIDES))).toThrow(
      'postman-region=eu is only supported with postman-stack=prod'
    );
  });
});

describe('repo-sync emulator endpoint profile', () => {
  it('atomically redirects every reachable Postman host', () => {
    const profile = resolvePostmanEndpointProfile('prod', 'us', armed(COMPLETE_OVERRIDES));
    expect(profile).toMatchObject({
      apiBaseUrl: 'http://127.0.0.1:8081/api',
      bifrostBaseUrl: 'http://127.0.0.1:8082/bifrost',
      fallbackBaseUrl: 'http://127.0.0.1:8083/fallback',
      iapubBaseUrl: 'http://127.0.0.1:8084/iapub',
      workerBaseUrl: 'http://127.0.0.1:8085/worker',
      cliInstallUrl: 'https://127.0.0.1:8086/install/unix.sh',
      cliWindowsInstallUrl: 'https://127.0.0.1:8087/install/win64.ps1'
    });
    expect(Object.values(profile).every((url) => url.includes('127.0.0.1'))).toBe(true);
  });

  it('normalizes trailing slashes and ignores the selected live stack', () => {
    const env = armed(
      Object.fromEntries(
        Object.entries(COMPLETE_OVERRIDES).map(([name, value]) => [name, `${value}///`])
      )
    );
    expect(resolvePostmanEndpointProfile('beta', 'us', env)).toMatchObject({
      apiBaseUrl: 'http://127.0.0.1:8081/api',
      bifrostBaseUrl: 'http://127.0.0.1:8082/bifrost',
      fallbackBaseUrl: 'http://127.0.0.1:8083/fallback',
      iapubBaseUrl: 'http://127.0.0.1:8084/iapub',
      workerBaseUrl: 'http://127.0.0.1:8085/worker',
      cliInstallUrl: 'https://127.0.0.1:8086/install/unix.sh',
      cliWindowsInstallUrl: 'https://127.0.0.1:8087/install/win64.ps1'
    });
  });

  it('propagates the emulator worker and CLI URLs through action input resolution', () => {
    vi.stubEnv(EMULATOR_PROFILE_ENV, EMULATOR_PROFILE_NAME);
    for (const [name, value] of Object.entries(COMPLETE_OVERRIDES)) vi.stubEnv(name, value);
    const inputs = readActionInputs({
      getInput: (name) => (name === 'project-name' ? 'emulator-test' : ''),
      setSecret: vi.fn()
    });

    expect(inputs).toMatchObject({
      postmanWorkerBase: COMPLETE_OVERRIDES[ENDPOINT_OVERRIDE_ENV.workerBaseUrl],
      postmanCliInstallUrl: COMPLETE_OVERRIDES[ENDPOINT_OVERRIDE_ENV.cliInstallUrl],
      postmanCliWindowsInstallUrl: COMPLETE_OVERRIDES[ENDPOINT_OVERRIDE_ENV.cliWindowsInstallUrl]
    });
    vi.unstubAllEnvs();
  });
});

describe('repo-sync emulator endpoint profile fail-closed validation', () => {
  it('rejects overrides without the arming variable', () => {
    expect(() =>
      resolvePostmanEndpointProfile('prod', 'us', {
        [ENDPOINT_OVERRIDE_ENV.apiBaseUrl]: COMPLETE_OVERRIDES[ENDPOINT_OVERRIDE_ENV.apiBaseUrl]
      })
    ).toThrow('ENDPOINT_PROFILE_NOT_ARMED');
  });

  it.each(['', '   '])('rejects an unarmed %j override before returning live hosts', (value) => {
    expect(() =>
      resolvePostmanEndpointProfile('prod', 'us', {
        [ENDPOINT_OVERRIDE_ENV.bifrostBaseUrl]: value
      })
    ).toThrow('ENDPOINT_PROFILE_NOT_ARMED');
  });

  it('rejects an empty arming value when an override is present', () => {
    expect(() =>
      resolvePostmanEndpointProfile('prod', 'us', {
        [EMULATOR_PROFILE_ENV]: '  ',
        [ENDPOINT_OVERRIDE_ENV.bifrostBaseUrl]:
          COMPLETE_OVERRIDES[ENDPOINT_OVERRIDE_ENV.bifrostBaseUrl]
      })
    ).toThrow('ENDPOINT_PROFILE_NOT_ARMED');
  });

  it.each(['live', 'prod', 'container', 'Emulator'])('rejects unknown profile %j', (profile) => {
    expect(() =>
      resolvePostmanEndpointProfile('prod', 'us', { [EMULATOR_PROFILE_ENV]: profile })
    ).toThrow('ENDPOINT_PROFILE_UNKNOWN');
  });

  it.each(Object.entries(ENDPOINT_OVERRIDE_ENV))(
    'rejects an armed profile missing %s',
    (_field, omitted) => {
      const env = armed({ ...COMPLETE_OVERRIDES });
      delete env[omitted];
      expect(() => resolvePostmanEndpointProfile('prod', 'us', env)).toThrow(
        'ENDPOINT_PROFILE_OVERRIDE_MISSING'
      );
      expect(() => resolvePostmanEndpointProfile('prod', 'us', env)).toThrow(omitted);
    }
  );

  it.each([
    ['relative URL', 'relative/path'],
    ['non-http scheme', 'ftp://127.0.0.1:8081'],
    ['credentials', 'http://user:pass@127.0.0.1:8081'], // trufflehog:ignore -- placeholder the profile must reject
    ['query string', 'http://127.0.0.1:8081?team=1'],
    ['fragment', 'http://127.0.0.1:8081#fragment'],
    ['whitespace', '   ']
  ])('rejects a malformed %s override', (_label, value) => {
    expect(() =>
      resolvePostmanEndpointProfile(
        'prod',
        'us',
        armed({ ...COMPLETE_OVERRIDES, [ENDPOINT_OVERRIDE_ENV.iapubBaseUrl]: value })
      )
    ).toThrow(/ENDPOINT_PROFILE_OVERRIDE_(INVALID|MISSING)/);
  });

  it.each(Object.entries(ENDPOINT_OVERRIDE_ENV))(
    'names malformed %s override failures',
    (_field, envName) => {
      expect(() =>
        resolvePostmanEndpointProfile(
          'prod',
          'us',
          armed({ ...COMPLETE_OVERRIDES, [envName]: 'ftp://127.0.0.1:8081' })
        )
      ).toThrow(envName);
    }
  );
});
