import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

export function assertPathWithinCwd(targetPath: string, fieldName: string): void {
  const originalPath = String(targetPath || '');
  const rawPath = originalPath.trim();
  const segments = rawPath.split(/[\\/]+/).filter(Boolean);
  if (
    !rawPath ||
    hasControlCharacter(originalPath) ||
    path.isAbsolute(rawPath) ||
    path.win32.isAbsolute(rawPath) ||
    segments.includes('..') ||
    rawPath.startsWith(':') ||
    hasControlCharacter(rawPath)
  ) {
    throw new Error(`${fieldName} must stay within the repository root; received ${targetPath}`);
  }

  const base = realpathSync(process.cwd());
  const resolved = path.resolve(base, rawPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must stay within the repository root; received ${targetPath}`);
  }

  let existingPath = resolved;
  while (!existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) {
      break;
    }
    existingPath = parent;
  }

  const realExistingPath = realpathSync(existingPath);
  const realRelative = path.relative(base, realExistingPath);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`${fieldName} must stay within the repository root; received ${targetPath}`);
  }
}
