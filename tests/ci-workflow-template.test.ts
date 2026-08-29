import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  getCiWorkflowTemplate,
  renderCiWorkflowTemplate,
  renderGcWorkflowTemplate
} from '../src/lib/ci-workflow-template.js';

type ExecPwshOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type RecordedPostmanInvocation = {
  invokeCount: number;
  thresholdArg: string;
  thresholdPair: [string, string];
};

type ExecPwshFailure = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const PWSH_PATH = process.env.PWSH_PATH?.trim() || 'pwsh';

// Per-test vitest budget for every test below that spawns real pwsh.
const PWSH_TEST_TIMEOUT_MS = 150_000;

// Nine short per-attempt execFileSync budgets for execPwsh. The generated scripts
// complete in well under 1s once spawned, but this host intermittently stalls pwsh
// process spawn for ~49-99s at roughly 15-25% of spawns (unsigned Homebrew pwsh,
// `spctl` reports `source=no usable signature`, heavy machine load). The stall is
// NOT first-spawn-only, so a `beforeAll` warmup cannot absorb it. Short attempts
// SIGKILL a stalled spawn and respawn; a fresh spawn normally completes in ~250-370ms,
// so nine short attempts make an all-attempts-stall failure vanishingly unlikely while
// still surfacing a genuinely hung script (every attempt would time out). Their sum
// is the worst-case wall clock one execPwsh call can consume and must stay strictly
// inside PWSH_TEST_TIMEOUT_MS (asserted below).
const PWSH_ATTEMPT_TIMEOUTS_MS = [5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000] as const;

// pwsh/CLR cold start can intermittently take 50-99s on an unsigned/loaded host, so
// prime the runtime once outside any per-test budget instead of charging that one-time
// process-startup cost to the first test that happens to spawn pwsh.
let pwshWarmed = false;

function warmPwsh(): void {
  if (pwshWarmed) return;
  pwshWarmed = true;
  try {
    execFileSync(
      PWSH_PATH,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output warm'],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PSModulePath: '',
          POWERSHELL_TELEMETRY_OPTOUT: '1',
          POWERSHELL_UPDATECHECK: 'Off',
          DOTNET_CLI_TELEMETRY_OPTOUT: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 180_000,
        killSignal: 'SIGKILL'
      }
    );
  } catch {
    // Cache-priming spawn only. If pwsh is missing or slow, the real tests still run
    // and still fail honestly on their own assertions.
  }
}

function execPwsh(command: string, options: ExecPwshOptions = {}): string {
  const run = (timeoutMs: number): string =>
    execFileSync(
      PWSH_PATH,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      {
        cwd: options.cwd,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          // These bodies only use built-in cmdlets, so the module search path is
          // dead weight. Pinning it empty keeps the probe hermetic: what the
          // generated script does must not depend on which modules the machine
          // running the suite happens to have installed.
          PSModulePath: '',
          POWERSHELL_TELEMETRY_OPTOUT: '1',
          POWERSHELL_UPDATECHECK: 'Off',
          DOTNET_CLI_TELEMETRY_OPTOUT: '1',
          ...options.env
        },
        // Never inherit stdin: vitest workers keep a pipe open and pwsh can block on read.
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        // Startup is warmed once in beforeAll, so these per-attempt budgets bound
        // script execution only and still catch a genuinely hung script.
        timeout: timeoutMs,
        killSignal: 'SIGKILL'
      }
    );

  let lastError: unknown;
  for (const timeoutMs of PWSH_ATTEMPT_TIMEOUTS_MS) {
    try {
      return run(timeoutMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') throw error;
      lastError = error;
    }
  }

  throw lastError;
}

beforeAll(() => {
  warmPwsh();
}, 240_000);

describe('execPwsh retry budget', () => {
  it('keeps the full pwsh attempt ladder strictly inside the per-test budget', () => {
    const ladderTotalMs = PWSH_ATTEMPT_TIMEOUTS_MS.reduce<number>((sum, ms) => sum + ms, 0);
    // Strict inequality: spawn/teardown overhead around each attempt needs real
    // headroom, so a ladder that exactly equals the budget is already a bug.
    expect(ladderTotalMs).toBeLessThan(PWSH_TEST_TIMEOUT_MS);
  });
});

function buildFakePostmanHarness(exitCode: number): string {
  return [
    '$script:RecordedPostmanArgv = @()',
    '$script:PostmanInvokeCount = 0',
    `$script:FakePostmanExitCode = ${exitCode}`,
    'function global:postman {',
    '  [CmdletBinding()]',
    '  param([Parameter(ValueFromRemainingArguments)]$RemainingArgs)',
    '  $script:RecordedPostmanArgv = @($RemainingArgs)',
    '  $script:PostmanInvokeCount++',
    '  $global:LASTEXITCODE = $script:FakePostmanExitCode',
    '}',
    ''
  ].join('\n');
}

const RECORDED_POSTMAN_OUTPUT_TAIL = [
  'Write-Output "__RECORD_BEGIN__"',
  'Write-Output "INVOKE_COUNT=$($script:PostmanInvokeCount)"',
  '$thresholdPair = @()',
  'for ($i = 0; $i -lt $script:RecordedPostmanArgv.Count; $i++) {',
  '  if ($script:RecordedPostmanArgv[$i] -eq "--env-var" -and $script:RecordedPostmanArgv[$i + 1] -like "RESPONSE_TIME_THRESHOLD=*") {',
  '    $thresholdPair = @($script:RecordedPostmanArgv[$i], $script:RecordedPostmanArgv[$i + 1])',
  '    break',
  '  }',
  '}',
  'Write-Output "THRESHOLD_ARG=$($thresholdPair[1])"',
  'Write-Output "THRESHOLD_PAIR_JSON=$($thresholdPair | ConvertTo-Json -Compress)"',
  'Write-Output "__RECORD_END__"'
].join('\n');

function parseRecordedPostmanInvocation(output: string): RecordedPostmanInvocation {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const begin = lines.indexOf('__RECORD_BEGIN__');
  const end = lines.indexOf('__RECORD_END__');
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);

  const record: Record<string, string> = {};
  for (const line of lines.slice(begin + 1, end)) {
    const separator = line.indexOf('=');
    expect(separator).toBeGreaterThan(0);
    record[line.slice(0, separator)] = line.slice(separator + 1);
  }

  const invokeCount = Number(record.INVOKE_COUNT);
  expect(Number.isFinite(invokeCount)).toBe(true);

  return {
    invokeCount,
    thresholdArg: record.THRESHOLD_ARG ?? '',
    thresholdPair: JSON.parse(record.THRESHOLD_PAIR_JSON ?? '[]') as [string, string]
  };
}

function execGeneratedWindowsRunStep(
  pwshBody: string,
  env: NodeJS.ProcessEnv,
  exitCode = 0
): RecordedPostmanInvocation {
  const agentTemp = mkdtempSync(path.join(tmpdir(), 'repo-sync-windows-agent-temp-'));
  try {
    const output = execPwsh(
      [buildFakePostmanHarness(exitCode), pwshBody, RECORDED_POSTMAN_OUTPUT_TAIL].join('\n'),
      {
        env: {
          AGENT_TEMPDIRECTORY: agentTemp,
          POSTMAN_SMOKE_COLLECTION_UID: 'smoke-uid',
          POSTMAN_CONTRACT_COLLECTION_UID: 'contract-uid',
          POSTMAN_ENVIRONMENT_UID: 'env-uid',
          ...env
        }
      }
    );
    return parseRecordedPostmanInvocation(output);
  } finally {
    rmSync(agentTemp, { recursive: true, force: true });
  }
}

function execGeneratedWindowsRunStepExpectFailure(
  pwshBody: string,
  env: NodeJS.ProcessEnv,
  exitCode: number
): ExecPwshFailure {
  const agentTemp = mkdtempSync(path.join(tmpdir(), 'repo-sync-windows-agent-temp-'));
  try {
    execPwsh(
      [buildFakePostmanHarness(exitCode), pwshBody, RECORDED_POSTMAN_OUTPUT_TAIL].join('\n'),
      {
        env: {
          AGENT_TEMPDIRECTORY: agentTemp,
          POSTMAN_SMOKE_COLLECTION_UID: 'smoke-uid',
          POSTMAN_CONTRACT_COLLECTION_UID: 'contract-uid',
          POSTMAN_ENVIRONMENT_UID: 'env-uid',
          ...env
        }
      }
    );
    throw new Error('expected generated Windows run step to fail');
  } catch (error) {
    const execError = error as Error & {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    if (execError.message === 'expected generated Windows run step to fail') {
      throw execError;
    }
    return {
      status: execError.status ?? null,
      stdout: String(execError.stdout ?? ''),
      stderr: String(execError.stderr ?? '')
    };
  } finally {
    rmSync(agentTemp, { recursive: true, force: true });
  }
}

function getWindowsSmokeAndContractSteps(): {
  smokeStep: { pwsh: string; displayName: string };
  contractStep: { pwsh: string; displayName: string };
} {
  const parsed = parse(getCiWorkflowTemplate('azure-devops', { runnerOs: 'windows' }));
  const smokeStep = parsed.steps.find(
    (step: { displayName?: string }) => step.displayName === 'Run Smoke Tests'
  );
  const contractStep = parsed.steps.find(
    (step: { displayName?: string }) => step.displayName === 'Run Contract Tests'
  );
  expect(smokeStep?.pwsh).toContain('& postman @arguments');
  expect(contractStep?.pwsh).toContain('& postman @arguments');
  return { smokeStep, contractStep };
}

describe('renderCiWorkflowTemplate', () => {
  it('keys concurrency on the resolved head branch rather than the raw merge ref', () => {
    const workflow = renderCiWorkflowTemplate();

    expect(workflow).toContain('group: postman-onboard-${{ github.head_ref || github.ref_name }}');
    expect(workflow).toContain('cancel-in-progress: false');
  });
  it('produces multi-line YAML output with real newlines', () => {
    const ciWorkflow = renderCiWorkflowTemplate();

    // Assert it's not a single-line blob
    const lines = ciWorkflow.split('\n');
    expect(lines.length).toBeGreaterThan(10);
  });

  it('does not contain literal backslash-n escape sequences', () => {
    const ciWorkflow = renderCiWorkflowTemplate();

    // The bug was .join('\\n') which produces the two-character sequence \n
    expect(ciWorkflow).not.toContain('\\n');
  });

  it('produces valid YAML that parses correctly', () => {
    const ciWorkflow = renderCiWorkflowTemplate();

    // This is the real customer-facing correctness assertion
    const parsed = parse(ciWorkflow);

    expect(parsed).toBeTypeOf('object');
    expect(parsed).toHaveProperty('name');
    expect(parsed).toHaveProperty('on');
    expect(parsed).toHaveProperty('jobs');
    expect(parsed.jobs).toHaveProperty('test');
  });

  it('includes all required workflow structure', () => {
    const ciWorkflow = renderCiWorkflowTemplate();
    const parsed = parse(ciWorkflow);

    expect(parsed.name).toBe('CI/CD Pipeline');
    expect(parsed.on).toHaveProperty('push');
    expect(parsed.on).toHaveProperty('pull_request');
    expect(parsed.on).toHaveProperty('schedule');
    expect(parsed.jobs.test).toHaveProperty('runs-on');
    expect(parsed.jobs.test).toHaveProperty('steps');
    expect(parsed.jobs.test.steps.length).toBeGreaterThan(5);
  });

  it('accepts custom postmanCliInstallUrl', () => {
    const customUrl = 'https://example.com/custom-install.sh';
    const ciWorkflow = renderCiWorkflowTemplate({
      postmanCliInstallUrl: customUrl
    });

    expect(ciWorkflow).toContain(customUrl);

    // Verify it still produces valid YAML
    const parsed = parse(ciWorkflow);
    expect(parsed).toHaveProperty('jobs');
  });

  it('uses default install URL when none provided', () => {
    const ciWorkflow = renderCiWorkflowTemplate();

    expect(ciWorkflow).toContain('https://dl-cli.pstmn.io/install/unix.sh');
  });

  it('contains expected CI steps in order', () => {
    const ciWorkflow = renderCiWorkflowTemplate();
    const parsed = parse(ciWorkflow);

    const stepNames = parsed.jobs.test.steps
      .filter((step: { name?: string }) => step.name)
      .map((step: { name: string }) => step.name);

    expect(stepNames).toContain('Install Postman CLI');
    expect(stepNames).toContain('Login to Postman CLI');
    expect(stepNames).toContain('Resolve Postman Resource IDs');
    expect(stepNames).toContain('Decode SSL certificates');
    expect(stepNames).toContain('Run Smoke Tests');
    expect(stepNames).toContain('Run Contract Tests');
  });

  it('routes install URL via env var, not shell interpolation', () => {
    const ciWorkflow = renderCiWorkflowTemplate();
    const parsed = parse(ciWorkflow);

    const installStep = parsed.jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Install Postman CLI'
    );

    expect(installStep).toBeDefined();
    expect(installStep.env).toHaveProperty('POSTMAN_CLI_INSTALL_URL');
    expect(installStep.run).toContain('$POSTMAN_CLI_INSTALL_URL');
    expect(installStep.run).not.toContain('${');
    expect(installStep.run).not.toContain('curl -o-');
    expect(installStep.run).toContain('curl -fsSL');
  });

  it('passes CI_ENVIRONMENT to Postman CLI as key=value', () => {
    const ciWorkflow = renderCiWorkflowTemplate();
    const parsed = parse(ciWorkflow);
    const runSteps = parsed.jobs.test.steps.filter((step: { name?: string }) =>
      step.name === 'Run Smoke Tests' || step.name === 'Run Contract Tests'
    );

    expect(runSteps).toHaveLength(2);
    for (const step of runSteps) {
      expect(step.env.CI_ENVIRONMENT).toBe("${{ vars.CI_ENVIRONMENT || 'Production' }}");
      expect(step.run).toContain('--env-var "CI_ENVIRONMENT=$CI_ENVIRONMENT"');
      expect(step.run).not.toContain('${{ vars.CI_ENVIRONMENT');
    }
  });

  it('rejects javascript: pseudo-protocol', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'javascript:alert(1)'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects http:// (non-https)', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'http://dl-cli.pstmn.io/install/unix.sh'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with shell metacharacters: semicolon', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'https://example.com/install.sh; rm -rf /'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with shell metacharacters: double quotes', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'https://example.com/install.sh" && rm -rf /'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with shell metacharacters: backticks', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'https://example.com/install.sh` echo pwned`'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with command substitution: $()', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'https://example.com/install.sh$(whoami)'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with pipe characters', () => {
    expect(() =>
      renderCiWorkflowTemplate({
        postmanCliInstallUrl: 'https://example.com/install.sh | cat'
      })
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('accepts valid https URLs with query parameters', () => {
    const url = 'https://cdn.example.com/path/install.sh?version=1.0&platform=linux';
    const ciWorkflow = renderCiWorkflowTemplate({
      postmanCliInstallUrl: url
    });

    const parsed = parse(ciWorkflow);
    const installStep = parsed.jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Install Postman CLI'
    );

    expect(installStep.env.POSTMAN_CLI_INSTALL_URL).toBe(url);
  });

  it('passes the configured Postman region to generated CLI login', () => {
    const ciWorkflow = renderCiWorkflowTemplate({ postmanRegion: 'eu' });
    const parsed = parse(ciWorkflow);
    const loginStep = parsed.jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Login to Postman CLI'
    );

    expect(loginStep.env.POSTMAN_API_KEY).toBe('${{ secrets.POSTMAN_API_KEY }}');
    expect(loginStep.run).toContain('postman login --with-api-key "$POSTMAN_API_KEY"');
    expect(loginStep.run).toContain('--region eu');
    expect(loginStep.run).not.toContain('${{ secrets.POSTMAN_API_KEY }}');

    const usWorkflow = renderCiWorkflowTemplate({ postmanRegion: 'us' });
    const usLogin = parse(usWorkflow).jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Login to Postman CLI'
    );
    // us is the CLI default and `--region us` is rejected by the Postman CLI, so the
    // generated login omits the flag for us.
    expect(usLogin.run).toContain('postman login --with-api-key "$POSTMAN_API_KEY"');
    expect(usLogin.run).not.toContain('--region');
    expect(usLogin.env.POSTMAN_API_KEY).toBe('${{ secrets.POSTMAN_API_KEY }}');

    expect(() => renderCiWorkflowTemplate({ postmanRegion: 'ap' })).toThrow(/postman-region/);
  });

  it('renders valid Azure DevOps YAML when requested', () => {
    const ciWorkflow = getCiWorkflowTemplate('azure-devops');
    const parsed = parse(ciWorkflow);

    expect(parsed.name).toBeUndefined();
    expect(parsed.trigger.branches.include).toContain('main');
    expect(parsed.schedules[0].always).toBe(true);
    expect(parsed.pool.vmImage).toBe('ubuntu-latest');
    expect(parsed.steps[0]).toMatchObject({
      checkout: 'self',
      persistCredentials: true
    });
    expect(ciWorkflow).toContain('--env-var "CI_ENVIRONMENT=${CI_ENVIRONMENT:-Production}"');
    const decodeStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Decode SSL certificates'
    );
    const smokeStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Run Smoke Tests'
    );
    const contractStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Run Contract Tests'
    );
    const azureScriptBodies = parsed.steps
      .map((step: { script?: string }) => step.script)
      .filter(Boolean)
      .join('\n');
    expect(decodeStep.script).toContain(
      'normalize_azure_optional_var POSTMAN_SSL_EXTRA_CA_CERTS_B64'
    );
    expect(smokeStep.script).toContain('normalize_azure_optional_var CI_ENVIRONMENT');
    expect(smokeStep.script).toContain(
      'normalize_azure_optional_var POSTMAN_SSL_CLIENT_PASSPHRASE'
    );
    expect(contractStep.script).toContain('normalize_azure_optional_var CI_ENVIRONMENT');
    expect(contractStep.script).toContain(
      'normalize_azure_optional_var POSTMAN_SSL_CLIENT_PASSPHRASE'
    );
    expect(smokeStep.script).toContain('postman collection run "$POSTMAN_SMOKE_COLLECTION_UID"');
    expect(smokeStep.script).toContain('-e "$POSTMAN_ENVIRONMENT_UID"');
    expect(contractStep.script).toContain(
      'postman collection run "$POSTMAN_CONTRACT_COLLECTION_UID"'
    );
    expect(contractStep.script).toContain('-e "$POSTMAN_ENVIRONMENT_UID"');
    expect(azureScriptBodies).not.toContain('$(POSTMAN_SSL_EXTRA_CA_CERTS_B64)');
    expect(azureScriptBodies).not.toContain('$(POSTMAN_SSL_CLIENT_PASSPHRASE)');
    expect(azureScriptBodies).not.toContain('$(CI_ENVIRONMENT)');
    expect(azureScriptBodies).not.toContain('$(POSTMAN_SMOKE_COLLECTION_UID)');
    expect(azureScriptBodies).not.toContain('$(POSTMAN_CONTRACT_COLLECTION_UID)');
    expect(azureScriptBodies).not.toContain('$(POSTMAN_ENVIRONMENT_UID)');
  });

  it('renders a native PowerShell Azure DevOps workflow for Windows runners', () => {
    const ciWorkflow = getCiWorkflowTemplate('azure-devops', {
      postmanCliWindowsInstallUrl: 'https://dl-cli.pstmn.io/install/win64.ps1',
      runnerOs: 'windows'
    });
    const parsed = parse(ciWorkflow);

    expect(parsed.pool.vmImage).toBe('windows-latest');
    expect(parsed.steps[0]).toMatchObject({
      checkout: 'self',
      persistCredentials: true
    });
    expect(parsed.steps.every((step: { script?: string }) => step.script === undefined)).toBe(true);

    const installStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Install Postman CLI'
    );
    const resolveStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Resolve Postman Resource IDs'
    );
    const decodeStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Decode SSL certificates'
    );
    const smokeStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Run Smoke Tests'
    );

    expect(installStep.env.POSTMAN_CLI_INSTALL_URL).toBe(
      'https://dl-cli.pstmn.io/install/win64.ps1'
    );
    expect(installStep.pwsh).toContain('DownloadString($env:POSTMAN_CLI_INSTALL_URL)');
    expect(resolveStep.pwsh).toContain('##vso[task.setvariable variable=POSTMAN_SMOKE_COLLECTION_UID]');
    expect(decodeStep.pwsh).toContain('[Convert]::FromBase64String');
    expect(smokeStep.pwsh).toContain("$arguments = @('collection', 'run'");
    expect(smokeStep.pwsh).toContain('& postman @arguments');
    expect(ciWorkflow).not.toMatch(/grep |awk |base64 -d|\[\[|CMD=\(|curl -fsSL/);
  });

  it.skipIf(process.platform === 'win32')('normalizes unresolved Azure optional macro values without clearing real values', () => {
    execFileSync('bash', [
      '-lc',
      `
set -euo pipefail
normalize_azure_optional_var() {
  local name="$1"
  local value="\${!name:-}"
  local unresolved_prefix='$'
  unresolved_prefix="\${unresolved_prefix}("
  if [[ "$value" == "$unresolved_prefix"*")" ]]; then
    printf -v "$name" %s ""
  fi
}

CI_ENVIRONMENT='$''(CI_ENVIRONMENT)'
normalize_azure_optional_var CI_ENVIRONMENT
[ -z "$CI_ENVIRONMENT" ]

POSTMAN_SSL_CLIENT_PASSPHRASE='real passphrase'
normalize_azure_optional_var POSTMAN_SSL_CLIENT_PASSPHRASE
[ "$POSTMAN_SSL_CLIENT_PASSPHRASE" = 'real passphrase' ]
`
    ]);
  });

  it('passes the configured Postman region to Azure DevOps CLI login', () => {
    const ciWorkflow = getCiWorkflowTemplate('azure-devops', { postmanRegion: 'eu' });
    const parsed = parse(ciWorkflow);
    const loginStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Login to Postman CLI'
    );

    expect(loginStep.script).toBe('postman login --with-api-key "$POSTMAN_API_KEY" --region eu');

    const usWorkflow = getCiWorkflowTemplate('azure-devops', { postmanRegion: 'us' });
    const usLogin = parse(usWorkflow).steps.find(
      (step: { displayName?: string }) => step.displayName === 'Login to Postman CLI'
    );

    expect(usLogin.script).toBe('postman login --with-api-key "$POSTMAN_API_KEY"');
    expect(() => getCiWorkflowTemplate('azure-devops', { postmanRegion: 'ap' })).toThrow(
      /postman-region/
    );
  });

  it('rejects unsupported runner operating systems', () => {
    expect(() =>
      getCiWorkflowTemplate('azure-devops', {
        runnerOs: 'solaris' as 'linux'
      })
    ).toThrow(/ci-runner-os/);
  });

  it('does not forward RESPONSE_TIME_THRESHOLD on GitHub Actions (Linux uses seeded 2000)', () => {
    const ciWorkflow = renderCiWorkflowTemplate();

    expect(ciWorkflow).not.toContain('RESPONSE_TIME_THRESHOLD');
  });

  it('does not forward RESPONSE_TIME_THRESHOLD on Azure DevOps Linux runners', () => {
    const ciWorkflow = getCiWorkflowTemplate('azure-devops');

    expect(ciWorkflow).not.toContain('RESPONSE_TIME_THRESHOLD');
  });

  it('forwards RESPONSE_TIME_THRESHOLD with a 10000 default on Windows smoke and contract steps', () => {
    const ciWorkflow = getCiWorkflowTemplate('azure-devops', { runnerOs: 'windows' });
    const parsed = parse(ciWorkflow);
    const smokeStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Run Smoke Tests'
    );
    const contractStep = parsed.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Run Contract Tests'
    );

    for (const step of [smokeStep, contractStep]) {
      expect(step.pwsh).toContain(
        '$responseTimeThreshold = Resolve-AdoOptional $env:RESPONSE_TIME_THRESHOLD'
      );
      expect(step.pwsh).toContain(
        "if ([string]::IsNullOrWhiteSpace($responseTimeThreshold)) { $responseTimeThreshold = '10000' }"
      );
      expect(step.pwsh).toContain(
        "'--env-var', \"RESPONSE_TIME_THRESHOLD=$responseTimeThreshold\""
      );
      expect(step.env.RESPONSE_TIME_THRESHOLD).toBe('$(RESPONSE_TIME_THRESHOLD)');
    }
  });

  describe.sequential('PowerShell Azure DevOps execution', () => {
    it('executes the generated PowerShell resource resolver against the canonical manifest', { timeout: PWSH_TEST_TIMEOUT_MS }, () => {
      const parsed = parse(
        getCiWorkflowTemplate('azure-devops', {
          runnerOs: 'windows'
        })
      );
      const resolveStep = parsed.steps.find(
        (step: { displayName?: string }) => step.displayName === 'Resolve Postman Resource IDs'
      );
      const sandbox = mkdtempSync(path.join(tmpdir(), 'repo-sync-windows-resources-'));
      try {
        mkdirSync(path.join(sandbox, '.postman'), { recursive: true });
        writeFileSync(
          path.join(sandbox, '.postman', 'resources.yaml'),
          [
            'version: 2',
            'canonical:',
            '  collections:',
            '    ../postman/collections/[Smoke] Core: smoke-uid',
            '    ../postman/collections/[Contract] Core: contract-uid',
            '  environments:',
            '    ../postman/environments/prod.postman_environment.json: env-uid',
            ''
          ].join('\n'),
          'utf8'
        );

        const output = execPwsh(resolveStep.pwsh, { cwd: sandbox });
        expect(output).toContain(
          '##vso[task.setvariable variable=POSTMAN_SMOKE_COLLECTION_UID]smoke-uid'
        );
        expect(output).toContain(
          '##vso[task.setvariable variable=POSTMAN_CONTRACT_COLLECTION_UID]contract-uid'
        );
        expect(output).toContain(
          '##vso[task.setvariable variable=POSTMAN_ENVIRONMENT_UID]env-uid'
        );
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it('forwards RESPONSE_TIME_THRESHOLD through the full generated Smoke pwsh body', { timeout: PWSH_TEST_TIMEOUT_MS }, () => {
      const { smokeStep, contractStep } = getWindowsSmokeAndContractSteps();
      // Contract step uses the same Resolve-AdoOptional threshold wiring; keep
      // one real pwsh boundary on Smoke and scale the rest via template parity.
      expect(contractStep.pwsh).toContain(
        '$responseTimeThreshold = Resolve-AdoOptional $env:RESPONSE_TIME_THRESHOLD'
      );
      expect(contractStep.pwsh).toContain(
        "if ([string]::IsNullOrWhiteSpace($responseTimeThreshold)) { $responseTimeThreshold = '10000' }"
      );
      const sharedEnv = {
        CI_ENVIRONMENT: '$(CI_ENVIRONMENT)',
        POSTMAN_SSL_CLIENT_PASSPHRASE: '$(POSTMAN_SSL_CLIENT_PASSPHRASE)'
      };

      const unresolved = execGeneratedWindowsRunStep(smokeStep.pwsh, {
        ...sharedEnv,
        RESPONSE_TIME_THRESHOLD: '$(RESPONSE_TIME_THRESHOLD)'
      });
      expect(unresolved.invokeCount).toBe(1);
      expect(unresolved.thresholdArg).toBe('RESPONSE_TIME_THRESHOLD=10000');
      expect(unresolved.thresholdPair).toEqual(['--env-var', 'RESPONSE_TIME_THRESHOLD=10000']);

      const blank = execGeneratedWindowsRunStep(smokeStep.pwsh, {
        ...sharedEnv,
        RESPONSE_TIME_THRESHOLD: ''
      });
      expect(blank.invokeCount).toBe(1);
      expect(blank.thresholdArg).toBe('RESPONSE_TIME_THRESHOLD=10000');

      const explicit = execGeneratedWindowsRunStep(smokeStep.pwsh, {
        ...sharedEnv,
        CI_ENVIRONMENT: 'Staging',
        RESPONSE_TIME_THRESHOLD: '5000'
      });
      expect(explicit.invokeCount).toBe(1);
      expect(explicit.thresholdArg).toBe('RESPONSE_TIME_THRESHOLD=5000');
      expect(explicit.thresholdPair).toEqual(['--env-var', 'RESPONSE_TIME_THRESHOLD=5000']);
    });

    it('keeps RESPONSE_TIME_THRESHOLD as one argv element through & postman @arguments for metacharacter values', { timeout: PWSH_TEST_TIMEOUT_MS }, () => {
      const { smokeStep, contractStep } = getWindowsSmokeAndContractSteps();
      expect(contractStep.pwsh).toContain(
        "'--env-var', \"RESPONSE_TIME_THRESHOLD=$responseTimeThreshold\""
      );
      const cases: Array<{ label: string; envValue: string; expectedArg: string }> = [
        {
          label: 'space',
          envValue: '10000 with space',
          expectedArg: 'RESPONSE_TIME_THRESHOLD=10000 with space'
        },
        { label: 'quote', envValue: '10"00', expectedArg: 'RESPONSE_TIME_THRESHOLD=10"00' }
      ];

      for (const testCase of cases) {
        const recorded = execGeneratedWindowsRunStep(smokeStep.pwsh, {
          CI_ENVIRONMENT: '$(CI_ENVIRONMENT)',
          POSTMAN_SSL_CLIENT_PASSPHRASE: '$(POSTMAN_SSL_CLIENT_PASSPHRASE)',
          RESPONSE_TIME_THRESHOLD: testCase.envValue
        });
        expect(recorded.invokeCount, testCase.label).toBe(1);
        expect(recorded.thresholdArg, testCase.label).toBe(testCase.expectedArg);
        expect(recorded.thresholdPair, testCase.label).toEqual(['--env-var', testCase.expectedArg]);
      }
    });

    it('fails the full generated Smoke pwsh body when postman exits non-zero', { timeout: PWSH_TEST_TIMEOUT_MS }, () => {
      const { smokeStep, contractStep } = getWindowsSmokeAndContractSteps();
      expect(contractStep.pwsh).toContain('failed with exit code');
      const sharedEnv = {
        CI_ENVIRONMENT: 'Production',
        RESPONSE_TIME_THRESHOLD: '5000',
        POSTMAN_SSL_CLIENT_PASSPHRASE: '$(POSTMAN_SSL_CLIENT_PASSPHRASE)'
      };

      const failure = execGeneratedWindowsRunStepExpectFailure(smokeStep.pwsh, sharedEnv, 17);
      const combined = `${failure.stdout}\n${failure.stderr}`;
      expect(failure.status).not.toBe(0);
      expect(combined).toContain(`${smokeStep.displayName} failed with exit code 17`);
    });
  });
});

describe('renderGcWorkflowTemplate', () => {
  it('emits a dedicated marker-guarded GitHub GC workflow with lifecycle triggers', () => {
    const workflow = renderGcWorkflowTemplate();

    expect(parse(workflow)).toMatchObject({ name: 'Postman Preview GC' });
    expect(workflow).toContain('delete:');
    expect(workflow).toContain('types: [closed]');
    expect(workflow).toContain('cron: "0 2 * * *"');
    expect(workflow).toContain('cli.cjs gc');
    expect(workflow).toContain('gc-summary-json');
  });
});

describe('private mock runtime credential wiring', () => {
  const VARIABLE = 'postmanPrivateMockApiKey';

  it('omits the private-mock variable from every generated workflow by default', () => {
    const workflows = [
      renderCiWorkflowTemplate(),
      getCiWorkflowTemplate('azure-devops', {}),
      getCiWorkflowTemplate('azure-devops', { runnerOs: 'windows' })
    ];

    for (const workflow of workflows) {
      expect(workflow).not.toContain(VARIABLE);
    }
  });

  it('forwards the CI Postman API key secret to both GitHub run steps for a private mock', () => {
    const workflow = renderCiWorkflowTemplate({ privateMockAuth: true });
    const parsed = parse(workflow);
    const smokeStep = parsed.jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Run Smoke Tests'
    );
    const contractStep = parsed.jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Run Contract Tests'
    );
    const loginStep = parsed.jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Login to Postman CLI'
    );
    const injected = workflow.split('\n').filter((line) => line.includes(VARIABLE));

    // Smoke and contract, and no more.
    expect(injected).toHaveLength(2);
    for (const line of injected) {
      expect(line).toContain('--env-var');
      expect(line).toContain('$POSTMAN_API_KEY');
      expect(line).not.toContain('${{ secrets.POSTMAN_API_KEY }}');
    }

    expect(loginStep.env.POSTMAN_API_KEY).toBe('${{ secrets.POSTMAN_API_KEY }}');
    expect(loginStep.run).toContain('"$POSTMAN_API_KEY"');
    expect(loginStep.run).not.toContain('${{ secrets.POSTMAN_API_KEY }}');

    for (const step of [smokeStep, contractStep]) {
      expect(step.env.POSTMAN_API_KEY).toBe('${{ secrets.POSTMAN_API_KEY }}');
      expect(step.run).toContain(VARIABLE + '=$POSTMAN_API_KEY');
      expect(step.run).not.toContain('${{ secrets.POSTMAN_API_KEY }}');
    }

    const secretEnvMaps = workflow
      .split('\n')
      .filter((line) => line.trim() === 'POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}');
    // Login plus one per run step.
    expect(secretEnvMaps).toHaveLength(3);
    expect(parse(workflow)).toBeTruthy();
  });

  it('maps the secret into the step environment for Azure DevOps bash runs', () => {
    const workflow = getCiWorkflowTemplate('azure-devops', { privateMockAuth: true });
    const injected = workflow.split('\n').filter((line) => line.includes(VARIABLE));

    expect(injected).toHaveLength(2);
    for (const line of injected) {
      // ADO does not auto-map secret variables into the script environment, so the
      // step must reference the shell variable it explicitly mapped.
      expect(line).toContain('$POSTMAN_API_KEY');
      expect(line).not.toContain('$(POSTMAN_API_KEY)');
    }
    const envMaps = workflow
      .split('\n')
      .filter((line) => line.trim() === 'POSTMAN_API_KEY: $(POSTMAN_API_KEY)');
    // One per run step, plus the pre-existing login step.
    expect(envMaps.length).toBeGreaterThanOrEqual(3);
    expect(parse(workflow)).toBeTruthy();
  });

  it('appends the variable to the PowerShell argument array on the Windows agent', () => {
    const workflow = getCiWorkflowTemplate('azure-devops', {
      runnerOs: 'windows',
      privateMockAuth: true
    });
    const injected = workflow.split('\n').filter((line) => line.includes(VARIABLE));

    expect(injected).toHaveLength(2);
    for (const line of injected) {
      expect(line).toContain('$arguments += @(');
      expect(line).toContain('$env:POSTMAN_API_KEY');
    }
    expect(parse(workflow)).toBeTruthy();
  });

  it('never writes a literal credential into a generated workflow', () => {
    const workflow = renderCiWorkflowTemplate({ privateMockAuth: true });

    expect(workflow).not.toContain('PMAK-');
  });

  it.skipIf(process.platform === 'win32')(
    'keeps POSTMAN_API_KEY as a single Bash argv element for shell metacharacters',
    () => {
      const fakeSecret = 'PMAK-spaces "quotes" $(whoami) $HOME';
      const workflow = renderCiWorkflowTemplate({ privateMockAuth: true });
      const mockCmdLine = workflow
        .split('\n')
        .find((line) => line.includes(`CMD+=(--env-var "${VARIABLE}=`));
      const expectedArg = `${VARIABLE}=${fakeSecret}`;

      expect(mockCmdLine).toBeDefined();
      expect(workflow).not.toContain(fakeSecret);
      expect(workflow).toContain('POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}');

      const snippet = [
        'CMD=(postman collection run smoke -e env)',
        mockCmdLine!.trim(),
        'for ((i=0; i<${#CMD[@]}; i++)); do',
        '  if [[ "${CMD[i]}" == "--env-var" && "${CMD[i+1]}" == *"' + VARIABLE + '="* ]]; then',
        '    echo "${CMD[i+1]}"',
        '    printf \'%s\\0\' "${CMD[i]}" "${CMD[i+1]}" | od -An -tx1',
        '  fi',
        'done',
        'touch /tmp/repo-sync-bash-injection-marker 2>/dev/null || true',
        'if [ -f /tmp/repo-sync-bash-injection-marker ]; then rm -f /tmp/repo-sync-bash-injection-marker; fi'
      ].join('\n');

      const output = execFileSync('bash', ['-lc', snippet], {
        env: {
          ...process.env,
          POSTMAN_API_KEY: fakeSecret
        },
        encoding: 'utf8'
      }).trim();

      const [argLine, hexDump] = output.split('\n');
      expect(argLine).toBe(expectedArg);
      // od output proves exactly two argv elements: --env-var and the key=value pair.
      expect(hexDump.replace(/\s+/g, ' ').trim()).toContain(
        '2d 2d 65 6e 76 2d 76 61 72 00'
      );
    }
  );
});
