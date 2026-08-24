import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const seaWorkflow = readFileSync(join(process.cwd(), '.github/workflows/sea-binary.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** Extract one top-level job block: `  <id>:` through the next job header or EOF. */
function jobText(workflow: string, jobId: string): string {
  const jobsBody = workflow.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? '';
  const header = `  ${jobId}:\n`;
  const start = jobsBody.indexOf(header);
  if (start < 0) return '';
  const rest = jobsBody.slice(start + header.length);
  const nextJob = rest.search(/^ {2}[a-zA-Z0-9_-]+:\n/m);
  return header + (nextJob < 0 ? rest : rest.slice(0, nextJob));
}

function namedStep(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

/** Ordered gate names launched via `run <name> ...` (excludes the `run()` helper definition). */
function linuxQueuedGates(runGates: string): string[] {
  return [...runGates.matchAll(/^\s+run ([a-zA-Z0-9_-]+)\s+/gm)].map((m) => m[1]!);
}

const linux = jobText(ciWorkflow, 'gate');
const distParity = jobText(ciWorkflow, 'dist-parity');
const ready = jobText(ciWorkflow, 'ready');
const windows = jobText(ciWorkflow, 'windows');

describe('CI and SEA PR workflow contracts', () => {
  it('exposes the committed-dist parity split in package scripts', () => {
    expect(pkg.scripts['verify:dist:shape']).toBe('node scripts/verify-dist-artifact.mjs');
    expect(pkg.scripts['verify:dist:parity']).toBe('git diff --ignore-space-at-eol --text --exit-code -- dist');
    expect(pkg.scripts['verify:dist:assert']).toBe('npm run verify:dist:shape && npm run verify:dist:parity');
    expect(pkg.scripts['verify:dist']).toBe('npm run build && npm run verify:dist:assert');
  });

  it('groups by PR number or ref and cancels in-progress only on pull_request in both workflows', () => {
    expect(ciWorkflow).toContain(
      'group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

    expect(seaWorkflow).toContain(
      'group: sea-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(seaWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

    // Push/manual must share the expression (no hard-coded true/false that would cancel pushes).
    expect(ciWorkflow).not.toMatch(/cancel-in-progress:\s*true\b/);
    expect(seaWorkflow).not.toMatch(/cancel-in-progress:\s*true\b/);
  });

  it('keeps four jobs with gate/dist-parity/windows/ready and correct needs edges', () => {
    const jobsSection = ciWorkflow.slice(ciWorkflow.indexOf('\njobs:\n'));
    const jobMatches = jobsSection.match(/^ {2}[a-zA-Z0-9_-]+:$/gm) ?? [];
    expect(jobMatches).toEqual(['  gate:', '  dist-parity:', '  windows:', '  ready:']);
    expect(linux).not.toMatch(/^\s*needs:/m);
    expect(windows).not.toMatch(/^\s*needs:/m);
    expect(distParity).toMatch(/^\s*needs:\s*gate\s*$/m);
    expect(ready).toContain('needs: [gate, dist-parity, windows]');
    expect(ready).toContain('if: always()');
  });

  it('checks out full history on Linux for commitlint and keeps Windows shallow', () => {
    expect(linux).toContain('fetch-depth: 0');
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);
    expect(windows).not.toContain('fetch-depth: 0');
    expect(windows).not.toContain('commitlint');
  });

  it('bundles exactly once on Linux before the read-only queue and keeps jobs independent', () => {
    expect(linux.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.indexOf('- run: npm run bundle')).toBeLessThan(linux.indexOf('- name: Run gates'));

    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).not.toMatch(/^\s*- run: npm run bundle\s*$/m);
    expect(windows).not.toContain('npm run bundle');
    expect(ciWorkflow).not.toMatch(/^\s*- run: npm run build\s*$/m);
    expect(ciWorkflow.match(/npm run typecheck/g) ?? []).toHaveLength(1);
  });

  it('queues the exact Linux read-only gates with actionlint and PR-only commitlint', () => {
    const runGates = namedStep(linux, 'Run gates');
    expect(runGates.length).toBeGreaterThan(0);

    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    expect(runGates).toContain('while [ "${#pid[@]}" -ge "$MAX_PARALLEL_GATES" ]; do finish_one; done');
    expect(runGates).toContain('while [ "${#pid[@]}" -gt 0 ]; do finish_one; done');
    expect(runGates).toContain('wait -n -p finished_pid');

    expect(linuxQueuedGates(runGates)).toEqual([
      'lint',
      'test',
      'typecheck',
      'dist-shape',
      'actionlint',
      'commitlint',
    ]);
    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run dist-shape npm run verify:dist:shape');
    expect(runGates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    // Queue stays read-only: no mutating build / bundle / bare verify:dist / rm inside the fan-out.
    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toContain('npm run bundle');
    expect(runGates).not.toContain('verify:dist:assert');
    expect(runGates).not.toContain('verify:dist:parity');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).not.toContain('rm -rf dist');
    expect(runGates).not.toMatch(/\brm\b/);
    expect(runGates).not.toMatch(/run dist\s+git diff --ignore-space-at-eol --text --exit-code -- dist/);

    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
    expect(runGates).toContain('>"$RUNNER_TEMP/$n.log"');
    expect(runGates).toContain('cat "$RUNNER_TEMP/$n.log"');
    expect(runGates).toContain('exit $fail');
  });

  it('pins actionlint 1.7.11 at $RUNNER_TEMP with zero Go setup or go install across CI/SEA/release', () => {
    const install = namedStep(linux, 'Install actionlint');
    expect(install.length).toBeGreaterThan(0);
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');

    for (const workflow of [ciWorkflow, releaseWorkflow, seaWorkflow]) {
      expect(workflow).not.toContain('actions/setup-go');
      expect(workflow).not.toContain('go install github.com/rhysd/actionlint');
      expect(workflow).not.toMatch(/\bgo install\b/);
    }

    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
      expect(workflow).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
      expect(workflow).toContain('run actionlint "$ACTIONLINT_BIN"');
    }
  });

  it('pins the actionlint downloader to an immutable commit SHA (no /main/scripts)', () => {
    const install = namedStep(linux, 'Install actionlint');
    expect(install.length).toBeGreaterThan(0);
    expect(install).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash',
    );
    expect(install).not.toContain('/main/scripts');
    expect(linux).not.toContain('/main/scripts');
  });

  it('runs the budgeted Git transport lane after the gate fan-out, Linux only', () => {
    const lane = namedStep(linux, 'Git smart-HTTP transport lane');
    expect(lane.length).toBeGreaterThan(0);
    expect(lane).toContain('npm run test:emulator:git');
    expect(lane).toContain('cap 47s');
    expect(lane).toContain('if [ "$elapsed" -gt 47 ]; then');
    expect(windows).not.toContain('emulator');
    expect(linux.indexOf('- name: Run gates')).toBeLessThan(linux.indexOf('- name: Git smart-HTTP transport lane'));
    expect(linux.indexOf('- name: Git smart-HTTP transport lane')).toBeLessThan(
      linux.indexOf('- name: Ensure clean tracked tree outside dist'),
    );
  });

  it('caches Windows node_modules with pinned actions/cache and runs the full test script via node --run', () => {
    expect(windows).toContain("node-version: '24'");
    expect(windows).not.toMatch(/^\s*cache:\s*npm\s*$/m);

    // Semantic pin: any 40-char hex SHA, consistent across file, with semver comment
    {
      const cachePins = [...ciWorkflow.matchAll(/actions\/cache@([0-9a-f]{40})/g)].map((m) => m[1]!);
      expect(cachePins.length).toBeGreaterThanOrEqual(1);
      for (const sha of cachePins) expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(new Set(cachePins).size).toBe(1);
      expect(windows).toMatch(/uses:\s*actions\/cache@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+/);
    }
    expect(windows).toContain('id: windows-node-modules');
    expect(windows).toContain('path: node_modules');
    expect(windows).toContain("key: Windows/node-24/exact-${{ hashFiles('package-lock.json') }}");
    expect(windows).not.toContain('restore-keys');
    expect(windows).not.toContain('restore-keys:');

    expect(windows).toContain("if: steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(windows).toContain('run: npm ci --prefer-offline --no-audit --no-fund');
    expect(windows).toMatch(
      /name: Prefetch vendored dependencies\n {8}if: steps\.windows-node-modules\.outputs\.cache-hit != 'true'[\s\S]*?node \.github\/scripts\/prefetch-vendored-deps\.mjs[\s\S]*?run: npm ci --prefer-offline --no-audit --no-fund/,
    );
    // Cache hit skips only install; the full unfiltered package.json "test"
    // script runs via Node's built-in runner (no npm.cmd boot on Windows).
    expect(windows).toMatch(/^\s*- run: node --run test\s*$/m);
    expect(windows).not.toMatch(/^\s*- run: npm test\s*$/m);
    expect(windows).not.toMatch(/node --run test --/);
    expect(windows).not.toMatch(/npm test --/);

    // Linux gate still queues the full suite via npm test.
    expect(linux).toContain('run test       npm test');

    // No queue / platform-neutral gates on Windows.
    expect(windows).not.toContain('name: Run gates');
    expect(windows).not.toContain('shell: pwsh');
    expect(windows).not.toContain('Start-Job');
    expect(windows).not.toContain('MAX_PARALLEL_GATES');
    expect(windows).not.toContain('npm run lint');
    expect(windows).not.toContain('npm run typecheck');
    expect(windows).not.toContain('npm run verify:dist:shape');
    expect(windows).not.toContain('npm run verify:dist:parity');
    expect(windows).not.toContain('npm run verify:dist:assert');
    expect(windows).not.toContain('npm run build');
    expect(windows).not.toContain('npm run bundle');
    expect(windows).not.toContain('actionlint');
    expect(windows).not.toContain('commitlint');
  });

  it('prefetches locked dependencies without exposing an npm credential', () => {
    expect(ciWorkflow.match(/node \.github\/scripts\/prefetch-vendored-deps\.mjs/g) ?? []).toHaveLength(3);
    expect(ciWorkflow.match(/DEPS_REPO: \$\{\{ secrets\.DEPS_REPO \}\}/g) ?? []).toHaveLength(3);
    expect(ciWorkflow.match(/DEPS_TOKEN: \$\{\{ secrets\.DEPS_TOKEN \}\}/g) ?? []).toHaveLength(3);
    expect(ciWorkflow).not.toContain('NPM_TOKEN');
    expect(windows).not.toMatch(/- run: node --run test\n\s+env:/);
  });

  it('uploads candidate dist from gate and expected-dist from dist-parity on mismatch', () => {
    const candidate = namedStep(linux, 'Upload candidate dist');
    expect(candidate.length).toBeGreaterThan(0);
    expect(candidate).toContain('uses: actions/upload-artifact@v7');
    expect(candidate).toContain('name: candidate-dist');
    expect(candidate).toContain('dist/');
    expect(candidate).toContain('dist-manifest.json');
    expect(namedStep(linux, 'Write dist manifest')).toContain('lock_hash');
    expect(namedStep(linux, 'Ensure clean tracked tree outside dist')).toContain('git status --porcelain');
    expect(linux).not.toContain('name: expected-dist');

    const upload = namedStep(distParity, 'Upload expected dist on mismatch');
    expect(upload.length).toBeGreaterThan(0);
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('uses: actions/upload-artifact@v7');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
    expect(distParity).toContain('npm run verify:dist:parity');
    expect(distParity).not.toContain('verify:dist:shape');
    expect(distParity).not.toContain('verify:dist:assert');
    expect(distParity).toContain('fetch-depth: 0');
    expect(distParity).toContain('npm run bundle');
  });

  it('aggregates gate, dist-parity, and windows in a required ready job', () => {
    expect(ready).toContain('if: always()');
    expect(ready).toContain('needs.gate.result');
    expect(ready).toContain('needs.dist-parity.result');
    expect(ready).toContain('needs.windows.result');
    expect(ready).toContain('exit 1');
    expect(ready).toContain('CI ready');
  });

  it('keeps SEA binary workflow separate from CI', () => {
    expect(ciWorkflow).not.toContain('SEA binary');
    expect(ciWorkflow).not.toContain('build-sea');
    expect(seaWorkflow).toContain('Build self-contained SEA binary');
  });
});

describe('live e2e tiering contract', () => {
  it('keeps live sandbox work off PRs and dispatches immutable releases asynchronously', () => {
    expect(existsSync(join(process.cwd(), '.github/workflows/live-e2e.yml'))).toBe(false);
    expect(releaseWorkflow).toContain('dispatch-live-monitor:');
    expect(releaseWorkflow).toContain('E2E_GATE_SUITE: smoke');
    expect(releaseWorkflow).toContain('continue-on-error: true');
    expect(releaseWorkflow).toContain('node .github/scripts/dispatch-e2e-monitor.mjs');
    expect(releaseWorkflow).not.toContain('wait-for-e2e-gate.mjs');
    expect(releaseWorkflow).not.toContain('gate_required');
  });
});
