import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type LogSink } from '@postman-cse/automation-core';

import { runRepoSync, type RepoSyncDependencies, type ResolvedInputs } from '../src/index.js';

/**
 * A log line is evidence. These tests pin the properties that make it worth
 * trusting: a credential an upstream echoes back never survives into output,
 * a failure names the stage it died in, and debug chatter stays opt-in.
 */

const PMAK = 'PMAK-reposynclogging-0123456789';
const ACCESS_TOKEN = 'pma_at_reposynclogging';

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      debug: (message) => lines.push('debug ' + message),
      info: (message) => lines.push('info ' + message),
      warning: (message) => lines.push('warning ' + message),
      error: (message) => lines.push('error ' + message)
    }
  };
}

function createInputs(): ResolvedInputs {
  return {
    projectName: 'core-payments',
    workspaceId: 'ws-123',
    baselineCollectionId: 'col-baseline',
    smokeCollectionId: 'col-smoke',
    contractCollectionId: 'col-contract',
    onboardingScope: 'full',
    prebuiltCollectionsJson: '',
    collectionSyncMode: 'refresh',
    specSyncMode: 'update',
    releaseLabel: undefined,
    environments: ['prod'],
    repoUrl: 'https://github.com/postman-cs/repo-sync-demo',
    integrationBackend: 'bifrost',
    workspaceLinkEnabled: true,
    environmentSyncEnabled: true,
    systemEnvMap: {},
    environmentUids: {},
    envRuntimeUrls: { prod: 'https://api.example.com' },
    artifactDir: 'postman',
    repoWriteMode: 'commit-and-push',
    currentRef: 'feature/repo-sync',
    githubHeadRef: '',
    githubRefName: 'feature/repo-sync',
    committerName: 'Postman',
    committerEmail: 'support@postman.com',
    postmanApiKey: PMAK,
    postmanAccessToken: ACCESS_TOKEN,
    credentialPreflight: 'warn',
    branchStrategy: 'legacy',
    previewTtlDays: 30,
    adoToken: '',
    githubToken: 'github-token',
    ghFallbackToken: 'fallback-token',
    provider: 'github',
    ciWorkflowBase64: '',
    generateCiWorkflow: false,
    monitorType: 'cloud',
    ciWorkflowPath: '.github/workflows/ci.yml',
    orgMode: false,
    monitorId: '',
    mockUrl: '',
    mockVisibility: 'public',
    mockEnvironmentEnabled: false,
    monitorCron: '',
    sslClientCert: '',
    sslClientKey: '',
    sslClientPassphrase: '',
    sslExtraCaCerts: '',
    specId: '',
    specContentChanged: true,
    specPath: '',
    teamId: '',
    repository: 'postman-cs/repo-sync-demo',
    postmanRegion: 'us',
    postmanStack: 'prod',
    postmanApiBase: 'https://api.getpostman.com',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
    postmanFallbackBase: 'https://go.postman.co/_api',
    postmanCliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh',
    postmanIapubBase: 'https://iapub.postman.co',
    secretsResolverProvider: 'none'
  };
}

// An upstream that reflects the credential back must not turn a diagnostic line
// into a leak. The stub answers enough of the run to reach environment sync,
// then fails there with the key embedded in the upstream message.
function createDependencies(logger: ReturnType<typeof createLogger>): RepoSyncDependencies {
  return {
    core: {
      info: () => undefined,
      setOutput: () => undefined,
      warning: () => undefined
    },
    logger,
    postman: {
      findEnvironmentByName: async () => {
        throw new Error('Postman rejected the request for key ' + PMAK);
      }
    } as never,
    github: {
      getRepositoryVariable: async () => '',
      setRepositoryVariable: async () => undefined
    },
    internalIntegration: {
      associateSystemEnvironments: async () => undefined,
      connectWorkspaceToRepository: async () => undefined,
      findWorkspaceForRepo: async () => ({ state: 'free' as const })
    }
  };
}

function run(logger: ReturnType<typeof createLogger>): Promise<unknown> {
  return runRepoSync(createInputs(), createDependencies(logger));
}

describe('repo sync logging', () => {
  let originalCwd = '';
  let testDir = '';

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'repo-sync-logging-'));
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('never emits the credential it was handed, even when upstream echoes it back', async () => {
    const { sink, lines } = recordingSink();

    await expect(run(createLogger({ sink, level: 'debug' }))).rejects.toThrow();

    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(PMAK);
    expect(all).not.toContain(ACCESS_TOKEN);
    expect(all).toContain('***');
  });

  it('names the stage that failed, which the rethrow alone would not', async () => {
    const { sink, lines } = recordingSink();

    await expect(run(createLogger({ sink, level: 'debug' }))).rejects.toThrow();

    const all = lines.join('\n');
    expect(all).toContain('repo sync failed');
    expect(all).toContain('phase=sync-environments');
    expect(all).toContain('phase failed');
  });

  it('keeps debug chatter out of a default run and opens it under RUNNER_DEBUG', async () => {
    async function collect(env: NodeJS.ProcessEnv): Promise<string[]> {
      const { sink, lines } = recordingSink();
      await run(createLogger({ sink, env })).catch(() => undefined);
      return lines;
    }

    expect((await collect({})).filter((line) => line.startsWith('debug'))).toHaveLength(0);
    expect(
      (await collect({ RUNNER_DEBUG: '1' })).filter((line) => line.startsWith('debug')).length
    ).toBeGreaterThan(0);
  });
});
