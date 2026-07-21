import { POSTMAN_ENDPOINT_PROFILES } from './postman/base-urls.js';
import type { GitProvider } from './repo/context.js';

export const DEFAULT_POSTMAN_CLI_INSTALL_URL = POSTMAN_ENDPOINT_PROFILES.prod.cliInstallUrl;
export const DEFAULT_POSTMAN_CLI_WINDOWS_INSTALL_URL =
  POSTMAN_ENDPOINT_PROFILES.prod.cliWindowsInstallUrl;

export type CiRunnerOs = 'linux' | 'windows';

type CiWorkflowTemplateOptions = {
  postmanCliInstallUrl?: string;
  postmanCliWindowsInstallUrl?: string;
  postmanRegion?: string;
  runnerOs?: CiRunnerOs;
};

function validateHttpsInstallUrl(url: string): string {
  const safeUrlPattern = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~/?=&%-]+$/;
  if (!safeUrlPattern.test(url)) {
    throw new Error(
      `postman-cli-install-url must be an https URL with safe characters; got: ${url}`
    );
  }
  return url;
}

function resolvePostmanRegion(postmanRegionOption: string | undefined): string {
  const postmanRegion = String(postmanRegionOption || '').trim() || 'us';
  if (!['us', 'eu'].includes(postmanRegion)) {
    throw new Error('postman-region must be one of: us, eu; got: ' + postmanRegion);
  }
  return postmanRegion;
}

function resolveCiRunnerOs(runnerOsOption: string | undefined): CiRunnerOs {
  const runnerOs = String(runnerOsOption || '').trim() || 'linux';
  if (runnerOs === 'linux' || runnerOs === 'windows') {
    return runnerOs;
  }
  throw new Error('ci-runner-os must be one of: linux, windows; got: ' + runnerOs);
}

export function renderCiWorkflowTemplate(options: CiWorkflowTemplateOptions = {}): string {
  const runnerOs = resolveCiRunnerOs(options.runnerOs);
  if (runnerOs === 'windows') {
    throw new Error('ci-runner-os=windows is currently supported for azure-devops workflows only');
  }
  const rawUrl =
    String(options.postmanCliInstallUrl || '').trim() || DEFAULT_POSTMAN_CLI_INSTALL_URL;
  const installUrl = validateHttpsInstallUrl(rawUrl);
  const postmanRegion = resolvePostmanRegion(options.postmanRegion);
  return buildCiWorkflowLines(installUrl, postmanRegion).join('\n');
}

function buildCiWorkflowLines(installUrl: string, postmanRegion: string): string[] {
  return [
  'name: CI/CD Pipeline',
  'on:',
  '  push:',
  '    branches: [main]',
  '  pull_request:',
  '    branches: [main]',
  '  schedule:',
  '    - cron: "0 */6 * * *"',
  'concurrency:',
  '  group: postman-onboard-${{ github.head_ref || github.ref_name }}',
  '  cancel-in-progress: false',
  'jobs:',
  '  test:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '      - name: Install Postman CLI',
  '        env:',
  `          POSTMAN_CLI_INSTALL_URL: ${installUrl}`,
  '        run: curl -fsSL "$POSTMAN_CLI_INSTALL_URL" | sh',
  '      - name: Login to Postman CLI',
  '        run: postman login --with-api-key ${{ secrets.POSTMAN_API_KEY }}' +
    (postmanRegion === 'eu' ? ' --region eu' : ''),
  '      - name: Resolve Postman Resource IDs',
  '        run: |',
  '          ruby <<\'RUBY\'',
  "          require 'yaml'",
  "          config = YAML.load_file('.postman/resources.yaml') || {}",
  "          cloud = config.fetch('canonical', config.fetch('cloudResources', {}))",
  "          collections = cloud.fetch('collections', {})",
  "          environments = cloud.fetch('environments', {})",
  "          smoke = collections.find { |path, _| path.include?('[Smoke]') }&.last",
  "          contract = collections.find { |path, _| path.include?('[Contract]') }&.last",
  "          environment = environments.find { |path, _| path.end_with?('/prod.postman_environment.json') }&.last || environments.values.first",
  "          missing = []",
  "          missing << 'smoke collection' unless smoke",
  "          missing << 'contract collection' unless contract",
  "          missing << 'environment' unless environment",
  "          abort(\"Missing Postman resource IDs in .postman/resources.yaml: #{missing.join(', ')}\") unless missing.empty?",
  "          File.open(ENV.fetch('GITHUB_ENV'), 'a') do |file|",
  "            file.puts(\"POSTMAN_SMOKE_COLLECTION_UID=#{smoke}\")",
  "            file.puts(\"POSTMAN_CONTRACT_COLLECTION_UID=#{contract}\")",
  "            file.puts(\"POSTMAN_ENVIRONMENT_UID=#{environment}\")",
  "          end",
  '          RUBY',
  '      - name: Decode SSL certificates',
  "        if: ${{ secrets.POSTMAN_SSL_CLIENT_CERT_B64 != '' }}",
  '        env:',
  '          POSTMAN_SSL_CLIENT_CERT_B64: ${{ secrets.POSTMAN_SSL_CLIENT_CERT_B64 }}',
  '          POSTMAN_SSL_CLIENT_KEY_B64: ${{ secrets.POSTMAN_SSL_CLIENT_KEY_B64 }}',
  '          POSTMAN_SSL_EXTRA_CA_CERTS_B64: ${{ secrets.POSTMAN_SSL_EXTRA_CA_CERTS_B64 }}',
  '        run: |',
  '          mkdir -p "$RUNNER_TEMP/postman-ssl"',
  '          printf %s "$POSTMAN_SSL_CLIENT_CERT_B64" | base64 -d > "$RUNNER_TEMP/postman-ssl/client.crt"',
  '          printf %s "$POSTMAN_SSL_CLIENT_KEY_B64" | base64 -d > "$RUNNER_TEMP/postman-ssl/client.key"',
  '          if [ -n "$POSTMAN_SSL_EXTRA_CA_CERTS_B64" ]; then',
  '            printf %s "$POSTMAN_SSL_EXTRA_CA_CERTS_B64" | base64 -d > "$RUNNER_TEMP/postman-ssl/ca.crt"',
  '          fi',
  '      - name: Run Smoke Tests',
  '        env:',
  '          POSTMAN_SSL_CLIENT_PASSPHRASE: ${{ secrets.POSTMAN_SSL_CLIENT_PASSPHRASE }}',
  '        run: |',
  '          CMD=(postman collection run "$POSTMAN_SMOKE_COLLECTION_UID"',
  '            -e "$POSTMAN_ENVIRONMENT_UID"',
  '            --report-events',
  "            --env-var \"CI_ENVIRONMENT=${{ vars.CI_ENVIRONMENT || 'Production' }}\")",
  "          if [ -f \"$RUNNER_TEMP/postman-ssl/client.crt\" ]; then",
  '            CMD+=(--ssl-client-cert "$RUNNER_TEMP/postman-ssl/client.crt"',
  '              --ssl-client-key "$RUNNER_TEMP/postman-ssl/client.key")',
  '            if [ -n "$POSTMAN_SSL_CLIENT_PASSPHRASE" ]; then',
  '              CMD+=(--ssl-client-passphrase "$POSTMAN_SSL_CLIENT_PASSPHRASE")',
  '            fi',
  '            if [ -f "$RUNNER_TEMP/postman-ssl/ca.crt" ]; then',
  '              CMD+=(--ssl-extra-ca-certs "$RUNNER_TEMP/postman-ssl/ca.crt")',
  '            fi',
  '          fi',
  '          "${CMD[@]}"',
  '      - name: Run Contract Tests',
  '        env:',
  '          POSTMAN_SSL_CLIENT_PASSPHRASE: ${{ secrets.POSTMAN_SSL_CLIENT_PASSPHRASE }}',
  '        run: |',
  '          CMD=(postman collection run "$POSTMAN_CONTRACT_COLLECTION_UID"',
  '            -e "$POSTMAN_ENVIRONMENT_UID"',
  '            --report-events',
  "            --env-var \"CI_ENVIRONMENT=${{ vars.CI_ENVIRONMENT || 'Production' }}\")",
  "          if [ -f \"$RUNNER_TEMP/postman-ssl/client.crt\" ]; then",
  '            CMD+=(--ssl-client-cert "$RUNNER_TEMP/postman-ssl/client.crt"',
  '              --ssl-client-key "$RUNNER_TEMP/postman-ssl/client.key")',
  '            if [ -n "$POSTMAN_SSL_CLIENT_PASSPHRASE" ]; then',
  '              CMD+=(--ssl-client-passphrase "$POSTMAN_SSL_CLIENT_PASSPHRASE")',
  '            fi',
  '            if [ -f "$RUNNER_TEMP/postman-ssl/ca.crt" ]; then',
  '              CMD+=(--ssl-extra-ca-certs "$RUNNER_TEMP/postman-ssl/ca.crt")',
  '            fi',
  '          fi',
  '          "${CMD[@]}"',
  ''
  ];
}

export const CI_WORKFLOW_TEMPLATE = renderCiWorkflowTemplate();

function buildAdoWindowsCollectionRunLines(
  displayName: string,
  collectionEnvironmentName: 'POSTMAN_SMOKE_COLLECTION_UID' | 'POSTMAN_CONTRACT_COLLECTION_UID'
): string[] {
  return [
    '  - pwsh: |',
    "      $ErrorActionPreference = 'Stop'",
    '      function Resolve-AdoOptional([string]$Value) {',
    "        if ($Value -match '^\\$\\([^)]+\\)$') { return '' }",
    '        return $Value',
    '      }',
    `      $collectionUid = $env:${collectionEnvironmentName}`,
    '      $ciEnvironment = Resolve-AdoOptional $env:CI_ENVIRONMENT',
    "      if ([string]::IsNullOrWhiteSpace($ciEnvironment)) { $ciEnvironment = 'Production' }",
    `      $arguments = @('collection', 'run', $collectionUid, '-e', $env:POSTMAN_ENVIRONMENT_UID, '--report-events', '--env-var', "CI_ENVIRONMENT=$ciEnvironment")`,
    "      $sslRoot = Join-Path $env:AGENT_TEMPDIRECTORY 'postman-ssl'",
    "      $clientCert = Join-Path $sslRoot 'client.crt'",
    "      $clientKey = Join-Path $sslRoot 'client.key'",
    "      $caCert = Join-Path $sslRoot 'ca.crt'",
    '      if (Test-Path -LiteralPath $clientCert) {',
    "        $arguments += @('--ssl-client-cert', $clientCert, '--ssl-client-key', $clientKey)",
    '        $passphrase = Resolve-AdoOptional $env:POSTMAN_SSL_CLIENT_PASSPHRASE',
    '        if (-not [string]::IsNullOrWhiteSpace($passphrase)) {',
    "          $arguments += @('--ssl-client-passphrase', $passphrase)",
    '        }',
    '        if (Test-Path -LiteralPath $caCert) {',
    "          $arguments += @('--ssl-extra-ca-certs', $caCert)",
    '        }',
    '      }',
    '      & postman @arguments',
    `      if ($LASTEXITCODE -ne 0) { throw '${displayName} failed with exit code ' + $LASTEXITCODE }`,
    `    displayName: ${displayName}`,
    '    env:',
    `      ${collectionEnvironmentName}: $(${collectionEnvironmentName})`,
    '      POSTMAN_ENVIRONMENT_UID: $(POSTMAN_ENVIRONMENT_UID)',
    '      CI_ENVIRONMENT: $(CI_ENVIRONMENT)',
    '      POSTMAN_SSL_CLIENT_PASSPHRASE: $(POSTMAN_SSL_CLIENT_PASSPHRASE)'
  ];
}

function buildAdoWindowsCiWorkflowLines(installUrl: string, postmanRegion: string): string[] {
  return [
    'trigger:',
    '  branches:',
    '    include:',
    '      - main',
    'schedules:',
    '  - cron: "0 */6 * * *"',
    '    displayName: Scheduled run',
    '    branches:',
    '      include:',
    '        - main',
    '    always: true',
    'pool:',
    '  vmImage: windows-latest',
    'steps:',
    '  - checkout: self',
    '    persistCredentials: true',
    '  - pwsh: |',
    "      $ErrorActionPreference = 'Stop'",
    '      if (-not (Get-Command postman -ErrorAction SilentlyContinue)) {',
    '        [System.Net.ServicePointManager]::SecurityProtocol = 3072',
    '        Invoke-Expression ((New-Object System.Net.WebClient).DownloadString($env:POSTMAN_CLI_INSTALL_URL))',
    '      }',
    '      & postman --version',
    "      if ($LASTEXITCODE -ne 0) { throw 'Postman CLI installation failed' }",
    '    displayName: Install Postman CLI',
    '    env:',
    `      POSTMAN_CLI_INSTALL_URL: ${installUrl}`,
    '  - pwsh: |',
    "      $ErrorActionPreference = 'Stop'",
    "      $arguments = @('login', '--with-api-key', $env:POSTMAN_API_KEY)",
    ...(postmanRegion === 'eu' ? ["      $arguments += @('--region', 'eu')"] : []),
    '      & postman @arguments',
    "      if ($LASTEXITCODE -ne 0) { throw 'Postman CLI login failed' }",
    '    displayName: Login to Postman CLI',
    '    env:',
    '      POSTMAN_API_KEY: $(POSTMAN_API_KEY)',
    '  - pwsh: |',
    "      $ErrorActionPreference = 'Stop'",
    "      $section = ''",
    "      $smoke = ''",
    "      $contract = ''",
    "      $environment = ''",
    "      $fallbackEnvironment = ''",
    "      foreach ($line in Get-Content -LiteralPath '.postman/resources.yaml') {",
    "        if ($line -match '^  (collections|environments):\\s*$') { $section = $Matches[1]; continue }",
    "        if ($line -notmatch '^    (.+?):\\s+(.+?)\\s*$') { continue }",
    "        $key = $Matches[1].Trim().Trim(\"'\").Trim('\"')",
    "        $value = $Matches[2].Trim().Trim(\"'\").Trim('\"')",
    "        if ($section -eq 'collections' -and $key -match '\\[Smoke\\]') { $smoke = $value }",
    "        if ($section -eq 'collections' -and $key -match '\\[Contract\\]') { $contract = $value }",
    "        if ($section -eq 'environments') {",
    "          if ([string]::IsNullOrWhiteSpace($fallbackEnvironment)) { $fallbackEnvironment = $value }",
    "          if ($key -match 'prod\\.postman_environment\\.json$') { $environment = $value }",
    '        }',
    '      }',
    '      if ([string]::IsNullOrWhiteSpace($environment)) { $environment = $fallbackEnvironment }',
    "      if ([string]::IsNullOrWhiteSpace($smoke)) { throw 'Missing smoke collection UID in .postman/resources.yaml' }",
    "      if ([string]::IsNullOrWhiteSpace($contract)) { throw 'Missing contract collection UID in .postman/resources.yaml' }",
    "      if ([string]::IsNullOrWhiteSpace($environment)) { throw 'Missing environment UID in .postman/resources.yaml' }",
    '      Write-Host "##vso[task.setvariable variable=POSTMAN_SMOKE_COLLECTION_UID]$smoke"',
    '      Write-Host "##vso[task.setvariable variable=POSTMAN_CONTRACT_COLLECTION_UID]$contract"',
    '      Write-Host "##vso[task.setvariable variable=POSTMAN_ENVIRONMENT_UID]$environment"',
    '    displayName: Resolve Postman Resource IDs',
    '  - pwsh: |',
    "      $ErrorActionPreference = 'Stop'",
    '      function Resolve-AdoOptional([string]$Value) {',
    "        if ($Value -match '^\\$\\([^)]+\\)$') { return '' }",
    '        return $Value',
    '      }',
    "      $sslRoot = Join-Path $env:AGENT_TEMPDIRECTORY 'postman-ssl'",
    '      New-Item -ItemType Directory -Path $sslRoot -Force | Out-Null',
    "      [IO.File]::WriteAllBytes((Join-Path $sslRoot 'client.crt'), [Convert]::FromBase64String($env:POSTMAN_SSL_CLIENT_CERT_B64))",
    "      [IO.File]::WriteAllBytes((Join-Path $sslRoot 'client.key'), [Convert]::FromBase64String($env:POSTMAN_SSL_CLIENT_KEY_B64))",
    '      $extraCa = Resolve-AdoOptional $env:POSTMAN_SSL_EXTRA_CA_CERTS_B64',
    '      if (-not [string]::IsNullOrWhiteSpace($extraCa)) {',
    "        [IO.File]::WriteAllBytes((Join-Path $sslRoot 'ca.crt'), [Convert]::FromBase64String($extraCa))",
    '      }',
    "    condition: ne(variables['POSTMAN_SSL_CLIENT_CERT_B64'], '')",
    '    displayName: Decode SSL certificates',
    '    env:',
    '      POSTMAN_SSL_CLIENT_CERT_B64: $(POSTMAN_SSL_CLIENT_CERT_B64)',
    '      POSTMAN_SSL_CLIENT_KEY_B64: $(POSTMAN_SSL_CLIENT_KEY_B64)',
    '      POSTMAN_SSL_EXTRA_CA_CERTS_B64: $(POSTMAN_SSL_EXTRA_CA_CERTS_B64)',
    ...buildAdoWindowsCollectionRunLines('Run Smoke Tests', 'POSTMAN_SMOKE_COLLECTION_UID'),
    ...buildAdoWindowsCollectionRunLines('Run Contract Tests', 'POSTMAN_CONTRACT_COLLECTION_UID'),
    ''
  ];
}

function buildAdoCiWorkflowLines(installUrl: string, postmanRegion: string): string[] {
  return [
  'trigger:',
  '  branches:',
  '    include:',
  '      - main',
  'schedules:',
  '  - cron: "0 */6 * * *"',
  '    displayName: Scheduled run',
  '    branches:',
  '      include:',
  '        - main',
  '    always: true',
  'pool:',
  '  vmImage: ubuntu-latest',
  'steps:',
  '  - checkout: self',
  '    persistCredentials: true',
  '  - script: curl -fsSL "$POSTMAN_CLI_INSTALL_URL" | sh',
  '    displayName: Install Postman CLI',
  '    env:',
  `      POSTMAN_CLI_INSTALL_URL: ${installUrl}`,
  '  - script: postman login --with-api-key "$POSTMAN_API_KEY"' +
    (postmanRegion === 'eu' ? ' --region eu' : ''),
  '    displayName: Login to Postman CLI',
  '    env:',
  '      POSTMAN_API_KEY: $(POSTMAN_API_KEY)',
  '  - script: |',
  "      SMOKE=$(grep '\\[Smoke\\]' .postman/resources.yaml | grep -v '^ *-' | head -1 | awk -F': ' '{print $NF}')",
  "      CONTRACT=$(grep '\\[Contract\\]' .postman/resources.yaml | grep -v '^ *-' | head -1 | awk -F': ' '{print $NF}')",
  "      ENV=$(grep 'prod\\.postman_environment\\.json' .postman/resources.yaml | grep -v '^ *-' | head -1 | awk -F': ' '{print $NF}')",
  "      ENV=${ENV:-$(grep '\\.postman_environment\\.json' .postman/resources.yaml | grep -v '^ *-' | head -1 | awk -F': ' '{print $NF}')}",
  '      [ -n "$SMOKE" ] || { echo "Missing smoke collection UID in .postman/resources.yaml"; exit 1; }',
  '      [ -n "$CONTRACT" ] || { echo "Missing contract collection UID in .postman/resources.yaml"; exit 1; }',
  '      [ -n "$ENV" ] || { echo "Missing environment UID in .postman/resources.yaml"; exit 1; }',
  '      echo "##vso[task.setvariable variable=POSTMAN_SMOKE_COLLECTION_UID]$SMOKE"',
  '      echo "##vso[task.setvariable variable=POSTMAN_CONTRACT_COLLECTION_UID]$CONTRACT"',
  '      echo "##vso[task.setvariable variable=POSTMAN_ENVIRONMENT_UID]$ENV"',
  '    displayName: Resolve Postman Resource IDs',
  '  - script: |',
  '      mkdir -p "$(Agent.TempDirectory)/postman-ssl"',
  '      printf %s "$POSTMAN_SSL_CLIENT_CERT_B64" | base64 -d > "$(Agent.TempDirectory)/postman-ssl/client.crt"',
  '      printf %s "$POSTMAN_SSL_CLIENT_KEY_B64" | base64 -d > "$(Agent.TempDirectory)/postman-ssl/client.key"',
  '      normalize_azure_optional_var() {',
  '        local name="$1"',
  '        local value="${!name:-}"',
  "        local unresolved_prefix='$'",
  '        unresolved_prefix="${unresolved_prefix}("',
  '        if [[ "$value" == "$unresolved_prefix"*")" ]]; then',
  '          printf -v "$name" %s ""',
  '        fi',
  '      }',
  '      normalize_azure_optional_var POSTMAN_SSL_EXTRA_CA_CERTS_B64',
  '      if [ -n "$POSTMAN_SSL_EXTRA_CA_CERTS_B64" ]; then',
  '        printf %s "$POSTMAN_SSL_EXTRA_CA_CERTS_B64" | base64 -d > "$(Agent.TempDirectory)/postman-ssl/ca.crt"',
  '      fi',
  "    condition: ne(variables['POSTMAN_SSL_CLIENT_CERT_B64'], '')",
  '    displayName: Decode SSL certificates',
  '    env:',
  '      POSTMAN_SSL_CLIENT_CERT_B64: $(POSTMAN_SSL_CLIENT_CERT_B64)',
  '      POSTMAN_SSL_CLIENT_KEY_B64: $(POSTMAN_SSL_CLIENT_KEY_B64)',
  '      POSTMAN_SSL_EXTRA_CA_CERTS_B64: $(POSTMAN_SSL_EXTRA_CA_CERTS_B64)',
  '  - script: |',
  '      normalize_azure_optional_var() {',
  '        local name="$1"',
  '        local value="${!name:-}"',
  "        local unresolved_prefix='$'",
  '        unresolved_prefix="${unresolved_prefix}("',
  '        if [[ "$value" == "$unresolved_prefix"*")" ]]; then',
  '          printf -v "$name" %s ""',
  '        fi',
  '      }',
  '      normalize_azure_optional_var CI_ENVIRONMENT',
  '      normalize_azure_optional_var POSTMAN_SSL_CLIENT_PASSPHRASE',
  '      CMD=(postman collection run "$POSTMAN_SMOKE_COLLECTION_UID"',
  '        -e "$POSTMAN_ENVIRONMENT_UID"',
  '        --report-events',
  '        --env-var "CI_ENVIRONMENT=${CI_ENVIRONMENT:-Production}")',
  '      if [ -f "$(Agent.TempDirectory)/postman-ssl/client.crt" ]; then',
  '        CMD+=(--ssl-client-cert "$(Agent.TempDirectory)/postman-ssl/client.crt"',
  '          --ssl-client-key "$(Agent.TempDirectory)/postman-ssl/client.key")',
  '        if [ -n "$POSTMAN_SSL_CLIENT_PASSPHRASE" ]; then',
  '          CMD+=(--ssl-client-passphrase "$POSTMAN_SSL_CLIENT_PASSPHRASE")',
  '        fi',
  '        if [ -f "$(Agent.TempDirectory)/postman-ssl/ca.crt" ]; then',
  '          CMD+=(--ssl-extra-ca-certs "$(Agent.TempDirectory)/postman-ssl/ca.crt")',
  '        fi',
  '      fi',
  '      "${CMD[@]}"',
  '    displayName: Run Smoke Tests',
  '    env:',
  '      CI_ENVIRONMENT: $(CI_ENVIRONMENT)',
  '      POSTMAN_SSL_CLIENT_PASSPHRASE: $(POSTMAN_SSL_CLIENT_PASSPHRASE)',
  '  - script: |',
  '      normalize_azure_optional_var() {',
  '        local name="$1"',
  '        local value="${!name:-}"',
  "        local unresolved_prefix='$'",
  '        unresolved_prefix="${unresolved_prefix}("',
  '        if [[ "$value" == "$unresolved_prefix"*")" ]]; then',
  '          printf -v "$name" %s ""',
  '        fi',
  '      }',
  '      normalize_azure_optional_var CI_ENVIRONMENT',
  '      normalize_azure_optional_var POSTMAN_SSL_CLIENT_PASSPHRASE',
  '      CMD=(postman collection run "$POSTMAN_CONTRACT_COLLECTION_UID"',
  '        -e "$POSTMAN_ENVIRONMENT_UID"',
  '        --report-events',
  '        --env-var "CI_ENVIRONMENT=${CI_ENVIRONMENT:-Production}")',
  '      if [ -f "$(Agent.TempDirectory)/postman-ssl/client.crt" ]; then',
  '        CMD+=(--ssl-client-cert "$(Agent.TempDirectory)/postman-ssl/client.crt"',
  '          --ssl-client-key "$(Agent.TempDirectory)/postman-ssl/client.key")',
  '        if [ -n "$POSTMAN_SSL_CLIENT_PASSPHRASE" ]; then',
  '          CMD+=(--ssl-client-passphrase "$POSTMAN_SSL_CLIENT_PASSPHRASE")',
  '        fi',
  '        if [ -f "$(Agent.TempDirectory)/postman-ssl/ca.crt" ]; then',
  '          CMD+=(--ssl-extra-ca-certs "$(Agent.TempDirectory)/postman-ssl/ca.crt")',
  '        fi',
  '      fi',
  '      "${CMD[@]}"',
  '    displayName: Run Contract Tests',
  '    env:',
  '      CI_ENVIRONMENT: $(CI_ENVIRONMENT)',
  '      POSTMAN_SSL_CLIENT_PASSPHRASE: $(POSTMAN_SSL_CLIENT_PASSPHRASE)',
  ''
  ];
}

export function renderGcWorkflowTemplate(): string {
  return [
  'name: Postman Preview GC',
  'on:',
  '  delete:',
  '    branches: ["**"]',
  '  pull_request:',
  '    types: [closed]',
  '  schedule:',
  '    - cron: "0 2 * * *"',
  '  workflow_dispatch:',
  '    inputs:',
  '      branch:',
  '        description: Branch name to GC (optional, otherwise sweep by TTL/branch-existence)',
  '        required: false',
  'concurrency:',
  '  group: postman-preview-gc-${{ github.ref_name }}',
  '  cancel-in-progress: false',
  'jobs:',
  '  gc:',
  '    runs-on: ubuntu-latest',
  '    if: github.event_name != \'pull_request\' || github.event.pull_request.head.repo.full_name == github.repository',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '        with:',
  '          fetch-depth: 0',
  '      - name: Run Postman preview GC (provider-neutral cli.cjs gc)',
  '        env:',
  '          POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}',
  '          POSTMAN_ACCESS_TOKEN: ${{ secrets.POSTMAN_ACCESS_TOKEN }}',
  '          POSTMAN_WORKSPACE_ID: ${{ vars.POSTMAN_WORKSPACE_ID }}',
  '          REPO_URL: https://github.com/${{ github.repository }}',
  '        run: |',
  '          set -euo pipefail',
  '          # The repo-sync action bundles a provider-neutral gc command (cli.cjs gc)',
  '          # that uses the Postman access token for inventory/deletion and the',
  '          # provider ambient credential (GITHUB_TOKEN via git ls-remote) for branch existence.',
  '          # Daily scheduled run is the retention executor (TTL contract of last resort).',
  '          if [ -n "${{ inputs.branch }}" ]; then',
  '            npx @postman-cse/onboarding-repo-sync gc --branch "${{ inputs.branch }}" --workspace-id "$POSTMAN_WORKSPACE_ID" --repo-url "$REPO_URL"',
  '          else',
  '            npx @postman-cse/onboarding-repo-sync gc --workspace-id "$POSTMAN_WORKSPACE_ID" --repo-url "$REPO_URL"',
  '          fi',
  '      - name: Orphan audit summary (job summary)',
  '        if: always()',
  '        run: |',
  '          echo "### Preview GC orphan audit" >> "$GITHUB_STEP_SUMMARY"',
  '          echo "Marker-guarded deletion only — strangers (no marker) are never deleted. See gc-summary-json for structured counts." >> "$GITHUB_STEP_SUMMARY"',
  ''
  ].join('\n');
}

export const GC_WORKFLOW_TEMPLATE = renderGcWorkflowTemplate();

export function getCiWorkflowTemplate(
  provider: GitProvider,
  options: CiWorkflowTemplateOptions = {}
): string {
  const runnerOs = resolveCiRunnerOs(options.runnerOs);
  if (provider === 'azure-devops') {
    const rawUrl = runnerOs === 'windows'
      ? String(options.postmanCliWindowsInstallUrl || '').trim() || DEFAULT_POSTMAN_CLI_WINDOWS_INSTALL_URL
      : String(options.postmanCliInstallUrl || '').trim() || DEFAULT_POSTMAN_CLI_INSTALL_URL;
    const postmanRegion = resolvePostmanRegion(options.postmanRegion);
    const installUrl = validateHttpsInstallUrl(rawUrl);
    return (runnerOs === 'windows'
      ? buildAdoWindowsCiWorkflowLines(installUrl, postmanRegion)
      : buildAdoCiWorkflowLines(installUrl, postmanRegion)
    ).join('\n');
  }
  return renderCiWorkflowTemplate(options);
}
