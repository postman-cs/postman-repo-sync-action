import {
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

/**
 * Write and validate a candidate beside its destination, then atomically
 * promote it. Callers remain responsible for validating that targetPath is
 * confined to their allowed root before calling this helper.
 */
export function writeFileAtomicSync(
  targetPath: string,
  content: string,
  validateCandidate?: (candidatePath: string) => void
): void {
  const resolvedTarget = path.resolve(targetPath);
  const targetDirectory = realpathSync(path.dirname(resolvedTarget));
  const temporaryDirectory = mkdtempSync(
    path.join(targetDirectory, `.${path.basename(resolvedTarget)}.`)
  );
  const candidatePath = path.join(temporaryDirectory, path.basename(resolvedTarget));

  try {
    writeFileSync(candidatePath, content, 'utf8');
    validateCandidate?.(candidatePath);
    renameSync(candidatePath, resolvedTarget);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
