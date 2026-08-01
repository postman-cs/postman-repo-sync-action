import { createSecretMasker, normalizeSecretValues } from '../src/lib/secrets.js';

export interface ProbeReceiptEmitter {
  readonly emitted: readonly string[];
  sanitize(text: string): string;
  emit(text: string, write: (sanitized: string) => void): string;
  check(): { safe: boolean; remainingSecretRepresentations: string[] };
}

/** Creates a receipt boundary: raw text is always sanitized before recording or writing. */
export function createProbeReceiptEmitter(secretValues: unknown): ProbeReceiptEmitter {
  const normalizedSecretValues = normalizeSecretValues(secretValues);
  const maskSecrets = createSecretMasker(normalizedSecretValues);
  const emitted: string[] = [];

  function sanitize(text: string): string {
    return maskSecrets(String(text ?? ''));
  }

  return {
    emitted,
    sanitize,
    emit(text, write): string {
      const sanitized = sanitize(text);
      emitted.push(sanitized);
      write(sanitized);
      return sanitized;
    },
    check(): { safe: boolean; remainingSecretRepresentations: string[] } {
      const remainingSecretRepresentations = normalizedSecretValues.filter((secret) =>
        emitted.some((text) => text.includes(secret))
      );
      return {
        safe: remainingSecretRepresentations.length === 0,
        remainingSecretRepresentations
      };
    }
  };
}

export interface DeleteAttempt {
  status?: number;
  error?: string;
}

export interface DispatchProbeCleanupDependencies {
  repositories: readonly string[];
  scratchDirs: readonly string[];
  deleteRepository(fullName: string): Promise<DeleteAttempt>;
  repositoryStatus(fullName: string): Promise<number>;
  removeScratchDir(dir: string): Promise<void>;
  onError(message: string): void;
  maxDeleteAttempts?: number;
}

export interface DispatchProbeCleanupResult {
  allDeleted: boolean;
  cleanupComplete: boolean;
}

/**
 * Cleans every tracked resource independently. Deletion retries are bounded;
 * verification and scratch cleanup still run after any prior failure.
 */
export async function cleanupDispatchProbe(
  dependencies: DispatchProbeCleanupDependencies
): Promise<DispatchProbeCleanupResult> {
  const maxDeleteAttempts = dependencies.maxDeleteAttempts ?? 3;
  let allDeleted = true;
  let scratchDirsDeleted = true;

  for (const fullName of dependencies.repositories) {
    for (let attempt = 0; attempt < maxDeleteAttempts; attempt += 1) {
      try {
        const result = await dependencies.deleteRepository(fullName);
        if (result.status === 204 || result.status === 404) {
          break;
        }
        dependencies.onError(
          `cleanup: DELETE /repos/${fullName} attempt ${attempt + 1}/${maxDeleteAttempts} -> ${result.status ?? `error: ${result.error ?? 'unknown'}`}`
        );
      } catch (error) {
        dependencies.onError(
          `cleanup: DELETE /repos/${fullName} attempt ${attempt + 1}/${maxDeleteAttempts} threw: ${(error as Error).message}`
        );
      }
    }
    // A failed DELETE alone does not settle deletion state: the independent
    // GET verification below is authoritative (a prior delete may have won).
  }

  for (const fullName of dependencies.repositories) {
    try {
      const status = await dependencies.repositoryStatus(fullName);
      if (status !== 404) {
        allDeleted = false;
        dependencies.onError(`cleanup verification FAILED: ${fullName} still resolves (${status})`);
      }
    } catch (error) {
      allDeleted = false;
      dependencies.onError(`cleanup verification FAILED: ${fullName}: ${(error as Error).message}`);
    }
  }

  for (const dir of dependencies.scratchDirs) {
    try {
      await dependencies.removeScratchDir(dir);
    } catch (error) {
      scratchDirsDeleted = false;
      dependencies.onError(`scratch cleanup FAILED: ${dir}: ${(error as Error).message}`);
    }
  }

  return { allDeleted, cleanupComplete: allDeleted && scratchDirsDeleted };
}

export function formatCleanupSummary(result: DispatchProbeCleanupResult): string {
  return result.cleanupComplete ? 'all deleted' : 'cleanup incomplete';
}
