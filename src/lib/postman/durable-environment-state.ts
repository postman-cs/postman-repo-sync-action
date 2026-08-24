import * as path from 'node:path';

import {
  canonicalizeManifestRef,
  StateUnreadableError,
  type DurableEnvironmentPolicy,
  type DurableEnvironmentProvisioningEntry,
  type DurableEnvironmentProvisioningProject,
  type EnvironmentProvisioningState,
  type PostmanResourcesState
} from './environment-reconciliation.js';

export const DURABLE_ENVIRONMENT_RESOURCES_STATE_VERSION = 3;

const DEFINITION_DIGEST_PATTERN = /^env-definition-v1:sha256:[0-9a-f]{64}$/u;
const DUPLICATE_UID_FIELDS = new Set([
  'uid',
  'environmentUid',
  'environmentUID',
  'postmanUid',
  'postmanUID'
]);

type PlainRecord = Record<string, unknown>;

export type ResolvedDurableEnvironmentState = {
  projectKey: string;
  slug: string;
  uid: string;
  artifact: string;
  displayName: string;
  policy: DurableEnvironmentPolicy;
  definitionDigest: string;
};

export type DurableEnvironmentStateUpsert = ResolvedDurableEnvironmentState;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): never {
  throw new StateUnreadableError(message);
}

function requirePlainRecord(value: unknown, label: string): PlainRecord {
  if (!isPlainRecord(value)) {
    fail(`${label} must be a mapping`);
  }
  return value;
}

function requireStateKey(value: string, label: string): string {
  if (!value || value !== value.trim()) {
    fail(`${label} must be a non-empty string without surrounding whitespace`);
  }
  if ([...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  })) {
    fail(`${label} must not contain control characters`);
  }
  return value;
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function copyToNullPrototype<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, record);
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return hasOwn(record, key) ? record[key] : undefined;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    fail(`${label} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function requireCanonicalManifestRef(value: unknown, label: string): string {
  const artifact = requireString(value, label);
  const canonical = canonicalizeManifestRef(artifact);
  if (artifact !== canonical) {
    fail(`${label} must be a canonical repository-relative manifest reference`);
  }
  const repoPath = path.posix.normalize(path.posix.join('.postman', artifact));
  if (
    path.posix.isAbsolute(repoPath) ||
    repoPath === '..' ||
    repoPath.startsWith('../')
  ) {
    fail(`${label} resolves outside the repository`);
  }
  return artifact;
}

function requireArtifactRef(value: unknown, label: string): string {
  const artifact = requireCanonicalManifestRef(value, label);
  if (!artifact.includes('/environments/') || !artifact.endsWith('.environment.yaml')) {
    fail(`${label} must reference a canonical environment YAML artifact`);
  }
  return artifact;
}

function requirePolicy(value: unknown, label: string): DurableEnvironmentPolicy {
  if (value !== 'create-only' && value !== 'refresh') {
    fail(`${label} must be "create-only" or "refresh"`);
  }
  return value;
}

function requireDefinitionDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DEFINITION_DIGEST_PATTERN.test(value)) {
    fail(`${label} must use env-definition-v1:sha256:<lowercase hex>`);
  }
  return value;
}

function assertNoDuplicateUidField(entry: PlainRecord, label: string): void {
  const duplicate = Object.keys(entry).find((key) => DUPLICATE_UID_FIELDS.has(key));
  if (duplicate) {
    fail(`${label}.${duplicate} duplicates canonical.environments UID authority`);
  }
}

function canonicalEnvironmentEntries(
  state: PostmanResourcesState
): Array<{ artifact: string; uid: string }> {
  if (state.canonical === undefined) return [];
  const canonical = requirePlainRecord(state.canonical, 'canonical');
  if (canonical.environments === undefined) return [];
  const environments = requirePlainRecord(
    canonical.environments,
    'canonical.environments'
  );
  return Object.entries(environments).map(([rawArtifact, rawUid]) => {
    const entryLabel = `canonical.environments[${JSON.stringify(rawArtifact)}]`;
    const uid = requireString(rawUid, entryLabel);
    return {
      artifact: requireCanonicalManifestRef(rawArtifact, entryLabel),
      uid
    };
  });
}

/** Reject ambiguous canonical environment aliases at the durable-write boundary. */
export function assertCanonicalEnvironmentReferences(
  state: PostmanResourcesState | null | undefined
): void {
  if (state) canonicalEnvironmentEntries(state);
}

function resolveCanonicalUid(
  entries: Array<{ artifact: string; uid: string }>,
  artifact: string,
  label: string
): string {
  const matches = entries.filter((entry) => entry.artifact === artifact);
  if (matches.length === 0) {
    fail(`${label}.artifact does not resolve through canonical.environments`);
  }
  if (matches.length > 1) {
    fail(`${label}.artifact resolves through multiple canonical.environments entries`);
  }
  return matches[0].uid;
}

function parseEntry(
  rawEntry: unknown,
  projectKey: string,
  slug: string,
  canonicalEntries: Array<{ artifact: string; uid: string }>
): ResolvedDurableEnvironmentState {
  const label = `environmentProvisioning.projects[${JSON.stringify(projectKey)}].environments[${JSON.stringify(slug)}]`;
  const entry = requirePlainRecord(rawEntry, label);
  assertNoDuplicateUidField(entry, label);
  const artifact = requireArtifactRef(entry.artifact, `${label}.artifact`);
  return {
    projectKey,
    slug,
    uid: resolveCanonicalUid(canonicalEntries, artifact, label),
    artifact,
    displayName: requireString(entry.displayName, `${label}.displayName`),
    policy: requirePolicy(entry.policy, `${label}.policy`),
    definitionDigest: requireDefinitionDigest(
      entry.definitionDigest,
      `${label}.definitionDigest`
    )
  };
}

/**
 * Parse and validate state v3 durable metadata.
 *
 * State v1/v2, or state v3 without environmentProvisioning metadata, resolves
 * to no durable bindings. Canonical environment mappings are never implicitly
 * adopted. Every returned UID is resolved exclusively from canonical.environments.
 */
export function parseDurableEnvironmentProvisioningState(
  state: PostmanResourcesState | null | undefined
): ResolvedDurableEnvironmentState[] {
  if (!state || state.environmentProvisioning === undefined) return [];
  if (state.version !== DURABLE_ENVIRONMENT_RESOURCES_STATE_VERSION) {
    fail(
      `environmentProvisioning metadata requires resources state version ${DURABLE_ENVIRONMENT_RESOURCES_STATE_VERSION}`
    );
  }

  const provisioning = requirePlainRecord(
    state.environmentProvisioning,
    'environmentProvisioning'
  );
  if (provisioning.projects === undefined) return [];
  const projects = requirePlainRecord(
    provisioning.projects,
    'environmentProvisioning.projects'
  );
  const canonicalEntries = canonicalEnvironmentEntries(state);
  const resolved: ResolvedDurableEnvironmentState[] = [];
  const artifactClaims = new Map<string, string>();
  const uidClaims = new Map<string, string>();

  for (const [rawProjectKey, rawProject] of Object.entries(projects)) {
    const projectKey = requireStateKey(
      rawProjectKey,
      'environmentProvisioning project key'
    );
    const project = requirePlainRecord(
      rawProject,
      `environmentProvisioning.projects[${JSON.stringify(projectKey)}]`
    );
    if (project.environments === undefined) continue;
    const environments = requirePlainRecord(
      project.environments,
      `environmentProvisioning.projects[${JSON.stringify(projectKey)}].environments`
    );
    for (const [rawSlug, rawEntry] of Object.entries(environments)) {
      const slug = requireStateKey(rawSlug, `durable environment slug for ${projectKey}`);
      const entry = parseEntry(rawEntry, projectKey, slug, canonicalEntries);
      const identity = `${projectKey}/${slug}`;
      const priorArtifactClaim = artifactClaims.get(entry.artifact);
      if (priorArtifactClaim && priorArtifactClaim !== identity) {
        fail(
          `durable environments ${priorArtifactClaim} and ${identity} claim artifact ${entry.artifact}`
        );
      }
      const priorUidClaim = uidClaims.get(entry.uid);
      if (priorUidClaim && priorUidClaim !== identity) {
        fail(
          `durable environments ${priorUidClaim} and ${identity} claim UID ${entry.uid}`
        );
      }
      artifactClaims.set(entry.artifact, identity);
      uidClaims.set(entry.uid, identity);
      resolved.push(entry);
    }
  }

  if (resolved.length > 0) {
    const workspace = requirePlainRecord(state.workspace, 'workspace');
    requireString(workspace.id, 'workspace.id');
  }
  return resolved;
}

function assertUpsertInput(input: DurableEnvironmentStateUpsert): void {
  requireStateKey(input.projectKey, 'durable project key');
  requireStateKey(input.slug, 'durable environment slug');
  requireString(input.uid, 'durable environment UID');
  requireArtifactRef(input.artifact, 'durable environment artifact');
  requireString(input.displayName, 'durable environment display name');
  requirePolicy(input.policy, 'durable environment policy');
  requireDefinitionDigest(input.definitionDigest, 'durable environment definition digest');
}

/**
 * Merge one reviewed durable binding into resources state v3.
 *
 * The canonical environment mapping must already contain exactly the supplied
 * artifact/UID pair. This helper never creates or copies a UID into metadata,
 * and it preserves unknown fields at every metadata level.
 */
export function upsertDurableEnvironmentProvisioningState(
  state: PostmanResourcesState,
  input: DurableEnvironmentStateUpsert
): PostmanResourcesState {
  assertUpsertInput(input);
  if (state.version !== 2 && state.version !== DURABLE_ENVIRONMENT_RESOURCES_STATE_VERSION) {
    fail('durable environment state upsert requires resources state version 2 or 3');
  }
  if (state.environmentProvisioning !== undefined) {
    parseDurableEnvironmentProvisioningState(state);
  }

  const canonicalEntries = canonicalEnvironmentEntries(state);
  const canonicalUid = resolveCanonicalUid(
    canonicalEntries,
    input.artifact,
    `durable environment ${input.projectKey}/${input.slug}`
  );
  if (canonicalUid !== input.uid) {
    fail(
      `durable environment ${input.projectKey}/${input.slug} expected UID ${input.uid}, but canonical.environments resolves ${canonicalUid}`
    );
  }

  const priorProvisioning = (state.environmentProvisioning ?? {}) as EnvironmentProvisioningState;
  const priorProjects = copyToNullPrototype((priorProvisioning.projects ?? {}) as Record<
    string,
    DurableEnvironmentProvisioningProject
  >);
  const priorProject = ownValue(priorProjects, input.projectKey) ?? {};
  const priorEnvironments = copyToNullPrototype((priorProject.environments ?? {}) as Record<
    string,
    DurableEnvironmentProvisioningEntry
  >);
  const priorEntry = ownValue(priorEnvironments, input.slug) ?? {};
  const nextEnvironments = copyToNullPrototype(priorEnvironments);
  nextEnvironments[input.slug] = {
    ...priorEntry,
    artifact: input.artifact,
    displayName: input.displayName,
    policy: input.policy,
    definitionDigest: input.definitionDigest
  };
  const nextProjects = copyToNullPrototype(priorProjects);
  nextProjects[input.projectKey] = {
    ...priorProject,
    environments: nextEnvironments
  };

  const nextState: PostmanResourcesState = {
    ...state,
    version: DURABLE_ENVIRONMENT_RESOURCES_STATE_VERSION,
    environmentProvisioning: {
      ...priorProvisioning,
      projects: nextProjects
    }
  };
  parseDurableEnvironmentProvisioningState(nextState);
  return nextState;
}
