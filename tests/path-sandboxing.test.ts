import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { assertPathWithinCwd } from '../src/index.js';

describe('assertPathWithinCwd', () => {
  it('allows relative paths within repo root', () => {
    expect(() => assertPathWithinCwd('postman', 'artifact-dir')).not.toThrow();
    expect(() => assertPathWithinCwd('.github/workflows/ci.yml', 'ci-workflow-path')).not.toThrow();
    expect(() => assertPathWithinCwd('nested/deep/dir', 'artifact-dir')).not.toThrow();
  });

  it('rejects paths that traverse above repo root', () => {
    expect(() => assertPathWithinCwd('../out', 'artifact-dir')).toThrow(
      'artifact-dir must stay within the repository root; received ../out'
    );
    expect(() => assertPathWithinCwd('../../etc/passwd', 'ci-workflow-path')).toThrow(
      'ci-workflow-path must stay within the repository root'
    );
    expect(() => assertPathWithinCwd('postman/../../out', 'artifact-dir')).toThrow(
      'artifact-dir must stay within the repository root'
    );
  });

  it('rejects absolute paths', () => {
    expect(() => assertPathWithinCwd('/etc/passwd', 'artifact-dir')).toThrow(
      'artifact-dir must stay within the repository root; received /etc/passwd'
    );
    expect(() => assertPathWithinCwd('/tmp/output', 'ci-workflow-path')).toThrow(
      'ci-workflow-path must stay within the repository root; received /tmp/output'
    );
    expect(() => assertPathWithinCwd('C:\\tmp\\output', 'ci-workflow-path')).toThrow(
      'ci-workflow-path must stay within the repository root; received C:\\tmp\\output'
    );
  });

  it('rejects pathspec magic and control characters', () => {
    expect(() => assertPathWithinCwd(':(top)', 'artifact-dir')).toThrow(
      'artifact-dir must stay within the repository root; received :(top)'
    );
    expect(() => assertPathWithinCwd('postman\nout', 'artifact-dir')).toThrow(
      'artifact-dir must stay within the repository root'
    );
    expect(() => assertPathWithinCwd('postman\x1Fout', 'artifact-dir')).toThrow(
      'artifact-dir must stay within the repository root'
    );
  });

  it('allows current directory reference', () => {
    expect(() => assertPathWithinCwd('.', 'artifact-dir')).not.toThrow();
    expect(() => assertPathWithinCwd('./postman', 'artifact-dir')).not.toThrow();
  });

  it('rejects paths whose existing parent resolves outside the repo root', () => {
    const originalCwd = process.cwd();
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-sync-sandbox-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'repo-sync-outside-'));

    try {
      mkdirSync(join(repoRoot, 'postman'), { recursive: true });
      symlinkSync(outsideRoot, join(repoRoot, 'postman', 'escaped'));
      process.chdir(repoRoot);

      expect(() => assertPathWithinCwd('postman/escaped/generated', 'artifact-dir')).toThrow(
        'artifact-dir must stay within the repository root; received postman/escaped/generated'
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
