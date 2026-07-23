export function normalizeSemver(version: string): string;
export function compareSemver(left: string, right: string): -1 | 0 | 1;
export function isSemverOlder(left: string, right: string): boolean;
export function classifyRelease(input: {
  ref: string;
  refName: string;
  packageVersion: string;
}): { release_kind: 'immutable' | 'alias'; npm_publish: 'true' | 'false' };
