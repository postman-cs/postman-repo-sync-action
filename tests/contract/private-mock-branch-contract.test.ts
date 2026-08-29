/**
 * Full runAction proof for the two branch-aware paths that can mutate private
 * mock collections. Both paths must carry the owner-prefixed public UID from
 * bootstrap through repo-sync to collection ROOT GET/PATCH; the live service
 * denies the same routes when addressed by a bare model id.
 */
import { describe, expect, it } from 'vitest';

import { runContractAction } from './harness.js';
import { createPlatform } from './platform-fake.js';

const OWNER_ID = 12_345_678;
const BASELINE_MODEL_ID = '5a8a796b-0000-4111-8222-333344445555';
const SMOKE_MODEL_ID = '6b9b8a7c-1111-4222-8333-444455556666';
const CONTRACT_MODEL_ID = '7c0c9b8d-2222-4333-8444-555566667777';
const BASELINE_UID = `${OWNER_ID}-${BASELINE_MODEL_ID}`;
const SMOKE_UID = `${OWNER_ID}-${SMOKE_MODEL_ID}`;
const CONTRACT_UID = `${OWNER_ID}-${CONTRACT_MODEL_ID}`;

function collection(name: string, id: string): Record<string, unknown> {
  return {
    id,
    name,
    $kind: 'collection',
    items: [
      {
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        name: 'Health',
        $kind: 'http-request',
        method: 'GET',
        url: 'https://api.example.com/health'
      }
    ]
  };
}

function branchDecision(tier: 'canonical' | 'preview'): string {
  const preview = tier === 'preview';
  return JSON.stringify({
    tier,
    strategy: 'preview',
    identity: {
      provider: 'github',
      headBranch: preview ? 'feature/private-mock' : 'main',
      rawRef: preview ? 'refs/heads/feature/private-mock' : 'refs/heads/main',
      defaultBranch: 'main',
      refKind: preview ? 'branch' : 'default-branch',
      isPrContext: false,
      isForkPr: false
    },
    canonicalBranch: 'main',
    reason: 'contract fixture'
  });
}

function inputs(): Record<string, string> {
  return {
    'project-name': 'core-payments',
    'workspace-id': 'ws-contract',
    'baseline-collection-id': BASELINE_UID,
    'smoke-collection-id': SMOKE_UID,
    'contract-collection-id': CONTRACT_UID,
    'postman-api-key': 'pmak-test',
    'postman-access-token': 'access-token-test',
    'environments-json': '["prod"]',
    'env-runtime-urls-json': '{"prod":"https://api.example.com"}',
    'mock-visibility': 'private',
    'repo-write-mode': 'none',
    'generate-ci-workflow': 'false',
    'workspace-link-enabled': 'false',
    'environment-sync-enabled': 'false',
    'branch-strategy': 'preview'
  };
}

describe.each(['canonical', 'preview'] as const)(
  'contract: private-mock attachment on the %s branch path',
  (tier) => {
    it('preserves public UIDs through root hook install and verification', async () => {
      const platform = createPlatform({
        userId: OWNER_ID,
        existingCollections: [
          { id: BASELINE_MODEL_ID, collection: collection('core-payments', BASELINE_MODEL_ID) },
          { id: SMOKE_MODEL_ID, collection: collection('[Smoke] core-payments', SMOKE_MODEL_ID) },
          {
            id: CONTRACT_MODEL_ID,
            collection: collection('[Contract] core-payments', CONTRACT_MODEL_ID)
          }
        ]
      });

      const result = await runContractAction({
        inputs: inputs(),
        env: {
          POSTMAN_BRANCH_DECISION: branchDecision(tier),
          ...(tier === 'preview' ? { POSTMAN_BRANCH_ASSET_IDS: 'owned' } : {})
        },
        fetchImpl: platform.fetch
      });

      expect(result.error).toBeUndefined();
      expect(result.outputs['mock-visibility']).toBe('private');

      // Every fallback collection export must use an owner-prefixed public UID.
      const exportEvents = platform.events.filter((event) =>
        event.startsWith('proxy:collection GET /v3/collections/') && event.endsWith('/export')
      );
      expect(exportEvents.length).toBeGreaterThanOrEqual(3);
      const exportedUids = new Set<string>();
      for (const event of exportEvents) {
        const match = /\/v3\/collections\/([^/]+)\/export$/.exec(event);
        expect(match).not.toBeNull();
        const uid = match![1]!;
        expect(uid).toMatch(/^\d+-[0-9a-f-]+$/);
        expect(uid).not.toBe(BASELINE_MODEL_ID);
        expect(uid).not.toBe(SMOKE_MODEL_ID);
        expect(uid).not.toBe(CONTRACT_MODEL_ID);
        exportedUids.add(uid);
      }
      expect(exportedUids.has(BASELINE_UID)).toBe(true);
      expect(exportedUids.has(SMOKE_UID)).toBe(true);
      expect(exportedUids.has(CONTRACT_UID)).toBe(true);

      // The stable root snapshot route is distinct from /export and must also
      // retain the public UID. These no-prebuilt contract runs exercise the
      // explicit fallback; exact prebuilt runs skip both root GET and export.
      const rootGetEvents = platform.events.filter((event) =>
        /^proxy:collection GET \/v3\/collections\/[^/]+$/.test(event)
      );
      expect(rootGetEvents).toEqual([
        `proxy:collection GET /v3/collections/${BASELINE_UID}`,
        `proxy:collection GET /v3/collections/${SMOKE_UID}`,
        `proxy:collection GET /v3/collections/${CONTRACT_UID}`
      ]);

      // PATCH IDs must be full owner-prefixed UIDs. The stable root snapshot
      // precedes PATCH, and fallback export occurs only after PATCH succeeds.
      // Use indices in the single global event array to prove chronology.
      const patchEvents = platform.events.filter((event) =>
        event.startsWith('proxy:collection PATCH /v3/collections/')
      );
      const patchedIds = patchEvents.map(
        (event) => event.split('/v3/collections/')[1] ?? ''
      );
      expect(patchedIds).toEqual([BASELINE_UID, SMOKE_UID, CONTRACT_UID]);
      for (const patchedId of patchedIds) {
        const rootGetGlobalIndex = platform.events.findIndex(
          (event) => event === `proxy:collection GET /v3/collections/${patchedId}`
        );
        const patchGlobalIndex = platform.events.findIndex((event) =>
          event.includes(`/v3/collections/${patchedId}`) &&
          event.startsWith('proxy:collection PATCH')
        );
        expect(rootGetGlobalIndex).toBeGreaterThanOrEqual(0);
        expect(patchGlobalIndex).toBeGreaterThanOrEqual(0);
        expect(patchGlobalIndex).toBeGreaterThan(rootGetGlobalIndex);
        const laterGetGlobalIndex = platform.events.findIndex((event, idx) =>
          idx > patchGlobalIndex &&
          event.startsWith('proxy:collection GET') &&
          event.includes(`/v3/collections/${patchedId}/export`)
        );
        expect(laterGetGlobalIndex).toBeGreaterThanOrEqual(0);
        expect(laterGetGlobalIndex).toBeGreaterThan(patchGlobalIndex);
      }

      // Fake state must contain the exact managed root hook evidence.
      for (const resource of platform.state.collections) {
        const scripts = (resource.collection as Record<string, unknown>).scripts as
          | Array<{ type: string; code: string }>
          | undefined;
        expect(scripts).toBeDefined();
        const hook = scripts!.find((script) =>
          String(script.code ?? '').includes('postmanPrivateMockApiKey')
        );
        expect(hook).toBeDefined();
        expect(hook!.type).toBe('http:beforeRequest');
      }
    });
  }
);
