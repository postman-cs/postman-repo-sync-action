import { environmentFileName } from './environment-yaml.js';
import { createHash } from 'node:crypto';

export type EnvironmentVariableDefinition = {
  key: string;
  value: string;
  type: 'default' | 'secret';
  enabled: boolean;
};

export type EnvironmentDefinition = {
  slug: string;
  values: EnvironmentVariableDefinition[];
};

export type ParsedEnvironmentDefinitions = {
  /** Ordered logical identities consumed by the existing orchestration/state code. */
  environments: string[];
  /** Rich definitions only. Legacy string entries intentionally have no map entry. */
  definitions: Record<string, EnvironmentDefinition>;
};

export type DurableEnvironmentPolicy = 'create-only' | 'refresh';

export type DurableEnvironmentDefinitionDigestInput = {
  workspaceId: string;
  projectKey: string;
  projectName: string;
  policy: DurableEnvironmentPolicy;
  environments: readonly EnvironmentDefinition[];
};

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ENVIRONMENTS = 100;
const MAX_VALUES_PER_ENVIRONMENT = 500;
const MAX_SLUG_LENGTH = 256;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_LENGTH = 256 * 1024;
const RESERVED_VARIABLE_KEYS = new Set(['x-pm-onboarding']);
const BIDI_FORMATTING_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const DURABLE_DEFINITION_SCHEMA = 'env-definition-v1';

type StringBudget = (value: string) => void;

function createResolvedInputBudget(): StringBudget {
  let bytes = 0;
  return (value: string): void => {
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_INPUT_BYTES) {
      throw new Error(
        `Resolved environment definitions must not exceed ${MAX_INPUT_BYTES} bytes`
      );
    }
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    // Field names are untrusted input too. Do not echo them into CI logs where
    // control characters or customer data could create a secondary leak.
    throw new Error(`${label} contains ${unknown.length} unsupported field(s)`);
  }
}

function assertNonEmptyBoundedString(
  value: unknown,
  label: string,
  maxLength: number
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} must not exceed ${maxLength} characters`);
  }
}

function assertEnvironmentSlug(
  slug: unknown,
  label: string,
  requireCanonicalWhitespace: boolean
): asserts slug is string {
  assertNonEmptyBoundedString(slug, `${label}.slug`, MAX_SLUG_LENGTH);
  if (requireCanonicalWhitespace && slug !== slug.trim()) {
    throw new Error(`${label}.slug must not have leading or trailing whitespace`);
  }
  if (BIDI_FORMATTING_CONTROLS.test(slug)) {
    throw new Error(`${label}.slug must not contain bidirectional formatting controls`);
  }
  // Reuse the canonical artifact identity validator so invalid Unicode, path
  // separators, control characters, and empty sanitized names fail at input
  // resolution rather than after cloud work has begun.
  environmentFileName('environment-input', slug);
}

function assertVariableKey(key: unknown, label: string): asserts key is string {
  assertNonEmptyBoundedString(key, `${label}.key`, MAX_KEY_LENGTH);
  if (!key.isWellFormed()) {
    throw new Error(`${label}.key must contain well-formed Unicode`);
  }
  if (key !== key.trim()) {
    throw new Error(`${label}.key must not have leading or trailing whitespace`);
  }
  if (BIDI_FORMATTING_CONTROLS.test(key)) {
    throw new Error(`${label}.key must not contain bidirectional formatting controls`);
  }
  if (Array.from(key).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  })) {
    throw new Error(`${label}.key must not contain control characters`);
  }
  if (RESERVED_VARIABLE_KEYS.has(key)) {
    throw new Error(`${label}.key "${key}" is reserved for action-owned metadata`);
  }
}

function parseVariable(
  value: unknown,
  label: string,
  accountString?: StringBudget
): EnvironmentVariableDefinition {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactFields(value, new Set(['key', 'value', 'type', 'enabled']), label);
  assertVariableKey(value.key, label);

  const type = value.type === undefined ? 'default' : value.type;
  if (type !== 'default' && type !== 'secret') {
    throw new Error(`${label}.type must be "default" or "secret"`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`${label}.enabled must be a boolean`);
  }
  if (value.value !== undefined && typeof value.value !== 'string') {
    throw new Error(`${label}.value must be a string when provided`);
  }

  const normalizedValue = value.value ?? '';
  if (!normalizedValue.isWellFormed()) {
    throw new Error(`${label}.value must contain well-formed Unicode`);
  }
  if (normalizedValue.length > MAX_VALUE_LENGTH) {
    throw new Error(`${label}.value must not exceed ${MAX_VALUE_LENGTH} characters`);
  }
  if (type === 'secret' && normalizedValue.length > 0) {
    // Never include the rejected value in the error: this input is not a
    // credential transport and validation failures may be logged by CI.
    throw new Error(`${label} declares a secret variable with a non-empty value`);
  }
  accountString?.(value.key);
  accountString?.(normalizedValue);

  return {
    key: value.key,
    value: normalizedValue,
    type,
    enabled: value.enabled ?? true
  };
}

function parseDefinition(
  value: unknown,
  index: number,
  accountString?: StringBudget
): EnvironmentDefinition {
  const label = `environments-json[${index}]`;
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a string slug or environment definition object`);
  }
  assertExactFields(value, new Set(['slug', 'values']), label);
  assertEnvironmentSlug(value.slug, label, true);
  accountString?.(value.slug);
  if (!Array.isArray(value.values)) {
    throw new Error(`${label}.values must be an array`);
  }
  if (value.values.length > MAX_VALUES_PER_ENVIRONMENT) {
    throw new Error(
      `${label}.values must not contain more than ${MAX_VALUES_PER_ENVIRONMENT} entries`
    );
  }

  const seenKeys = new Set<string>();
  const values = value.values.map((entry, valueIndex) => {
    const parsed = parseVariable(entry, `${label}.values[${valueIndex}]`, accountString);
    if (seenKeys.has(parsed.key)) {
      throw new Error(`${label}.values contains duplicate key "${parsed.key}"`);
    }
    seenKeys.add(parsed.key);
    return parsed;
  });

  return { slug: value.slug, values };
}

/**
 * Parse the backward-compatible environments-json action input.
 *
 * This released contract remains string-only. Rich definitions belong to the
 * separate durable-environments-json parser below.
 */
export function parseEnvironmentDefinitionsJson(raw: string): ParsedEnvironmentDefinitions {
  if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`environments-json must not exceed ${MAX_INPUT_BYTES} bytes`);
  }
  if (!raw.trim()) {
    return { environments: [], definitions: Object.create(null) as Record<string, EnvironmentDefinition> };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Native JSON.parse diagnostics can echo input fragments. Keep malformed
    // input failures deterministic and safe for CI logs.
    throw new Error('environments-json must contain valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('environments-json must contain a JSON array');
  }
  if (parsed.length > MAX_ENVIRONMENTS) {
    throw new Error(`environments-json must not contain more than ${MAX_ENVIRONMENTS} entries`);
  }

  const environments: string[] = [];
  const definitions = Object.create(null) as Record<string, EnvironmentDefinition>;
  const seenSlugs = new Set<string>();

  parsed.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(`environments-json[${index}] must be a string slug`);
    }
    // Preserve the exact identity accepted by the legacy string contract.
    assertEnvironmentSlug(entry, `environments-json[${index}]`, false);
    const slug = entry;

    if (seenSlugs.has(slug)) {
      throw new Error(`environments-json contains duplicate slug "${slug}"`);
    }
    seenSlugs.add(slug);
    environments.push(slug);
  });

  return { environments, definitions };
}

/**
 * Revalidate the structured form immediately before orchestration. This keeps
 * direct JavaScript callers and mutated resolveInputs results behind the same
 * secret/identity boundary as JSON action inputs.
 */
export function validateResolvedEnvironmentDefinitions(
  environments: unknown,
  definitions: unknown
): ParsedEnvironmentDefinitions {
  if (!Array.isArray(environments)) {
    throw new Error('Resolved environments must be an array');
  }
  if (environments.length > MAX_ENVIRONMENTS) {
    throw new Error(`Resolved environments must not contain more than ${MAX_ENVIRONMENTS} entries`);
  }
  if (!isPlainRecord(definitions)) {
    throw new Error('Resolved environment definitions must be an object');
  }

  const normalizedEnvironments: string[] = [];
  const normalizedDefinitions = Object.create(null) as Record<string, EnvironmentDefinition>;
  const seenSlugs = new Set<string>();
  const accountString = createResolvedInputBudget();

  environments.forEach((slug, index) => {
    assertEnvironmentSlug(slug, `environments[${index}]`, false);
    accountString(slug);
    if (seenSlugs.has(slug)) {
      throw new Error(`Resolved environments contain duplicate slug "${slug}"`);
    }
    seenSlugs.add(slug);
    normalizedEnvironments.push(slug);
  });

  for (const [mapSlug, rawDefinition] of Object.entries(definitions)) {
    assertEnvironmentSlug(mapSlug, 'Resolved environment definition key', true);
    accountString(mapSlug);
    const definition = parseDefinition(
      rawDefinition,
      normalizedEnvironments.indexOf(mapSlug),
      accountString
    );
    if (definition.slug !== mapSlug) {
      throw new Error(
        `Resolved environment definition key "${mapSlug}" does not match slug "${definition.slug}"`
      );
    }
    if (!seenSlugs.has(mapSlug)) {
      throw new Error(
        `Resolved environment definition "${mapSlug}" has no matching environments entry`
      );
    }
    normalizedDefinitions[mapSlug] = definition;
  }

  return {
    environments: normalizedEnvironments,
    definitions: normalizedDefinitions
  };
}

function assertDurableBoundedString(
  value: unknown,
  label: string,
  maxScalars: number
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (!value.isWellFormed()) {
    throw new Error(`${label} must contain well-formed Unicode`);
  }
  if (Array.from(value).length > maxScalars) {
    throw new Error(`${label} must not exceed ${maxScalars} Unicode scalar values`);
  }
}

function assertDurableIdentifier(value: string, label: string): void {
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
  if (Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  })) {
    throw new Error(`${label} must not contain C0 or C1 control code points`);
  }
  if (BIDI_FORMATTING_CONTROLS.test(value)) {
    throw new Error(`${label} must not contain bidirectional formatting code points`);
  }
}

function assertDurableExactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    // Durable definitions may contain customer configuration. Do not echo an
    // attacker-controlled field name into CI diagnostics.
    throw new Error(`${label} contains an unsupported field`);
  }
}

function assertDurableSlug(slug: unknown, label: string): asserts slug is string {
  assertDurableBoundedString(slug, `${label}.slug`, MAX_SLUG_LENGTH);
  assertDurableIdentifier(slug, `${label}.slug`);
  if (
    slug === '.' ||
    slug === '..' ||
    /[\\/]/u.test(slug) ||
    /^[A-Za-z]:/u.test(slug)
  ) {
    throw new Error(`${label}.slug must not be a path or contain path separators`);
  }
  environmentFileName('durable-environment-input', slug);
}

function assertDurableVariableKey(key: unknown, label: string): asserts key is string {
  assertDurableBoundedString(key, `${label}.key`, MAX_KEY_LENGTH);
  assertDurableIdentifier(key, `${label}.key`);
  if (RESERVED_VARIABLE_KEYS.has(key)) {
    throw new Error(`${label}.key is reserved for action-owned metadata`);
  }
}

function parseDurableVariable(value: unknown, label: string): EnvironmentVariableDefinition {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertDurableExactFields(value, new Set(['key', 'value', 'type', 'enabled']), label);
  assertDurableVariableKey(value.key, label);

  const type = value.type === undefined ? 'default' : value.type;
  if (type !== 'default' && type !== 'secret') {
    throw new Error(`${label}.type must be "default" or "secret"`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`${label}.enabled must be a boolean`);
  }
  if (value.value !== undefined && typeof value.value !== 'string') {
    throw new Error(`${label}.value must be a string when provided`);
  }

  const normalizedValue = value.value ?? '';
  if (!normalizedValue.isWellFormed()) {
    throw new Error(`${label}.value must contain well-formed Unicode`);
  }
  if (Buffer.byteLength(normalizedValue, 'utf8') > MAX_VALUE_LENGTH) {
    throw new Error(`${label}.value must not exceed ${MAX_VALUE_LENGTH} UTF-8 bytes`);
  }
  if (type === 'secret' && normalizedValue.length > 0) {
    throw new Error(`${label} declares a secret variable with a non-empty value`);
  }

  return {
    key: value.key,
    value: normalizedValue,
    type,
    enabled: value.enabled ?? true
  };
}

function parseDurableDefinition(value: unknown, index: number): EnvironmentDefinition {
  const label = `durable-environments-json[${index}]`;
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an environment definition object`);
  }
  assertDurableExactFields(value, new Set(['slug', 'values']), label);
  assertDurableSlug(value.slug, label);
  if (!Array.isArray(value.values)) {
    throw new Error(`${label}.values must be an array`);
  }
  if (value.values.length > MAX_VALUES_PER_ENVIRONMENT) {
    throw new Error(
      `${label}.values must not contain more than ${MAX_VALUES_PER_ENVIRONMENT} entries`
    );
  }

  const seenKeys = Object.create(null) as Record<string, true>;
  const values = value.values.map((entry, valueIndex) => {
    const parsed = parseDurableVariable(entry, `${label}.values[${valueIndex}]`);
    if (Object.prototype.hasOwnProperty.call(seenKeys, parsed.key)) {
      throw new Error(`${label}.values contains a duplicate variable key`);
    }
    seenKeys[parsed.key] = true;
    return parsed;
  });

  return { slug: value.slug, values };
}

function portableIdentifierCollisionKey(value: string): string {
  return value.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD');
}

/** Parse the rich-only durable environment definition contract. */
export function parseDurableEnvironmentDefinitionsJson(
  raw: string
): ParsedEnvironmentDefinitions {
  if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`durable-environments-json must not exceed ${MAX_INPUT_BYTES} UTF-8 bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('durable-environments-json must contain valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('durable-environments-json must contain a JSON array');
  }
  if (parsed.length > MAX_ENVIRONMENTS) {
    throw new Error(
      `durable-environments-json must not contain more than ${MAX_ENVIRONMENTS} entries`
    );
  }

  const environments: string[] = [];
  const definitions = Object.create(null) as Record<string, EnvironmentDefinition>;
  const collisionOwners = Object.create(null) as Record<string, true>;

  parsed.forEach((entry, index) => {
    const definition = parseDurableDefinition(entry, index);
    const collisionKey = portableIdentifierCollisionKey(definition.slug);
    if (Object.prototype.hasOwnProperty.call(collisionOwners, collisionKey)) {
      throw new Error('durable-environments-json contains colliding environment slugs');
    }
    collisionOwners[collisionKey] = true;
    environments.push(definition.slug);
    definitions[definition.slug] = definition;
  });

  return { environments, definitions };
}

/**
 * Revalidate the normalized durable shape immediately before planning or
 * mutation. Direct JavaScript callers must cross the same identity, Unicode,
 * size, and secret boundary as JSON action/CLI callers.
 */
export function validateResolvedDurableEnvironmentDefinitions(
  environments: unknown,
  definitions: unknown
): ParsedEnvironmentDefinitions {
  if (!Array.isArray(environments)) {
    throw new Error('Resolved durable environments must be an array');
  }
  if (environments.length > MAX_ENVIRONMENTS) {
    throw new Error(
      `Resolved durable environments must not contain more than ${MAX_ENVIRONMENTS} entries`
    );
  }
  if (!isPlainRecord(definitions)) {
    throw new Error('Resolved durable environment definitions must be an object');
  }

  const normalizedEnvironments: string[] = [];
  const normalizedDefinitions = Object.create(null) as Record<string, EnvironmentDefinition>;
  const collisionOwners = Object.create(null) as Record<string, true>;
  const accountString = createResolvedInputBudget();

  environments.forEach((rawSlug, index) => {
    assertDurableSlug(rawSlug, `durableEnvironments[${index}]`);
    const collisionKey = portableIdentifierCollisionKey(rawSlug);
    if (Object.prototype.hasOwnProperty.call(collisionOwners, collisionKey)) {
      throw new Error('Resolved durable environments contain colliding slugs');
    }
    collisionOwners[collisionKey] = true;
    normalizedEnvironments.push(rawSlug);
  });

  for (const [mapSlug, rawDefinition] of Object.entries(definitions)) {
    assertDurableSlug(mapSlug, 'Resolved durable environment definition key');
    const definition = parseDurableDefinition(
      rawDefinition,
      normalizedEnvironments.indexOf(mapSlug)
    );
    if (definition.slug !== mapSlug) {
      throw new Error('Resolved durable environment definition key does not match its slug');
    }
    if (!normalizedEnvironments.includes(mapSlug)) {
      throw new Error('Resolved durable environment definition has no matching environments entry');
    }
    accountString(definition.slug);
    for (const value of definition.values) {
      accountString(value.key);
      accountString(value.value);
    }
    normalizedDefinitions[mapSlug] = definition;
  }

  for (const slug of normalizedEnvironments) {
    if (!Object.prototype.hasOwnProperty.call(normalizedDefinitions, slug)) {
      throw new Error('Resolved durable environment is missing its rich definition');
    }
  }

  return {
    environments: normalizedEnvironments,
    definitions: normalizedDefinitions
  };
}

/** Compute the versioned digest of normalized durable environment definitions. */
export function computeDurableEnvironmentDefinitionDigest(
  input: DurableEnvironmentDefinitionDigestInput
): string {
  const envelope = {
    schema: DURABLE_DEFINITION_SCHEMA,
    workspaceId: input.workspaceId,
    projectKey: input.projectKey,
    projectName: input.projectName,
    policy: input.policy,
    environments: input.environments.map((definition) => ({
      slug: definition.slug,
      values: definition.values.map((value) => ({
        key: value.key,
        value: value.value,
        type: value.type,
        enabled: value.enabled
      }))
    }))
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(envelope), 'utf8')
    .digest('hex');
  return `${DURABLE_DEFINITION_SCHEMA}:sha256:${digest}`;
}
