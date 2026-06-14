import { POSTMAN_ENDPOINT_PROFILES } from './postman/base-urls.js';

export const DEFAULT_POSTMAN_CLI_INSTALL_URL = POSTMAN_ENDPOINT_PROFILES.prod.cliInstallUrl;

function validateHttpsInstallUrl(url: string): string {
  const safeUrlPattern = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~/?=&%-]+$/;
  if (!safeUrlPattern.test(url)) {
    throw new Error(
      `postman-cli-install-url must be an https URL with safe characters; got: ${url}`
    );
  }
  return url;
}

export function renderCiWorkflowTemplate(
  options: { postmanCliInstallUrl?: string } = {}
): string {
  const rawUrl =
    String(options.postmanCliInstallUrl || '').trim() || DEFAULT_POSTMAN_CLI_INSTALL_URL;
  const installUrl = validateHttpsInstallUrl(rawUrl);
  return buildCiWorkflowLines(installUrl).join('\n');
}

function buildCiWorkflowLines(installUrl: string): string[] {
  return [
  'name: CI/CD Pipeline',
  'on:',
  '  push:',
  '    branches: [main]',
  '  pull_request:',
  '    branches: [main]',
  '  schedule:',
  '    - cron: "0 */6 * * *"',
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
  '        run: postman login --with-api-key ${{ secrets.POSTMAN_API_KEY }}',
  '      - name: Resolve Postman Resource IDs',
  '        run: |',
  '          ruby <<\'RUBY\'',
  "          require 'yaml'",
  "          config = YAML.load_file('.postman/resources.yaml') || {}",
  "          cloud = config.fetch('cloudResources', {})",
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
