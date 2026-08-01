/**
 * Contract for the WS10 dispatch lane workflow: manual-only trigger, read-only
 * repo permissions, secrets threaded ONLY into the probe step's env, and the
 * exact probe command. Guards against the lane drifting into a PR gate or the
 * tokens leaking into other steps.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { cleanupDispatchProbe, createProbeReceiptEmitter, formatCleanupSummary } from '../scripts/live-github-dispatch-probe-support.js';

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'github-dispatch-proof.yml');
const probePath = path.join(__dirname, '..', 'scripts', 'live-github-dispatch-probe.ts');
const probeSupportPath = path.join(__dirname, '..', 'scripts', 'live-github-dispatch-probe-support.ts');
const raw = readFileSync(workflowPath, 'utf8');
const probeSource = readFileSync(probePath, 'utf8');
const probeSupportSource = readFileSync(probeSupportPath, 'utf8');
const workflow = parse(raw) as Record<string, unknown>;

type JsonRecord = Record<string, unknown>;

function job(): JsonRecord {
  const jobs = workflow.jobs as JsonRecord;
  return jobs['dispatch-proof'] as JsonRecord;
}

function steps(): JsonRecord[] {
  return job().steps as JsonRecord[];
}

describe('github-dispatch-proof workflow contract', () => {
  it('is manual dispatch only -- never a PR gate', () => {
    const on = (workflow.on ?? (workflow as JsonRecord)[String(true)]) as JsonRecord;
    expect(Object.keys(on)).toEqual(['workflow_dispatch']);
  });

  it('holds contents: read at both workflow and job level', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job().permissions).toEqual({ contents: 'read' });
  });

  it('runs the probe through the exact committed entrypoint', () => {
    const probe = steps().find((step) => String(step.run ?? '').includes('live-github-dispatch-probe'));
    expect(probe).toBeDefined();
    expect(String(probe!.run).trim()).toBe('npx --yes tsx scripts/live-github-dispatch-probe.ts');
  });

  it('runs the complete ordered roster of live dispatch cases', () => {
    const cases = probeSource.match(/const cases:\s*Array<\[string, \(\) => Promise<void>\]>\s*=\s*\[([\s\S]*?)\n\s*\];/);
    expect(cases).not.toBeNull();
    const identities = [...cases![1].matchAll(/\['([^']+)',\s*case\w+\]/g)].map((match) => match[1]);
    expect(identities).toEqual([
      'default-branch',
      'tag-ref',
      'same-repo-pr',
      'read-only-token',
      'token-order',
      'protected-branch',
      'ruleset-push'
    ]);
    expect(new Set(identities)).toHaveLength(7);
  });

  it('keeps the probe receipt and cleanup safety contracts', () => {
    expect(probeSource).toMatch(/from\s*['"]\.\/live-github-dispatch-probe-support\.js['"]/);
    expect(probeSource).toMatch(/const\s+receipts\s*=\s*createProbeReceiptEmitter\(\[WRITE_TOKEN, READONLY_TOKEN\]\)/);
    expect(probeSupportSource).toMatch(/import\s*\{[^}]*createSecretMasker[^}]*normalizeSecretValues[^}]*}\s*from\s*['"]\.\.\/src\/lib\/secrets\.js['"]/);
    expect(probeSupportSource).toMatch(/const\s+normalizedSecretValues\s*=\s*normalizeSecretValues\(secretValues\)/);
    expect(probeSupportSource).toMatch(/const\s+maskSecrets\s*=\s*createSecretMasker\(normalizedSecretValues\)/);
    expect(probeSupportSource).toMatch(/emitted\.push\(sanitized\)/);
    expect(probeSupportSource).toMatch(/remainingSecretRepresentations/);
    expect(probeSource).toMatch(/fetch\([\s\S]*?signal:\s*AbortSignal\.timeout\(/);

    expect(probeSource).toMatch(/const cleanupResult = await cleanupDispatchProbe\(/);
    expect(probeSource).toMatch(/onError: errorReceipt/);
    expect(probeSupportSource).toMatch(/maxDeleteAttempts = dependencies\.maxDeleteAttempts \?\? 3/);
    expect(probeSupportSource).toMatch(/for \(const fullName of dependencies\.repositories\)/);
    expect(probeSupportSource).toMatch(/repositoryStatus\(fullName\)/);
    expect(probeSupportSource).toMatch(/removeScratchDir\(dir\)/);
    expect(probeSupportSource).toMatch(/return \{ allDeleted, cleanupComplete: allDeleted && scratchDirsDeleted \}/);
    expect(probeSource).toMatch(/const cleanupSummary = formatCleanupSummary\(cleanupResult\)/);
    expect(probeSource).toMatch(/if \(!cleanupResult\.cleanupComplete\) process\.exitCode = 1/);
  });

  it('formats cleanup summaries truthfully for complete and incomplete cleanup outcomes', () => {
    expect(formatCleanupSummary({ allDeleted: true, cleanupComplete: true })).toBe('all deleted');
    expect(formatCleanupSummary({ allDeleted: true, cleanupComplete: false })).toBe('cleanup incomplete');
    expect(formatCleanupSummary({ allDeleted: false, cleanupComplete: false })).toBe('cleanup incomplete');
  });

  it('sanitizes every token representation before emitting and records exactly that receipt', () => {
    const token = 'token+with /:@?%';
    const receipts: string[] = [];
    const emitter = createProbeReceiptEmitter([token]);
    const url = new URL('https://github.com/');
    url.password = token;
    const raw = `raw=${token}; encoded=${encodeURIComponent(token)}; userinfo=https://x-access-token:${token}@github.com; url-userinfo=${url.password}`;

    const emitted = emitter.emit(raw, (receipt) => receipts.push(receipt));

    expect(receipts).toEqual([emitted]);
    expect(emitter.emitted).toEqual([emitted]);
    expect(emitted).not.toContain(token);
    expect(emitted).not.toContain(encodeURIComponent(token));
    expect(emitted).not.toContain(url.password);
    expect(emitter.check()).toEqual({ safe: true, remainingSecretRepresentations: [] });
  });

  it('runs bounded cleanup, verification, and scratch removal independently after failures', async () => {
    const deleted: string[] = [];
    const verified: string[] = [];
    const removed: string[] = [];
    const errors: string[] = [];

    const result = await cleanupDispatchProbe({
      repositories: ['owner/first', 'owner/second'],
      scratchDirs: ['/tmp/first', '/tmp/second'],
      maxDeleteAttempts: 2,
      deleteRepository: async (repo) => {
        deleted.push(repo);
        if (repo === 'owner/first') throw new Error('delete failed');
        return { status: 204 };
      },
      repositoryStatus: async (repo) => {
        verified.push(repo);
        if (repo === 'owner/first') throw new Error('verify failed');
        return 404;
      },
      removeScratchDir: async (dir) => {
        removed.push(dir);
        if (dir === '/tmp/first') throw new Error('remove failed');
      },
      onError: (message) => errors.push(message)
    });

    expect(deleted).toEqual(['owner/first', 'owner/first', 'owner/second']);
    expect(verified).toEqual(['owner/first', 'owner/second']);
    expect(removed).toEqual(['/tmp/first', '/tmp/second']);
    expect(errors).toHaveLength(4);
    expect(result).toEqual({ allDeleted: false, cleanupComplete: false });
  });

  it('proves a read-only denial leaves the remote head unchanged', () => {
    const readOnlyCase = probeSource.match(/async function caseReadOnlyToken\(\): Promise<void> \{([\s\S]*?)\n\}/);
    expect(readOnlyCase).not.toBeNull();
    expect(readOnlyCase![1]).toMatch(/const before = await remoteBranchSha\(repo\.fullName, repo\.defaultBranch\)/);
    expect(readOnlyCase![1]).toMatch(/const after = await remoteBranchSha\(repo\.fullName, repo\.defaultBranch\)/);
    expect(readOnlyCase![1]).toMatch(/const unchanged = after === before/);
    expect(readOnlyCase![1]).toMatch(/record\(name, denied && unchanged/);
  });

  it('threads dispatch tokens only into the probe step env', () => {
    for (const step of steps()) {
      const env = (step.env ?? {}) as JsonRecord;
      const hasTokens = 'WS10_DISPATCH_WRITE_TOKEN' in env || 'WS10_DISPATCH_READONLY_TOKEN' in env;
      const isProbe = String(step.run ?? '').includes('live-github-dispatch-probe');
      if (hasTokens) {
        expect(isProbe).toBe(true);
        expect(env.WS10_DISPATCH_WRITE_TOKEN).toBe('${{ secrets.WS10_DISPATCH_WRITE_TOKEN }}');
        expect(env.WS10_DISPATCH_READONLY_TOKEN).toBe('${{ secrets.WS10_DISPATCH_READONLY_TOKEN }}');
      }
    }
    // The tokens are referenced nowhere else in the file.
    const tokenMentions = raw.match(/WS10_DISPATCH_(?:WRITE|READONLY)_TOKEN/g) ?? [];
    // 2 comment mentions + 2 env keys + 2 secrets refs = 6
    expect(tokenMentions.length).toBe(6);
  });

  it('never uploads artifacts or persists anything', () => {
    expect(raw).not.toMatch(/upload-artifact|actions\/cache@|git push|git commit/);
  });

  it('bounds the job to 15 minutes', () => {
    expect(job()['timeout-minutes']).toBe(15);
  });
});
