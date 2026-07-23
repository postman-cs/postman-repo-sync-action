import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyRelease,
  compareSemver,
  isSemverOlder,
  normalizeSemver
} from '../scripts/release-policy.mjs';

describe('release policy classification', () => {
  it('classifies exact and zero-patch immutable tags with npm_publish true', () => {
    expect(classifyRelease({ ref: 'refs/tags/v2.1.10', refName: 'v2.1.10', packageVersion: '2.1.10' })).toEqual({
      release_kind: 'immutable',
      npm_publish: 'true'
    });
    expect(classifyRelease({ ref: 'refs/tags/v2.1', refName: 'v2.1', packageVersion: '2.1.0' })).toEqual({
      release_kind: 'immutable',
      npm_publish: 'true'
    });
  });

  it('classifies rolling major aliases with npm_publish false and rejects branch/mismatch refs', () => {
    expect(classifyRelease({ ref: 'refs/tags/v2', refName: 'v2', packageVersion: '2.1.10' })).toEqual({
      release_kind: 'alias',
      npm_publish: 'false'
    });
    expect(() => classifyRelease({ ref: 'refs/heads/main', refName: 'main', packageVersion: '2.1.10' })).toThrow(
      /got refs\/heads\/main; expected v2\.1\.10, v2\.1 when patch is zero, or v2/
    );
    expect(() => classifyRelease({ ref: 'refs/tags/v2.1.9', refName: 'v2.1.9', packageVersion: '2.1.10' })).toThrow(
      /got v2\.1\.9; expected v2\.1\.10, v2\.1 when patch is zero, or v2/
    );
    expect(() => classifyRelease({ ref: 'refs/tags/v2.2', refName: 'v2.2', packageVersion: '2.1.10' })).toThrow(
      /accepted immutable tag/
    );
  });
});

describe('release policy alias comparisons', () => {
  it('orders full semantic versions so zero-patch cannot regress past a newer patch', () => {
    expect(normalizeSemver('2.1')).toBe('2.1.0');
    expect(compareSemver('2.1.0', '2.1.1')).toBe(-1);
    expect(compareSemver('2.1.1', '2.1.1')).toBe(0);
    expect(compareSemver('2.1.2', '2.1.1')).toBe(1);
    expect(isSemverOlder('2.1.0', '2.1.1')).toBe(true);
    expect(isSemverOlder('2.1.1', '2.1.1')).toBe(false);
    expect(isSemverOlder('2.1.2', '2.1.1')).toBe(false);
  });
});

describe('declared release-surface docs match package-driven major semantics', () => {
  const root = join(import.meta.dirname, '..');
  const releasePolicy = readFileSync(join(root, 'RELEASE_POLICY.md'), 'utf8');
  const security = readFileSync(join(root, 'SECURITY.md'), 'utf8');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');

  it('describes generic vN / current-major forms without stale v1 claims', () => {
    for (const [name, text] of [
      ['RELEASE_POLICY.md', releasePolicy],
      ['SECURITY.md', security],
      ['README.md', readme]
    ] as const) {
      expect(text, `${name} must not claim stale v1.x.y`).not.toMatch(/v1\.x\.y/);
      expect(text, `${name} must not claim rolling v1`).not.toMatch(/rolling `?v1`?/);
    }

    expect(releasePolicy).toMatch(/`vN\.x\.y`/);
    expect(releasePolicy).toMatch(/`vN\.x`/);
    expect(releasePolicy).toMatch(/rolling current-major `vN`/);
    expect(releasePolicy).toMatch(/`v0` tags stay frozen/);

    expect(security).toMatch(/latest immutable release on the current supported major/);
    expect(security).toMatch(/rolling `vN` alias/);
    expect(security).toMatch(/Older tags remain/);

    expect(readme).toMatch(/rolling-major `vN`/);
  });
});
