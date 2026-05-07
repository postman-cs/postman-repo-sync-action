# postman-repo-sync-action

Sync Postman workspace assets into a repository and optionally connect the workspace back to that repository.

Use this action when a repo should contain the Postman artifacts needed for CI, reviews, and repeatable API test runs:

- Postman Collection v3 multi-file YAML exports under `postman/collections/`.
- Postman environment exports under `postman/environments/`.
- `.postman/resources.yaml` with local-to-cloud resource mappings.
- Optional `.postman/workflows.yaml` spec-to-collection metadata.
- Optional generated GitHub Actions workflow for Postman CLI smoke and contract runs.
- Optional mock server, cloud monitor, workspace repository link, and system environment associations.

## Quick Start

```yaml
jobs:
  repo-sync:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      actions: write
    steps:
      - uses: actions/checkout@v4

      - uses: postman-cs/postman-repo-sync-action@v0
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

For existing repositories that already own their CI workflow, disable workflow generation:

```yaml
with:
  generate-ci-workflow: false
```

Or write the generated workflow somewhere other than `.github/workflows/ci.yml`:

```yaml
with:
  ci-workflow-path: .github/workflows/postman-sync.yml
```

## Requirements

- `actions/checkout` must run before this action.
- `project-name` is required.
- Provide a valid `postman-api-key`, or provide `postman-access-token` so the action can generate one.
- `contents: write` is required when `repo-write-mode` commits files.
- `actions: write` is required when the action writes workflow files.
- `gh-fallback-token` is recommended when the default `GITHUB_TOKEN` cannot update workflow files or repository secrets.

`postman-access-token` is required for workspace-to-repository linking, system environment association, and API key generation. If it is omitted, those integration steps are skipped and the remaining artifact sync can still run with `postman-api-key`.

## What Gets Written

The default artifact root is `postman/`. The action ensures these directories exist:

- `postman/collections`
- `postman/environments`
- `postman/flows`
- `postman/globals`
- `postman/mocks`
- `postman/specs`

Collections are exported as Collection v3 multi-file YAML directories, for example:

```text
postman/collections/[Smoke] core-payments/
  collection.yaml
  <folder>.yaml
  <request>.yaml
```

The action also writes `.postman/resources.yaml`. The generated CI workflow reads that file to resolve smoke collection, contract collection, and environment IDs for Postman CLI runs.

Long Postman folder and request names are truncated to 120 characters per path segment when files are written.

When a local OpenAPI spec is found, `.postman/resources.yaml` records it under `localResources.specs`. If `spec-id` and an unambiguous local spec are available, the action also maps the spec under `cloudResources.specs`. When a mapped spec and exported collections are both present, `.postman/workflows.yaml` is written with `syncSpecToCollection` metadata.

## Repository Writes

`repo-write-mode` controls repository mutation:

| Mode | Behavior |
| --- | --- |
| `commit-and-push` | Commit generated files and push them back to the current checked out ref. |
| `commit-only` | Commit generated files without pushing. Use this for customer-managed PR workflows. |
| `none` | Write files in the workspace only. |

For `commit-and-push`, the push target is resolved from `current-ref`, then `GITHUB_HEAD_REF`, then `GITHUB_REF_NAME`. Pull request merge refs are normalized to the PR head branch. Pushes use `HEAD:refs/heads/<resolved-branch>`.

If branch protection requires pull requests, run on a temporary branch with `repo-write-mode: commit-only`, then create the PR in a later workflow step.

## Sync Modes

`collection-sync-mode` controls collection lifecycle:

| Mode | Behavior |
| --- | --- |
| `refresh` | Refresh exports and rewrite resource mappings for the current ref. |
| `reuse` | Reuse explicit IDs or IDs already present in `.postman/resources.yaml`. |
| `version` | Require a release label and suffix exported collection directories, mock names, and monitor names with that label. |

`spec-sync-mode` supports:

| Mode | Behavior |
| --- | --- |
| `update` | Keep the current spec mapping updated. |
| `version` | Require a release label and use versioned metadata. |

If either mode is `version`, provide `release-label` or run on a ref name that can be used as the release label.

## Monitoring And Mocks

When `baseline-collection-id`, `workspace-id`, and at least one environment are available, the action creates or reuses a mock server.

When `smoke-collection-id`, `workspace-id`, and at least one environment are available, the action creates or reuses a cloud smoke monitor unless `monitor-type: cli` is set. If `monitor-cron` is empty, a new cloud monitor is created disabled.

Use `mock-url` or `monitor-id` to force reuse of existing assets.

## mTLS

The generated CI workflow can run Postman CLI with client certificates. Set these GitHub repository secrets:

- `POSTMAN_SSL_CLIENT_CERT_B64`
- `POSTMAN_SSL_CLIENT_KEY_B64`
- `POSTMAN_SSL_CLIENT_PASSPHRASE` (optional)
- `POSTMAN_SSL_EXTRA_CA_CERTS_B64` (optional)

You can also pass the matching action inputs. When `ssl-client-cert` is provided and a GitHub token/repository context is available, the action attempts to persist those values as repository secrets for the generated workflow.

## CLI

The package also ships a `postman-repo-sync` binary for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems.

```bash
npm install -g @postman-cse/onboarding-repo-sync

postman-repo-sync \
  --project-name core-payments \
  --workspace-id ws-123 \
  --baseline-collection-id col-baseline \
  --smoke-collection-id col-smoke \
  --contract-collection-id col-contract \
  --postman-api-key "$POSTMAN_API_KEY" \
  --result-json postman-repo-sync-result.json \
  --dotenv-path postman-repo-sync.env \
  --repo-write-mode commit-only
```

The CLI auto-detects repository URL, branch, and SHA from common CI environment variables. It writes JSON to stdout, writes the same JSON to `--result-json`, and optionally writes shell-sourceable `POSTMAN_REPO_SYNC_*` values to `--dotenv-path`. Logs go to stderr.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `project-name` | | Required. Service name used for environments, mock servers, and monitors. |
| `workspace-id` | | Postman workspace ID. Can be resolved from `.postman/resources.yaml` when available. |
| `baseline-collection-id` | | Baseline collection exported into the repo and used for mock server creation. |
| `smoke-collection-id` | | Smoke collection used for monitor creation and generated CI. |
| `contract-collection-id` | | Contract collection exported into the repo and used for generated CI. |
| `environments-json` | `["prod"]` | JSON array of environment slugs to create or update. |
| `env-runtime-urls-json` | `{}` | JSON map of environment slug to runtime base URL. |
| `environment-uids-json` | `{}` | JSON map of environment slug to existing Postman environment UID. |
| `system-env-map-json` | `{}` | JSON map of environment slug to system environment ID. |
| `repo-url` | Auto-detected | Explicit repository URL for workspace linking. Auto-detected from common GitHub, GitLab, Bitbucket, and Azure DevOps CI variables when available. |
| `artifact-dir` | `postman` | Root directory for exported artifacts. |
| `repo-write-mode` | `commit-and-push` | `commit-and-push`, `commit-only`, or `none`. |
| `current-ref` | | Explicit branch/ref override for push target resolution. |
| `generate-ci-workflow` | `true` | Whether to write the generated CI workflow. |
| `ci-workflow-path` | `.github/workflows/ci.yml` | Path for the generated CI workflow. |
| `ci-workflow-base64` | | Base64-encoded workflow content that replaces the built-in template. |
| `collection-sync-mode` | `refresh` | `refresh`, `reuse`, or `version`. |
| `spec-sync-mode` | `update` | `update` or `version`. |
| `release-label` | | Label used for versioned collection/spec sync. |
| `spec-id` | | Cloud spec UID to persist in `.postman/resources.yaml`. |
| `spec-path` | | Repo-root-relative local spec path to use for metadata. |
| `monitor-type` | `cloud` | `cloud` creates/reuses a cloud monitor; `cli` skips cloud monitor creation. |
| `monitor-id` | | Existing smoke monitor ID to validate and reuse. |
| `mock-url` | | Existing mock server URL to reuse. |
| `monitor-cron` | | Cron expression for cloud monitor scheduling. Empty creates a disabled monitor. |
| `workspace-link-enabled` | `true` | Enable workspace-to-repository linking. Requires `postman-access-token`. |
| `environment-sync-enabled` | `true` | Enable system environment association. Requires `postman-access-token`. |
| `integration-backend` | `bifrost` | Backend used for workspace linking and environment association. |
| `org-mode` | `false` | Include `x-entity-team-id` for org-mode Bifrost calls. |
| `postman-api-key` | | Postman API key for standard Postman API operations. |
| `postman-access-token` | | Postman session access token for integration operations and API key generation. |
| `github-token` | | Token for commits, pushes, workflow updates, and secret persistence. |
| `gh-fallback-token` | | Preferred fallback token for workflow-file pushes and secret persistence. |
| `committer-name` | `Postman CSE` | Git committer name for sync commits. |
| `committer-email` | `help@postman.com` | Git committer email for sync commits. |
| `ssl-client-cert` | | Base64-encoded PEM client certificate. |
| `ssl-client-key` | | Base64-encoded PEM private key. Required with `ssl-client-cert`. |
| `ssl-client-passphrase` | | Optional private-key passphrase. |
| `ssl-extra-ca-certs` | | Optional base64-encoded PEM CA bundle. |

## Outputs

| Output | Meaning |
| --- | --- |
| `integration-backend` | Resolved integration backend. |
| `resolved-current-ref` | Branch used as the push target for `commit-and-push`. |
| `workspace-link-status` | `success`, `skipped`, or `failed`. |
| `environment-sync-status` | `success`, `skipped`, or `failed`. |
| `environment-uids-json` | JSON map of environment slug to Postman environment UID. |
| `mock-url` | Created or reused mock server URL. |
| `monitor-id` | Created or reused smoke monitor ID. |
| `repo-sync-summary-json` | JSON summary of commit, environment, mock, monitor, push, and integration state. |
| `commit-sha` | Commit SHA produced by `repo-write-mode`, when a commit is created. |

## Credentials

Create a Postman API key in Postman under **Settings -> Account Settings -> API Keys**, then store it as `POSTMAN_API_KEY`.

The `postman-access-token` value is a session token used for integration APIs that are not covered by PMAK. To obtain it:

```bash
postman login
cat ~/.postman/postmanrc | jq -r '.login._profiles[].accessToken'
```

Store that value as `POSTMAN_ACCESS_TOKEN`. It expires with the Postman session and must be refreshed when integration steps start skipping or failing because of authentication.

## Local Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

`npm run build` produces the committed `dist/index.cjs` action bundle used by `action.yml` and `dist/cli.cjs` for the CLI.
