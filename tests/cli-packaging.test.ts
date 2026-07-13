import { execFile } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('CLI packaging contract', () => {
  it('commits a Node shebang and executable mode on dist/cli.cjs', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const contents = await readFile(cliPath, 'utf8');
    expect(contents.startsWith('#!/usr/bin/env node\n')).toBe(true);

    const mode = (await stat(cliPath)).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);

    await access(cliPath, constants.X_OK);
  });

  it('packs, installs, and runs postman-repo-sync --help without shell parse errors', async () => {
    const packDir = await makeTempDir('postman-repo-sync-pack-');
    const prefixDir = await makeTempDir('postman-repo-sync-prefix-');

    const packResult = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', packDir],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
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
    await mkdir(prefixDir, { recursive: true });
    await execFileAsync('npm', ['install', '--prefix', prefixDir, tarballPath], {
      encoding: 'utf8',
      env: {
        NPM_CONFIG_CACHE: path.join(packDir, '.npm-cache'),
        PATH: process.env.PATH ?? ''
      },
      maxBuffer: 20 * 1024 * 1024
    });

    const binPath = path.join(
      prefixDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'postman-repo-sync.cmd' : 'postman-repo-sync'
    );

    const help = await execFileAsync(binPath, ['--help'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        // Prove help ignores credentials/network requirements.
        INPUT_POSTMAN_API_KEY: '',
        POSTMAN_API_KEY: '',
        POSTMAN_ACCESS_TOKEN: ''
      },
      maxBuffer: 1024 * 1024
    });

    expect(help.stdout).toMatch(/Usage:\s+postman-repo-sync/i);
    expect(help.stderr).not.toMatch(/permission denied|exec format|syntax error|unexpected token|"use strict"/i);
    expect(help.stdout).not.toMatch(/"use strict"/);

    const version = await execFileAsync(binPath, ['--version'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      maxBuffer: 1024 * 1024
    });
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(version.stdout.trim()).toBe(packageJson.version);
  }, 60000);

  it('runs the direct dist/cli.cjs artifact with a shebang path', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const help = await execFileAsync(cliPath, ['--help'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      maxBuffer: 1024 * 1024
    });
    expect(help.stdout).toMatch(/Usage:\s+postman-repo-sync/i);
  }, 20000);
});
