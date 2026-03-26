import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createRepoSyncDependencies,
  resolveInputs,
  resolvePostmanApiKeyAndTeamId,
  runRepoSync,
  type ExecLike,
  type RepoSyncDependencies,
  type ResolvedInputs
} from './index.js';
import { createSecretMasker } from './lib/secrets.js';

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

export class ConsoleReporter implements ReporterCore {
  public info(message: string): void {
    console.error(message);
  }

  public warning(message: string): void {
    console.error(`warning: ${message}`);
  }

  public setOutput(_name: string, _value: string): void {
  }

  public setSecret(_secret: string): void {
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === `--${name}`) {
      return argv[index + 1];
    }
    if (arg?.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
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
          throw new Error(`Command failed with exit code ${exitCode}: ${commandLabel}`);
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

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig {
  const inputNames = [
    'project-name',
    'workspace-id',
    'baseline-collection-id',
    'smoke-collection-id',
    'contract-collection-id',
    'collection-sync-mode',
    'spec-sync-mode',
    'release-label',
    'environments-json',
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
    'github-token',
    'gh-fallback-token',
    'ci-workflow-base64',
    'generate-ci-workflow',
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
    'spec-path',
    'team-id'
  ];

  const inputEnv: NodeJS.ProcessEnv = { ...env };
  for (const name of inputNames) {
    const value = readFlag(argv, name);
    if (value !== undefined) {
      inputEnv[normalizeCliFlag(name)] = value;
    }
  }

  return {
    inputEnv,
    resultJsonPath: readFlag(argv, 'result-json') ?? 'postman-repo-sync-result.json',
    dotenvPath: readFlag(argv, 'dotenv-path')
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
  const env = runtime.env ?? process.env;
  const config = parseCliArgs(argv, env);
  const inputs = resolveInputs(config.inputEnv);
  const reporter = new ConsoleReporter();
  const initialMasker = createSecretMasker([
    inputs.postmanApiKey,
    inputs.postmanAccessToken,
    inputs.githubToken,
    inputs.ghFallbackToken,
    inputs.sslClientCert,
    inputs.sslClientKey,
    inputs.sslClientPassphrase,
    inputs.sslExtraCaCerts
  ]);
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

  const writeStdout = runtime.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  writeStdout(`${JSON.stringify(result, null, 2)}\n`);
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

if (entrypoint && currentModulePath === entrypoint) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
