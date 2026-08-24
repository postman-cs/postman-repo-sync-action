import { describe, expect, it } from 'vitest';

import {
  computeDurableEnvironmentDefinitionDigest,
  parseDurableEnvironmentDefinitionsJson,
  parseEnvironmentDefinitionsJson,
  validateResolvedDurableEnvironmentDefinitions
} from '../src/lib/postman/environment-definitions.js';

function orderedDefinitions(raw: string) {
  const parsed = parseDurableEnvironmentDefinitionsJson(raw);
  return parsed.environments.map((slug) => parsed.definitions[slug]!);
}

describe('durable environment definitions', () => {
  it('leaves the legacy parser string-only with exact string identities', () => {
    const legacy = parseEnvironmentDefinitionsJson('["prod"," qa "]');

    expect(legacy.environments).toEqual(['prod', ' qa ']);
    expect(Object.keys(legacy.definitions)).toEqual([]);
    expect(() => parseEnvironmentDefinitionsJson(
      '[{"slug":"dev","values":[]}]'
    )).toThrow(/must be a string slug/);
  });

  it('accepts only rich entries and materializes every default', () => {
    const parsed = parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      {
        slug: 'dev',
        values: [
          { key: 'baseUrl', value: 'https://dev.example.com' },
          { key: 'disabled', enabled: false },
          { key: 'jwtToken', type: 'secret' }
        ]
      }
    ]));

    expect(parsed.environments).toEqual(['dev']);
    expect(parsed.definitions.dev).toEqual({
      slug: 'dev',
      values: [
        {
          key: 'baseUrl',
          value: 'https://dev.example.com',
          type: 'default',
          enabled: true
        },
        { key: 'disabled', value: '', type: 'default', enabled: false },
        { key: 'jwtToken', value: '', type: 'secret', enabled: true }
      ]
    });
    expect(() => parseDurableEnvironmentDefinitionsJson('["dev"]')).toThrow(
      /must be an environment definition object/
    );
  });

  it('stores prototype-sensitive slugs and keys only as own properties', () => {
    const parsed = parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      {
        slug: '__proto__',
        values: [
          { key: '__proto__' },
          { key: 'prototype' },
          { key: 'constructor' }
        ]
      }
    ]));

    expect(Object.getPrototypeOf(parsed.definitions)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(parsed.definitions, '__proto__')).toBe(true);
    expect(parsed.definitions.__proto__?.values.map(({ key }) => key)).toEqual([
      '__proto__',
      'prototype',
      'constructor'
    ]);
  });

  it.each([
    ['non-array root', '{}', /must contain a JSON array/],
    ['missing slug', '[{"values":[]}]', /slug must be a non-empty string/],
    ['missing values', '[{"slug":"dev"}]', /values must be an array/],
    ['unknown environment field', '[{"slug":"dev","values":[],"uid":"secret"}]', /unsupported field/],
    ['unknown value field', '[{"slug":"dev","values":[{"key":"one","vault":"secret"}]}]', /unsupported field/],
    ['invalid type', '[{"slug":"dev","values":[{"key":"one","type":"vault"}]}]', /type must be/],
    ['invalid enabled', '[{"slug":"dev","values":[{"key":"one","enabled":"yes"}]}]', /enabled must be a boolean/],
    ['duplicate key', '[{"slug":"dev","values":[{"key":"one"},{"key":"one"}]}]', /duplicate variable key/],
    ['reserved key', '[{"slug":"dev","values":[{"key":"x-pm-onboarding"}]}]', /reserved/],
    ['dot slug', '[{"slug":"..","values":[]}]', /must not be a path/],
    ['separator slug', '[{"slug":"dev\\\\refresh","values":[]}]', /path separators/],
    ['drive-qualified slug', '[{"slug":"C:dev","values":[]}]', /must not be a path/],
    ['trimmed slug', '[{"slug":" dev ","values":[]}]', /leading or trailing whitespace/],
    ['trimmed key', '[{"slug":"dev","values":[{"key":" jwt "}]}]', /leading or trailing whitespace/]
  ])('rejects %s', (_name, raw, expected) => {
    expect(() => parseDurableEnvironmentDefinitionsJson(raw)).toThrow(expected);
  });

  it.each([
    '\u0000',
    '\u001f',
    '\u007f',
    '\u0085',
    '\u009f',
    '\u061c',
    '\u200e',
    '\u200f',
    '\u202a',
    '\u202e',
    '\u2066',
    '\u2069'
  ])('rejects control or bidi code point U+%s in slugs and keys', (control) => {
    expect(() => parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      { slug: `dev${control}`, values: [] }
    ]))).toThrow(/control|bidirectional/);
    expect(() => parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      { slug: 'dev', values: [{ key: `jwt${control}` }] }
    ]))).toThrow(/control|bidirectional/);
  });

  it('uses Unicode scalar counts for identifiers and UTF-8 bytes for values', () => {
    const acceptedSlug = '🚀'.repeat(256);
    const acceptedValue = '🚀'.repeat(64 * 1024);
    expect(() => parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      { slug: acceptedSlug, values: [{ key: 'large', value: acceptedValue }] }
    ]))).not.toThrow();

    expect(() => parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      { slug: `${acceptedSlug}🚀`, values: [] }
    ]))).toThrow(/256 Unicode scalar values/);
    expect(() => parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      { slug: 'dev', values: [{ key: 'large', value: `${acceptedValue}x` }] }
    ]))).toThrow(/262144 UTF-8 bytes/);
  });

  it('reapplies durable Unicode, byte, collision, and prototype rules to structured callers', () => {
    const acceptedSlug = '🚀'.repeat(256);
    const accepted = parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      { slug: acceptedSlug, values: [{ key: '__proto__' }] }
    ]));

    const normalized = validateResolvedDurableEnvironmentDefinitions(
      accepted.environments,
      accepted.definitions
    );
    expect(normalized.environments).toEqual([acceptedSlug]);
    expect(Object.getPrototypeOf(normalized.definitions)).toBeNull();

    const oversizedValue = {
      slug: 'dev',
      values: [{
        key: 'large',
        value: '🚀'.repeat(64 * 1024 + 1),
        type: 'default' as const,
        enabled: true
      }]
    };
    expect(() => validateResolvedDurableEnvironmentDefinitions(
      ['dev'],
      { dev: oversizedValue }
    )).toThrow(/262144 UTF-8 bytes/);

    const composed = { slug: 'é', values: [] };
    const decomposed = { slug: 'e\u0301', values: [] };
    expect(() => validateResolvedDurableEnvironmentDefinitions(
      [composed.slug, decomposed.slug],
      { [composed.slug]: composed, [decomposed.slug]: decomposed }
    )).toThrow(/colliding slugs/);
  });

  it('bounds aggregate strings for direct structured callers', () => {
    const definition = {
      slug: 'dev',
      values: Array.from({ length: 5 }, (_entry, index) => ({
        key: `key-${index}`,
        value: 'v'.repeat(220 * 1024),
        type: 'default' as const,
        enabled: true
      }))
    };

    expect(() => validateResolvedDurableEnvironmentDefinitions(
      ['dev'],
      { dev: definition }
    )).toThrow(/must not exceed 1048576 bytes/);
  });

  it('enforces aggregate and cardinality limits', () => {
    expect(() => parseDurableEnvironmentDefinitionsJson(' '.repeat(1024 * 1024 + 1))).toThrow(
      /1048576 UTF-8 bytes/
    );
    expect(() => parseDurableEnvironmentDefinitionsJson(JSON.stringify(
      Array.from({ length: 101 }, (_entry, index) => ({ slug: `env-${index}`, values: [] }))
    ))).toThrow(/more than 100 entries/);
    expect(() => parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      {
        slug: 'dev',
        values: Array.from({ length: 501 }, (_entry, index) => ({ key: `key-${index}` }))
      }
    ]))).toThrow(/more than 500 entries/);
  });

  it('rejects malformed Unicode and normalized case-fold collisions', () => {
    expect(() => parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      { slug: 'dev\ud800', values: [] }
    ]))).toThrow(/well-formed Unicode/);
    expect(() => parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      { slug: 'é', values: [] },
      { slug: 'e\u0301', values: [] }
    ]))).toThrow(/colliding environment slugs/);
    expect(() => parseDurableEnvironmentDefinitionsJson(JSON.stringify([
      { slug: 'STRASSE', values: [] },
      { slug: 'straße', values: [] }
    ]))).toThrow(/colliding environment slugs/);
  });

  it('rejects populated secret values without echoing them', () => {
    const canary = 'runtime-jwt-that-must-not-leak';
    let message = '';
    try {
      parseDurableEnvironmentDefinitionsJson(JSON.stringify([
        { slug: 'dev', values: [{ key: 'jwtToken', type: 'secret', value: canary }] }
      ]));
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/secret variable with a non-empty value/);
    expect(message).not.toContain(canary);
  });

  it('matches the normative env-definition-v1 digest vector', () => {
    const environments = orderedDefinitions(JSON.stringify([
      {
        values: [
          { value: 'https://dev.example.com', key: 'baseUrl' },
          { type: 'secret', key: 'jwtToken' }
        ],
        slug: 'dev'
      }
    ], null, 2));

    expect(computeDurableEnvironmentDefinitionDigest({
      workspaceId: 'ws-123',
      projectKey: 'payments',
      projectName: 'Payments API',
      policy: 'create-only',
      environments
    })).toBe(
      'env-definition-v1:sha256:1094bacc7eab489cc441ea5057ab61c268af1ca8e5d6eab17016df9cd7a62187'
    );
  });

  it('makes input whitespace and object-key order immaterial while preserving array order', () => {
    const compact = orderedDefinitions(
      '[{"slug":"dev","values":[{"key":"one","value":"1"},{"key":"two","value":"2"}]}]'
    );
    const reorderedKeys = orderedDefinitions(JSON.stringify([
      {
        values: [
          { enabled: true, type: 'default', value: '1', key: 'one' },
          { value: '2', key: 'two' }
        ],
        slug: 'dev'
      }
    ], null, 2));
    const context = {
      workspaceId: 'ws-123',
      projectKey: 'payments',
      projectName: 'Payments API',
      policy: 'refresh' as const
    };

    const compactDigest = computeDurableEnvironmentDefinitionDigest({ ...context, environments: compact });
    expect(computeDurableEnvironmentDefinitionDigest({
      ...context,
      environments: reorderedKeys
    })).toBe(compactDigest);
    expect(computeDurableEnvironmentDefinitionDigest({
      ...context,
      environments: [{
        ...compact[0]!,
        values: [...compact[0]!.values].reverse()
      }]
    })).not.toBe(compactDigest);
  });
});
