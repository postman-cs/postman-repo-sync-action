# Postman Onboarding: Repo Sync

[![CI](https://github.com/postman-cs/postman-repo-sync-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-repo-sync-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-repo-sync-action?sort=semver)](https://github.com/postman-cs/postman-repo-sync-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-repo-sync)](https://www.npmjs.com/package/@postman-cse/onboarding-repo-sync) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Exports Postman [collections](https://learning.postman.com/docs/use/use-collections/collections-schemas/) and [environments](https://learning.postman.com/docs/use/send-requests/variables/managing-environments/) into your repository and wires CI, [mock servers](https://learning.postman.com/docs/design-apis/mock-apis/set-up-mock-servers/), and [monitors](https://learning.postman.com/docs/monitoring-your-api/setting-up-monitor/) around them.

Part of the [Postman API Onboarding suite](https://github.com/postman-cs/postman-api-onboarding-action).

## Which action should I use?

| Need | Use |
| --- | --- |
| Run the full onboarding flow from one workflow step | [Postman API Onboarding](https://github.com/postman-cs/postman-api-onboarding-action) |
| Mint a fresh service-account access token and team ID | [Postman Onboarding: Service Token](https://github.com/postman-cs/postman-resolve-service-token-action) |
| Create a workspace, upload an OpenAPI spec, and generate collections | [Postman Onboarding: Workspace Bootstrap](https://github.com/postman-cs/postman-bootstrap-action) |
| Export workspace artifacts into the repository and wire CI, mocks, and monitors | This action |
| Discover OpenAPI specs from AWS services | [Postman Onboarding: AWS Spec Discovery](https://github.com/postman-cs/postman-aws-spec-discovery-action) |
| Apply the curated smoke-test flow to an existing Smoke collection | [Postman Onboarding: Smoke Flow](https://github.com/postman-cs/postman-smoke-flow-action) |
| Link Postman Insights services to an onboarding workspace | [Postman Onboarding: Insights Linking](https://github.com/postman-cs/postman-insights-onboarding-action) |

## Usage

```yaml
jobs:
  repo-sync:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      actions: write
    steps:
      - uses: actions/checkout@v5

      - id: postman-auth
        uses: postman-cs/postman-resolve-service-token-action@v1
        with:
          postman-region: us
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}

      - uses: postman-cs/postman-repo-sync-action@v1
        with:
          project-name: core-payments
          postman-region: us
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ steps.postman-auth.outputs.token }}
          team-id: ${{ steps.postman-auth.outputs.team-id }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

`actions/checkout` must run before this action. `project-name` is the only schema-required input. A useful sync also needs a Postman API key or a service-token step that can mint one, plus workspace and collection IDs from inputs or `.postman/resources.yaml`.

The example permissions let `GITHUB_TOKEN` commit generated artifacts and update the generated workflow file. `contents: write` is required for `repo-write-mode: commit-only` and `commit-and-push`. `actions: write` is required when `generate-ci-workflow` writes under `.github/workflows/`. Repository secret persistence, such as a generated `POSTMAN_API_KEY` or mTLS certificate secret, needs `gh-fallback-token` with permission to manage Actions secrets.

`postman-region` controls the Postman public API host and generated [Postman CLI login region](https://learning.postman.com/docs/postman-cli/postman-cli-auth/). Use `us` for `https://api.getpostman.com` and `eu` for `https://api.eu.postman.com` when the team uses [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/).

## Examples

### Full sync with workspace assets

```yaml
- uses: postman-cs/postman-repo-sync-action@v1
  with:
    project-name: core-payments
    workspace-id: ws-123
    baseline-collection-id: col-baseline
    smoke-collection-id: col-smoke
    contract-collection-id: col-contract
    postman-region: us
    environments-json: '["prod","stage"]'
    env-runtime-urls-json: '{"prod":"https://api.example.com","stage":"https://stage-api.example.com"}'
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ steps.postman-auth.outputs.token }}
    team-id: ${{ steps.postman-auth.outputs.team-id }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

`postman-access-token` is required for workspace-to-repository linking, system environment association, and API key generation. Use `postman-resolve-service-token-action` to mint it at runtime from a [Postman service account](https://learning.postman.com/docs/administration/service-accounts/) PMAK. If it is omitted, those integration steps are skipped and the remaining artifact sync can still run with `postman-api-key`. See [docs/credentials.md](docs/credentials.md).

### Disable CI workflow generation

For existing repositories that already own their CI workflow, disable workflow generation:

```yaml
with:
  generate-ci-workflow: false
```

### Custom CI workflow path

Write the generated workflow somewhere other than `.github/workflows/ci.yml`:

```yaml
with:
  ci-workflow-path: .github/workflows/postman-sync.yml
```

### Commit-only mode for protected branches

If branch protection requires pull requests, run on a temporary branch with commit-only writes, then create the PR in a later workflow step. Use this for customer-managed PR workflows.

```yaml
with:
  repo-write-mode: commit-only
```

`repo-write-mode` options:

| Mode | Behavior |
| --- | --- |
| `commit-and-push` | Commit generated files and push them back to the current checked out ref. |
| `commit-only` | Commit generated files without pushing. |
| `none` | Write files in the workspace only. |

### Reuse an existing mock server and monitor

Pass `mock-url` or `monitor-id` to validate and reuse existing [mock servers](https://learning.postman.com/docs/design-apis/mock-apis/set-up-mock-servers/) or [monitors](https://learning.postman.com/docs/monitoring-your-api/setting-up-monitor/) instead of creating new ones:

```yaml
with:
  mock-url: https://abc123.mock.pstmn.io
  monitor-id: 1e2f3a4b-monitor-id
```

### mTLS certificates for Postman CLI runs

The generated CI workflow can run [Postman CLI collection runs](https://learning.postman.com/docs/postman-cli/postman-cli-collections/) with client certificates. Pass the cert material as inputs; when a GitHub token and repository context are available, the action persists them as repository secrets (`POSTMAN_SSL_CLIENT_CERT_B64`, `POSTMAN_SSL_CLIENT_KEY_B64`, `POSTMAN_SSL_CLIENT_PASSPHRASE`, `POSTMAN_SSL_EXTRA_CA_CERTS_B64`) for the generated workflow:

```yaml
with:
  ssl-client-cert: ${{ secrets.POSTMAN_SSL_CLIENT_CERT_B64 }}
  ssl-client-key: ${{ secrets.POSTMAN_SSL_CLIENT_KEY_B64 }}
  ssl-client-passphrase: ${{ secrets.POSTMAN_SSL_CLIENT_PASSPHRASE }}
```

## Inputs

<!-- inputs-table:start -->
| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `generate-ci-workflow` | Whether to generate the CI workflow file | no | `true` |
| `ci-workflow-path` | Path to write the generated CI workflow file | no | `.github/workflows/ci.yml` |
| `project-name` | Service project name used for environment, mock, and monitor naming. | yes |  |
| `workspace-id` | Postman workspace ID used for workspace-link and export metadata. | no |  |
| `baseline-collection-id` | Baseline collection ID used for exported artifacts and mock server creation. | no |  |
| `monitor-type` | Type of monitor to create ("cloud" or "cli"). "cli" will skip cloud monitor creation and rely on the CI workflow. | no | `cloud` |
| `smoke-collection-id` | Smoke collection ID used for monitor creation. | no |  |
| `contract-collection-id` | Contract collection ID used for exported artifacts. | no |  |
| `collection-sync-mode` | Collection sync lifecycle mode (refresh or version). | no | `refresh` |
| `spec-sync-mode` | Spec sync lifecycle mode (update or version). | no | `update` |
| `release-label` | Optional release label used for versioned naming. | no |  |
| `monitor-id` | Existing smoke monitor ID. When set, the action validates and reuses this monitor instead of creating a new one. | no |  |
| `mock-url` | Existing mock server URL. When set, the action validates and reuses this mock instead of creating a new one. | no |  |
| `monitor-cron` | Cron expression for monitor scheduling (e.g. '0 */6 * * *'). When empty, the monitor is created disabled and triggered to run once per workflow invocation (and once on every subsequent run). | no | `""` |
| `environments-json` | JSON array of environment slugs to create or update. | no | `["prod"]` |
| `repo-url` | Explicit repository URL (GitHub or GitLab). Defaults to https://github.com/$GITHUB_REPOSITORY on GitHub Actions, or $CI_PROJECT_URL on GitLab CI, when omitted. | no |  |
| `workspace-link-enabled` | Enable workspace linking. | no | `true` |
| `environment-sync-enabled` | Enable association of Postman environments to system environments. | no | `true` |
| `system-env-map-json` | JSON map of environment slug to system environment id. | no | `{}` |
| `environment-uids-json` | JSON map of environment slug to Postman environment uid. | no | `{}` |
| `env-runtime-urls-json` | JSON map of environment slug to runtime base URL. | no | `{}` |
| `artifact-dir` | Root directory for exported Postman artifacts. | no | `postman` |
| `repo-write-mode` | Repo mutation mode for generated artifacts and workflow files. | no | `commit-and-push` |
| `current-ref` | Explicit ref override for push-changes when the checkout is detached. | no |  |
| `committer-name` | Git committer name for sync commits. | no | `Postman` |
| `committer-email` | Git committer email for sync commits. | no | `support@postman.com` |
| `postman-api-key` | Postman API key used for environment, mock, and monitor operations. | no |  |
| `postman-access-token` | Postman access token used for workspace linking, system environment association, and generated API-key creation. | no |  |
| `team-id` | Postman team ID resolved by postman-resolve-service-token-action for org-mode integration calls. Falls back to POSTMAN_TEAM_ID when omitted. | no | `""` |
| `credential-preflight` | Credential identity preflight policy. warn (default) logs a note and continues when postman-api-key and postman-access-token resolve to different parent orgs; enforce fails the run on that condition before any workspace is created. Both modes warn when postman-access-token is not a service-account token. | no | `warn` |
| `github-token` | GitHub token used for repo variable persistence and commits. | no |  |
| `gh-fallback-token` | Fallback token for repository variable APIs and workflow-file pushes. | no |  |
| `org-mode` | Whether the Postman team uses org-mode. When true, x-entity-team-id is included in Postman integration API calls. Non-org teams must omit this header. | no | `false` |
| `ci-workflow-base64` | Optional base64-encoded ci.yml content. Defaults to the built-in template. | no |  |
| `ssl-client-cert` | Base64-encoded PEM client certificate for Postman CLI mTLS runs. | no |  |
| `ssl-client-key` | Base64-encoded PEM client private key for Postman CLI mTLS runs. | no |  |
| `ssl-client-passphrase` | Optional passphrase for encrypted ssl-client-key. | no |  |
| `ssl-extra-ca-certs` | Optional base64-encoded PEM CA certificate bundle for custom trust. | no |  |
| `spec-id` | Spec UID from bootstrap, persisted into .postman/resources.yaml cloudResources. | no |  |
| `spec-path` | Optional repo-root-relative path to the local spec file for resources/workflows metadata. | no |  |
| `postman-region` | Postman data residency region for public API and Postman CLI calls. One of: us or eu. | no | `us` |
<!-- inputs-table:end -->

## Outputs

<!-- outputs-table:start -->
| Name | Description |
| --- | --- |
| `resolved-current-ref` | Resolved push target based on current-ref semantics. |
| `workspace-link-status` | Whether workspace linking succeeded, was skipped, or failed. |
| `environment-sync-status` | Whether environment sync succeeded, was skipped, or failed. |
| `environment-uids-json` | JSON map of environment slug to Postman environment uid. |
| `mock-url` | Created or reused mock server URL. |
| `monitor-id` | Created or reused smoke monitor ID. |
| `repo-sync-summary-json` | JSON summary of repo materialization and workspace sync outputs. |
| `commit-sha` | Commit SHA produced by repo-write-mode, if any. |
<!-- outputs-table:end -->

## How it works

The action syncs a Postman workspace into the checked-out repository and can connect the workspace back to that repository:

- [Postman Collection v3](https://learning.postman.com/docs/use/use-collections/collections-schemas/) multi-file YAML exports under `postman/collections/`.
- [Postman environment](https://learning.postman.com/docs/use/send-requests/variables/managing-environments/) exports under `postman/environments/`.
- `.postman/resources.yaml` with local-to-cloud resource mappings.
- Optional `.postman/workflows.yaml` spec-to-collection metadata.
- Optional generated GitHub Actions workflow for [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-run-collection/) smoke and contract runs.
- Optional mock server, cloud monitor, workspace repository link, and system environment associations.

The generated files are intended to be committed when `repo-write-mode` is `commit-only` or `commit-and-push`. Treat `postman/` and `.postman/` as reviewable source artifacts for the onboarding workflow; commit and review them like any other tracked source.

A typical export looks like:

```text
postman/collections/core-payments/
  collection.yaml
  <folder>.yaml
  <request>.yaml
postman/collections/[Smoke] core-payments/
  collection.yaml
  <folder>.yaml
  <request>.yaml
postman/environments/
  prod.postman_environment.json
.postman/
  resources.yaml
```

For `commit-and-push`, the push target is resolved from `current-ref`, then `GITHUB_HEAD_REF`, then `GITHUB_REF_NAME`. Pull request merge refs are normalized to the PR head branch.

Mocks and monitors: when `baseline-collection-id`, `workspace-id`, and at least one environment are available, the action creates or reuses a mock server. When `smoke-collection-id` is also available, it creates or reuses a cloud smoke monitor unless `monitor-type: cli` is set. With an empty `monitor-cron`, a new cloud monitor is created disabled and triggered once per workflow invocation.

Deeper reference:

- [Artifact layout and Collection v3 format](docs/artifact-layout.md), including sync modes and versioned releases.
- [Credentials](docs/credentials.md): `postman-api-key`, `postman-access-token`, credential preflight, GitHub tokens.
- [CLI usage](docs/cli.md): the `postman-repo-sync` binary for GitLab CI, Bitbucket Pipelines, and Azure DevOps.
- [Security](SECURITY.md): supported releases, reporting, and secret-handling expectations.
- [Support](SUPPORT.md): where to ask usage questions and what diagnostics to include.
- [Release policy](RELEASE_POLICY.md): immutable version tags and the rolling `v1` alias.

## Resources

### The suite

| Action | Role |
| --- | --- |
| [Postman API Onboarding](https://github.com/postman-cs/postman-api-onboarding-action) | Entry point: chains workspace bootstrap, repo sync, and optional Insights linking |
| [Postman Onboarding: Service Token](https://github.com/postman-cs/postman-resolve-service-token-action) | Mints the service-account access token and team ID |
| [Postman Onboarding: AWS Spec Discovery](https://github.com/postman-cs/postman-aws-spec-discovery-action) | Discovers and exports API specs from AWS services |
| [Postman Onboarding: Workspace Bootstrap](https://github.com/postman-cs/postman-bootstrap-action) | Creates the workspace, uploads the spec, generates collections |
| [Postman Onboarding: Smoke Flow](https://github.com/postman-cs/postman-smoke-flow-action) | Applies a curated flow.yaml to the Smoke collection |
| [Postman Onboarding: Repo Sync](https://github.com/postman-cs/postman-repo-sync-action) | Exports artifacts into the repo and wires CI, mocks, and monitors |
| [Postman Onboarding: Insights Linking](https://github.com/postman-cs/postman-insights-onboarding-action) | Links Insights discovered services to the workspace |

- [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action): mints a service-account access token and team ID.
- [postman-api-onboarding-action](https://github.com/postman-cs/postman-api-onboarding-action): composite action that orchestrates the onboarding pipeline.
- [postman-bootstrap-action](https://github.com/postman-cs/postman-bootstrap-action): workspace provisioning, spec upload, and collection generation.
- [postman-smoke-flow-action](https://github.com/postman-cs/postman-smoke-flow-action): applies a curated flow.yaml to the Smoke collection.
- [postman-insights-onboarding-action](https://github.com/postman-cs/postman-insights-onboarding-action): links Postman Insights to a workspace.
- [postman-aws-spec-discovery-action](https://github.com/postman-cs/postman-aws-spec-discovery-action): discovers API specs in AWS accounts.
- npm package: [@postman-cse/onboarding-repo-sync](https://www.npmjs.com/package/@postman-cse/onboarding-repo-sync)
- Postman API and auth references: [Postman API](https://learning.postman.com/docs/reference/postman-api/intro-api/), [API authentication](https://learning.postman.com/docs/reference/postman-api/authentication/), [Postman CLI auth](https://learning.postman.com/docs/postman-cli/postman-cli-auth/), [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/)
- Postman artifact and runtime references: [Collection v3 schema](https://learning.postman.com/docs/use/use-collections/collections-schemas/), [Postman CLI collection runs](https://learning.postman.com/docs/postman-cli/postman-cli-run-collection/), [environments](https://learning.postman.com/docs/use/send-requests/variables/managing-environments/), [mock servers](https://learning.postman.com/docs/design-apis/mock-apis/set-up-mock-servers/), [monitors](https://learning.postman.com/docs/monitoring-your-api/setting-up-monitor/)


## Telemetry

This action sends a single anonymous usage event when a run completes, so the
Postman team can measure adoption across CI systems. The event contains the
action name and version, your Postman team ID, the detected CI provider and
runner kind, the run outcome, the CI run identifier, an event timestamp, and a one-way SHA-256 hash of the repository
identifier. Each event also carries a schema version and a constant event type used only by the collector. The Postman team ID is sent in the clear on a legitimate-interest
basis to measure product adoption.

The `events.pm-cse.dev` endpoint is operated by the Postman Customer Success
Engineering team. Postman, Inc. processes these events only to measure
onboarding adoption in aggregate, retains them only as aggregated counts for
product-adoption trend analysis, and includes no payload field that identifies
an individual person.

It never sends API keys, access tokens, spec content, workspace or repository
names, or any personal data. It is fire-and-forget with a hard
timeout and can never block or fail your pipeline. Corporate HTTP and HTTPS
proxies are honored through the standard `HTTPS_PROXY`, `HTTP_PROXY`, and
`NO_PROXY` environment variables.

Disable it by setting either environment variable in your CI:

```sh
POSTMAN_ACTIONS_TELEMETRY=off
# or the cross-tool standard
DO_NOT_TRACK=1
```

Telemetry is also skipped automatically when no Postman team ID can be resolved.

Events are sent over HTTPS to `https://events.pm-cse.dev/v1/events`. To
allowlist this destination on a restricted network, or to route events to a
collector you operate, set the `POSTMAN_ACTIONS_TELEMETRY_ENDPOINT` environment
variable to your own URL.

## License

[MIT](LICENSE)
