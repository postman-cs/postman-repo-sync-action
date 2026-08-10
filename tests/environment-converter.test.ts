import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  convertEnvironmentToYaml,
  environmentFileName,
  slugifyEnvironmentName
} from '../src/postman-v3/environment-converter.js';

describe('convertEnvironmentToYaml', () => {
  it('reshapes a sync-service env body into {name, values:[{key,value}]}', () => {
    const yaml = convertEnvironmentToYaml({
      id: '00000000-0000-0000-0000-000000000000',
      name: 'books-service - prod',
      _postman_variable_scope: 'environment',
      values: [
        { key: 'baseUrl', value: 'https://api.example.com', type: 'default', enabled: true },
        { key: 'CI', value: 'false', type: 'default', enabled: true }
      ]
    });
    expect(loadYaml(yaml)).toEqual({
      name: 'books-service - prod',
      values: [
        { key: 'baseUrl', value: 'https://api.example.com' },
        { key: 'CI', value: 'false' }
      ]
    });
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

  it('drops per-value type and enabled fields to match v12 client output', () => {
    const yaml = convertEnvironmentToYaml({
      name: 'env',
      values: [{ key: 'secretVar', value: '', type: 'secret', enabled: true }]
    });
    const parsed = loadYaml(yaml) as { values: Array<Record<string, unknown>> };
    expect(parsed.values[0]).toEqual({ key: 'secretVar', value: '' });
    expect(parsed.values[0]).not.toHaveProperty('type');
    expect(parsed.values[0]).not.toHaveProperty('enabled');
  });

  it('defaults missing values array to empty', () => {
    expect(loadYaml(convertEnvironmentToYaml({ name: 'env' }))).toEqual({
      name: 'env',
      values: []
    });
  });

  it('defaults missing name to empty string', () => {
    expect(loadYaml(convertEnvironmentToYaml({ values: [] }))).toEqual({
      name: '',
      values: []
    });
  });

  it('coerces non-string values to empty string (defensive)', () => {
    const yaml = convertEnvironmentToYaml({
      name: 'env',
      values: [
        { key: 'num', value: 42 },
        { key: 'bool', value: true },
        { key: 'nested', value: { deep: 1 } },
        { key: 'nil', value: null }
      ]
    });
    expect(loadYaml(yaml)).toEqual({
      name: 'env',
      values: [
        { key: 'num', value: '' },
        { key: 'bool', value: '' },
        { key: 'nested', value: '' },
        { key: 'nil', value: '' }
      ]
    });
  });

  it('handles null/undefined input without throwing', () => {
    expect(loadYaml(convertEnvironmentToYaml(null))).toEqual({ name: '', values: [] });
    expect(loadYaml(convertEnvironmentToYaml(undefined))).toEqual({ name: '', values: [] });
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

  it('emits YAML that round-trips through js-yaml load', () => {
    const yaml = convertEnvironmentToYaml({
      name: 'multi env',
      values: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2' }
      ]
    });
    expect(() => loadYaml(yaml)).not.toThrow();
  });
});

describe('slugifyEnvironmentName', () => {
  it('lowercases and collapses whitespace to hyphens', () => {
    expect(slugifyEnvironmentName('Books Service')).toBe('books-service');
  });

  it('strips unsafe characters', () => {
    expect(slugifyEnvironmentName('Books & Service!')).toBe('books-service');
  });

  it('preserves already-slugged input verbatim', () => {
    expect(slugifyEnvironmentName('books-service')).toBe('books-service');
  });

  it('collapses runs of hyphens', () => {
    expect(slugifyEnvironmentName('foo   ---   bar')).toBe('foo-bar');
  });

  it('trims leading/trailing punctuation', () => {
    expect(slugifyEnvironmentName('---foo---')).toBe('foo');
    expect(slugifyEnvironmentName('...foo...')).toBe('foo');
  });

  it('preserves dots and underscores', () => {
    expect(slugifyEnvironmentName('v1.0_test')).toBe('v1.0_test');
  });
});

describe('environmentFileName', () => {
  it('builds `<workspace-slug> - <env-slug>.environment.yaml`', () => {
    expect(environmentFileName('books-service', 'prod')).toBe('books-service - prod.environment.yaml');
  });

  it('slugifies both components independently', () => {
    expect(environmentFileName('Books Service', 'Prod Env')).toBe('books-service - prod-env.environment.yaml');
  });
});
