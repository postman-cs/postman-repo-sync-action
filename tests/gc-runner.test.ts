import { describe, expect, it, vi } from 'vitest';

import { type AssetMarker } from '../src/lib/repo/branch-decision.js';
import {
  collectGcCandidates,
  inventoryRemoteBranches,
  runGc,
  type GcPostmanClient
} from '../src/lib/repo/gc-runner.js';

const REPO = 'https://github.com/acme/payments';

function marker(overrides: Partial<AssetMarker> = {}): AssetMarker {
  return {
    repo: REPO,
    rawBranch: 'feature/payments',
    sanitizedBranch: 'feature-payments',
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
      { name: 'core-payments @feature-payments - dev', uid: 'env-preview' },
      { name: 'core-payments - dev', uid: 'env-canonical' }
    ]),
    getEnvironment: vi.fn().mockResolvedValue(envelopeWithMarker(marker())),
    listMocks: vi.fn().mockResolvedValue([
      { uid: 'mock-preview', name: 'core-payments @feature-payments Mock', collection: 'col-1', mockUrl: 'https://m', environment: 'env-preview' },
      { uid: 'mock-canonical', name: 'core-payments Mock', collection: 'col-2', mockUrl: 'https://m2', environment: 'env-canonical' }
    ]),
    listMonitors: vi.fn().mockResolvedValue([
      { uid: 'mon-preview', name: 'core-payments @feature-payments - Smoke Monitor', active: true, collectionUid: 'col-1', environmentUid: 'env-preview' }
    ]),
    deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    deleteMock: vi.fn().mockResolvedValue(undefined),
    deleteMonitor: vi.fn().mockResolvedValue(undefined),
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
    expect(candidates.map((c) => c.uid)).toEqual(['env-preview', 'mock-preview', 'mon-preview']);
  });

  it('mocks and monitors inherit the marker from their preview environment', async () => {
    const candidates = await collectGcCandidates(client(), 'ws-1');
    const mock = candidates.find((c) => c.kind === 'mock');
    expect(mock?.marker?.rawBranch).toBe('feature/payments');
  });
});

describe('runGc', () => {
  it('branch deleted: removes the whole preview set, leaves canonical assets alone', async () => {
    const postman = client();
    const exec = {
      getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'abc\trefs/heads/main\n', stderr: '' })
    };
    const summary = await runGc({ workspaceId: 'ws-1', repo: REPO, postman, exec });
    expect(postman.deleteEnvironment).toHaveBeenCalledWith('env-preview');
    expect(postman.deleteMock).toHaveBeenCalledWith('mock-preview');
    expect(postman.deleteMonitor).toHaveBeenCalledWith('mon-preview');
    expect(summary.counts.delete).toBe(3);
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
    expect(summary.counts.retain).toBe(3);
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
    expect(summary.counts.delete).toBe(3);
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
    expect(summary.counts.delete).toBe(3);
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
