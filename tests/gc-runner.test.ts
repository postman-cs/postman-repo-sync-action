import { describe, expect, it, vi } from 'vitest';

import { buildBranchSlug, type AssetMarker } from '../src/lib/repo/branch-decision.js';
import {
  collectGcCandidates,
  inventoryRemoteBranches,
  runGc,
  type GcPostmanClient
} from '../src/lib/repo/gc-runner.js';

const REPO = 'https://github.com/acme/payments';
const BRANCH_SUFFIX = buildBranchSlug('feature/payments').suffix;

function marker(overrides: Partial<AssetMarker> = {}): AssetMarker {
  return {
    repo: REPO,
    rawBranch: 'feature/payments',
    sanitizedBranch: BRANCH_SUFFIX,
    role: 'preview',
    headSha: 'deadbeef',
    createdAt: '2026-07-01T00:00:00Z',
    lastSyncedAt: '2026-07-10T00:00:00Z',
    expiresAt: '2026-08-09T00:00:00Z',
    ...overrides
  };
}

function envelopeWithMarker(m: AssetMarker): unknown {
  return {
    data: {
      values: [
        { key: 'baseUrl', value: 'https://x' },
        { key: 'x-pm-onboarding', value: JSON.stringify(m) }
      ]
    }
  };
}

function client(overrides: Partial<GcPostmanClient> = {}): GcPostmanClient {
  return {
    listEnvironments: vi.fn().mockResolvedValue([
      { name: `core-payments @${BRANCH_SUFFIX} - dev`, uid: 'env-preview' },
      { name: 'core-payments - dev', uid: 'env-canonical' }
    ]),
    getEnvironment: vi.fn().mockResolvedValue(envelopeWithMarker(marker())),
    updateEnvironment: vi.fn().mockResolvedValue(undefined),
    listMocks: vi.fn().mockResolvedValue([
      { uid: 'mock-preview', name: `core-payments @${BRANCH_SUFFIX} Mock`, collection: 'col-1', mockUrl: 'https://m', environment: 'env-preview' },
      { uid: 'mock-canonical', name: 'core-payments Mock', collection: 'col-2', mockUrl: 'https://m2', environment: 'env-canonical' }
    ]),
    listMonitors: vi.fn().mockResolvedValue([
      { uid: 'mon-preview', name: `core-payments @${BRANCH_SUFFIX} - Smoke Monitor`, active: true, collectionUid: 'col-1', environmentUid: 'env-preview' }
    ]),
    listSpecifications: vi.fn().mockResolvedValue([]),
    getSpecContent: vi.fn().mockResolvedValue(undefined),
    listSpecCollections: vi.fn().mockResolvedValue([]),
    listCollections: vi.fn().mockResolvedValue([
      { uid: 'col-1', name: `[Smoke] core-payments @${BRANCH_SUFFIX}` },
      { uid: 'col-contract', name: `[Contract] core-payments @${BRANCH_SUFFIX}` }
    ]),
    deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    deleteMock: vi.fn().mockResolvedValue(undefined),
    deleteMonitor: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    deleteSpec: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe('inventoryRemoteBranches', () => {
  it('parses ls-remote heads into a branch set', async () => {
    const exec = {
      getExecOutput: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'abc\trefs/heads/main\ndef\trefs/heads/feature/payments\n',
        stderr: ''
      })
    };
    const branches = await inventoryRemoteBranches(exec);
    expect(branches).toEqual(new Set(['main', 'feature/payments']));
    expect(exec.getExecOutput).toHaveBeenCalledWith('git', ['ls-remote', '--heads', 'origin'], { ignoreReturnCode: true });
  });

  it('returns undefined on credential denial (degraded mode)', async () => {
    const exec = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'auth failed' })
    };
    expect(await inventoryRemoteBranches(exec)).toBeUndefined();
  });
});

describe('collectGcCandidates', () => {
  it('only generated-name shapes become candidates; canonical assets are invisible to GC', async () => {
    const candidates = await collectGcCandidates(client(), 'ws-1');
    expect(candidates.map((c) => c.uid)).toEqual(['env-preview', 'mock-preview', 'mon-preview', 'col-1']);
  });

  it('mocks and monitors inherit the marker from their preview environment', async () => {
    const candidates = await collectGcCandidates(client(), 'ws-1');
    const mock = candidates.find((c) => c.kind === 'mock');
    expect(mock?.marker?.rawBranch).toBe('feature/payments');
  });

  it('discovers a preview spec from its embedded durable marker', async () => {
    const listCollections = vi.fn().mockResolvedValue([
      { uid: 'col-1', name: `[Smoke] core-payments @${BRANCH_SUFFIX}` },
      { uid: 'col-contract', name: `[Contract] core-payments @${BRANCH_SUFFIX}` }
    ]);
    const postman = client({
      listSpecifications: vi.fn().mockResolvedValue([{ uid: 'spec-preview', name: `core-payments @${BRANCH_SUFFIX}` }]),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3\nx-postman-onboarding: ${JSON.stringify(marker())}\n`),
      // Production relation rows contain only the bare collection model ID;
      // they do not project the collection name.
      listSpecCollections: vi.fn().mockResolvedValue([{ uid: 'col-contract', name: '' }]),
      listCollections
    });
    const candidates = await collectGcCandidates(postman, 'ws-1');
    expect(candidates.find((candidate) => candidate.kind === 'spec')).toMatchObject({
      uid: 'spec-preview', marker: { rawBranch: 'feature/payments' }
    });
    expect(candidates.find((candidate) => candidate.uid === 'col-contract')).toMatchObject({
      kind: 'collection',
      name: `[Contract] core-payments @${BRANCH_SUFFIX}`
    });
    expect(listCollections).toHaveBeenCalledTimes(1);
    expect(listCollections).toHaveBeenCalledWith('ws-1');
  });

  it('does not trust a generated-looking relation name when the exact collection is canonical', async () => {
    const postman = client({
      listSpecifications: vi.fn().mockResolvedValue([{ uid: 'spec-preview', name: `core-payments @${BRANCH_SUFFIX}` }]),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3\nx-postman-onboarding: ${JSON.stringify(marker())}\n`),
      listSpecCollections: vi.fn().mockResolvedValue([{
        uid: 'col-canonical',
        name: `[Contract] core-payments @${BRANCH_SUFFIX}`
      }]),
      listCollections: vi.fn().mockResolvedValue([
        { uid: 'col-1', name: `[Smoke] core-payments @${BRANCH_SUFFIX}` },
        { uid: 'col-canonical', name: '[Contract] core-payments' }
      ])
    });

    const candidates = await collectGcCandidates(postman, 'ws-1');
    expect(candidates.some((candidate) => candidate.uid === 'col-canonical')).toBe(false);
    expect(candidates.some((candidate) => candidate.uid === 'spec-preview')).toBe(false);
  });

  it('preserves a preview specification when relation discovery fails', async () => {
    const postman = client({
      listSpecifications: vi.fn().mockResolvedValue([{ uid: 'spec-preview', name: `core-payments @${BRANCH_SUFFIX}` }]),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3\nx-postman-onboarding: ${JSON.stringify(marker())}\n`),
      listSpecCollections: vi.fn().mockRejectedValue(new Error('relation service unavailable'))
    });

    const candidates = await collectGcCandidates(postman, 'ws-1');
    expect(candidates.some((candidate) => candidate.uid === 'spec-preview')).toBe(false);
  });

  it('takes one collection snapshot for duplicate agreeing specification relations', async () => {
    const listCollections = vi.fn().mockResolvedValue([
      { uid: 'col-1', name: `[Smoke] core-payments @${BRANCH_SUFFIX}` },
      { uid: 'col-shared', name: `[Contract] core-payments @${BRANCH_SUFFIX}` }
    ]);
    const postman = client({
      listSpecifications: vi.fn().mockResolvedValue([
        { uid: 'spec-preview-a', name: `core-payments @${BRANCH_SUFFIX}` },
        { uid: 'spec-preview-b', name: `core-payments @${BRANCH_SUFFIX}` }
      ]),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3\nx-postman-onboarding: ${JSON.stringify(marker())}\n`),
      listSpecCollections: vi.fn().mockResolvedValue([{ uid: 'col-shared', name: '' }]),
      listCollections
    });

    const candidates = await collectGcCandidates(postman, 'ws-1');
    expect(candidates.filter((candidate) => candidate.uid === 'col-shared')).toHaveLength(1);
    expect(listCollections).toHaveBeenCalledTimes(1);
  });

  it('joins bare relation IDs to exact owner-prefixed inventory IDs without exporting', async () => {
    const modelId = '12345678-abcd-ef01-2345-678901234567';
    const publicUid = `10490519-${modelId}`;
    const legacyExport = vi.fn().mockRejectedValue(new Error('GC must not export'));
    const postman = Object.assign(client({
      listSpecifications: vi.fn().mockResolvedValue([{ uid: 'spec-preview', name: `core-payments @${BRANCH_SUFFIX}` }]),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3\nx-postman-onboarding: ${JSON.stringify(marker())}\n`),
      listSpecCollections: vi.fn().mockResolvedValue([{ uid: modelId, name: 'attacker-supplied relation name' }]),
      listCollections: vi.fn().mockResolvedValue([
        { uid: 'col-1', name: `[Smoke] core-payments @${BRANCH_SUFFIX}` },
        { uid: publicUid, name: `[Contract] core-payments @${BRANCH_SUFFIX}` }
      ])
    }), { getCollection: legacyExport });

    const candidates = await collectGcCandidates(postman, 'ws-1');
    expect(candidates).toContainEqual(expect.objectContaining({
      kind: 'collection', uid: publicUid, name: `[Contract] core-payments @${BRANCH_SUFFIX}`
    }));
    expect(legacyExport).not.toHaveBeenCalled();
  });

  it('joins owner-prefixed relation IDs to exact bare inventory IDs', async () => {
    const modelId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const postman = client({
      listMocks: vi.fn().mockResolvedValue([]),
      listMonitors: vi.fn().mockResolvedValue([]),
      listSpecifications: vi.fn().mockResolvedValue([{ uid: 'spec-preview', name: `core-payments @${BRANCH_SUFFIX}` }]),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3\nx-postman-onboarding: ${JSON.stringify(marker())}\n`),
      listSpecCollections: vi.fn().mockResolvedValue([{ uid: `10490519-${modelId}`, name: '' }]),
      listCollections: vi.fn().mockResolvedValue([
        { uid: modelId, name: `[Contract] core-payments @${BRANCH_SUFFIX}` }
      ])
    });

    const candidates = await collectGcCandidates(postman, 'ws-1');
    expect(candidates).toContainEqual(expect.objectContaining({ kind: 'collection', uid: modelId }));
    expect(candidates).toContainEqual(expect.objectContaining({ kind: 'spec', uid: 'spec-preview' }));
  });

  it('preserves a marked spec when its relation is absent from the snapshot', async () => {
    const postman = client({
      listSpecifications: vi.fn().mockResolvedValue([{ uid: 'spec-preview', name: `core-payments @${BRANCH_SUFFIX}` }]),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3\nx-postman-onboarding: ${JSON.stringify(marker())}\n`),
      listSpecCollections: vi.fn().mockResolvedValue([{ uid: 'col-missing', name: '' }])
    });

    const candidates = await collectGcCandidates(postman, 'ws-1');
    expect(candidates.some((candidate) => candidate.uid === 'spec-preview')).toBe(false);
    expect(candidates.some((candidate) => candidate.uid === 'col-missing')).toBe(false);
  });

  it('preserves a marked spec when relation discovery returns an empty set', async () => {
    const postman = client({
      listSpecifications: vi.fn().mockResolvedValue([{ uid: 'spec-preview', name: `core-payments @${BRANCH_SUFFIX}` }]),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3\nx-postman-onboarding: ${JSON.stringify(marker())}\n`),
      listSpecCollections: vi.fn().mockResolvedValue([])
    });

    const candidates = await collectGcCandidates(postman, 'ws-1');
    expect(candidates.some((candidate) => candidate.uid === 'spec-preview')).toBe(false);
  });

  it.each([
    ['list failure', vi.fn().mockRejectedValue(new Error('collection list unavailable'))],
    ['malformed row', vi.fn().mockResolvedValue([{ uid: 'col-contract', name: '' }])]
  ])('preserves marked specs when the authoritative snapshot has a %s', async (_label, listCollections) => {
    const postman = client({
      listCollections: listCollections as GcPostmanClient['listCollections'],
      listSpecifications: vi.fn().mockResolvedValue([{ uid: 'spec-preview', name: `core-payments @${BRANCH_SUFFIX}` }]),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3\nx-postman-onboarding: ${JSON.stringify(marker())}\n`),
      listSpecCollections: vi.fn().mockResolvedValue([{ uid: 'col-contract', name: '' }])
    });

    const candidates = await collectGcCandidates(postman, 'ws-1');
    expect(candidates.some((candidate) => candidate.uid === 'spec-preview')).toBe(false);
    expect(candidates.some((candidate) => candidate.kind === 'collection')).toBe(false);
  });

  it('preserves a marked spec when normalized inventory identity is ambiguous', async () => {
    const modelId = '12345678-abcd-ef01-2345-678901234567';
    const postman = client({
      listCollections: vi.fn().mockResolvedValue([
        { uid: modelId, name: `[Contract] core-payments @${BRANCH_SUFFIX}` },
        { uid: `10490519-${modelId}`, name: `[Contract] core-payments @${BRANCH_SUFFIX}` }
      ]),
      listSpecifications: vi.fn().mockResolvedValue([{ uid: 'spec-preview', name: `core-payments @${BRANCH_SUFFIX}` }]),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3\nx-postman-onboarding: ${JSON.stringify(marker())}\n`),
      listSpecCollections: vi.fn().mockResolvedValue([{ uid: modelId, name: '' }])
    });

    const candidates = await collectGcCandidates(postman, 'ws-1');
    expect(candidates.some((candidate) => candidate.uid === 'spec-preview')).toBe(false);
    expect(candidates.some((candidate) => candidate.kind === 'collection')).toBe(false);
  });

  it('does not inherit a marker into a collection from a non-generated mock', async () => {
    const postman = client({
      listMocks: vi.fn().mockResolvedValue([
        { uid: 'mock-attacker', name: 'attacker mock', collection: 'col-victim', mockUrl: 'https://m', environment: 'env-preview' }
      ]),
      listMonitors: vi.fn().mockResolvedValue([])
    });
    const candidates = await collectGcCandidates(postman, 'ws-1');
    expect(candidates.some((candidate) => candidate.uid === 'col-victim')).toBe(false);
  });
});

describe('runGc', () => {
  it('branch deleted: removes the whole preview set, leaves canonical assets alone', async () => {
    const postman = client({
      listSpecifications: vi.fn().mockResolvedValue([{ uid: 'spec-preview', name: `core-payments @${BRANCH_SUFFIX}` }]),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3\nx-postman-onboarding: ${JSON.stringify(marker())}\n`),
      listSpecCollections: vi.fn().mockResolvedValue([{ uid: 'col-contract', name: `[Contract] core-payments @${BRANCH_SUFFIX}` }])
    });
    const exec = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'abc\trefs/heads/main\n', stderr: '' })
    };
    const summary = await runGc({ workspaceId: 'ws-1', repo: REPO, postman, exec });
    expect(postman.deleteEnvironment).toHaveBeenCalledWith('env-preview');
    expect(postman.deleteMock).toHaveBeenCalledWith('mock-preview');
    expect(postman.deleteMonitor).toHaveBeenCalledWith('mon-preview');
    expect(postman.deleteCollection).toHaveBeenCalledWith('col-1');
    expect(postman.deleteSpec).toHaveBeenCalledWith('spec-preview');
    expect(postman.deleteCollection).toHaveBeenCalledWith('col-contract');
    expect(summary.counts.delete).toBe(6);
    expect(summary.degraded).toBe(false);
  });

  it('branch alive: retains the preview set', async () => {
    const postman = client();
    const exec = {
      getExecOutput: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'abc\trefs/heads/main\ndef\trefs/heads/feature/payments\n',
        stderr: ''
      })
    };
    const summary = await runGc({ workspaceId: 'ws-1', repo: REPO, postman, exec });
    expect(postman.deleteEnvironment).not.toHaveBeenCalled();
    expect(summary.counts.retain).toBe(4);
  });

  it('retires a deleted channel first, then deletes it after deleteAfter', async () => {
    const channel = marker({ role: 'channel', channelCode: 'DEV', rawBranch: 'develop', sanitizedBranch: 'develop', expiresAt: undefined });
    const postman = client({
      listEnvironments: vi.fn().mockResolvedValue([{ name: '[DEV] core-payments - dev', uid: 'env-channel' }]),
      getEnvironment: vi.fn().mockResolvedValue(envelopeWithMarker(channel)),
      listMocks: vi.fn().mockResolvedValue([]),
      listMonitors: vi.fn().mockResolvedValue([])
    });
    const exec = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'abc\trefs/heads/main\n', stderr: '' })
    };

    const first = await runGc({
      workspaceId: 'ws-1', repo: REPO, postman, exec,
      now: new Date('2026-07-15T00:00:00Z'), previewTtlDays: 7
    });
    expect(first.counts.retire).toBe(1);
    expect(postman.deleteEnvironment).not.toHaveBeenCalled();
    expect(postman.updateEnvironment).toHaveBeenCalledWith(
      'env-channel',
      '[DEV] core-payments - dev',
      expect.arrayContaining([expect.objectContaining({
        key: 'x-pm-onboarding',
        value: expect.stringContaining('2026-07-22T00:00:00.000Z')
      })])
    );

    vi.mocked(postman.getEnvironment).mockResolvedValue(envelopeWithMarker({
      ...channel,
      retirementDetectedAt: '2026-07-15T00:00:00.000Z',
      retirementReason: 'branch-deleted',
      deleteAfter: '2026-07-22T00:00:00.000Z'
    }));
    const second = await runGc({
      workspaceId: 'ws-1', repo: REPO, postman, exec,
      now: new Date('2026-07-23T00:00:00Z')
    });
    expect(second.counts.delete).toBe(1);
    expect(postman.deleteEnvironment).toHaveBeenCalledWith('env-channel');
  });

  it('degraded (no git credential): probes skipped, TTL-expired assets still deleted', async () => {
    const postman = client({
      getEnvironment: vi.fn().mockResolvedValue(
        envelopeWithMarker(marker({ expiresAt: '2026-07-01T00:00:00Z' }))
      )
    });
    const exec = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'denied' })
    };
    const summary = await runGc({
      workspaceId: 'ws-1',
      repo: REPO,
      postman,
      exec,
      now: new Date('2026-07-14T00:00:00Z')
    });
    expect(summary.degraded).toBe(true);
    expect(postman.deleteEnvironment).toHaveBeenCalledWith('env-preview');
  });

  it('manual --branch scope never probes the remote', async () => {
    const postman = client();
    const exec = { getExecOutput: vi.fn() };
    const summary = await runGc({
      workspaceId: 'ws-1',
      repo: REPO,
      postman,
      exec,
      onlyBranch: 'feature/payments'
    });
    expect(exec.getExecOutput).not.toHaveBeenCalled();
    expect(summary.counts.delete).toBe(4);
  });

  it('dry run decides but deletes nothing', async () => {
    const postman = client();
    const exec = { getExecOutput: vi.fn() };
    const summary = await runGc({
      workspaceId: 'ws-1',
      repo: REPO,
      postman,
      exec,
      allPreviews: true,
      dryRun: true
    });
    expect(postman.deleteEnvironment).not.toHaveBeenCalled();
    expect(summary.counts.delete).toBe(4);
  });

  it('stranger assets from another repo are never deleted', async () => {
    const postman = client({
      getEnvironment: vi.fn().mockResolvedValue(
        envelopeWithMarker(marker({ repo: 'https://github.com/acme/other' }))
      )
    });
    const exec = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    };
    const summary = await runGc({ workspaceId: 'ws-1', repo: REPO, postman, exec });
    expect(postman.deleteEnvironment).not.toHaveBeenCalled();
    expect(summary.counts.stranger).toBeGreaterThan(0);
  });
});
