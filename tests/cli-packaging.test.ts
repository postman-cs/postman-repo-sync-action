import { execFile } from 'node:child_process';
import { openSync, readSync, closeSync } from 'node:fs';
import {
  access,
  constants,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmCliArgs = process.platform === 'win32' ? [process.env.npm_execpath || ''] : [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];
const CLI_SHEBANG = '#!/usr/bin/env node\n';
/** Read-only git must not block on concurrent index.lock under multi-agent host load. */
const gitReadEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', PATH: process.env.PATH ?? '' };

/** Leading bytes only — never fully decode multi‑MB dist/cli.cjs. */
function readFileHeadSync(filePath: string, byteLength: number): string {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(byteLength);
    const bytesRead = readSync(fd, buffer, 0, byteLength, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

async function snapshotPackage(sourceRoot: string, snapshotRoot: string): Promise<void> {
  await Promise.all(
    ['package.json', 'package-lock.json', 'action.yml'].map((name) =>
      cp(path.join(sourceRoot, name), path.join(snapshotRoot, name))
    )
  );
  await cp(path.join(sourceRoot, 'dist'), path.join(snapshotRoot, 'dist'), { recursive: true });
  await mkdir(path.join(snapshotRoot, 'scripts'), { recursive: true });
  await cp(
    path.join(sourceRoot, 'scripts', 'verify-release-artifacts.mjs'),
    path.join(snapshotRoot, 'scripts', 'verify-release-artifacts.mjs')
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('CLI packaging contract', () => {
  // Host load: concurrent agents hold index.lock; git ls-files is read-only but still waits.
  // Keep full shebang + 100755 assertions; budget matches the sibling help smoke (not default 5s).
  it('commits a Node shebang and git-index executable mode on dist/cli.cjs', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    expect(readFileHeadSync(cliPath, CLI_SHEBANG.length)).toBe(CLI_SHEBANG);

    if (process.platform !== 'win32') {
      await access(cliPath, constants.X_OK);
    }

    const staged = await execFileAsync('git', ['ls-files', '--stage', 'dist/cli.cjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitReadEnv
    });
    expect(staged.stdout).toMatch(/^100755 /);
  }, 20_000);

  it('runs ./dist/cli.cjs --help and --version without credentials, network, or writes', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const sandbox = await makeTempDir('postman-repo-sync-cli-sandbox-');
    const env = {
      PATH: process.env.PATH ?? '',
      INPUT_POSTMAN_API_KEY: '',
      POSTMAN_API_KEY: '',
      POSTMAN_ACCESS_TOKEN: '',
      INPUT_POSTMAN_ACCESS_TOKEN: '',
      HOME: sandbox,
      TMPDIR: sandbox
    };

    const help = await execFileAsync(process.execPath, [cliPath, '--help'], {
      cwd: sandbox,
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024
    });
    expect(help.stdout).toMatch(/Usage:\s+postman-repo-sync/i);
    expect(help.stderr).not.toMatch(/permission denied|exec format|syntax error|unexpected token|"use strict"/i);

    const version = await execFileAsync(process.execPath, [cliPath, '--version'], {
      cwd: sandbox,
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024
    });
    expect(version.stdout.trim()).toBe(packageJson.version);

    const writtenFiles = (await readdir(sandbox, { recursive: true, withFileTypes: true })).filter(
      (entry) => entry.isFile()
    );
    expect(writtenFiles).toEqual([]);
  }, 20_000);

  it('keeps an exact dist census of action/cli/index entrypoints', async () => {
    const distDir = path.join(repoRoot, 'dist');
    const entries = (
      await execFileAsync('git', ['ls-files', '--', 'dist'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: gitReadEnv
      })
    ).stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((filePath) => path.basename(filePath))
      .sort();
    expect(entries).toEqual(['action.cjs', 'cli.cjs', 'index.cjs']);

    const onDisk = await readdir(distDir);
    expect(onDisk.slice().sort()).toEqual(['action.cjs', 'cli.cjs', 'index.cjs']);
  });

  it('keeps its dist snapshot isolated from later source-tree writes', async () => {
    const sourceRoot = await makeTempDir('postman-repo-sync-package-source-');
    const snapshotRoot = await makeTempDir('postman-repo-sync-package-copy-');
    await mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'scripts'), { recursive: true });
    await Promise.all(
      ['package.json', 'package-lock.json', 'action.yml'].map((name) =>
        writeFile(path.join(sourceRoot, name), '{}\n', 'utf8')
      )
    );
    await Promise.all(
      ['action.cjs', 'cli.cjs', 'index.cjs'].map((name) =>
        writeFile(path.join(sourceRoot, 'dist', name), `${name}\n`, 'utf8')
      )
    );
    await writeFile(
      path.join(sourceRoot, 'scripts', 'verify-release-artifacts.mjs'),
      'export {}\n',
      'utf8'
    );

    await snapshotPackage(sourceRoot, snapshotRoot);
    await writeFile(path.join(sourceRoot, 'dist', '.concurrent-build-marker'), 'changed\n', 'utf8');
    await writeFile(
      path.join(sourceRoot, 'scripts', 'verify-release-artifacts.mjs'),
      'changed\n',
      'utf8'
    );

    expect((await readdir(path.join(snapshotRoot, 'dist'))).sort()).toEqual([
      'action.cjs',
      'cli.cjs',
      'index.cjs'
    ]);
    expect(await readFile(path.join(snapshotRoot, 'scripts', 'verify-release-artifacts.mjs'), 'utf8')).toBe(
      'export {}\n'
    );
  });

  it('does not rebuild dist from packaging tests', async () => {
    const packageJson = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const packagingSource = await readFile(path.join(repoRoot, 'tests', 'cli-packaging.test.ts'), 'utf8');
    // Build banned phrases so this assertion body does not self-match.
    const rebuildBan = ['npm', 'run', 'build'].join(' ');
    const bundleBan = ['npm', 'run', 'bundle'].join(' ');
    const bundlerBan = ['es', 'build'].join('');
    const wipeBan = ['rm', '-rf', 'dist'].join(' ');
    expect(packageJson).toMatch(/"verify:dist:assert"/);
    expect(packagingSource.includes(rebuildBan)).toBe(false);
    expect(packagingSource.includes(bundleBan)).toBe(false);
    expect(packagingSource.includes(bundlerBan)).toBe(false);
    expect(packagingSource.includes(wipeBan)).toBe(false);
  });

  it('packs, extracts, and runs postman-repo-sync --help without shell parse errors', async () => {
    // Snapshot only for pack isolation so concurrent writers cannot mutate npm pack inputs.
    const packageSnapshotRoot = await makeTempDir('postman-repo-sync-package-snapshot-');
    await snapshotPackage(repoRoot, packageSnapshotRoot);

    const packDir = await makeTempDir('postman-repo-sync-pack-');
    const prefixDir = await makeTempDir('postman-repo-sync-prefix-');

    const packResult = await execFileAsync(
      npmCommand,
      [...npmCliArgs, 'pack', '--ignore-scripts', '--json', '--pack-destination', packDir],
      {
        cwd: packageSnapshotRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: path.join(packDir, '.npm-cache'),
          PATH: process.env.PATH ?? ''
        },
        maxBuffer: 20 * 1024 * 1024
      }
    );
    const [packed] = JSON.parse(packResult.stdout) as Array<{
      filename: string;
      name: string;
    }>;
    expect(packed.name).toBe('@postman-cse/onboarding-repo-sync');

    const tarballPath = path.join(packDir, packed.filename);
    const installDir = path.join(
      prefixDir,
      'node_modules',
      '@postman-cse',
      'onboarding-repo-sync'
    );
    await mkdir(installDir, { recursive: true });
    await execFileAsync(
      'tar',
      ['-xzf', tarballPath, '-C', installDir, '--strip-components', '1'],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH ?? '' },
        maxBuffer: 20 * 1024 * 1024
      }
    );

    const packedEntries = (
      await execFileAsync('tar', ['-tzf', tarballPath], {
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH ?? '' },
        maxBuffer: 20 * 1024 * 1024
      })
    ).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    expect(packedEntries).toContain('package/scripts/verify-release-artifacts.mjs');
    expect(packedEntries.filter((entry) => entry.startsWith('package/scripts/'))).toEqual([
      'package/scripts/verify-release-artifacts.mjs'
    ]);

    const binPath = path.join(installDir, 'dist', 'cli.cjs');
    await access(path.join(installDir, 'scripts', 'verify-release-artifacts.mjs'), constants.F_OK);

    const help = await execFileAsync(process.execPath, [binPath, '--help'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: process.env.PATH ?? '',
        INPUT_POSTMAN_API_KEY: '',
        POSTMAN_API_KEY: '',
        POSTMAN_ACCESS_TOKEN: ''
      },
      maxBuffer: 1024 * 1024
    });

    expect(help.stdout).toMatch(/Usage:\s+postman-repo-sync/i);
    expect(help.stderr).not.toMatch(/permission denied|exec format|syntax error|unexpected token|"use strict"/i);
    expect(help.stdout).not.toMatch(/"use strict"/);

    const version = await execFileAsync(process.execPath, [binPath, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH ?? '' },
      maxBuffer: 1024 * 1024
    });
    const packageJson = JSON.parse(await readFile(path.join(packageSnapshotRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(version.stdout.trim()).toBe(packageJson.version);
  }, 120_000);
});
