import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { vi, describe, expect, it } from 'vitest';

// Every test in this file execs real node child processes; the default 5s
// vitest timeout flakes under full-suite load, so raise it file-wide.
vi.setConfig({ testTimeout: 60_000 });

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
