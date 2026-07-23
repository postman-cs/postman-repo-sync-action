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
