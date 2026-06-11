import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

describe('README action tables', () => {
  it('match action.yml (run npm run docs:tables after editing action.yml)', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [resolve(repoRoot, 'scripts/render-action-tables.mjs'), '--check'],
        { cwd: repoRoot, stdio: 'pipe' }
      )
    ).not.toThrow();
  });
});
