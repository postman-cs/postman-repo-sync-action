import { describe, expect, it, vi } from 'vitest';

import { cleanupDispatchProbe, formatCleanupSummary } from '../scripts/live-github-dispatch-probe-support.js';

describe('live GitHub dispatch probe cleanup', () => {
  it('retries a failed deletion, then verifies it while continuing to later repositories', async () => {
    const deleteRepository = vi.fn(async (repository: string) => {
      if (repository === 'owner/first' && deleteRepository.mock.calls.length === 1) {
        throw new Error('transient delete failure');
      }
      return { status: 204 };
    });
    const repositoryStatus = vi.fn<(repository: string) => Promise<number>>(async () => 404);
    const removeScratchDir = vi.fn<(dir: string) => Promise<void>>(async () => undefined);
    const onError = vi.fn();

    const result = await cleanupDispatchProbe({
      repositories: ['owner/first', 'owner/later'],
      scratchDirs: ['/tmp/first', '/tmp/later'],
      maxDeleteAttempts: 2,
      deleteRepository,
      repositoryStatus,
      removeScratchDir,
      onError
    });

    expect(deleteRepository.mock.calls.map(([repository]) => repository)).toEqual([
      'owner/first',
      'owner/first',
      'owner/later'
    ]);
    expect(deleteRepository).toHaveBeenCalledTimes(3);
    expect(repositoryStatus.mock.calls.map(([repository]) => repository)).toEqual(['owner/first', 'owner/later']);
    expect(removeScratchDir.mock.calls.map(([dir]) => dir)).toEqual(['/tmp/first', '/tmp/later']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ allDeleted: true, cleanupComplete: true });
    expect(formatCleanupSummary(result)).toBe('all deleted');
  });

  it('bounds persistent failures while attempting all later resources and reporting incomplete cleanup', async () => {
    const deleteRepository = vi.fn(async (repository: string) => {
      if (repository === 'owner/persistent-delete') return { status: 500, error: 'still failing' };
      return { status: 204 };
    });
    const repositoryStatus = vi.fn(async (repository: string) => {
      if (repository === 'owner/persistent-delete') return 200;
      if (repository === 'owner/verification-throws') throw new Error('verification unavailable');
      return 404;
    });
    const removeScratchDir = vi.fn(async (dir: string) => {
      if (dir === '/tmp/remove-fails') throw new Error('scratch removal failed');
    });
    const onError = vi.fn();

    const result = await cleanupDispatchProbe({
      repositories: ['owner/persistent-delete', 'owner/verification-throws', 'owner/later'],
      scratchDirs: ['/tmp/remove-fails', '/tmp/later'],
      maxDeleteAttempts: 2,
      deleteRepository,
      repositoryStatus,
      removeScratchDir,
      onError
    });

    expect(deleteRepository.mock.calls.map(([repository]) => repository)).toEqual([
      'owner/persistent-delete',
      'owner/persistent-delete',
      'owner/verification-throws',
      'owner/later'
    ]);
    expect(deleteRepository).toHaveBeenCalledTimes(4);
    expect(repositoryStatus.mock.calls.map(([repository]) => repository)).toEqual([
      'owner/persistent-delete',
      'owner/verification-throws',
      'owner/later'
    ]);
    expect(removeScratchDir.mock.calls.map(([dir]) => dir)).toEqual(['/tmp/remove-fails', '/tmp/later']);
    expect(onError).toHaveBeenCalledTimes(5);
    expect(onError.mock.calls.flat()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('owner/persistent-delete'),
        expect.stringContaining('owner/verification-throws'),
        expect.stringContaining('/tmp/remove-fails')
      ])
    );
    expect(result).toEqual({ allDeleted: false, cleanupComplete: false });
    expect(formatCleanupSummary(result)).toBe('cleanup incomplete');
  });

  it('reports all deleted only when every repository verifies as absent', async () => {
    const deleteRepository = vi.fn<(repository: string) => Promise<{ status: number }>>(async () => ({ status: 404 }));
    const repositoryStatus = vi.fn<(repository: string) => Promise<number>>(async () => 404);
    const removeScratchDir = vi.fn<(dir: string) => Promise<void>>(async () => undefined);
    const onError = vi.fn();

    const result = await cleanupDispatchProbe({
      repositories: ['owner/already-gone', 'owner/also-gone'],
      scratchDirs: ['/tmp/already-gone'],
      deleteRepository,
      repositoryStatus,
      removeScratchDir,
      onError
    });

    expect(deleteRepository.mock.calls.map(([repository]) => repository)).toEqual(['owner/already-gone', 'owner/also-gone']);
    expect(repositoryStatus.mock.calls.map(([repository]) => repository)).toEqual(['owner/already-gone', 'owner/also-gone']);
    expect(removeScratchDir).toHaveBeenCalledWith('/tmp/already-gone');
    expect(onError).not.toHaveBeenCalled();
    expect(result).toEqual({ allDeleted: true, cleanupComplete: true });
    expect(formatCleanupSummary(result)).toBe('all deleted');
  });

  it('reports incomplete cleanup when scratch removal fails after every repository is verified absent', async () => {
    const deleteRepository = vi.fn<(repository: string) => Promise<{ status: number }>>(async () => ({ status: 404 }));
    const repositoryStatus = vi.fn<(repository: string) => Promise<number>>(async () => 404);
    const removeScratchDir = vi.fn(async (dir: string) => {
      if (dir === '/tmp/remove-fails') throw new Error('scratch removal failed');
    });
    const onError = vi.fn();

    const result = await cleanupDispatchProbe({
      repositories: ['owner/already-gone', 'owner/also-gone'],
      scratchDirs: ['/tmp/remove-fails', '/tmp/later'],
      deleteRepository,
      repositoryStatus,
      removeScratchDir,
      onError
    });

    expect(deleteRepository.mock.calls.map(([repository]) => repository)).toEqual(['owner/already-gone', 'owner/also-gone']);
    expect(repositoryStatus.mock.calls.map(([repository]) => repository)).toEqual(['owner/already-gone', 'owner/also-gone']);
    expect(removeScratchDir.mock.calls.map(([dir]) => dir)).toEqual(['/tmp/remove-fails', '/tmp/later']);
    expect(onError.mock.calls.flat()).toEqual(expect.arrayContaining([expect.stringContaining('/tmp/remove-fails')]));
    expect(result).toEqual({ allDeleted: true, cleanupComplete: false });
    expect(formatCleanupSummary(result)).toBe('cleanup incomplete');
  });
});
