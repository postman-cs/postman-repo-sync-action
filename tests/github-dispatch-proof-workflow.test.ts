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

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'github-dispatch-proof.yml');
const raw = readFileSync(workflowPath, 'utf8');
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
