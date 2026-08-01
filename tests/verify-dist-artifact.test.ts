import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { vi, describe, expect, it } from 'vitest';

// Every test in this file execs real node child processes; the default 5s
// vitest timeout flakes under full-suite load, so raise it file-wide.
vi.setConfig({ testTimeout: 60_000 });

interface RepoConfig {
  pkgName: string;
  binName: string;
  pkgMain: string;
  actionMain: string | null;
  census: string[];
}

const CONFIG: RepoConfig = {"pkgName":"@postman-cse/onboarding-repo-sync","binName":"postman-repo-sync","pkgMain":"dist/index.cjs","actionMain":"dist/action.cjs","census":["action.cjs","cli.cjs","index.cjs"]};

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifyScript = path.join(repoRoot, 'scripts', 'verify-dist-artifact.mjs');
/** Read-only git must not block on concurrent index.lock under multi-agent host load. */
const gitReadEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', PATH: process.env.PATH ?? '' };
const COMMITTED_DIST_PATHS = ['dist', 'package.json', 'action.yml'] as const;
const SHIPPED_ENTRYPOINTS = ['dist/index.cjs', 'dist/action.cjs', 'dist/cli.cjs'] as const;

type OnTestFinished = (fn: () => void | Promise<void>) => void;

async function makeTempDir(prefix: string, onTestFinished: OnTestFinished): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

interface FixtureOptions {
  shebang?: boolean;
  mode?: number;
  helpBody?: string;
  hangHelp?: boolean;
  hangVersion?: boolean;
  cliVersion?: string;
  pkgVersion?: string;
  extraDistFile?: string;
  omitEntry?: string;
  symlinkEntry?: string;
  brokenEntry?: string;
  requireSpecifier?: string;
  requireExampleOnly?: string;
  contractEntry?: string;
  contractEnv?: Record<string, string>;
  libraryGetterThrows?: boolean;
  dynamicVariableRegistry?: unknown;
  dynamicVariablesExport?: string;
  dynamicVariablesReport?: { generators: number; failures: string[] };
}

async function writeFixture(root: string, options: FixtureOptions = {}): Promise<void> {
  const distDir = path.join(root, 'dist');
  await mkdir(distDir, { recursive: true });
  const realPkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  const pkgVersion = options.pkgVersion ?? realPkg.version;
  const cliVersion = options.cliVersion ?? pkgVersion;
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: CONFIG.pkgName,
      version: pkgVersion,
      main: CONFIG.pkgMain,
      bin: { [CONFIG.binName]: 'dist/cli.cjs' }
    }),
    'utf8'
  );
  if (CONFIG.actionMain) {
    await writeFile(
      path.join(root, 'action.yml'),
      `name: fixture\nruns:\n  using: node24\n  main: ${CONFIG.actionMain}\n`,
      'utf8'
    );
  }
  if (options.contractEntry !== undefined || options.contractEnv !== undefined || options.dynamicVariableRegistry !== undefined) {
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'scripts', 'dist-boot-contract.json'), JSON.stringify({ entry: options.contractEntry ?? CONFIG.actionMain, exitCode: 0, outputIncludes: [], ...(options.contractEnv === undefined ? {} : { env: options.contractEnv }), ...(options.dynamicVariableRegistry === undefined ? {} : { dynamicVariableRegistry: options.dynamicVariableRegistry }) }), 'utf8');
  }

  const shebang = options.shebang === false ? '' : '#!/usr/bin/env node\n';
  const helpBody = options.helpBody ?? `Usage: ${CONFIG.binName} [options]\n`;
  const requireLine = options.requireSpecifier
    ? `let peer;\ntry {\n  peer = require(${JSON.stringify(options.requireSpecifier)});\n} catch {\n  peer = undefined;\n}\nvoid peer;\n`
    : '';
  const requireExample = options.requireExampleOnly
    ? `// Example only: require(${JSON.stringify(options.requireExampleOnly)})\nconst example = ${JSON.stringify(`require(${JSON.stringify(options.requireExampleOnly)})`)};\nvoid example;\n`
    : '';
  const cliSource = `${shebang}${requireLine}${requireExample}const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  if (${Boolean(options.hangHelp)}) {
    setInterval(() => {}, 1_000);
  } else {
    process.stdout.write(${JSON.stringify(helpBody)});
    process.exit(0);
  }
}
else if (args.includes('--version') || args.includes('-V')) {
  if (${Boolean(options.hangVersion)}) {
    setInterval(() => {}, 1_000);
  } else {
    process.stdout.write(${JSON.stringify(`${cliVersion}\n`)});
    process.exit(0);
  }
}
else {
  process.stderr.write('unexpected\\n');
  process.exit(1);
}
`;
  const cliPath = path.join(distDir, 'cli.cjs');
  await writeFile(cliPath, cliSource, { encoding: 'utf8', mode: options.mode ?? 0o755 });
  if (options.mode !== undefined) {
    await chmod(cliPath, options.mode);
  }
  for (const name of CONFIG.census) {
    if (name === 'cli.cjs' || name === options.omitEntry) {
      continue;
    }
    if (name === options.symlinkEntry) {
      await symlink(cliPath, path.join(distDir, name));
      continue;
    }
    const body = name === options.brokenEntry ? 'const = broken;\n' : options.libraryGetterThrows && name === path.posix.basename(CONFIG.pkgMain) ? "Object.defineProperty(module.exports, 'broken', { enumerable: true, get() { throw new TypeError('getter-only library export'); } });\n" : options.dynamicVariablesReport && name === path.posix.basename(CONFIG.pkgMain) ? `module.exports[${JSON.stringify(options.dynamicVariablesExport ?? 'observeBundledDynamicVariables')}] = () => { process.stdout.write('DYNAMIC_FIXTURE_INVOKED\\n'); return ${JSON.stringify(options.dynamicVariablesReport)}; };\n` : 'module.exports = {};\n';
    await writeFile(path.join(distDir, name), body, 'utf8');
  }
  if (options.extraDistFile) {
    await writeFile(path.join(distDir, options.extraDistFile), 'module.exports = {};\n', 'utf8');
  }
}

async function materializeCommittedDistSnapshot(targetRoot: string): Promise<void> {
  const tracked = (
    await execFileAsync('git', ['ls-files', '--', ...COMMITTED_DIST_PATHS], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitReadEnv,
      maxBuffer: 1024 * 1024
    })
  ).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  if (tracked.length === 0) {
    throw new Error('verify-dist-artifact: no committed dist/manifest paths in git index');
  }

  for (const rel of tracked) {
    const dest = path.join(targetRoot, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    const { stdout } = await execFileAsync('git', ['show', `HEAD:${rel}`], {
      cwd: repoRoot,
      encoding: 'buffer',
      env: gitReadEnv,
      maxBuffer: 64 * 1024 * 1024
    });
    await writeFile(dest, stdout);
    if (rel === 'dist/cli.cjs' && process.platform !== 'win32') {
      await chmod(dest, 0o755);
    }
  }
}

async function runVerify(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [verifyScript, root], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? ''
      },
      maxBuffer: 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const execError = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof execError.code === 'number' ? execError.code : 1,
      stdout: String(execError.stdout ?? ''),
      stderr: String(execError.stderr ?? '')
    };
  }
}

describe('verify-dist-artifact canonical contract', () => {
  it('ships bounded collection and environment acquisition before resources state materialization', async () => {
    for (const entrypoint of SHIPPED_ENTRYPOINTS) {
      const bundle = await readFile(path.join(repoRoot, entrypoint), 'utf8');
      const collectionAcquisition = bundle.indexOf('collection-acquisition count=');
      const environmentAcquisition = bundle.indexOf('environment-artifact-acquisition count=');
      const resourcesMaterialization = bundle.indexOf(
        'writeFileSync)(".postman/resources.yaml", buildResourcesManifest('
      );

      expect(collectionAcquisition, entrypoint).toBeGreaterThanOrEqual(0);
      expect(environmentAcquisition, entrypoint).toBeGreaterThan(collectionAcquisition);
      expect(resourcesMaterialization, entrypoint).toBeGreaterThan(environmentAcquisition);
      expect(bundle, entrypoint).toContain('var ARTIFACT_ACQUISITION_WIDTH = 2;');
      expect(bundle, entrypoint).toContain('async function runBoundedInOrder(items, width, worker)');
      expect(bundle, entrypoint).toContain(
        'Array.from({ length: Math.min(width, items.length) }, () => runWorker())'
      );
      expect(bundle, entrypoint).toContain(
        'collectionSpecs,\n      ARTIFACT_ACQUISITION_WIDTH,\n      (spec) => acquireCollectionArtifact('
      );
      expect(bundle, entrypoint).toContain(
        'environmentSpecs,\n      ARTIFACT_ACQUISITION_WIDTH,\n      (spec) => dependencies.postman.getEnvironment(spec.envUid)'
      );
    }
  });

  it('passes against the committed dist artifact', async ({ onTestFinished }) => {
    const snapshotRoot = await makeTempDir('verify-dist-committed-', onTestFinished);
    await materializeCommittedDistSnapshot(snapshotRoot);
    const result = await runVerify(snapshotRoot);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('verify-dist-artifact: ok');
  }, 30_000);

  it('fails closed when shipped action bytes receive invalid inherited branch decisions', async ({ onTestFinished }) => {
    const snapshotRoot = await makeTempDir('verify-dist-branch-decision-', onTestFinished);
    const githubOutput = path.join(snapshotRoot, 'github-output');
    const networkSentinel = path.join(snapshotRoot, 'network-attempted');
    const networkPreload = path.join(snapshotRoot, 'network-guard.cjs');
    await materializeCommittedDistSnapshot(snapshotRoot);
    await writeFile(githubOutput, '', 'utf8');
    await writeFile(networkPreload, [
      "const { appendFileSync } = require('node:fs');",
      "const sentinel = process.env.VERIFY_DIST_NETWORK_SENTINEL;",
      "function block(kind) { appendFileSync(sentinel, kind + '\\n'); throw new Error('VERIFY_DIST_NETWORK_FORBIDDEN ' + kind); }",
      "function patch(mod, names) { const target = require(mod); for (const name of names) { if (typeof target[name] === 'function') target[name] = (...args) => block(mod + '.' + name); } }",
      "patch('node:net', ['connect', 'createConnection']);",
      "const net = require('node:net'); if (net.Socket && net.Socket.prototype) net.Socket.prototype.connect = (...args) => block('node:net.Socket.connect');",
      "patch('node:tls', ['connect']);",
      "patch('node:http', ['request', 'get']);",
      "patch('node:https', ['request', 'get']);",
      "globalThis.fetch = (...args) => block('global.fetch');"
    ].join('\n'), 'utf8');
    const invalidDecisions = [
      {
        name: 'impossible canonical fork decision',
        actionPath: path.join(snapshotRoot, 'dist', 'action.cjs'),
        cwd: snapshotRoot,
        decision: {
          tier: 'canonical',
          strategy: 'publish-gate',
          identity: {
            provider: 'github',
            headBranch: 'main',
            rawRef: 'refs/heads/main',
            defaultBranch: 'main',
            refKind: 'default-branch',
            isPrContext: true,
            isForkPr: true,
            headSha: '0123456789abcdef0123456789abcdef01234567'
          },
          canonicalBranch: 'main',
          reason: 'semantically impossible fork canonical writer'
        }
      },
      {
        name: 'whitespace-canonical preview decision',
        actionPath: path.join(repoRoot, 'dist', 'action.cjs'),
        cwd: repoRoot,
        decision: {
          tier: 'preview',
          strategy: 'preview',
          identity: {
            provider: 'github',
            headBranch: 'main',
            rawRef: 'refs/heads/main',
            defaultBranch: 'main',
            refKind: 'default-branch',
            isPrContext: false,
            isForkPr: false,
            headSha: '0123456789abcdef0123456789abcdef01234567'
          },
          canonicalBranch: ' main ',
          reason: 'whitespace-decorated canonical branch claims preview'
        }
      }
    ];

    for (const { name, actionPath, cwd, decision } of invalidDecisions) {
      await writeFile(githubOutput, '', 'utf8');
      await rm(networkSentinel, { force: true });
      let result: { code: number; stdout: string; stderr: string };
      try {
        const child = await execFileAsync(process.execPath, [actionPath], {
          cwd,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            TMPDIR: process.env.TMPDIR ?? '',
            GITHUB_OUTPUT: githubOutput,
            'INPUT_PROJECT-NAME': 'branch-decision-contract-test',
            NODE_OPTIONS: `--require=${networkPreload}`,
            POSTMAN_BRANCH_DECISION: JSON.stringify(decision),
            POSTMAN_ACTIONS_TELEMETRY: 'off',
            VERIFY_DIST_NETWORK_SENTINEL: networkSentinel
          },
          timeout: 25_000,
          maxBuffer: 1024 * 1024
        });
        result = { code: 0, stdout: child.stdout, stderr: child.stderr };
      } catch (error) {
        const execError = error as { code?: number; stdout?: string; stderr?: string };
        result = {
          code: typeof execError.code === 'number' ? execError.code : 1,
          stdout: String(execError.stdout ?? ''),
          stderr: String(execError.stderr ?? '')
        };
      }

      expect(result.code, name).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`, name).toContain('CONTRACT_BRANCH_DECISION_INVALID');
      await expect(readFile(networkSentinel, 'utf8'), name).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(githubOutput, 'utf8'), name).toBe('');
    }
  }, 30_000);

  it('passes a well-formed temporary dist tree', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-ok-', onTestFinished);
    await writeFixture(root);
    const result = await runVerify(root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  }, 30_000);

  it('fails the real verifier on the historical getter-only library export boot failure', async ({ onTestFinished }) => {
    const root = await makeTempDir('verify-dist-libboot-', onTestFinished);
    await writeFixture(root, { libraryGetterThrows: true });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/LIBRARY_EXPORT_ACCESS_FAILED|library entrypoint.*failed to boot/);
  });

  it('uses dynamicVariableRegistry as the sole registry trigger and expectation source', async ({ onTestFinished }) => {
    const absent = await makeTempDir('verify-dist-dynamic-absent-', onTestFinished);
    await writeFixture(absent, { dynamicVariablesReport: { generators: 118, failures: ['must not be observed'] } });
    const skipped = await runVerify(absent);
    expect(skipped.code).toBe(0);
    expect(skipped.stdout).not.toContain('DYNAMIC_FIXTURE_INVOKED');
    const success = await makeTempDir('verify-dist-dynamic-success-', onTestFinished);
    await writeFixture(success, { dynamicVariableRegistry: { export: 'fixtureRegistry', expectedGeneratorCount: 3 }, dynamicVariablesExport: 'fixtureRegistry', dynamicVariablesReport: { generators: 3, failures: [] } });
    const result = await runVerify(success);
    expect(result.code).toBe(0);
  });

  it('rejects missing, malformed, and mismatched dynamic-variable registries', async ({ onTestFinished }) => {
    const missing = await makeTempDir('verify-dist-dynamic-missing-', onTestFinished);
    await writeFixture(missing, { dynamicVariableRegistry: { export: 'missingRegistry', expectedGeneratorCount: 1 } });
    expect((await runVerify(missing)).stderr).toContain('DYNAMIC_VARS_BOOT_FAILED missing export=missingRegistry');
    for (const registry of [null, { export: 'not-valid', expectedGeneratorCount: 1 }, { export: 'fixtureRegistry', expectedGeneratorCount: 0 }]) {
      const root = await makeTempDir('verify-dist-dynamic-malformed-', onTestFinished);
      await writeFixture(root, { dynamicVariableRegistry: registry });
      expect((await runVerify(root)).stderr).toMatch(/dynamicVariableRegistry/);
    }
    const mismatch = await makeTempDir('verify-dist-dynamic-count-', onTestFinished);
    await writeFixture(mismatch, { dynamicVariableRegistry: { export: 'fixtureRegistry', expectedGeneratorCount: 3 }, dynamicVariablesExport: 'fixtureRegistry', dynamicVariablesReport: { generators: 2, failures: [] } });
    expect((await runVerify(mismatch)).stderr).toContain('DYNAMIC_VARS_BOOT_FAILED');
  });

  it('fails when the configured dynamic-variable registry reports generator failures', async ({ onTestFinished }) => {
    const root = await makeTempDir('verify-dist-dynamic-failures-', onTestFinished);
    await writeFixture(root, { dynamicVariableRegistry: { export: 'fixtureRegistry', expectedGeneratorCount: 3 }, dynamicVariablesExport: 'fixtureRegistry', dynamicVariablesReport: { generators: 3, failures: ['x: boom'] } });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('DYNAMIC_VARS_BOOT_FAILED');
    expect(result.stderr).toContain('x: boom');
  });


  it('rejects a boot contract entry that differs from action.yml runs.main', async ({ onTestFinished }) => {
    const root = await makeTempDir('verify-dist-contract-mismatch-', onTestFinished);
    await writeFixture(root, { contractEntry: 'dist/cli.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/does not match action.yml runs\.main/);
  });

  it('rejects a traversing boot contract entry', async ({ onTestFinished }) => {
    const root = await makeTempDir('verify-dist-contract-traversal-', onTestFinished);
    await writeFixture(root, { contractEntry: '../outside.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/must not traverse outside dist/);
  });

  it('rejects a boot contract entry outside dist', async ({ onTestFinished }) => {
    const root = await makeTempDir('verify-dist-contract-nondist-', onTestFinished);
    await writeFixture(root, { contractEntry: 'outside.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/must point under dist/);
  }, 15_000);

  it('rejects boot contracts that override protected boot environment', async ({ onTestFinished }) => {
    const protectedEnvCases: Record<string, string>[] = [
      { NODE_OPTIONS: '--require=fixture' },
      { GITHUB_OUTPUT: '/tmp/fixture-output' }
    ];
    for (const env of protectedEnvCases) {
      const root = await makeTempDir('verify-dist-protected-env-', onTestFinished);
      await writeFixture(root, { contractEnv: env });
      const result = await runVerify(root);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/protected boot environment/);
    }
  });

  it('fails when the CLI shebang is missing', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-shebang-', onTestFinished);
    await writeFixture(root, { shebang: false });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/missing Node shebang/);
  });

  it.skipIf(process.platform === 'win32')('fails when cli.cjs is not executable on disk', async ({ onTestFinished }) => {
    const root = await makeTempDir('verify-dist-mode-', onTestFinished);
    await writeFixture(root, { mode: 0o644 });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/not executable on disk/);
  });

  it('fails when the git index does not mark cli.cjs executable', async ({ expect, onTestFinished }) => {
    const gitRoot = await makeTempDir('verify-dist-gitmode-', onTestFinished);
    const pkgRoot = path.join(gitRoot, 'packages', 'pkg');
    await mkdir(pkgRoot, { recursive: true });
    await writeFixture(pkgRoot);
    await execFileAsync('git', ['init', '--quiet'], { cwd: gitRoot });
    await execFileAsync('git', ['add', '--', '.'], { cwd: gitRoot });
    await execFileAsync('git', ['update-index', '--chmod=-x', 'packages/pkg/dist/cli.cjs'], {
      cwd: gitRoot
    });
    const result = await runVerify(pkgRoot);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/git-index mode is 100644/);
  }, 15_000);

  it('fails when dist census has an extra file', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-extra-', onTestFinished);
    await writeFixture(root, { extraDistFile: 'extra.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/dist census mismatch/);
  });

  it('fails when dist census has a hidden extra file', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-hidden-', onTestFinished);
    await writeFixture(root, { extraDistFile: '.hidden' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/dist census mismatch/);
  });

  it('fails when dist census is missing an entrypoint', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-missing-', onTestFinished);
    const missing = CONFIG.census.find((name) => name !== 'cli.cjs') as string;
    await writeFixture(root, { omitEntry: missing });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/dist census mismatch/);
  });

  it.skipIf(process.platform === 'win32')('fails when an expected entrypoint is a symlink', async ({ onTestFinished }) => {
    const root = await makeTempDir('verify-dist-symlink-', onTestFinished);
    const linked = CONFIG.census.find((name) => name !== 'cli.cjs') as string;
    await writeFixture(root, { symlinkEntry: linked });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/regular file, not a directory or symlink/);
  });

  it('fails when direct --help does not produce the usage banner', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-help-', onTestFinished);
    await writeFixture(root, { helpBody: 'no banner here\n' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/missing usage banner/);
  });

  it('fails within the test budget when direct --help hangs', async ({ onTestFinished }) => {
    const root = await makeTempDir('verify-dist-help-timeout-', onTestFinished);
    await writeFixture(root, { hangHelp: true });
    const startedAt = Date.now();
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/direct dist[\\/]cli\.cjs --help timed out after 5000ms/);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  it('fails within the test budget when direct --version hangs', async ({ onTestFinished }) => {
    const root = await makeTempDir('verify-dist-version-timeout-', onTestFinished);
    await writeFixture(root, { hangVersion: true });
    const startedAt = Date.now();
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/direct dist[\\/]cli\.cjs --version timed out after 5000ms/);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  it('fails when direct --version drifts from package.json', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-version-', onTestFinished);
    await writeFixture(root, { cliVersion: '0.0.0-drift' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--version was/);
  });

  it('fails when node --check rejects a bundled entrypoint', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-syntax-', onTestFinished);
    const broken = CONFIG.census.find((name) => name !== 'cli.cjs') as string;
    await writeFixture(root, { brokenEntry: broken });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/node --check/);
  });

  it('fails when a literal require() targets a third-party module', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-thirdparty-', onTestFinished);
    await writeFixture(root, { requireSpecifier: 'left-pad' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/non-builtin\/third-party require\("left-pad"\)/);
  });

  it('fails when a literal require() targets a relative path', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-relative-', onTestFinished);
    await writeFixture(root, { requireSpecifier: './side-effect.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/non-builtin\/third-party require/);
  });

  it('ignores require() examples in comments and string data', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-example-', onTestFinished);
    await writeFixture(root, { requireExampleOnly: 'left-pad' });
    const result = await runVerify(root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it('accepts bare and node: builtin require() specifiers', async ({ expect, onTestFinished }) => {
    const rootBare = await makeTempDir('verify-dist-bare-', onTestFinished);
    await writeFixture(rootBare, { requireSpecifier: 'fs' });
    const bare = await runVerify(rootBare);
    expect(bare.stderr).toBe('');
    expect(bare.code).toBe(0);

    const rootPrefixed = await makeTempDir('verify-dist-prefixed-', onTestFinished);
    await writeFixture(rootPrefixed, { requireSpecifier: 'node:fs' });
    const prefixed = await runVerify(rootPrefixed);
    expect(prefixed.stderr).toBe('');
    expect(prefixed.code).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('rejects symlinked dist roots, caught network calls, and unconsumed GitHub output markers', async ({ onTestFinished }) => {
    const actionMain = CONFIG.actionMain as string;
    const symlinkRoot = await makeTempDir('verify-dist-parent-symlink-', onTestFinished);
    await writeFixture(symlinkRoot);
    await rm(path.join(symlinkRoot, 'dist'), { recursive: true });
    await symlink(symlinkRoot, path.join(symlinkRoot, 'dist'));
    expect((await runVerify(symlinkRoot)).stderr).toMatch(/dist root must be a regular non-symlink directory/);

    const networkRoot = await makeTempDir('verify-dist-network-', onTestFinished);
    await writeFixture(networkRoot, { contractEntry: actionMain });
    await writeFile(path.join(networkRoot, actionMain), "try { require('node:https').get('https://example.invalid'); } catch {}\nmodule.exports = {};\n", 'utf8');
    expect((await runVerify(networkRoot)).stderr).toMatch(/attempted network I\/O/);

    const outputRoot = await makeTempDir('verify-dist-github-output-', onTestFinished);
    await writeFixture(outputRoot, { contractEntry: actionMain });
    await writeFile(path.join(outputRoot, 'scripts', 'dist-boot-contract.json'), JSON.stringify({ entry: actionMain, exitCode: 0, outputIncludes: [], githubOutputIncludes: ['fixture-output=ok'] }), 'utf8');
    await writeFile(path.join(outputRoot, actionMain), "require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, 'fixture-output=ok\\n');\nmodule.exports = {};\n", 'utf8');
    expect((await runVerify(outputRoot)).code).toBe(0);
    await writeFile(path.join(outputRoot, 'scripts', 'dist-boot-contract.json'), JSON.stringify({ entry: actionMain, exitCode: 0, outputIncludes: [], githubOutputIncludes: ['missing-output'] }), 'utf8');
    expect((await runVerify(outputRoot)).stderr).toMatch(/GitHub output missing contract marker/);

    const throwRoot = await makeTempDir('verify-dist-direct-action-throw-', onTestFinished);
    await writeFixture(throwRoot, { contractEntry: actionMain });
    await writeFile(path.join(throwRoot, actionMain), "throw new TypeError('direct action boot failure');\n", 'utf8');
    expect((await runVerify(throwRoot)).stderr).toMatch(/action entrypoint.*boot exited|direct action boot failure/);
  });

  it('accepts the documented optional peer allowlist', async ({ expect, onTestFinished }) => {
    const root = await makeTempDir('verify-dist-peer-', onTestFinished);
    await writeFixture(root, { requireSpecifier: 'encoding' });
    const result = await runVerify(root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });
});
