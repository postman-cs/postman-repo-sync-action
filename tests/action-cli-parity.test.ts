import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

/**
 * P3 drift gate (.plans/e2e-suite-tuneup.md): the CLI maintains a hard-coded
 * input-name array (CLI_INPUT_NAMES) separate from action.yml. Assert the two
 * stay equal so a new action input cannot ship without its CLI flag (and vice
 * versa), minus the explicit CLI-only allowlist below.
 */

// Inputs the CLI accepts that action.yml deliberately does not declare: on the
// GitHub runner these arrive via the runner's own env (GITHUB_REPOSITORY,
// GITHUB_HEAD_REF, GITHUB_REF_NAME); the CLI needs flags to stand in for them.
const CLI_ONLY_INPUTS = ['repository', 'github-head-ref', 'github-ref-name'];

function actionManifestInputs(): string[] {
  const manifest = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
    inputs?: Record<string, unknown>;
  };
  return Object.keys(manifest.inputs ?? {});
}

function cliInputNames(): string[] {
  const source = readFileSync(resolve(repoRoot, 'src/cli.ts'), 'utf8');
  const match = source.match(/const CLI_INPUT_NAMES = \[([^\]]*)\]/);
  if (!match) throw new Error('CLI_INPUT_NAMES array not found in src/cli.ts');
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

describe('action.yml <-> CLI flag parity', () => {
  it('every action.yml input has a CLI flag', () => {
    const cli = new Set(cliInputNames());
    const missing = actionManifestInputs().filter((name) => !cli.has(name));
    expect(missing).toEqual([]);
  });

  it('every CLI input flag is an action.yml input, minus the explicit CLI-only allowlist', () => {
    const manifest = new Set(actionManifestInputs());
    const extras = cliInputNames().filter(
      (name) => !manifest.has(name) && !CLI_ONLY_INPUTS.includes(name)
    );
    expect(extras).toEqual([]);
  });

  it('keeps the CLI-only allowlist minimal: every entry is a real CLI flag and not a manifest input', () => {
    const cli = new Set(cliInputNames());
    const manifest = new Set(actionManifestInputs());
    expect(CLI_ONLY_INPUTS.filter((name) => !cli.has(name))).toEqual([]);
    expect(CLI_ONLY_INPUTS.filter((name) => manifest.has(name))).toEqual([]);
  });
});
