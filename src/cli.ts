import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createRepoSyncDependencies,
  decideBranchTier,
  runGatedSkip,
  resolveInputs,
  resolvePostmanApiKeyAndTeamId,
  runRepoSync,
  type ExecLike,
  type RepoSyncDependencies,
  type ResolvedInputs
} from './index.js';
import { runCredentialPreflight } from './lib/postman/credential-identity.js';
import { mintAccessTokenIfNeeded } from './lib/postman/token-provider.js';
import { createSecretMasker } from './lib/secrets.js';
import { runGc } from './lib/repo/gc-runner.js';
import { renderGcSummary } from './lib/repo/preview-gc.js';

interface CliConfig {
  inputEnv: NodeJS.ProcessEnv;
  resultJsonPath: string;
  dotenvPath?: string;
}

interface CliRuntime {
  env?: NodeJS.ProcessEnv;
  executeRepoSync?: typeof runRepoSync;
  writeStdout?: (chunk: string) => void;
}

const execFileAsync = promisify(execFile);

type ReporterCore = RepoSyncDependencies['core'];

const CLI_INPUT_NAMES = [
  'project-name',
  'workspace-id',
  'baseline-collection-id',
  'smoke-collection-id',
  'contract-collection-id',
  'collection-sync-mode',
  'spec-sync-mode',
  'release-label',
  'environments-json',
  'git-provider',
  'ado-token',
  'repo-url',
  'integration-backend',
  'workspace-link-enabled',
  'environment-sync-enabled',
  'system-env-map-json',
  'environment-uids-json',
  'env-runtime-urls-json',
  'artifact-dir',
  'repo-write-mode',
  'repository',
  'current-ref',
  'github-head-ref',
  'github-ref-name',
  'committer-name',
  'committer-email',
  'postman-api-key',
  'postman-access-token',
  'credential-preflight',
  'github-token',
  'gh-fallback-token',
  'ci-workflow-base64',
  'generate-ci-workflow',
  'ci-runner-os',
  'monitor-type',
  'ci-workflow-path',
  'org-mode',
  'monitor-id',
  'mock-url',
  'monitor-cron',
  'ssl-client-cert',
  'ssl-client-key',
  'ssl-client-passphrase',
   'ssl-extra-ca-certs',
   'spec-id',
   'spec-content-changed',
   'spec-path',
  'team-id',
  'postman-region',
  'postman-stack',
  'branch-strategy',
  'canonical-branch',
  'channels',
  'preview-ttl'
] as const;

const HELP_TEXT = `Usage: postman-repo-sync [options]

Sync Postman artifacts into a git repository.

Subcommands:
  gc [--branch <name> | --all-previews] [--dry-run]
                                 Garbage-collect preview/channel asset sets
                                 (marker-guarded; strangers are never deleted)

Options:
  --help                         Show this help and exit
  --version                      Show version and exit
  --result-json <path>           Write JSON result (default: postman-repo-sync-result.json)
  --dotenv-path <path>           Optional dotenv output path
  --<input-name> <value>         Action input as kebab-case flag (same names as action.yml)

Examples:
  postman-repo-sync --help
  postman-repo-sync --repo-write-mode none --workspace-id <id> ...
`;

export class ConsoleReporter implements ReporterCore {
  public info(message: string): void {
    console.error(message);
  }

  public warning(message: string): void {
    console.error(`warning: ${message}`);
  }

  public setOutput(): void {
  }

  public setSecret(): void {
  }
}

export function normalizeCliFlag(name: string): string {
  return `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
}

function toCommandLabel(
  commandLine: string,
  args: string[],
  secretMasker: (value: string) => string
): string {
  return secretMasker([commandLine, ...args].join(' '));
}

export function createCliExec(secretMasker: (value: string) => string): ExecLike {
  return {
    getExecOutput: async (commandLine, args = [], options) => {
      const commandLabel = toCommandLabel(commandLine, args, secretMasker);
      process.stderr.write(`[command] ${commandLabel}\n`);

      try {
        const result = await execFileAsync(commandLine, args, {
          cwd: options?.cwd,
          env: options?.env ?? process.env,
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true
        });
        const stdout = String(result.stdout ?? '');
        const stderr = String(result.stderr ?? '');
        if (stdout) {
          process.stderr.write(secretMasker(stdout));
        }
        if (stderr) {
          process.stderr.write(secretMasker(stderr));
        }
        return {
          exitCode: 0,
          stdout,
          stderr
        };
      } catch (error) {
        const execError = error as {
          code?: number | string;
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          message?: string;
        };
        const stdout = String(execError.stdout ?? '');
        const stderr = String(execError.stderr ?? '');
        const fallbackMessage = execError.message ? `${execError.message}\n` : '';
        if (stdout) {
          process.stderr.write(secretMasker(stdout));
        }
        if (stderr) {
          process.stderr.write(secretMasker(stderr));
        } else if (fallbackMessage) {
          process.stderr.write(secretMasker(fallbackMessage));
        }
        const exitCode =
          typeof execError.code === 'number'
            ? execError.code
            : Number.parseInt(String(execError.code ?? '1'), 10) || 1;
        if (!options?.ignoreReturnCode) {
          throw new Error(`Command failed with exit code ${exitCode}: ${commandLabel}`, {
            cause: error
          });
        }
        return {
          exitCode,
          stdout,
          stderr
        };
      }
    }
  };
}

function resolvePackageVersion(): string {
  const candidates: string[] = [];
  // Present in the esbuild CJS bundle (dist/cli.cjs -> ../package.json).
  if (typeof __filename === 'string' && __filename) {
    candidates.push(path.join(path.dirname(__filename), '..', 'package.json'));
  }
  // vitest/ESM and local smoke: package.json at cwd.
  candidates.push(path.join(process.cwd(), 'package.json'));

  for (const packageJsonPath of candidates) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (packageJson.name === '@postman-cse/onboarding-repo-sync' && packageJson.version) {
        return String(packageJson.version).trim();
      }
    } catch {
      // try next candidate
    }
  }
  return '0.0.0';
}

function wantsHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

function wantsVersion(argv: string[]): boolean {
  return argv.includes('--version') || argv.includes('-V');
}

function runnerFormEnvName(name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig {
  const inputNames = new Set<string>(CLI_INPUT_NAMES);
  const inputEnv: NodeJS.ProcessEnv = { ...env };
  let resultJsonPath = 'postman-repo-sync-result.json';
  let dotenvPath: string | undefined;
  const seenFlags = new Map<string, string>();
  let sawHelp = false;
  let sawVersion = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      sawHelp = true;
      continue;
    }
    if (arg === '--version' || arg === '-V') {
      sawVersion = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    let name: string;
    let value: string | undefined;
    const separator = arg.indexOf('=');
    if (separator !== -1) {
      name = arg.slice(2, separator);
      value = arg.slice(separator + 1);
      if (value === '') {
        throw new Error(`Missing value for --${name}`);
      }
    } else {
      name = arg.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for --${name}`);
      }
      value = next;
      index += 1;
    }

    if (!name) {
      throw new Error(`Unknown option ${arg}`);
    }

    if (name === 'result-json') {
      const previous = seenFlags.get(name);
      if (previous !== undefined && previous !== value) {
        throw new Error(`Conflicting values for --${name}`);
      }
      seenFlags.set(name, value);
      resultJsonPath = value;
      continue;
    }
    if (name === 'dotenv-path') {
      const previous = seenFlags.get(name);
      if (previous !== undefined && previous !== value) {
        throw new Error(`Conflicting values for --${name}`);
      }
      seenFlags.set(name, value);
      dotenvPath = value;
      continue;
    }
    if (!inputNames.has(name)) {
      throw new Error(`Unknown option --${name}`);
    }

    const previous = seenFlags.get(name);
    if (previous !== undefined && previous !== value) {
      throw new Error(`Conflicting values for --${name}`);
    }
    seenFlags.set(name, value);

    // Explicit CLI flags own the input: write normalized form and clear the
    // hyphenated runner-form alias so flag precedence beats env conflicts.
    const normalized = normalizeCliFlag(name);
    const runnerForm = runnerFormEnvName(name);
    inputEnv[normalized] = value;
    if (runnerForm !== normalized) {
      delete inputEnv[runnerForm];
    }
  }

  if (sawHelp && sawVersion) {
    throw new Error('Cannot use --help and --version together');
  }

  return {
    inputEnv,
    resultJsonPath,
    dotenvPath
  };
}

export function toDotenv(outputs: object): string {
  return Object.entries(outputs as Record<string, unknown>)
    .map(([key, value]) => [
      `POSTMAN_REPO_SYNC_${key.replace(/-/g, '_').toUpperCase()}`,
      String(value ?? '')
    ] as const)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
}

async function writeOptionalFile(filePath: string | undefined, content: string): Promise<void> {
  if (!filePath) {
    return;
  }
  const workspaceRoot = path.resolve(process.cwd());
  const resolved = path.resolve(workspaceRoot, filePath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Output path must stay within workspace: ${filePath}`);
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
}

export function createCliDependencies(
  inputs: ResolvedInputs,
  resolved: { apiKey: string; teamId: string }
): RepoSyncDependencies {
  const secretMasker = createSecretMasker([
    resolved.apiKey,
    inputs.postmanAccessToken,
    inputs.adoToken,
    inputs.githubToken,
    inputs.ghFallbackToken,
    inputs.sslClientCert,
    inputs.sslClientKey,
    inputs.sslClientPassphrase,
    inputs.sslExtraCaCerts
  ]);
  const cliExec = createCliExec(secretMasker);

  return createRepoSyncDependencies(
    inputs,
    resolved,
    {
      core: new ConsoleReporter(),
      exec: cliExec
    },
    {
      secretMasker
    }
  );
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  runtime: CliRuntime = {}
): Promise<void> {
  const writeStdout = runtime.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));

  if (wantsHelp(argv) && wantsVersion(argv)) {
    throw new Error('Cannot use --help and --version together');
  }
  if (wantsHelp(argv)) {
    writeStdout(HELP_TEXT.endsWith('\n') ? HELP_TEXT : `${HELP_TEXT}\n`);
    return;
  }
  if (wantsVersion(argv)) {
    writeStdout(`${resolvePackageVersion()}\n`);
    return;
  }

  const env = runtime.env ?? process.env;

  if (argv[0] === 'gc') {
    await runGcCommand(argv.slice(1), env, writeStdout);
    return;
  }

  const config = parseCliArgs(argv, env);
  const inputs = resolveInputs(config.inputEnv);
  const reporter = new ConsoleReporter();

  // Match the action entrypoint: a gated branch must never mint an access
  // token, run credential preflight, or construct a Postman client.
  const branchDecision = decideBranchTier(inputs, config.inputEnv);
  if (branchDecision.tier === 'gated') {
    const result = runGatedSkip(inputs, branchDecision, reporter);
    await writeOptionalFile(config.resultJsonPath, JSON.stringify(result, null, 2));
    await writeOptionalFile(config.dotenvPath, toDotenv(result));
    writeStdout(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  // PMAK-only runs: mint the access token up front (mirrors runAction) so the
  // gateway asset ops and Bifrost paths below get the full access-token surface
  // instead of failing the missing-token guard. dist/cli.cjs (what CI and the
  // e2e harness invoke) must behave exactly like dist/index.cjs here.
  await mintAccessTokenIfNeeded(inputs, reporter);

  const initialMasker = createSecretMasker([
    inputs.postmanApiKey,
    inputs.postmanAccessToken,
    inputs.adoToken,
    inputs.githubToken,
    inputs.ghFallbackToken,
    inputs.sslClientCert,
    inputs.sslClientKey,
    inputs.sslClientPassphrase,
    inputs.sslExtraCaCerts
  ]);
  // Proactive credential preflight: resolve and cross-check both identities
  // once, before resolve/createApiKey or any write. The CLI entry must run this
  // exactly as runAction does, or dist/cli.cjs (what CI and the e2e harness
  // invoke) would skip the preflight that dist/index.cjs performs.
  await runCredentialPreflight({
    apiBaseUrl: inputs.postmanApiBase,
    iapubBaseUrl: inputs.postmanIapubBase,
    postmanApiKey: inputs.postmanApiKey,
    postmanAccessToken: inputs.postmanAccessToken,
    explicitTeamId: inputs.teamId || undefined,
    mode: inputs.credentialPreflight,
    mask: initialMasker,
    log: reporter
  });

  const resolvingExec = createCliExec(initialMasker);
  const resolved = await resolvePostmanApiKeyAndTeamId(
    inputs,
    reporter,
    resolvingExec,
    initialMasker,
    {
      persistGeneratedApiKeySecret: false,
      env
    }
  );

  const dependencies = createCliDependencies(inputs, resolved);

  if (inputs.environmentSyncEnabled && !dependencies.internalIntegration) {
    dependencies.core.warning(
      'Skipping system environment association because postman-access-token is not configured'
    );
  }
  if (inputs.workspaceLinkEnabled && !dependencies.internalIntegration) {
    dependencies.core.warning(
      'Skipping workspace linking because postman-access-token is not configured'
    );
  }

  const result = await (runtime.executeRepoSync ?? runRepoSync)(inputs, dependencies);

  await writeOptionalFile(config.resultJsonPath, JSON.stringify(result, null, 2));
  await writeOptionalFile(config.dotenvPath, toDotenv(result));

  writeStdout(`${JSON.stringify(result, null, 2)}\n`);
}

/**
 * Manual GC escape hatch (PRD R18): \`cli.cjs gc --branch <name> | --all-previews\`.
 * Provider GC wrappers (scheduled sweeps, branch-delete hooks) are thin
 * invocations of this command. Deletion is marker-guarded (lib/repo/preview-gc);
 * strangers and channel sets outside their deleteAfter window are never touched.
 */
async function runGcCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  writeStdout: (chunk: string) => void
): Promise<void> {
  let onlyBranch: string | undefined;
  let allPreviews = false;
  let dryRun = false;
  const passthrough: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--branch') {
      onlyBranch = argv[index + 1];
      if (!onlyBranch || onlyBranch.startsWith('--')) {
        throw new Error('Missing value for --branch');
      }
      index += 1;
    } else if (arg === '--all-previews') {
      allPreviews = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      passthrough.push(arg);
    }
  }
  if (onlyBranch && allPreviews) {
    throw new Error('Use either --branch <name> or --all-previews, not both');
  }

  const config = parseCliArgs(passthrough, env);
  const inputs = resolveInputs(config.inputEnv);
  if (!inputs.workspaceId) {
    throw new Error('gc requires --workspace-id (the workspace holding the preview/channel sets)');
  }
  const repo = inputs.repoUrl || inputs.repository;
  if (!repo) {
    throw new Error('gc requires --repo-url or --repository to scope marker ownership');
  }

  const reporter = new ConsoleReporter();
  await mintAccessTokenIfNeeded(inputs, reporter);
  const initialMasker = createSecretMasker([
    inputs.postmanApiKey,
    inputs.postmanAccessToken,
    inputs.githubToken,
    inputs.ghFallbackToken
  ]);
  const resolved = await resolvePostmanApiKeyAndTeamId(
    inputs,
    reporter,
    createCliExec(initialMasker),
    initialMasker,
    { persistGeneratedApiKeySecret: false, env }
  );
  const dependencies = createCliDependencies(inputs, resolved);
  if (!dependencies.postman.deleteCollection || !dependencies.postman.listSpecifications || !dependencies.postman.getSpecContent || !dependencies.postman.listSpecCollections || !dependencies.postman.deleteSpec) {
    throw new Error('gc requires the full branch-aware inventory client; this runtime is missing a spec or collection GC capability.');
  }

  const summary = await runGc({
    workspaceId: inputs.workspaceId,
    repo,
    postman: {
      ...dependencies.postman,
      deleteCollection: dependencies.postman.deleteCollection,
      listSpecifications: dependencies.postman.listSpecifications,
      getSpecContent: dependencies.postman.getSpecContent,
      listSpecCollections: dependencies.postman.listSpecCollections,
      deleteSpec: dependencies.postman.deleteSpec
    },
    exec: createCliExec(initialMasker),
    onlyBranch,
    allPreviews,
    dryRun,
    previewTtlDays: inputs.previewTtlDays,
    channels: inputs.channels,
    log: (message) => reporter.info(message)
  });

  reporter.info(renderGcSummary(summary));
  writeStdout(JSON.stringify(summary, null, 2) + '\n');
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

function isEntrypoint(currentPath: string, entrypointPath: string | undefined): boolean {
  if (!currentPath || !entrypointPath) {
    return false;
  }
  try {
    return realpathSync(currentPath) === realpathSync(entrypointPath);
  } catch {
    return path.resolve(currentPath) === path.resolve(entrypointPath);
  }
}

if (isEntrypoint(currentModulePath, entrypoint)) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
