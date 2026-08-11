import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFileAtomicSync } from '../src/lib/fs/atomic-file.js';

describe('writeFileAtomicSync', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('promotes a validated same-filesystem candidate', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'repo-sync-atomic-'));
    roots.push(root);
    const target = path.join(root, 'nested', 'environment.yaml');
    mkdirSync(path.dirname(target));
    writeFileAtomicSync(target, 'name: prod\n', (candidate) => {
      expect(path.dirname(path.dirname(candidate))).toBe(realpathSync(path.dirname(target)));
      expect(readFileSync(candidate, 'utf8')).toBe('name: prod\n');
    });
    expect(readFileSync(target, 'utf8')).toBe('name: prod\n');
    expect(readdirSync(path.dirname(target))).toEqual(['environment.yaml']);
  });

  it('keeps the prior target and cleans the candidate when validation fails', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'repo-sync-atomic-'));
    roots.push(root);
    const target = path.join(root, 'environment.yaml');
    writeFileSync(target, 'name: prior\n');
    expect(() =>
      writeFileAtomicSync(target, 'name: candidate\n', () => {
        throw new Error('candidate rejected');
      })
    ).toThrow('candidate rejected');
    expect(readFileSync(target, 'utf8')).toBe('name: prior\n');
    expect(readdirSync(root)).toEqual(['environment.yaml']);
  });
});
