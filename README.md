# Postman Repo Sync

[![CI](https://github.com/postman-cs/postman-repo-sync-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-repo-sync-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-repo-sync-action?sort=semver)](https://github.com/postman-cs/postman-repo-sync-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-repo-sync)](https://www.npmjs.com/package/@postman-cse/onboarding-repo-sync) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/postman-cs/postman-repo-sync-action/badge)](https://scorecard.dev/viewer/?uri=github.com/postman-cs/postman-repo-sync-action)

Exports Postman collections and environments into your repository and wires CI, mocks, and monitors around them.

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

      - uses: postman-cs/postman-repo-sync-action@v1
        with:
          project-name: core-payments
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

`actions/checkout` must run before this action. `project-name` is the only required input; workspace and collection IDs are resolved from `.postman/resources.yaml` when the repo already carries one.

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
    environments-json: '["prod","stage"]'
    env-runtime-urls-json: '{"prod":"https://api.example.com","stage":"https://stage-api.example.com"}'
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

`postman-access-token` is required for workspace-to-repository linking, system environment association, and API key generation. If it is omitted, those integration steps are skipped and the remaining artifact sync can still run with `postman-api-key`. See [docs/credentials.md](docs/credentials.md).

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

Pass `mock-url` or `monitor-id` to validate and reuse existing assets instead of creating new ones:

```yaml
with:
  mock-url: https://abc123.mock.pstmn.io
  monitor-id: 1e2f3a4b-monitor-id
```

### mTLS certificates for Postman CLI runs

The generated CI workflow can run Postman CLI with client certificates. Pass the cert material as inputs; when a GitHub token and repository context are available, the action persists them as repository secrets (`POSTMAN_SSL_CLIENT_CERT_B64`, `POSTMAN_SSL_CLIENT_KEY_B64`, `POSTMAN_SSL_CLIENT_PASSPHRASE`, `POSTMAN_SSL_EXTRA_CA_CERTS_B64`) for the generated workflow:

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
| `integration-backend` | Integration backend for workspace linking and environment sync. | no | `bifrost` |
| `workspace-link-enabled` | Enable workspace linking. | no | `true` |
| `environment-sync-enabled` | Enable association of Postman environments to system environments. | no | `true` |
| `system-env-map-json` | JSON map of environment slug to system environment id. | no | `{}` |
| `environment-uids-json` | JSON map of environment slug to Postman environment uid. | no | `{}` |
| `env-runtime-urls-json` | JSON map of environment slug to runtime base URL. | no | `{}` |
| `artifact-dir` | Root directory for exported Postman artifacts. | no | `postman` |
| `repo-write-mode` | Repo mutation mode for generated artifacts and workflow files. | no | `commit-and-push` |
| `current-ref` | Explicit ref override for push-changes when the checkout is detached. | no |  |
| `committer-name` | Git committer name for sync commits. | no | `Postman CSE` |
| `committer-email` | Git committer email for sync commits. | no | `help@postman.com` |
| `postman-api-key` | Postman API key used for environment, mock, and monitor operations. | no |  |
| `postman-access-token` | Postman access token used for Bifrost and system environment association. | no |  |
| `credential-preflight` | Credential identity preflight policy. warn (default) logs a note and continues when postman-api-key and postman-access-token resolve to different parent orgs; enforce fails the run on that condition before any workspace is created; off skips the identity probes entirely (the reactive error guidance still applies). Promotion of the default to enforce is planned once the live e2e legs prove both directions. | no | `warn` |
| `github-token` | GitHub token used for repo variable persistence and commits. | no |  |
| `gh-fallback-token` | Fallback token for repository variable APIs and workflow-file pushes. | no |  |
| `org-mode` | Whether the Postman team uses org-mode. When true, x-entity-team-id header is included in Bifrost proxy calls. Non-org teams must omit this header. | no | `false` |
| `ci-workflow-base64` | Optional base64-encoded ci.yml content. Defaults to the built-in template. | no |  |
| `ssl-client-cert` | Base64-encoded PEM client certificate for Postman CLI mTLS runs. | no |  |
| `ssl-client-key` | Base64-encoded PEM client private key for Postman CLI mTLS runs. | no |  |
| `ssl-client-passphrase` | Optional passphrase for encrypted ssl-client-key. | no |  |
| `ssl-extra-ca-certs` | Optional base64-encoded PEM CA certificate bundle for custom trust. | no |  |
| `spec-id` | Spec UID from bootstrap, persisted into .postman/resources.yaml cloudResources. | no |  |
| `spec-path` | Optional repo-root-relative path to the local spec file for resources/workflows metadata. | no |  |
| `postman-stack` | Postman stack profile. | no | `prod` |
<!-- inputs-table:end -->

## Outputs

<!-- outputs-table:start -->
| Name | Description |
| --- | --- |
| `integration-backend` | Resolved integration backend for the customer preview run. |
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

- Postman Collection v3 multi-file YAML exports under `postman/collections/`.
- Postman environment exports under `postman/environments/`.
- `.postman/resources.yaml` with local-to-cloud resource mappings.
- Optional `.postman/workflows.yaml` spec-to-collection metadata.
- Optional generated GitHub Actions workflow for Postman CLI smoke and contract runs.
- Optional mock server, cloud monitor, workspace repository link, and system environment associations.

A typical export looks like:

```text
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

## Resources

- [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action): mints a service-account access token and team ID.
- [postman-api-onboarding-action](https://github.com/postman-cs/postman-api-onboarding-action): composite action that orchestrates the onboarding pipeline.
- [postman-bootstrap-action](https://github.com/postman-cs/postman-bootstrap-action): workspace provisioning, spec upload, and collection generation.
- [postman-smoke-flow-action](https://github.com/postman-cs/postman-smoke-flow-action): applies a curated flow.yaml to the Smoke collection.
- [postman-insights-onboarding-action](https://github.com/postman-cs/postman-insights-onboarding-action): links Postman Insights to a workspace.
- [postman-aws-spec-discovery-action](https://github.com/postman-cs/postman-aws-spec-discovery-action): discovers API specs in AWS accounts.
- npm package: [@postman-cse/onboarding-repo-sync](https://www.npmjs.com/package/@postman-cse/onboarding-repo-sync)
- [Postman API documentation](https://learning.postman.com/docs/developer/postman-api/intro-api/)
- [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-overview/)

## License

[MIT](LICENSE)
