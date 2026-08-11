import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  assertEnvironmentYamlRoundTrip,
  assertUniqueEnvironmentFileNames,
  convertEnvironmentToYaml,
  environmentFileName
} from '../src/postman-v3/environment-converter.js';

describe('convertEnvironmentToYaml', () => {
  it('mirrors the canonical Postman Local Mode environment filesystem contract', () => {
    const yaml = convertEnvironmentToYaml({
      id: '00000000-0000-0000-0000-000000000000',
      name: 'Books Service - prod',
      _postman_variable_scope: 'environment',
      color: 27,
      values: [
        {
          key: 'baseUrl',
          value: 'https://api.example.com',
          type: 'default',
          enabled: false,
          description: 'Runtime endpoint'
        },
        {
          key: 'TOKEN',
          value: 'must-not-be-written',
          enabled: true,
          secret: true,
          source: {
            provider: 'postman',
            postman: { type: 'local', secretId: 'secret-123' }
          }
        },
        { key: 'LEGACY_SECRET', value: '', type: 'secret', enabled: true }
      ]
    });
    expect(loadYaml(yaml)).toEqual({
      name: 'Books Service - prod',
      values: [
        {
          key: 'baseUrl',
          value: 'https://api.example.com',
          disabled: true,
          description: 'Runtime endpoint'
        },
        {
          key: 'TOKEN',
          secret: true,
          source: {
            provider: 'postman',
            postman: { type: 'local', secretId: 'secret-123' }
          }
        },
        { key: 'LEGACY_SECRET', secret: true }
      ],
      color: 27
    });
    expect(yaml).not.toContain('must-not-be-written');
    expect(yaml.indexOf('value: https://api.example.com')).toBeLessThan(
      yaml.indexOf('disabled: true')
    );
    expect(yaml.indexOf('disabled: true')).toBeLessThan(yaml.indexOf('description:'));
  });

  it('drops volatile fields (id, _postman_variable_scope, timestamps)', () => {
    const yaml = convertEnvironmentToYaml({
      id: 'abc',
      name: 'env',
      _postman_variable_scope: 'environment',
      createdAt: '2020-01-01',
      updatedAt: '2020-01-02',
      owner: '12345',
      values: [{ key: 'k', value: 'v' }]
    });
    expect(yaml).not.toContain('id:');
    expect(yaml).not.toContain('_postman_variable_scope');
    expect(yaml).not.toContain('createdAt');
    expect(yaml).not.toContain('updatedAt');
    expect(yaml).not.toContain('owner:');
  });

  it('redacts legacy typed secrets into canonical secret entries', () => {
    const yaml = convertEnvironmentToYaml({
      name: 'env',
      values: [{ key: 'secretVar', value: '', type: 'secret', enabled: true }]
    });
    const parsed = loadYaml(yaml) as { values: Array<Record<string, unknown>> };
    expect(parsed.values[0]).toEqual({ key: 'secretVar', secret: true });
    expect(parsed.values[0]).not.toHaveProperty('type');
    expect(parsed.values[0]).not.toHaveProperty('enabled');
    expect(parsed.values[0]).not.toHaveProperty('value');
  });

  it('emits disabled only for enabled=false and preserves descriptions', () => {
    const parsed = loadYaml(convertEnvironmentToYaml({
      name: 'env',
      values: [
        { key: 'on', value: '1', enabled: true },
        { key: 'default-on', value: '2' },
        { key: 'off', value: '3', enabled: false, description: 'Disabled entry' }
      ]
    })) as { values: Array<Record<string, unknown>> };
    expect(parsed.values).toEqual([
      { key: 'on', value: '1' },
      { key: 'default-on', value: '2' },
      { key: 'off', value: '3', disabled: true, description: 'Disabled entry' }
    ]);
  });

  it('preserves only valid integer colors', () => {
    expect(loadYaml(convertEnvironmentToYaml({ name: 'valid', values: [], color: 359 })))
      .toEqual({ name: 'valid', values: [], color: 359 });
    for (const color of [-1, 360, 4.5, '5']) {
      expect(loadYaml(convertEnvironmentToYaml({ name: 'invalid', values: [], color })))
        .toEqual({ name: 'invalid', values: [] });
    }
  });

  it('defaults missing values array to empty', () => {
    expect(loadYaml(convertEnvironmentToYaml({ name: 'env' }))).toEqual({
      name: 'env',
      values: []
    });
  });

  it.each([{}, { name: '' }, null, undefined])(
    'rejects a missing or empty cloud environment name (%j)',
    (body) => {
      expect(() => convertEnvironmentToYaml(body)).toThrow(/non-empty string name/);
    }
  );

  it('normalizes unexpected primitive keys, values, and descriptions like app migration', () => {
    const yaml = convertEnvironmentToYaml({
      name: 'env',
      values: [
        { key: 'num', value: 42 },
        { key: 'bool', value: true },
        { key: 'nil', value: null, description: 7 }
      ]
    });
    expect(loadYaml(yaml)).toEqual({
      name: 'env',
      values: [
        { key: 'num', value: '42' },
        { key: 'bool', value: 'true' },
        { key: 'nil', value: '', description: '7' }
      ]
    });
  });

  it('keeps YAML-reserved-looking string values as strings on round-trip', () => {
    const yaml = convertEnvironmentToYaml({
      name: 'env',
      values: [
        { key: 'flagFalse', value: 'false' },
        { key: 'flagTrue', value: 'true' },
        { key: 'numeric', value: '42' },
        { key: 'empty', value: '' }
      ]
    });
    const parsed = loadYaml(yaml) as { values: Array<{ value: unknown }> };
    for (const entry of parsed.values) {
      expect(typeof entry.value).toBe('string');
    }
  });

  it('emits YAML that round-trips through the canonical candidate validator', () => {
    const yaml = convertEnvironmentToYaml({
      name: 'multi env',
      values: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2' }
      ]
    });
    expect(() => assertEnvironmentYamlRoundTrip(yaml, yaml)).not.toThrow();
  });
});

describe('environmentFileName', () => {
  it('builds from the full stable cloud display name', () => {
    expect(environmentFileName('books-service', 'prod')).toBe('books-service - prod.environment.yaml');
  });

  it('preserves app-supported spaces and case', () => {
    expect(environmentFileName('Books Service', 'Prod Env')).toBe('Books Service - Prod Env.environment.yaml');
  });

  it('supports logical environment names containing the client filename separator', () => {
    expect(environmentFileName('Books Service', 'qa - west')).toBe(
      'Books Service - qa - west.environment.yaml'
    );
  });

  it('rejects an empty logical environment name', () => {
    expect(() => environmentFileName('books-service', '')).toThrow(/non-empty filesystem name/);
  });

  it('rejects path separators before legacy migration paths can be derived', () => {
    expect(() => environmentFileName('books-service', '../../../tmp/prod')).toThrow(
      /path separators/
    );
  });

  it('caps the app-sanitized display name at 64 UTF-8 bytes before the extension', () => {
    const fileName = environmentFileName('p'.repeat(60), 'production');
    expect(Buffer.byteLength(fileName.slice(0, -'.environment.yaml'.length), 'utf8')).toBe(64);
  });
});

describe('assertUniqueEnvironmentFileNames', () => {
  it.each([
    [['Prod', 'prod']],
    [[`${'x'.repeat(80)}-one`, `${'x'.repeat(80)}-two`]],
    [['caf\u00e9', 'cafe\u0301']],
    [['stra\u00dfe', 'strasse']]
  ])('rejects normalized filename collisions for %j', (names) => {
    expect(() => assertUniqueEnvironmentFileNames('books-service', names)).toThrow(
      /same artifact filename/
    );
  });

  it('accepts app-distinct spaces, hyphens, and names containing ` - `', () => {
    expect(() =>
      assertUniqueEnvironmentFileNames('books-service', ['qa env', 'qa-env', 'qa - west'])
    ).not.toThrow();
  });
});

describe('assertEnvironmentYamlRoundTrip', () => {
  it('accepts a contract fixture matching the Postman Local Mode serializer', () => {
    const captured = [
      'name: Books Service - prod',
      'values:',
      '  - key: baseUrl',
      '    value: https://api.example.com',
      '  - key: CI',
      "    value: 'false'",
      '    disabled: true',
      '    description: CI toggle',
      '  - key: TOKEN',
      '    secret: true',
      '    source:',
      '      provider: postman',
      '      postman:',
      '        type: local',
      '        secretId: secret-123',
      'color: 14',
      ''
    ].join('\n');
    expect(() => assertEnvironmentYamlRoundTrip(captured, captured)).not.toThrow();
  });

  it('rejects malformed or lossy candidates before promotion', () => {
    const expected = convertEnvironmentToYaml({
      name: 'env',
      values: [{ key: 'baseUrl', value: 'https://api.example.com' }]
    });
    expect(() => assertEnvironmentYamlRoundTrip('name: env\nvalues: nope\n', expected)).toThrow(
      /changed during round-trip/
    );
    expect(() =>
      assertEnvironmentYamlRoundTrip('name: env\nvalues: []\n', expected)
    ).toThrow(/changed during round-trip/);
  });
});
