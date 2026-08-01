/**
 * WS10 live dispatch probe: proves RepoMutationService push policy against
 * REAL GitHub -- disposable repos, real branch protection, real repository
 * rulesets, real token capability enforcement. This is the "real GitHub
 * proves policy" half of the WS10 decision (containers prove transport).
 *
 * Never a PR gate. Run locally or via the manual `github-dispatch-proof.yml`
 * workflow_dispatch lane:
 *
 *   WS10_DISPATCH_WRITE_TOKEN=ghp_...   # classic PAT: repo + delete_repo
 *   WS10_DISPATCH_READONLY_TOKEN=ghp_... # classic PAT: NO scopes
 *   npx --yes tsx scripts/live-github-dispatch-probe.ts
 *
 * The write token creates (and always deletes) throwaway public repos named
 * ws10-dispatch-<case>-<nonce> under the token owner's account. Receipts are
 * printed sanitized: token values never appear (asserted before exit).
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { RepoMutationService } from '../src/lib/github/repo-mutation.js';
import type { ExecuteFn, ExecuteResult } from '../src/lib/github/repo-mutation.js';
import {
  cleanupDispatchProbe,
  createProbeReceiptEmitter,
  formatCleanupSummary,
  type DeleteAttempt
} from './live-github-dispatch-probe-support.js';

const execFileAsync = promisify(execFile);

const API = 'https://api.github.com';
const WRITE_TOKEN = process.env.WS10_DISPATCH_WRITE_TOKEN ?? '';
const READONLY_TOKEN = process.env.WS10_DISPATCH_READONLY_TOKEN ?? '';
const API_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 60_000;

if (!WRITE_TOKEN) {
  console.error('WS10_DISPATCH_WRITE_TOKEN is required (classic PAT: repo + delete_repo)');
  process.exit(2);
}
if (!READONLY_TOKEN) {
  console.error('WS10_DISPATCH_READONLY_TOKEN is required (classic PAT with no scopes)');
  process.exit(2);
}

type JsonRecord = Record<string, unknown>;

interface CaseResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CaseResult[] = [];
const scratchDirs: string[] = [];
const createdRepos: string[] = [];
const receipts = createProbeReceiptEmitter([WRITE_TOKEN, READONLY_TOKEN]);

function sanitize(text: string): string {
  return receipts.sanitize(text);
}

function logReceipt(text: string): void {
  receipts.emit(text, console.log);
}

function errorReceipt(text: string): void {
  receipts.emit(text, console.error);
}

async function gh(
  token: string,
  method: string,
  route: string,
  body?: JsonRecord | JsonRecord[]
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${API}${route}`, {
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = text;
    }
  }
  return { status: response.status, json };
}

async function createScratchDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  scratchDirs.push(dir);
  return dir;
}

/** Hermetic git env: no operator config, credentials, or prompts leak in. */
function hermeticGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_AUTHOR_NAME: 'ws10-probe',
    GIT_AUTHOR_EMAIL: 'ws10-probe@example.invalid',
    GIT_COMMITTER_NAME: 'ws10-probe',
    GIT_COMMITTER_EMAIL: 'ws10-probe@example.invalid'
  };
}

function realGitExecute(cwd: string, env: NodeJS.ProcessEnv, executed: string[][]): ExecuteFn {
  return async (command, args): Promise<ExecuteResult> => {
    executed.push([command, ...args]);
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? ''
      };
    }
  };
}

let ownerLogin = '';

async function createDisposableRepo(caseName: string): Promise<{ fullName: string; url: string; defaultBranch: string }> {
  const nonce = Math.random().toString(36).slice(2, 8);
  const name = `ws10-dispatch-${caseName}-${nonce}`;
  const created = await gh(WRITE_TOKEN, 'POST', '/user/repos', {
    name,
    description: 'Disposable WS10 dispatch-lane probe repo (auto-deleted)',
    private: false,
    auto_init: true
  });
  if (created.status !== 201) {
    throw new Error(`repo create failed (${created.status}): ${sanitize(JSON.stringify(created.json)).slice(0, 300)}`);
  }
  const record = created.json as JsonRecord;
  const fullName = String(record.full_name);
  createdRepos.push(fullName);
  // auto_init commit can lag; poll until the default branch resolves.
  const defaultBranch = String(record.default_branch || 'main');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const head = await gh(WRITE_TOKEN, 'GET', `/repos/${fullName}/branches/${defaultBranch}`);
    if (head.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { fullName, url: `https://github.com/${fullName}.git`, defaultBranch };
}

async function deleteRepo(fullName: string): Promise<DeleteAttempt> {
  try {
    const res = await gh(WRITE_TOKEN, 'DELETE', `/repos/${fullName}`);
    return { status: res.status };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

interface WorkClone {
  dir: string;
  execute: ExecuteFn;
  executed: string[][];
}

async function cloneWorkRepo(url: string, name: string, branch?: string): Promise<WorkClone> {
  const parent = await createScratchDir(name);
  const home = path.join(parent, 'home');
  const dir = path.join(parent, 'work');
  const env = hermeticGitEnv(home);
  const authedUrl = url.replace('https://', `https://x-access-token:${WRITE_TOKEN}@`);
  const cloneArgs = ['clone', ...(branch ? ['--branch', branch] : []), authedUrl, dir];
  await execFileAsync('git', cloneArgs, { env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  // Restore the anonymous URL so every pushed credential comes from the
  // service's own buildAuthenticatedRemoteUrl rewrite, exactly as in CI.
  await execFileAsync('git', ['remote', 'set-url', 'origin', url], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS
  });
  const executed: string[][] = [];
  return { dir, execute: realGitExecute(dir, env, executed), executed };
}

async function remoteBranchSha(fullName: string, branch: string, expect?: string): Promise<string> {
  // The branches API can lag a just-completed push; when the caller knows the
  // sha it expects, re-read briefly before accepting a stale answer.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await gh(WRITE_TOKEN, 'GET', `/repos/${fullName}/branches/${branch}`);
    if (res.status === 200) {
      const record = res.json as JsonRecord;
      const commit = record.commit as JsonRecord | undefined;
      const sha = String(commit?.sha ?? '');
      if (!expect || sha === expect) return sha;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const res = await gh(WRITE_TOKEN, 'GET', `/repos/${fullName}/branches/${branch}`);
  const record = res.status === 200 ? (res.json as JsonRecord) : {};
  const commit = record.commit as JsonRecord | undefined;
  return String(commit?.sha ?? '');
}

function service(clone: WorkClone, fullName: string, url: string): RepoMutationService {
  return new RepoMutationService({
    cwd: clone.dir,
    execute: clone.execute,
    provider: 'github',
    repository: fullName,
    repoUrl: url
  });
}

async function seedChange(clone: WorkClone, fileName = 'postman/collection.yaml'): Promise<void> {
  const target = path.join(clone.dir, fileName);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `# probe payload ${Date.now()}\n`, 'utf8');
}

function record(name: string, ok: boolean, detail: string): void {
  const sanitized = sanitize(detail);
  results.push({ name, ok, detail: sanitized });
  logReceipt(`${ok ? 'PASS' : 'FAIL'} ${name} -- ${sanitized}`);
}

async function caseDefaultBranch(): Promise<void> {
  const name = 'default-branch';
  const repo = await createDisposableRepo(name);
  try {
    const before = await remoteBranchSha(repo.fullName, repo.defaultBranch);
    const clone = await cloneWorkRepo(repo.url, name);
    await seedChange(clone);
    const outcome = await service(clone, repo.fullName, repo.url).commitAndPush({
      committerName: 'ws10-probe',
      committerEmail: 'ws10-probe@example.invalid',
      currentRef: `refs/heads/${repo.defaultBranch}`,
      repoWriteMode: 'commit-and-push',
      githubToken: WRITE_TOKEN,
      stagePaths: ['postman']
    });
    const after = await remoteBranchSha(repo.fullName, repo.defaultBranch, outcome.commitSha);
    const ok = outcome.pushed && after === outcome.commitSha && after !== before;
    record(name, ok, `pushed=${outcome.pushed} remoteHead=${after.slice(0, 7)} commit=${outcome.commitSha.slice(0, 7)}`);
  } finally {
    await deleteRepo(repo.fullName);
  }
}

async function caseTagRef(): Promise<void> {
  const name = 'tag-ref';
  const repo = await createDisposableRepo(name);
  try {
    const clone = await cloneWorkRepo(repo.url, name);
    await seedChange(clone);
    try {
      await service(clone, repo.fullName, repo.url).commitAndPush({
        committerName: 'ws10-probe',
        committerEmail: 'ws10-probe@example.invalid',
        currentRef: 'refs/tags/v9.9.9',
        repoWriteMode: 'commit-and-push',
        githubToken: WRITE_TOKEN,
        stagePaths: ['postman']
      });
      record(name, false, 'tag ref was accepted for commit-and-push (should fail closed)');
    } catch (error) {
      const message = (error as Error).message;
      const ok = /No current ref could be resolved/.test(message);
      record(name, ok, `rejected: ${message.slice(0, 120)}`);
    }
  } finally {
    await deleteRepo(repo.fullName);
  }
}

async function caseSameRepoPr(): Promise<void> {
  const name = 'same-repo-pr';
  const repo = await createDisposableRepo(name);
  try {
    // Real PR: create a head branch with a divergent commit, open a PR, then
    // push through the service exactly as the Action runs on pull_request
    // (currentRef=refs/pull/N/merge, githubHeadRef=<head branch>).
    const setup = await cloneWorkRepo(repo.url, `${name}-setup`);
    const env = hermeticGitEnv(path.join(setup.dir, '..', 'home'));
    await execFileAsync('git', ['checkout', '-b', 'feature/probe'], {
      cwd: setup.dir,
      env,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS
    });
    await writeFile(path.join(setup.dir, 'seed.txt'), 'pr seed\n', 'utf8');
    await execFileAsync('git', ['add', 'seed.txt'], { cwd: setup.dir, env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    await execFileAsync('git', ['commit', '-m', 'seed: pr head'], {
      cwd: setup.dir,
      env,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS
    });
    const authed = repo.url.replace('https://', `https://x-access-token:${WRITE_TOKEN}@`);
    await execFileAsync('git', ['push', authed, 'HEAD:refs/heads/feature/probe'], {
      cwd: setup.dir,
      env,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS
    });
    const pr = await gh(WRITE_TOKEN, 'POST', `/repos/${repo.fullName}/pulls`, {
      title: 'WS10 dispatch probe PR',
      head: 'feature/probe',
      base: repo.defaultBranch,
      body: 'Disposable probe PR (repo auto-deleted).'
    });
    if (pr.status !== 201) {
      record(name, false, `PR create failed (${pr.status}): ${JSON.stringify(pr.json).slice(0, 200)}`);
      return;
    }
    const prNumber = Number((pr.json as JsonRecord).number);

    const clone = await cloneWorkRepo(repo.url, name, 'feature/probe');
    await seedChange(clone);
    const outcome = await service(clone, repo.fullName, repo.url).commitAndPush({
      committerName: 'ws10-probe',
      committerEmail: 'ws10-probe@example.invalid',
      currentRef: `refs/pull/${prNumber}/merge`,
      githubHeadRef: 'feature/probe',
      repoWriteMode: 'commit-and-push',
      githubToken: WRITE_TOKEN,
      stagePaths: ['postman']
    });
    const after = await remoteBranchSha(repo.fullName, 'feature/probe', outcome.commitSha);
    const ok =
      outcome.pushed &&
      outcome.resolvedCurrentRef === 'feature/probe' &&
      after === outcome.commitSha;
    record(
      name,
      ok,
      `pr=#${prNumber} resolvedRef=${outcome.resolvedCurrentRef} pushed=${outcome.pushed} headNow=${after.slice(0, 7)}`
    );
  } finally {
    await deleteRepo(repo.fullName);
  }
}

async function caseReadOnlyToken(): Promise<void> {
  const name = 'read-only-token';
  const repo = await createDisposableRepo(name);
  try {
    const before = await remoteBranchSha(repo.fullName, repo.defaultBranch);
    const clone = await cloneWorkRepo(repo.url, name);
    await seedChange(clone);
    try {
      await service(clone, repo.fullName, repo.url).commitAndPush({
        committerName: 'ws10-probe',
        committerEmail: 'ws10-probe@example.invalid',
        currentRef: `refs/heads/${repo.defaultBranch}`,
        repoWriteMode: 'commit-and-push',
        githubToken: READONLY_TOKEN,
        stagePaths: ['postman']
      });
      record(name, false, 'push with a scopeless token succeeded (should be denied by GitHub)');
    } catch (error) {
      const message = (error as Error).message;
      // GitHub denies scopeless-token pushes with 403; the service must
      // surface the denial (never silently claim success).
      const denied = /403|denied|permission|not found/i.test(message);
      const after = await remoteBranchSha(repo.fullName, repo.defaultBranch);
      const unchanged = after === before;
      record(name, denied && unchanged, `denied: ${message.slice(0, 140)} headUnchanged=${unchanged}`);
    }
  } finally {
    await deleteRepo(repo.fullName);
  }
}

async function caseTokenFallbackOrder(): Promise<void> {
  const name = 'token-order';
  const repo = await createDisposableRepo(name);
  try {
    const clone = await cloneWorkRepo(repo.url, name);
    await seedChange(clone);
    // fallbackToken is offered FIRST by buildPushTokenOrder; give it the
    // scopeless token so real GitHub rejects it, then the write token must
    // succeed as the second candidate.
    const outcome = await service(clone, repo.fullName, repo.url).commitAndPush({
      committerName: 'ws10-probe',
      committerEmail: 'ws10-probe@example.invalid',
      currentRef: `refs/heads/${repo.defaultBranch}`,
      repoWriteMode: 'commit-and-push',
      fallbackToken: READONLY_TOKEN,
      githubToken: WRITE_TOKEN,
      stagePaths: ['postman']
    });
    const after = await remoteBranchSha(repo.fullName, repo.defaultBranch, outcome.commitSha);
    const setUrlTokens = clone.executed
      .filter((argv) => argv[1] === 'remote' && argv[2] === 'set-url')
      .map((argv) => argv[4])
      .filter((url) => url?.includes('x-access-token'));
    const offeredReadonlyFirst =
      setUrlTokens.length >= 2 &&
      setUrlTokens[0].includes(encodeURIComponent(READONLY_TOKEN)) &&
      setUrlTokens[1].includes(encodeURIComponent(WRITE_TOKEN));
    const ok = outcome.pushed && after === outcome.commitSha && offeredReadonlyFirst;
    record(
      name,
      ok,
      `pushed=${outcome.pushed} candidates=${setUrlTokens.length} readonlyOfferedFirst=${offeredReadonlyFirst} remoteHead=${after.slice(0, 7)} commit=${outcome.commitSha.slice(0, 7)}`
    );
  } finally {
    await deleteRepo(repo.fullName);
  }
}

async function caseProtectedBranch(): Promise<void> {
  const name = 'protected-branch';
  const repo = await createDisposableRepo(name);
  try {
    const protect = await gh(WRITE_TOKEN, 'PUT', `/repos/${repo.fullName}/branches/${repo.defaultBranch}/protection`, {
      required_status_checks: null,
      enforce_admins: true,
      required_pull_request_reviews: { required_approving_review_count: 1 },
      restrictions: null
    });
    if (protect.status !== 200) {
      record(name, false, `protection setup failed (${protect.status}): ${JSON.stringify(protect.json).slice(0, 200)}`);
      return;
    }
    const before = await remoteBranchSha(repo.fullName, repo.defaultBranch);
    const clone = await cloneWorkRepo(repo.url, name);
    await seedChange(clone);
    try {
      await service(clone, repo.fullName, repo.url).commitAndPush({
        committerName: 'ws10-probe',
        committerEmail: 'ws10-probe@example.invalid',
        currentRef: `refs/heads/${repo.defaultBranch}`,
        repoWriteMode: 'commit-and-push',
        githubToken: WRITE_TOKEN,
        stagePaths: ['postman']
      });
      record(name, false, 'push to protected branch succeeded (protection did not bite)');
    } catch (error) {
      const message = (error as Error).message;
      const after = await remoteBranchSha(repo.fullName, repo.defaultBranch);
      const ok = /GH006|protected branch/i.test(message) && after === before;
      record(name, ok, `rejected: ${message.slice(0, 140)} headUnchanged=${after === before}`);
    }
  } finally {
    await deleteRepo(repo.fullName);
  }
}

async function caseRulesetPush(): Promise<void> {
  const name = 'ruleset-push';
  const repo = await createDisposableRepo(name);
  try {
    const ruleset = await gh(WRITE_TOKEN, 'POST', `/repos/${repo.fullName}/rulesets`, {
      name: 'ws10-block-direct-push',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [{ type: 'pull_request', parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false
      } }]
    });
    if (ruleset.status !== 201) {
      record(name, false, `ruleset setup failed (${ruleset.status}): ${JSON.stringify(ruleset.json).slice(0, 240)}`);
      return;
    }
    const before = await remoteBranchSha(repo.fullName, repo.defaultBranch);
    const clone = await cloneWorkRepo(repo.url, name);
    await seedChange(clone);
    try {
      await service(clone, repo.fullName, repo.url).commitAndPush({
        committerName: 'ws10-probe',
        committerEmail: 'ws10-probe@example.invalid',
        currentRef: `refs/heads/${repo.defaultBranch}`,
        repoWriteMode: 'commit-and-push',
        githubToken: WRITE_TOKEN,
        stagePaths: ['postman']
      });
      record(name, false, 'push through active ruleset succeeded (ruleset did not bite)');
    } catch (error) {
      const message = (error as Error).message;
      const after = await remoteBranchSha(repo.fullName, repo.defaultBranch);
      const ok = /GH013|repository rule violations/i.test(message) && after === before;
      record(name, ok, `rejected: ${message.slice(0, 140)} headUnchanged=${after === before}`);
    }
  } finally {
    await deleteRepo(repo.fullName);
  }
}

async function main(): Promise<void> {
  const who = await gh(WRITE_TOKEN, 'GET', '/user');
  if (who.status !== 200) {
    errorReceipt(`write token rejected by /user (${who.status})`);
    process.exit(2);
  }
  ownerLogin = String((who.json as JsonRecord).login);
  logReceipt(`probe identity: ${ownerLogin}`);

  const cases: Array<[string, () => Promise<void>]> = [
    ['default-branch', caseDefaultBranch],
    ['tag-ref', caseTagRef],
    ['same-repo-pr', caseSameRepoPr],
    ['read-only-token', caseReadOnlyToken],
    ['token-order', caseTokenFallbackOrder],
    ['protected-branch', caseProtectedBranch],
    ['ruleset-push', caseRulesetPush]
  ];

  for (const [caseName, run] of cases) {
    try {
      await run();
    } catch (error) {
      record(caseName, false, `threw: ${(error as Error).message.slice(0, 200)}`);
    }
  }
}

main()
  .catch((error) => {
    errorReceipt(`probe crashed: ${(error as Error).stack ?? String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    const cleanupResult = await cleanupDispatchProbe({
      repositories: createdRepos,
      scratchDirs,
      deleteRepository: deleteRepo,
      repositoryStatus: async (fullName) => (await gh(WRITE_TOKEN, 'GET', `/repos/${fullName}`)).status,
      removeScratchDir: async (dir) => rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 }),
      onError: errorReceipt
    });
    const failed = results.filter((r) => r.ok === false);
    const cleanupSummary = formatCleanupSummary(cleanupResult);
    logReceipt(
      `\nsummary: ${results.length - failed.length}/${results.length} cases passed; repos created=${createdRepos.length}, ${cleanupSummary}`
    );
    // Receipt hygiene must inspect what was actually emitted, against every
    // recognized representation of both tokens.
    if (!receipts.check().safe) {
      errorReceipt('SECRET LEAK in receipts -- failing loudly');
      process.exitCode = 1;
    }
    if (!cleanupResult.cleanupComplete) process.exitCode = 1;
    if (failed.length > 0) process.exitCode = 1;
  });
