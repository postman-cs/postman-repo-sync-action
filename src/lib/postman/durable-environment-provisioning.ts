import { createHash } from 'node:crypto';

import type {
  DurableEnvironmentPolicy,
  EnvironmentDefinition,
  EnvironmentVariableDefinition
} from './environment-definitions.js';

export type DurableEnvironmentAction =
  | 'unresolved'
  | 'review-required'
  | 'create'
  | 'reuse'
  | 'reused-preserved'
  | 'replace';

export type DurableEnvironmentBinding = {
  uid: string;
  displayName: string;
};

export type DurableEnvironmentPlanEntry = {
  slug: string;
  displayName: string;
  action: Exclude<DurableEnvironmentAction, 'reused-preserved'>;
  uid?: string;
  runtimeSlotKeys: string[];
  definition: EnvironmentDefinition;
};

export type DurableEnvironmentPublicEntry = Omit<
  DurableEnvironmentPlanEntry,
  'definition'
>;

export type DurableEnvironmentResultEntry = {
  slug: string;
  displayName: string;
  action: Exclude<DurableEnvironmentAction, 'unresolved' | 'review-required' | 'reuse'>;
  uid: string;
  runtimeSlotKeys: string[];
  observedDigest?: string;
};

export type DurableEnvironmentOrphanEntry = {
  slug: string;
  displayName: string;
  uid: string;
  action: 'retained';
};

export class DurableEnvironmentPartialApplyError extends Error {
  public readonly code = 'DURABLE_ENVIRONMENT_PARTIAL_APPLY_FAILED';
  public readonly completedEntries: readonly DurableEnvironmentResultEntry[];
  public readonly failedSlug: string;

  public constructor(
    failedSlug: string,
    completedEntries: readonly DurableEnvironmentResultEntry[],
    cause: unknown
  ) {
    super(
      `Durable environment apply failed for "${failedSlug}" after ${completedEntries.length} completed entr${completedEntries.length === 1 ? 'y' : 'ies'}`,
      { cause }
    );
    this.name = 'DurableEnvironmentPartialApplyError';
    this.failedSlug = failedSlug;
    this.completedEntries = completedEntries.map((entry) => ({
      ...entry,
      runtimeSlotKeys: [...entry.runtimeSlotKeys]
    }));
  }
}

export type DurableEnvironmentClient = {
  listEnvironments(workspaceId: string): Promise<Array<{ name: string; uid: string }>>;
  createEnvironment(
    workspaceId: string,
    name: string,
    values: EnvironmentVariableDefinition[],
    options: { onExisting: 'error' }
  ): Promise<string>;
  updateEnvironment(
    uid: string,
    name: string,
    values: EnvironmentVariableDefinition[]
  ): Promise<void>;
  getEnvironment(uid: string): Promise<unknown>;
};

export type DurableEnvironmentPlanInput = {
  workspaceId: string;
  projectName: string;
  policy: DurableEnvironmentPolicy;
  environments: readonly string[];
  definitions: Readonly<Record<string, EnvironmentDefinition>>;
  explicitUids: Readonly<Record<string, string>>;
  trackedBindings: Readonly<Record<string, DurableEnvironmentBinding>>;
};

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function definitionFor(
  definitions: Readonly<Record<string, EnvironmentDefinition>>,
  slug: string
): EnvironmentDefinition {
  if (!hasOwn(definitions, slug)) {
    throw new Error(`Durable environment "${slug}" is missing its rich definition`);
  }
  return definitions[slug];
}

function runtimeSlots(definition: EnvironmentDefinition): string[] {
  return definition.values
    .filter((value) => value.type === 'secret')
    .map((value) => value.key);
}

function publicEntry(entry: DurableEnvironmentPlanEntry): DurableEnvironmentPublicEntry {
  return {
    slug: entry.slug,
    displayName: entry.displayName,
    action: entry.action,
    ...(entry.uid ? { uid: entry.uid } : {}),
    runtimeSlotKeys: [...entry.runtimeSlotKeys]
  };
}

export function projectDurableEnvironmentPlan(
  entries: readonly DurableEnvironmentPlanEntry[]
): DurableEnvironmentPublicEntry[] {
  return entries.map(publicEntry);
}

export function projectDurableEnvironmentOfflinePlan(
  entries: readonly DurableEnvironmentPlanEntry[]
): DurableEnvironmentPublicEntry[] {
  return entries.map((entry) => ({
    slug: entry.slug,
    displayName: entry.displayName,
    action: entry.action,
    runtimeSlotKeys: [...entry.runtimeSlotKeys]
  }));
}

export function projectDurableEnvironmentOrphans(
  input: Pick<DurableEnvironmentPlanInput, 'environments' | 'trackedBindings'>
): DurableEnvironmentOrphanEntry[] {
  const requested = new Set(input.environments);
  return Object.entries(input.trackedBindings)
    .filter(([slug]) => !requested.has(slug))
    .map(([slug, binding]) => ({
      slug,
      displayName: binding.displayName,
      uid: binding.uid,
      action: 'retained' as const
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

export function planDurableEnvironmentsOffline(
  input: DurableEnvironmentPlanInput
): DurableEnvironmentPlanEntry[] {
  const undeclaredExplicitSlug = Object.keys(input.explicitUids).find(
    (slug) => !input.environments.includes(slug)
  );
  if (undeclaredExplicitSlug) {
    throw new Error(
      'durable-environment-uids-json contains a slug not declared by durable-environments-json'
    );
  }

  return input.environments.map((slug) => {
    const definition = definitionFor(input.definitions, slug);
    const persisted = hasOwn(input.trackedBindings, slug)
      ? input.trackedBindings[slug]
      : undefined;
    const explicitUid = hasOwn(input.explicitUids, slug)
      ? String(input.explicitUids[slug] ?? '').trim()
      : '';
    if (explicitUid && persisted?.uid && explicitUid !== persisted.uid) {
      throw new Error(
        `Durable environment "${slug}" has conflicting explicit and tracked UIDs`
      );
    }
    const derivedDisplayName = `${input.projectName} - ${slug}`;
    if (persisted && persisted.displayName !== derivedDisplayName) {
      throw new Error(
        `Durable environment "${slug}" would rename "${persisted.displayName}" to "${derivedDisplayName}"; rename is not supported`
      );
    }
    return {
      slug,
      displayName: persisted?.displayName ?? derivedDisplayName,
      action: 'unresolved',
      ...(explicitUid || persisted?.uid ? { uid: explicitUid || persisted?.uid } : {}),
      runtimeSlotKeys: runtimeSlots(definition),
      definition
    };
  });
}

function indexLiveEnvironments(
  entries: readonly { name: string; uid: string }[]
): {
  byName: Map<string, Array<{ name: string; uid: string }>>;
  byUid: Map<string, { name: string; uid: string }>;
} {
  const byName = new Map<string, Array<{ name: string; uid: string }>>();
  const byUid = new Map<string, { name: string; uid: string }>();
  for (const raw of entries) {
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new Error('Postman environment list contains an entry without a valid name');
    }
    const name = raw.name;
    const uid = String(raw.uid ?? '').trim();
    if (!uid) {
      throw new Error('Postman environment list contains an entry without a UID');
    }
    const entry = { name, uid };
    const named = byName.get(name) ?? [];
    named.push(entry);
    byName.set(name, named);
    const prior = byUid.get(uid);
    if (prior && prior.name !== name) {
      throw new Error(`Postman environment UID ${uid} appears under multiple names`);
    }
    byUid.set(uid, entry);
  }
  return { byName, byUid };
}

function resolveReviewedUid(
  input: DurableEnvironmentPlanInput,
  slug: string
): { uid?: string; displayName?: string } {
  const explicit = hasOwn(input.explicitUids, slug)
    ? String(input.explicitUids[slug] ?? '').trim()
    : '';
  const tracked = hasOwn(input.trackedBindings, slug)
    ? input.trackedBindings[slug]
    : undefined;
  if (explicit && tracked?.uid && explicit !== tracked.uid) {
    throw new Error(
      `Durable environment "${slug}" has conflicting explicit and tracked UIDs`
    );
  }
  return {
    ...(explicit || tracked?.uid ? { uid: explicit || tracked?.uid } : {}),
    ...(tracked?.displayName ? { displayName: tracked.displayName } : {})
  };
}

export function planDurableEnvironmentsLive(
  input: DurableEnvironmentPlanInput,
  liveEntries: readonly { name: string; uid: string }[],
  options: { reportUntrackedCandidates?: boolean } = {}
): DurableEnvironmentPlanEntry[] {
  const live = indexLiveEnvironments(liveEntries);
  const claimedUids = new Map<string, string>();

  return input.environments.map((slug) => {
    const definition = definitionFor(input.definitions, slug);
    const reviewed = resolveReviewedUid(input, slug);
    const derivedDisplayName = `${input.projectName} - ${slug}`;
    if (reviewed.displayName && reviewed.displayName !== derivedDisplayName) {
      throw new Error(
        `Durable environment "${slug}" would rename "${reviewed.displayName}" to "${derivedDisplayName}"; rename is not supported`
      );
    }
    const displayName = reviewed.displayName ?? derivedDisplayName;
    const exactMatches = live.byName.get(displayName) ?? [];
    if (exactMatches.length > 1) {
      throw new Error(
        `Durable environment "${slug}" has multiple exact-name candidates in workspace ${input.workspaceId}`
      );
    }

    if (reviewed.uid) {
      const priorSlug = claimedUids.get(reviewed.uid);
      if (priorSlug && priorSlug !== slug) {
        throw new Error(
          `Postman environment UID ${reviewed.uid} is claimed by durable slugs "${priorSlug}" and "${slug}"`
        );
      }
      claimedUids.set(reviewed.uid, slug);
      const liveByUid = live.byUid.get(reviewed.uid);
      if (!liveByUid || liveByUid.name !== displayName || exactMatches[0]?.uid !== reviewed.uid) {
        throw new Error(
          `Durable environment "${slug}" UID ${reviewed.uid} does not match workspace exact name "${displayName}"`
        );
      }
      return {
        slug,
        displayName,
        action: input.policy === 'create-only' ? 'reuse' : 'replace',
        uid: reviewed.uid,
        runtimeSlotKeys: runtimeSlots(definition),
        definition
      };
    }

    if (exactMatches[0]) {
      if (options.reportUntrackedCandidates) {
        return {
          slug,
          displayName,
          action: 'review-required',
          uid: exactMatches[0].uid,
          runtimeSlotKeys: runtimeSlots(definition),
          definition
        };
      }
      throw new Error(
        `Durable environment "${slug}" found untracked exact-name candidate ${exactMatches[0].uid}; review it and supply durable-environment-uids-json before apply`
      );
    }

    return {
      slug,
      displayName,
      action: 'create',
      runtimeSlotKeys: runtimeSlots(definition),
      definition
    };
  });
}

function observationFingerprint(
  plan: readonly DurableEnvironmentPlanEntry[],
  liveEntries: readonly { name: string; uid: string }[]
): string {
  const relevantNames = new Set(plan.map((entry) => entry.displayName));
  const relevantUids = new Set(plan.flatMap((entry) => entry.uid ? [entry.uid] : []));
  return JSON.stringify(
    liveEntries
      .filter((entry) => relevantNames.has(entry.name) || relevantUids.has(entry.uid))
      .map((entry) => ({ name: entry.name, uid: entry.uid }))
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.uid.localeCompare(right.uid)
      )
  );
}

export function parseDurableEnvironmentValues(
  value: unknown
): EnvironmentVariableDefinition[] {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const nested = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record;
  if (!Array.isArray(nested.values)) {
    throw new Error('Postman environment response values must be an array');
  }
  return nested.values.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Postman environment response values[${index}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.key !== 'string') {
      throw new Error(`Postman environment response values[${index}].key must be a string`);
    }
    if (entry.type !== undefined && entry.type !== 'default' && entry.type !== 'secret') {
      throw new Error(`Postman environment response values[${index}].type is invalid`);
    }
    if (entry.secret !== undefined && typeof entry.secret !== 'boolean') {
      throw new Error(`Postman environment response values[${index}].secret must be a boolean`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new Error(`Postman environment response values[${index}].enabled must be a boolean`);
    }
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') {
      throw new Error(`Postman environment response values[${index}].disabled must be a boolean`);
    }
    const isSecret = entry.type === 'secret' || entry.secret === true;
    if (entry.value !== undefined && typeof entry.value !== 'string') {
      throw new Error(`Postman environment response values[${index}].value must be a string`);
    }
    if (entry.value === undefined && !isSecret) {
      throw new Error(`Postman environment response values[${index}].value must be a string`);
    }
    return {
      key: String(entry.key),
      value: isSecret ? '' : entry.value as string,
      type: isSecret ? 'secret' : 'default',
      enabled: entry.enabled !== false && entry.disabled !== true
    };
  });
}

function hasActionOwnershipMarker(value: unknown, slug: string): boolean {
  return normalizedObservedValues(value, slug)
    .some((entry) => entry.key === 'x-pm-onboarding');
}

function expectedValues(definition: EnvironmentDefinition): EnvironmentVariableDefinition[] {
  return definition.values.map((entry) => ({
    key: entry.key,
    value: entry.type === 'secret' ? '' : entry.value,
    type: entry.type,
    enabled: entry.enabled
  }));
}

function normalizedObservedValues(
  live: unknown,
  slug: string
): EnvironmentVariableDefinition[] {
  if (!live || typeof live !== 'object' || Array.isArray(live)) {
    throw new Error(`Durable environment "${slug}" could not be read after reconciliation`);
  }
  return parseDurableEnvironmentValues(live).map((entry) => ({
    ...entry,
    value: entry.type === 'secret' ? '' : entry.value
  }));
}

export function durableEnvironmentObservedDigest(live: unknown, slug: string): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        schema: 'env-observed-v1',
        values: normalizedObservedValues(live, slug)
      }),
      'utf8'
    )
    .digest('hex');
  return `env-observed-v1:sha256:${digest}`;
}

function verifyAppliedValues(
  definition: EnvironmentDefinition,
  live: unknown,
  slug: string
): void {
  if (
    JSON.stringify(normalizedObservedValues(live, slug)) !==
    JSON.stringify(expectedValues(definition))
  ) {
    throw new Error(`Durable environment "${slug}" did not converge to the requested value metadata`);
  }
}

function assertLiveBinding(
  entry: DurableEnvironmentPlanEntry,
  liveEntries: readonly { name: string; uid: string }[],
  expected: 'absent' | 'present',
  phase: 'pre-operation' | 'post-operation'
): void {
  const live = indexLiveEnvironments(liveEntries);
  const exactMatches = live.byName.get(entry.displayName) ?? [];
  if (exactMatches.length > 1) {
    throw new Error(
      `Durable environment "${entry.slug}" has multiple exact-name candidates during ${phase}`
    );
  }
  if (expected === 'absent') {
    if (exactMatches.length > 0) {
      throw new Error(
        `Durable environment "${entry.slug}" appeared before create during ${phase}; rerun plan`
      );
    }
    return;
  }
  if (!entry.uid) {
    throw new Error(`Durable environment "${entry.slug}" has no validated UID`);
  }
  const byUid = live.byUid.get(entry.uid);
  if (
    exactMatches.length !== 1 ||
    exactMatches[0]?.uid !== entry.uid ||
    byUid?.name !== entry.displayName
  ) {
    throw new Error(
      `Durable environment "${entry.slug}" UID/name binding changed during ${phase}`
    );
  }
}

export async function applyDurableEnvironmentPlan(
  input: DurableEnvironmentPlanInput,
  client: DurableEnvironmentClient,
  initialLiveEntries: readonly { name: string; uid: string }[],
  plan: readonly DurableEnvironmentPlanEntry[]
): Promise<DurableEnvironmentResultEntry[]> {
  const preWriteLive = await client.listEnvironments(input.workspaceId);
  if (
    observationFingerprint(plan, initialLiveEntries) !==
    observationFingerprint(plan, preWriteLive)
  ) {
    throw new Error('Durable environment workspace observations changed before mutation; rerun plan');
  }
  // Rebuild against the pre-write snapshot so every reviewed UID/name/class
  // binding is checked again before the batch's first write.
  planDurableEnvironmentsLive(input, preWriteLive);

  const results: DurableEnvironmentResultEntry[] = [];
  for (const entry of plan) {
    let cloudAppliedEntry: DurableEnvironmentResultEntry | undefined;
    try {
      assertLiveBinding(
        entry,
        await client.listEnvironments(input.workspaceId),
        entry.action === 'create' ? 'absent' : 'present',
        'pre-operation'
      );
      if (entry.action === 'create') {
        const uid = await client.createEnvironment(
          input.workspaceId,
          entry.displayName,
          entry.definition.values,
          { onExisting: 'error' }
        );
        cloudAppliedEntry = {
          slug: entry.slug,
          displayName: entry.displayName,
          action: 'create',
          uid,
          runtimeSlotKeys: entry.runtimeSlotKeys
        };
        assertLiveBinding(
          { ...entry, uid },
          await client.listEnvironments(input.workspaceId),
          'present',
          'post-operation'
        );
        const live = await client.getEnvironment(uid);
        verifyAppliedValues(entry.definition, live, entry.slug);
        cloudAppliedEntry.observedDigest = durableEnvironmentObservedDigest(live, entry.slug);
        results.push(cloudAppliedEntry);
        continue;
      }

      if (!entry.uid) {
        throw new Error(`Durable environment "${entry.slug}" has no validated UID`);
      }
      const preOperationPayload = await client.getEnvironment(entry.uid);
      if (hasActionOwnershipMarker(preOperationPayload, entry.slug)) {
        throw new Error(
          `Durable environment "${entry.slug}" is owned by the branch asset lifecycle and cannot be adopted`
        );
      }
      if (entry.action === 'replace') {
        await client.updateEnvironment(entry.uid, entry.displayName, entry.definition.values);
        cloudAppliedEntry = {
          slug: entry.slug,
          displayName: entry.displayName,
          action: 'replace',
          uid: entry.uid,
          runtimeSlotKeys: entry.runtimeSlotKeys
        };
        assertLiveBinding(
          entry,
          await client.listEnvironments(input.workspaceId),
          'present',
          'post-operation'
        );
        const live = await client.getEnvironment(entry.uid);
        verifyAppliedValues(entry.definition, live, entry.slug);
        cloudAppliedEntry.observedDigest = durableEnvironmentObservedDigest(live, entry.slug);
        results.push(cloudAppliedEntry);
        continue;
      }

      assertLiveBinding(
        entry,
        await client.listEnvironments(input.workspaceId),
        'present',
        'post-operation'
      );
      results.push({
        slug: entry.slug,
        displayName: entry.displayName,
        action: 'reused-preserved',
        uid: entry.uid,
        runtimeSlotKeys: entry.runtimeSlotKeys,
        observedDigest: durableEnvironmentObservedDigest(preOperationPayload, entry.slug)
      });
    } catch (error) {
      throw new DurableEnvironmentPartialApplyError(
        entry.slug,
        cloudAppliedEntry ? [...results, cloudAppliedEntry] : results,
        error
      );
    }
  }
  return results;
}
