import {
  countManagedItemAuthBlocks,
  isManagedPrivateMockAuthRootHook,
  stripManagedItemAuthBlocks
} from './private-mock-auth-script.js';

type JsonRecord = Record<string, unknown>;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function cloneScriptRecord(script: unknown): JsonRecord {
  if (!script || typeof script !== 'object' || Array.isArray(script)) {
    return script as JsonRecord;
  }
  return { ...(script as JsonRecord) };
}

function cloneCollectionNodeIterative(collection: JsonRecord): JsonRecord {
  const cloned: JsonRecord = { ...collection };
  if (Array.isArray(collection.scripts)) {
    cloned.scripts = collection.scripts.map((script) => cloneScriptRecord(script));
  }

  const stack: Array<{ source: JsonRecord; target: JsonRecord }> = [];

  const attachNested = (source: JsonRecord, target: JsonRecord): void => {
    if (Array.isArray(source.scripts)) {
      target.scripts = source.scripts.map((script) => cloneScriptRecord(script));
    }
    for (const key of ['items', 'children'] as const) {
      const nested = asArray<JsonRecord>(source[key]);
      if (nested.length === 0) {
        continue;
      }
      const clonedNested = nested.map((item) => ({ ...item }));
      target[key] = clonedNested;
      for (let i = 0; i < nested.length; i += 1) {
        stack.push({ source: nested[i], target: clonedNested[i] });
      }
    }
  };

  attachNested(collection, cloned);
  while (stack.length > 0) {
    const frame = stack.pop()!;
    attachNested(frame.source, frame.target);
  }

  return cloned;
}

function cloneCollection(collection: JsonRecord): JsonRecord {
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(collection);
    } catch {
      // Fall through to JSON or iterative collection clone.
    }
  }
  try {
    return JSON.parse(JSON.stringify(collection)) as JsonRecord;
  } catch {
    return cloneCollectionNodeIterative(collection);
  }
}

function cleanManagedItemAuthScriptsInPlace(item: JsonRecord, stripManagedBlocks: boolean): number {
  if (!stripManagedBlocks) {
    return 0;
  }
  const scripts = item.scripts;
  if (!Array.isArray(scripts)) {
    return 0;
  }

  let strippedBlocks = 0;
  const nextScripts: JsonRecord[] = [];
  for (const script of scripts) {
    if (!script || typeof script !== 'object' || Array.isArray(script)) {
      nextScripts.push(script as JsonRecord);
      continue;
    }
    const record = script as JsonRecord;
    if (String(record.type ?? '') !== 'beforeRequest') {
      nextScripts.push(record);
      continue;
    }
    const originalCode = String(record.code ?? '');
    const cleaned = stripManagedItemAuthBlocks(originalCode);
    if (cleaned === originalCode) {
      // Preserve customer/near-miss beforeRequest scripts byte-for-byte.
      nextScripts.push(record);
      continue;
    }
    strippedBlocks += countManagedItemAuthBlocks(originalCode);
    if (!cleaned) {
      // Managed-only script: drop the script object entirely.
      continue;
    }
    nextScripts.push({ ...record, code: cleaned });
  }

  if (nextScripts.length === 0) {
    delete item.scripts;
  } else {
    item.scripts = nextScripts;
  }
  return strippedBlocks;
}

export function isPrivateMockLegacyExportCleanupEnabled(): boolean {
  const value = String(process.env.POSTMAN_PRIVATE_MOCK_LEGACY_EXPORT_CLEANUP ?? '').trim().toLowerCase();
  return value !== 'off';
}

export function verifyPrivateMockRootHook(collection: JsonRecord): boolean {
  const scripts = asArray<JsonRecord>(collection.scripts);
  return scripts.some((script) => isManagedPrivateMockAuthRootHook(script));
}

/**
 * Clone and clean one split Collection v3 artifact node. Split trees store each
 * folder/request in its own YAML document, so this is the on-disk equivalent of
 * visiting one child in {@link applyPrivateMockExportCleanup}. Root collection
 * scripts are intentionally handled separately by the caller.
 */
export function applyPrivateMockArtifactNodeCleanup(
  node: JsonRecord,
  options: { stripManagedBlocks?: boolean } = {}
): { node: JsonRecord; strippedBlocks: number } {
  const stripManagedBlocks = options.stripManagedBlocks ?? isPrivateMockLegacyExportCleanupEnabled();
  const cloned = cloneCollection(node);
  return {
    node: cloned,
    strippedBlocks: cleanManagedItemAuthScriptsInPlace(cloned, stripManagedBlocks)
  };
}

/**
 * Clone a gateway v3 collection IR, optionally strip byte-exact managed item-level
 * private-mock auth blocks from `beforeRequest` scripts, and report whether the
 * managed collection-root hook is present. Pure: no I/O or credential values.
 */
export function applyPrivateMockExportCleanup(
  collection: JsonRecord,
  options: { stripManagedBlocks?: boolean } = {}
): { collection: JsonRecord; strippedBlocks: number; rootVerified: boolean } {
  const stripManagedBlocks = options.stripManagedBlocks ?? isPrivateMockLegacyExportCleanupEnabled();
  const cloned = cloneCollection(collection);
  let strippedBlocks = 0;

  const walkItemsIteratively = (rootItems: JsonRecord[]): void => {
    const stack: JsonRecord[] = [...rootItems].reverse();
    while (stack.length > 0) {
      const item = stack.pop()!;
      strippedBlocks += cleanManagedItemAuthScriptsInPlace(item, stripManagedBlocks);
      for (const key of ['items', 'children'] as const) {
        const nested = asArray<JsonRecord>(item[key]);
        for (let i = nested.length - 1; i >= 0; i -= 1) {
          stack.push(nested[i]);
        }
      }
    }
  };

  walkItemsIteratively(asArray<JsonRecord>(cloned.items));

  return {
    collection: cloned,
    strippedBlocks,
    rootVerified: verifyPrivateMockRootHook(cloned)
  };
}
