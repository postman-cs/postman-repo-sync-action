import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveInputs } from '../src/index.js';
import { activateWorkingDirectory } from '../src/lib/working-directory.js';

let originalCwd: string;
let originalWorkspace: string | undefined;
const tempDirs: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-sync-working-directory-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, 'services', 'payments'), { recursive: true });
  return root;
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalWorkspace = process.env.GITHUB_WORKSPACE;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalWorkspace === undefined) {
    delete process.env.GITHUB_WORKSPACE;
  } else {
    process.env.GITHUB_WORKSPACE = originalWorkspace;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('activateWorkingDirectory', () => {
  it('is a no-op for an empty input', () => {
    const root = makeRoot();
    process.chdir(root);
    process.env.GITHUB_WORKSPACE = root;
    const cwdBefore = process.cwd();

    expect(activateWorkingDirectory('', root)).toEqual({
      changed: false,
      originalRoot: root,
      effectiveRoot: root
    });
    expect(process.cwd()).toBe(cwdBefore);
    expect(process.env.GITHUB_WORKSPACE).toBe(root);
  });

  it('activates an inward symlink and aligns process roots', () => {
    const root = makeRoot();
    const service = path.join(root, 'services', 'payments');
    const realRoot = realpathSync(root);
    const realService = realpathSync(service);
    symlinkSync(service, path.join(root, 'payments-link'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(activateWorkingDirectory('payments-link', root)).toEqual({
      changed: true,
      originalRoot: realRoot,
      effectiveRoot: realService
    });
    expect(process.cwd()).toBe(realService);
    expect(process.env.GITHUB_WORKSPACE).toBe(realService);
  });

  it('rejects absolute, traversing, missing, file, and outbound-symlink paths', () => {
    const root = makeRoot();
    const outside = mkdtempSync(path.join(tmpdir(), 'repo-sync-working-directory-outside-'));
    tempDirs.push(outside);
    writeFileSync(path.join(root, 'service.txt'), 'not a directory');
    symlinkSync(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');

    for (const input of [
      path.join(root, 'services', 'payments'),
      '../outside',
      'services/../services/payments',
      'missing',
      'service.txt',
      'outside-link'
    ]) {
      expect(() => activateWorkingDirectory(input, root), input).toThrow(/working-directory/i);
      expect(process.cwd()).toBe(originalCwd);
    }
  });
});

describe('generate-ci-workflow service-directory guard', () => {
  it('preserves the root default and defaults generation off for a service directory', () => {
    expect(resolveInputs({}).generateCiWorkflow).toBe(true);
    const serviceInputs = resolveInputs({ INPUT_WORKING_DIRECTORY: 'services/payments' });
    expect(serviceInputs.generateCiWorkflow).toBe(false);
    expect(serviceInputs.generateCiWorkflowDefaulted).toBe(true);
  });

  it('accepts explicit false and rejects explicit true for a service directory', () => {
    expect(
      resolveInputs({
        INPUT_WORKING_DIRECTORY: 'services/payments',
        INPUT_GENERATE_CI_WORKFLOW: 'false'
      }).generateCiWorkflow
    ).toBe(false);
    expect(() =>
      resolveInputs({
        INPUT_WORKING_DIRECTORY: 'services/payments',
        INPUT_GENERATE_CI_WORKFLOW: 'true'
      })
    ).toThrow(/generate-ci-workflow.*working-directory/i);
  });
});
