import { afterEach, describe, expect, it } from 'vitest';

import {
  MANAGED_ITEM_AUTH_BLOCKS,
  PRIVATE_MOCK_AUTH_ROOT_MARKER,
  PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
  PRIVATE_MOCK_AUTH_ROOT_TYPE,
  PRIVATE_MOCK_AUTH_VARIABLE
} from '../src/lib/postman/private-mock-auth-script.js';
import {
  applyPrivateMockExportCleanup,
  isPrivateMockLegacyExportCleanupEnabled,
  verifyPrivateMockRootHook
} from '../src/lib/postman/private-mock-export-cleanup.js';

type JsonRecord = Record<string, unknown>;

const ENV_KEY = 'POSTMAN_PRIVATE_MOCK_LEGACY_EXPORT_CLEANUP';

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return value;
}

function snapshotJson(value: unknown): string {
  return JSON.stringify(value);
}

function createV3Collection(options: {
  rootHook?: boolean;
  rootScripts?: JsonRecord[];
  itemBeforeRequest?: string;
  nestedItemBeforeRequest?: string;
} = {}): JsonRecord {
  const nestedRequest: JsonRecord = {
    id: 'cccccccc-dddd-eeee-ffff-000000000001',
    name: 'Nested',
    $kind: 'http-request',
    method: 'GET',
    url: 'https://api.example.com/nested'
  };
  if (options.nestedItemBeforeRequest !== undefined) {
    nestedRequest.scripts = [{
      type: 'beforeRequest',
      code: options.nestedItemBeforeRequest,
      language: 'text/javascript'
    }];
  }

  const request: JsonRecord = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: 'List Payments',
    $kind: 'http-request',
    method: 'GET',
    url: 'https://api.example.com/payments'
  };
  if (options.itemBeforeRequest !== undefined) {
    request.scripts = [{
      type: 'beforeRequest',
      code: options.itemBeforeRequest,
      language: 'text/javascript'
    }];
  }

  const collection: JsonRecord = {
    id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    name: 'Fixture',
    $kind: 'collection',
    items: [
      request,
      {
        id: 'dddddddd-eeee-ffff-0000-111111111111',
        name: 'Folder',
        $kind: 'collection',
        items: [nestedRequest]
      }
    ]
  };

  if (options.rootScripts !== undefined) {
    collection.scripts = options.rootScripts;
  } else if (options.rootHook !== false) {
    collection.scripts = [{
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
      language: 'text/javascript'
    }];
  }

  return collection;
}

function createDeepNestedCollection(depth: number): JsonRecord {
  const customer = "console.log('customer-owned');";
  const managedBlock = MANAGED_ITEM_AUTH_BLOCKS[2] ?? '';
  let node: JsonRecord = {
    id: 'leaf-0000-0000-0000-000000000001',
    name: 'Leaf',
    $kind: 'http-request',
    method: 'GET',
    url: 'https://api.example.com/leaf',
    scripts: [{
      type: 'beforeRequest',
      code: `${managedBlock}\n\n${customer}`,
      language: 'text/javascript'
    }]
  };

  for (let level = depth - 1; level >= 1; level -= 1) {
    const parent: JsonRecord = {
      id: `level-${level}`,
      name: `Level ${level}`,
      $kind: 'collection'
    };
    if (level % 2 === 0) {
      parent.children = [node];
    } else {
      parent.items = [node];
    }
    node = parent;
  }

  return {
    id: 'deep-root-collection',
    name: 'Deep Nested',
    $kind: 'collection',
    scripts: [{
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
      language: 'text/javascript'
    }],
    items: [node]
  };
}

function walkLeafFromRoot(collection: JsonRecord): JsonRecord | undefined {
  let current: JsonRecord | undefined = collection;
  while (current) {
    const items: JsonRecord[] = asArray<JsonRecord>(current.items);
    const children: JsonRecord[] = asArray<JsonRecord>(current.children);
    if (items.length === 0 && children.length === 0) {
      return current;
    }
    current = items[0] ?? children[0];
  }
  return undefined;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function createThreeLevelCollection(leafBeforeRequest: string): JsonRecord {
  const leaf: JsonRecord = {
    id: 'leaf-0000-0000-0000-000000000001',
    name: 'Leaf',
    $kind: 'http-request',
    method: 'GET',
    url: 'https://api.example.com/leaf',
    scripts: [{
      type: 'beforeRequest',
      code: leafBeforeRequest,
      language: 'text/javascript'
    }]
  };

  return {
    id: 'root-collection',
    name: 'Three Level',
    $kind: 'collection',
    scripts: [{
      type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
      code: PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
      language: 'text/javascript'
    }],
    items: [{
      id: 'level-1',
      name: 'Level 1',
      $kind: 'collection',
      items: [{
        id: 'level-2',
        name: 'Level 2',
        $kind: 'collection',
        children: [leaf]
      }]
    }]
  };
}

function assertNoCredentialLeakage(result: ReturnType<typeof applyPrivateMockExportCleanup>): void {
  expect(Object.keys(result).sort()).toEqual(['collection', 'rootVerified', 'strippedBlocks']);
  expect(typeof result.strippedBlocks).toBe('number');
  expect(typeof result.rootVerified).toBe('boolean');
  expect(result.collection).toBeTruthy();

  const metadata = JSON.stringify({
    strippedBlocks: result.strippedBlocks,
    rootVerified: result.rootVerified
  });
  expect(metadata).not.toMatch(/pmak-[a-z0-9]+/i);
  expect(metadata).not.toMatch(/PMAK-[A-Za-z0-9]+/);
  expect(metadata).not.toMatch(/['"][a-f0-9]{32,}['"]/i);
  expect(metadata).not.toContain('=PMAK');
}

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe('private-mock export cleanup properties', () => {
  describe('1. purity — input IR is never mutated', () => {
    it('does not mutate a deep-frozen input collection', () => {
      const input = createV3Collection({
        itemBeforeRequest: `${MANAGED_ITEM_AUTH_BLOCKS[2]}\n\nconsole.log('customer-owned');`
      });
      const before = snapshotJson(input);
      deepFreeze(input);

      const result = applyPrivateMockExportCleanup(input);

      expect(snapshotJson(input)).toBe(before);
      expect(result.collection).not.toBe(input);
      assertNoCredentialLeakage(result);
    });
  });

  describe('2. exact-block only', () => {
    it.each([0, 1, 2] as const)('removes byte-exact managed v%s item block', (index) => {
      const block = MANAGED_ITEM_AUTH_BLOCKS[index] ?? '';
      const customer = "console.log('customer-owned');";
      const input = createV3Collection({
        itemBeforeRequest: `${block}\n\n${customer}`
      });
      const { collection, strippedBlocks } = applyPrivateMockExportCleanup(input);
      const request = (collection.items as JsonRecord[])[0];
      const scripts = request.scripts as JsonRecord[];

      expect(strippedBlocks).toBe(1);
      expect(scripts).toHaveLength(1);
      expect(String(scripts[0].code)).toBe(`\n${customer}`);
    });

    it('leaves a one-character-modified managed block untouched', () => {
      const exact = MANAGED_ITEM_AUTH_BLOCKS[2] ?? '';
      const oneCharOff = `${exact.slice(0, 40)}X${exact.slice(41)}`;
      expect(oneCharOff).not.toBe(exact);

      const input = createV3Collection({ itemBeforeRequest: oneCharOff });
      const { collection, strippedBlocks } = applyPrivateMockExportCleanup(input);
      const request = (collection.items as JsonRecord[])[0];

      expect(strippedBlocks).toBe(0);
      expect(String((request.scripts as JsonRecord[])[0].code)).toBe(oneCharOff);
    });

    it('leaves unrelated customer beforeRequest code untouched', () => {
      const customer = "pm.request.headers.add('X-Customer', 'owned');";
      const input = createV3Collection({ itemBeforeRequest: customer });
      const { collection, strippedBlocks } = applyPrivateMockExportCleanup(input);
      const request = (collection.items as JsonRecord[])[0];

      expect(strippedBlocks).toBe(0);
      expect(String((request.scripts as JsonRecord[])[0].code)).toBe(customer);
    });

    it('counts every removed managed block when customer code remains', () => {
      const customer = "console.log('customer-owned');";
      const input = createV3Collection({
        itemBeforeRequest: `${MANAGED_ITEM_AUTH_BLOCKS[0]}\n${MANAGED_ITEM_AUTH_BLOCKS[2]}\n${customer}`
      });

      const { collection, strippedBlocks } = applyPrivateMockExportCleanup(input);
      const request = (collection.items as JsonRecord[])[0];

      expect(strippedBlocks).toBe(2);
      expect(String((request.scripts as JsonRecord[])[0].code)).toContain(customer);
    });

    it('does not strip a managed block embedded in a template literal', () => {
      const block = MANAGED_ITEM_AUTH_BLOCKS[2] ?? '';
      const embedded = `const doc = \`${block}\`;\nvar keep = 1;`;
      const input = createV3Collection({ itemBeforeRequest: embedded });
      const { collection, strippedBlocks } = applyPrivateMockExportCleanup(input);
      const request = (collection.items as JsonRecord[])[0];

      expect(strippedBlocks).toBe(0);
      expect(String((request.scripts as JsonRecord[])[0].code)).toBe(embedded);
    });
  });

  describe('3. managed-only removal', () => {
    it('drops a beforeRequest script that was 100% managed', () => {
      const input = createV3Collection({ itemBeforeRequest: MANAGED_ITEM_AUTH_BLOCKS[0] });
      const { collection, strippedBlocks } = applyPrivateMockExportCleanup(input);
      const request = (collection.items as JsonRecord[])[0];

      expect(strippedBlocks).toBe(1);
      expect(request.scripts).toBeUndefined();
    });

    it('keeps customer code when managed and customer code share one script', () => {
      const customer = "console.log('stay');";
      const input = createV3Collection({
        itemBeforeRequest: `${MANAGED_ITEM_AUTH_BLOCKS[2]}\n\n${customer}`
      });
      const { collection, strippedBlocks } = applyPrivateMockExportCleanup(input);
      const request = (collection.items as JsonRecord[])[0];
      const scripts = request.scripts as JsonRecord[];

      expect(strippedBlocks).toBe(1);
      expect(scripts).toHaveLength(1);
      expect(String(scripts[0].code)).toBe(`\n${customer}`);
    });
  });

  describe('4. nesting — folders/children at arbitrary depth', () => {
    it('walks a three-level items/children tree', () => {
      const input = createThreeLevelCollection(MANAGED_ITEM_AUTH_BLOCKS[1] ?? '');
      const { collection, strippedBlocks } = applyPrivateMockExportCleanup(input);
      const level1 = (collection.items as JsonRecord[])[0];
      const level2 = ((level1.items as JsonRecord[])[0]);
      const leaf = ((level2.children as JsonRecord[])[0]);

      expect(strippedBlocks).toBe(1);
      expect(leaf.scripts).toBeUndefined();
    });

    it('strips managed blocks from both top-level and nested items', () => {
      const input = createV3Collection({
        itemBeforeRequest: MANAGED_ITEM_AUTH_BLOCKS[0],
        nestedItemBeforeRequest: MANAGED_ITEM_AUTH_BLOCKS[1]
      });
      const { collection, strippedBlocks } = applyPrivateMockExportCleanup(input);
      const request = (collection.items as JsonRecord[])[0];
      const folder = (collection.items as JsonRecord[])[1];
      const nested = ((folder.items as JsonRecord[])[0]);

      expect(strippedBlocks).toBe(2);
      expect(request.scripts).toBeUndefined();
      expect(nested.scripts).toBeUndefined();
    });

    it('completes cleanup on a depth that exceeds recursive walk stack limits', () => {
      const depth = 10000;
      const input = createDeepNestedCollection(depth);
      const structuredClone = globalThis.structuredClone;
      // Force the JSON/iterative clone path so deep fixtures are not bounded by structuredClone depth.
      (globalThis as { structuredClone?: typeof structuredClone }).structuredClone = undefined;

      const recursiveWalk = (items: JsonRecord[]): void => {
        for (const item of items) {
          const scripts = item.scripts;
          if (Array.isArray(scripts)) {
            for (const script of scripts) {
              if (script && typeof script === 'object' && !Array.isArray(script)) {
                String((script as JsonRecord).code ?? '');
              }
            }
          }
          for (const key of ['items', 'children'] as const) {
            recursiveWalk(asArray<JsonRecord>(item[key]));
          }
        }
      };

      try {
        expect(() => recursiveWalk(asArray<JsonRecord>(input.items))).toThrow(RangeError);

        const first = applyPrivateMockExportCleanup(input);
        const leaf = walkLeafFromRoot(first.collection);
        const leafScripts = leaf?.scripts as JsonRecord[] | undefined;

        expect(first.strippedBlocks).toBe(1);
        expect(leafScripts).toHaveLength(1);
        expect(String(leafScripts?.[0]?.code)).toBe("\nconsole.log('customer-owned');");

        const second = applyPrivateMockExportCleanup(first.collection);
        expect(second.strippedBlocks).toBe(0);
        const secondLeafScripts = walkLeafFromRoot(second.collection)?.scripts as JsonRecord[] | undefined;
        expect(secondLeafScripts).toHaveLength(1);
        expect(String(secondLeafScripts?.[0]?.code)).toBe(String(leafScripts?.[0]?.code));
      } finally {
        globalThis.structuredClone = structuredClone;
      }
    });
  });

  describe('5. idempotence', () => {
    it('reports strippedBlocks: 0 on the second pass and preserves the IR', () => {
      const input = createV3Collection({
        itemBeforeRequest: `${MANAGED_ITEM_AUTH_BLOCKS[2]}\n\nconsole.log('stay');`
      });
      const first = applyPrivateMockExportCleanup(input);
      const second = applyPrivateMockExportCleanup(first.collection);

      expect(second.strippedBlocks).toBe(0);
      expect(snapshotJson(second.collection)).toBe(snapshotJson(first.collection));
      expect(second.rootVerified).toBe(true);
    });
  });

  describe('6. root untouched — collection-root http:beforeRequest is never stripped', () => {
    it('never visits collection.scripts during item cleanup', () => {
      const rootWithItemBlock = [{
        type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
        code: `${PRIVATE_MOCK_AUTH_ROOT_SCRIPT}\n${MANAGED_ITEM_AUTH_BLOCKS[2]}`,
        language: 'text/javascript'
      }];
      const input = createV3Collection({
        rootScripts: rootWithItemBlock,
        itemBeforeRequest: MANAGED_ITEM_AUTH_BLOCKS[0]
      });
      const beforeRootCode = String(rootWithItemBlock[0].code);

      const { collection, strippedBlocks } = applyPrivateMockExportCleanup(input);
      const rootScripts = collection.scripts as JsonRecord[];

      expect(strippedBlocks).toBe(1);
      expect(String(rootScripts[0].code)).toBe(beforeRootCode);
      expect(((collection.items as JsonRecord[])[0]).scripts).toBeUndefined();
    });
  });

  describe('7. verifyPrivateMockRootHook', () => {
    it('returns true only for the exact managed http:beforeRequest root script', () => {
      const input = createV3Collection();
      expect(verifyPrivateMockRootHook(input)).toBe(true);
    });

    it('returns false for marker-only corrupt root scripts', () => {
      const input = createV3Collection({
        rootScripts: [{
          type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
          code: `// ${PRIVATE_MOCK_AUTH_ROOT_MARKER}\nvar privateMockApiKey = 1;`,
          language: 'text/javascript'
        }]
      });
      expect(verifyPrivateMockRootHook(input)).toBe(false);
    });

    it('returns false for bare beforeRequest at collection root even with the marker', () => {
      const input = createV3Collection({
        rootScripts: [{
          type: 'beforeRequest',
          code: `// ${PRIVATE_MOCK_AUTH_ROOT_MARKER}\nvar x = 1;`,
          language: 'text/javascript'
        }]
      });
      expect(verifyPrivateMockRootHook(input)).toBe(false);
    });

    it('returns false when the root marker is missing', () => {
      const input = createV3Collection({
        rootScripts: [{
          type: PRIVATE_MOCK_AUTH_ROOT_TYPE,
          code: 'var privateMockApiKey = 1;',
          language: 'text/javascript'
        }]
      });
      expect(verifyPrivateMockRootHook(input)).toBe(false);
    });

    it.each([
      ['undefined scripts', undefined],
      ['null scripts', null],
      ['empty scripts', []],
      ['non-array scripts', 'not-an-array']
    ] as const)('returns false for %s without throwing', (_label, scripts) => {
      const input: JsonRecord = { id: 'x', name: 'x', items: [] };
      if (scripts !== undefined) {
        input.scripts = scripts;
      }
      expect(() => verifyPrivateMockRootHook(input)).not.toThrow();
      expect(verifyPrivateMockRootHook(input)).toBe(false);
    });
  });

  describe('8. kill switch — isPrivateMockLegacyExportCleanupEnabled', () => {
    it('is enabled by default and for non-off values', () => {
      delete process.env[ENV_KEY];
      expect(isPrivateMockLegacyExportCleanupEnabled()).toBe(true);

      process.env[ENV_KEY] = '';
      expect(isPrivateMockLegacyExportCleanupEnabled()).toBe(true);

      process.env[ENV_KEY] = 'false';
      expect(isPrivateMockLegacyExportCleanupEnabled()).toBe(true);

      process.env[ENV_KEY] = '0';
      expect(isPrivateMockLegacyExportCleanupEnabled()).toBe(true);

      process.env[ENV_KEY] = 'on';
      expect(isPrivateMockLegacyExportCleanupEnabled()).toBe(true);
    });

    it('is disabled only for trimmed case-insensitive "off"', () => {
      for (const value of ['off', 'OFF', ' Off ', '\toff\n']) {
        process.env[ENV_KEY] = value;
        expect(isPrivateMockLegacyExportCleanupEnabled()).toBe(false);
      }
    });

    it('honors stripManagedBlocks=false while still reporting root verification', () => {
      const input = createV3Collection({ itemBeforeRequest: MANAGED_ITEM_AUTH_BLOCKS[2] });
      const { collection, strippedBlocks, rootVerified } = applyPrivateMockExportCleanup(input, {
        stripManagedBlocks: false
      });

      expect(strippedBlocks).toBe(0);
      expect(rootVerified).toBe(true);
      expect(String(((collection.items as JsonRecord[])[0].scripts as JsonRecord[])[0].code))
        .toBe(MANAGED_ITEM_AUTH_BLOCKS[2]);
    });

    it('disables item-block cleanup when the env kill switch is off', () => {
      process.env[ENV_KEY] = 'off';
      const input = createV3Collection({ itemBeforeRequest: MANAGED_ITEM_AUTH_BLOCKS[2] });
      const { collection, strippedBlocks, rootVerified } = applyPrivateMockExportCleanup(input);

      expect(strippedBlocks).toBe(0);
      expect(rootVerified).toBe(true);
      expect(String(((collection.items as JsonRecord[])[0].scripts as JsonRecord[])[0].code))
        .toBe(MANAGED_ITEM_AUTH_BLOCKS[2]);
    });
  });

  describe('9. no credential leakage', () => {
    it('returns only the public result shape without adding credential metadata', () => {
      const input = createV3Collection({
        itemBeforeRequest: `${MANAGED_ITEM_AUTH_BLOCKS[2]}\n\nconsole.log('customer-owned');`
      });

      const result = applyPrivateMockExportCleanup(input);
      assertNoCredentialLeakage(result);
      expect(JSON.stringify(result.collection)).toContain(PRIVATE_MOCK_AUTH_VARIABLE);
      expect(JSON.stringify(result.collection)).not.toMatch(/pmak-[a-z0-9]+/i);
      expect(JSON.stringify(result.collection)).not.toMatch(/['"][a-f0-9]{32,}['"]/i);
    });
  });

  describe('integration — missing root hooks', () => {
    it('reports rootVerified=false when the managed root hook is absent', () => {
      const input = createV3Collection({ rootHook: false });
      expect(verifyPrivateMockRootHook(input)).toBe(false);
      expect(applyPrivateMockExportCleanup(input).rootVerified).toBe(false);
    });
  });
});
