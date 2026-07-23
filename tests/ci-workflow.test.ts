import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const seaWorkflow = readFileSync(join(process.cwd(), '.github/workflows/sea-binary.yml'), 'utf8');

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

/** Ordered Windows gate names from `@{ Name = '...'; Command = { ... } }` entries. */
function windowsQueuedGates(runGates: string): string[] {
  return [...runGates.matchAll(/@\{ Name = '([^']+)'; Command = \{/g)].map((m) => m[1]!);
}

/** Exact Windows `Run gates` PowerShell body under `run: |`, with YAML indent stripped. */
function extractWindowsRunGatesBody(source: string): string {
  const windowsJob = jobText(source, 'windows');
  const match = windowsJob.match(/ {6}- name: Run gates\n {8}shell: pwsh\n {8}run: \|\n([\s\S]*)$/);
  if (!match?.[1]) {
    throw new Error('Windows Run gates pwsh body not found');
  }
  return match[1]
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

/** Cross-platform fake `npm` (POSIX executable / Windows `npm.cmd`) that never shells out to real npm. */
function installFakeNpm(binDir: string, exits: Record<string, number>): void {
  const exitsJson = JSON.stringify(exits);
  const nodeBody = `#!/usr/bin/env node
const exits = ${exitsJson};
const args = process.argv.slice(2);
let key;
if (args[0] === 'test') key = 'test';
else if (args[0] === 'run' && args[1]) key = args[1];
else {
  console.error('fake-npm: unexpected args', args.join(' '));
  process.exit(99);
}
const code = exits[key];
if (typeof code !== 'number') {
  console.error('fake-npm: unmapped command', key);
  process.exit(99);
}
process.exit(code);
`;

  if (process.platform === 'win32') {
    const jsPath = join(binDir, 'npm.js');
    writeFileSync(jsPath, nodeBody.replace(/^#!.*\n/, ''), 'utf8');
    writeFileSync(join(binDir, 'npm.cmd'), `@echo off\r\nnode "%~dp0npm.js" %*\r\n`, 'utf8');
  } else {
    const npmPath = join(binDir, 'npm');
    writeFileSync(npmPath, nodeBody, 'utf8');
    chmodSync(npmPath, 0o755);
  }
}

function runWindowsGatesScript(script: string, exits: Record<string, number>) {
  const root = mkdtempSync(join(tmpdir(), 'repo-sync-ci-windows-gates-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  installFakeNpm(binDir, exits);
  writeFileSync(join(root, 'run-gates.ps1'), `${script}\n`, 'utf8');

  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', 'run-gates.ps1'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { result, output, root };
}

const linux = jobText(ciWorkflow, 'gate');
const windows = jobText(ciWorkflow, 'windows');

describe('CI and SEA PR workflow contracts', () => {
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

  it('checks out full history on Linux for commitlint and keeps Windows shallow', () => {
    expect(linux).toContain('fetch-depth: 0');
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);
    expect(windows).not.toContain('fetch-depth: 0');
    expect(windows).not.toContain('commitlint');
  });

  it('bundles exactly once on Linux and Windows before each read-only queue', () => {
    expect(linux.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(windows.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);

    expect(linux.indexOf('- run: npm run bundle')).toBeLessThan(linux.indexOf('- name: Run gates'));
    expect(windows.indexOf('- run: npm run bundle')).toBeLessThan(windows.indexOf('- name: Run gates'));

    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');
    expect(ciWorkflow).not.toMatch(/^\s*- run: npm run build\s*$/m);
    expect(ciWorkflow.match(/npm run typecheck/g) ?? []).toHaveLength(2);
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
      'dist',
      'actionlint',
      'commitlint',
    ]);
    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run dist       npm run verify:dist:assert');
    expect(runGates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    // Queue stays read-only: no mutating build / bundle / bare verify:dist / rm inside the fan-out.
    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toContain('npm run bundle');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).not.toContain('rm -rf dist');
    expect(runGates).not.toMatch(/\brm\b/);
    expect(runGates).not.toMatch(/run dist\s+git diff --ignore-space-at-eol --text --exit-code -- dist/);

    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
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

  it('queues exactly four Windows gates at max-two with terminating throw failure propagation', () => {
    const runGates = namedStep(windows, 'Run gates');
    expect(runGates.length).toBeGreaterThan(0);
    expect(runGates).toContain('shell: pwsh');
    expect(runGates).toContain("$ErrorActionPreference = 'Stop'");
    expect(runGates).toContain('$MAX_PARALLEL_GATES = 2');
    expect(runGates).toContain('while ($running.Count -ge $MAX_PARALLEL_GATES)');
    expect(runGates).toContain('Start-Job');

    expect(windowsQueuedGates(runGates)).toEqual(['lint', 'test', 'typecheck', 'dist']);
    expect(runGates).toContain(
      "@{ Name = 'lint'; Command = { npm run lint; if ($LASTEXITCODE -ne 0) { throw \"gate:lint failed with exit code $LASTEXITCODE\" } } }",
    );
    expect(runGates).toContain(
      "@{ Name = 'test'; Command = { npm test; if ($LASTEXITCODE -ne 0) { throw \"gate:test failed with exit code $LASTEXITCODE\" } } }",
    );
    expect(runGates).toContain(
      "@{ Name = 'typecheck'; Command = { npm run typecheck; if ($LASTEXITCODE -ne 0) { throw \"gate:typecheck failed with exit code $LASTEXITCODE\" } } }",
    );
    expect(runGates).toContain(
      "@{ Name = 'dist'; Command = { npm run verify:dist:assert; if ($LASTEXITCODE -ne 0) { throw \"gate:dist failed with exit code $LASTEXITCODE\" } } }",
    );

    // Nonzero child must throw so Start-Job State becomes Failed; bare exit keeps Completed.
    expect(runGates).not.toContain('exit $LASTEXITCODE');
    expect(runGates).not.toMatch(/if \(\$LASTEXITCODE -ne 0\) \{ exit /);
    // Receive-Job under Stop would abort aggregation; Continue + 2>&1 keeps error text in the log.
    expect(runGates).toContain('Receive-Job $done -ErrorAction Continue 2>&1 | Out-File');
    expect(runGates).toContain('Receive-Job $job -ErrorAction Continue 2>&1 | Out-File');
    expect(runGates).toContain("$results[$done.Name] = $done.State -eq 'Completed'");
    expect(runGates).toContain("$results[$job.Name] = $job.State -eq 'Completed'");

    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toContain('npm run bundle');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).not.toContain('actionlint');
    expect(runGates).not.toContain('commitlint');

    expect(runGates).toContain('gate:$name=pass');
    expect(runGates).toContain('gate:$name=fail');
    expect(runGates).toContain('if ($failed) { exit 1 }');
  });

  it('keeps upload-on-dist-failure on the Linux gate job', () => {
    const upload = namedStep(linux, 'Upload expected dist on mismatch');
    expect(upload.length).toBeGreaterThan(0);
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('uses: actions/upload-artifact@v7');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
  });

  it(
    'executes the Windows Run gates body with fake npm and propagates nonzero as process failure',
    () => {
      const script = extractWindowsRunGatesBody(ciWorkflow);
      expect(script).toContain("$ErrorActionPreference = 'Stop'");
      expect(script).toContain('throw "gate:lint failed with exit code $LASTEXITCODE"');
      expect(script).toContain('Receive-Job $done -ErrorAction Continue 2>&1 | Out-File');
      expect(script).toContain('Receive-Job $job -ErrorAction Continue 2>&1 | Out-File');
      expect(script).not.toContain('exit $LASTEXITCODE');

      const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        encoding: 'utf8',
      });
      const probeError = probe.error as NodeJS.ErrnoException | undefined;
      expect(probeError, `${probe.stderr ?? ''}`).toBeUndefined();

      const zeroExits = {
        lint: 0,
        test: 0,
        typecheck: 0,
        'verify:dist:assert': 0,
      };
      const failLintExits = {
        lint: 9,
        test: 0,
        typecheck: 0,
        'verify:dist:assert': 0,
      };

      let passRoot: string | undefined;
      let failRoot: string | undefined;
      try {
        // Exact extracted body already sets Stop; run as-is (runner-style fail-fast).
        const pass = runWindowsGatesScript(script, zeroExits);
        passRoot = pass.root;
        expect(pass.result.error, pass.output).toBeUndefined();
        expect(pass.result.signal, pass.output).toBeNull();
        expect(pass.result.status, pass.output).toBe(0);
        expect(pass.output).toContain('gate:lint=pass');
        expect(pass.output).toContain('gate:test=pass');
        expect(pass.output).toContain('gate:typecheck=pass');
        expect(pass.output).toContain('gate:dist=pass');

        const fail = runWindowsGatesScript(script, failLintExits);
        failRoot = fail.root;
        expect(fail.result.error, fail.output).toBeUndefined();
        expect(fail.result.signal, fail.output).toBeNull();
        expect(fail.result.status, fail.output).not.toBe(0);
        expect(fail.output).toContain('gate:lint=fail');
        expect(fail.output).toMatch(/gate:test=(?:pass|fail)/);
        expect(fail.output).toMatch(/gate:typecheck=(?:pass|fail)/);
        expect(fail.output).toMatch(/gate:dist=(?:pass|fail)/);
        expect(fail.output).toContain('gate:test=pass');
        expect(fail.output).toContain('gate:typecheck=pass');
        expect(fail.output).toContain('gate:dist=pass');
        // Aggregation completed under Stop: gate-specific throw text is in the lint group log.
        expect(fail.output).toContain('gate:lint failed with exit code 9');
        expect(fail.output).toContain('::group::lint');
        expect(fail.output).toContain('::endgroup::');
      } finally {
        if (passRoot) rmSync(passRoot, { recursive: true, force: true });
        if (failRoot) rmSync(failRoot, { recursive: true, force: true });
      }
    },
    90_000,
  );
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
