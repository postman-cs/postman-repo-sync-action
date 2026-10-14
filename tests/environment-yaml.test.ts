import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  assertUniqueEnvironmentFileNames,
  environmentFileName,
  serializeEnvironmentYaml
} from '../src/lib/postman/environment-yaml.js';

describe('environment YAML serialization', () => {
  it('writes canonical values and metadata', () => {
    const yaml = serializeEnvironmentYaml(
      {
        color: 245,
        values: [
          { key: 'host', value: 42 },
          { key: 'token', secret: true, value: 'do-not-write' },
          { key: 'disabled', value: null, enabled: false, description: 7 },
          { key: 'typed-secret', type: 'secret', source: 'vault://token' }
        ]
      },
      'Production'
    );

    expect(loadYaml(yaml)).toEqual({
      name: 'Production',
      values: [
        { key: 'host', value: '42' },
        { key: 'token', secret: true },
        { key: 'disabled', value: '', disabled: true, description: '7' },
        { key: 'typed-secret', secret: true, source: 'vault://token' }
      ],
      color: 245
    });
    expect(yaml).not.toContain('do-not-write');
  });

  it('rejects malformed service payloads', () => {
    expect(() => serializeEnvironmentYaml(null, 'Production')).toThrow('object body');
    expect(() => serializeEnvironmentYaml({ values: {} }, 'Production')).toThrow('values array');
    expect(() => serializeEnvironmentYaml([], 'Production')).toThrow('object body');
  });

  it('omits invalid colors while preserving the environment', () => {
    expect(loadYaml(serializeEnvironmentYaml({ values: [], color: 360 }, 'Production'))).toEqual({
      name: 'Production',
      values: []
    });
  });
});

describe('environment artifact filenames', () => {
  it('preserves the environment suffix when the project name is long', () => {
    const name = environmentFileName('a'.repeat(200), 'Production');
    expect(name).toMatch(/ - Production\.environment\.yaml$/);
    expect(name.endsWith('Production.environment.yaml')).toBe(true);
    expect(Buffer.byteLength(name.slice(0, -'.environment.yaml'.length))).toBeLessThanOrEqual(64);
  });

  it.each(['', 'has/slash', 'has\\slash', 'has\u0000control'])('rejects invalid environment name %j', (name) => {
    expect(() => environmentFileName('project', name)).toThrow('environment name');
  });

  it('rejects filenames that collide after normalization', () => {
    expect(() => assertUniqueEnvironmentFileNames('project', ['Production', 'production'])).toThrow(
      'resolve to the same artifact filename'
    );
  });
});
