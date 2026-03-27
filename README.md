# postman-repo-sync-action

Public open-alpha GitHub Action that owns Postman-to-repo sync concerns split out of `api-catalog-demo-infra/.github/actions/finalize`.

## Scope

Retained from finalize:

- Create or update Postman environments from runtime URLs.
- Associate Postman environments to system environments through Bifrost.
- Create mock servers and smoke monitors from generated collections.
- Export Postman collections in the Collection v3 multi-file YAML directory structure under `postman/collections/` (e.g., `[Baseline] <name>/collection.yaml`, nested folder and request YAML files), and export environments plus `.postman/resources.yaml` into the repository.
- Link the Postman workspace to the repository (GitHub or GitLab) through Bifrost.
- Commit synced artifacts and push them back to the current checked out ref.

Removed from finalize:

- Generate Fern docs or write documentation URLs back to GitHub.
- Store AWS deployment orchestration concerns in the public action interface.
- Push directly to `main`.

For existing repositories, use `generate-ci-workflow: false` to avoid touching workflow files, or set `ci-workflow-path` to materialize the generated pipeline under a non-conflicting filename such as `.github/workflows/postman-sync.yml`.


### Git provider support

Workspace-to-repository linking via Bifrost supports both **GitHub** and **GitLab** (cloud and self-hosted) repository URLs. When `repo-url` is omitted, the action auto-detects the repository URL from `$GITHUB_REPOSITORY` (GitHub Actions) or `$CI_PROJECT_URL` (GitLab CI). You can also pass an explicit `repo-url` for any git provider.

### mTLS / Client Certificate Support

The generated CI workflow supports client certificates for testing APIs that require mTLS.

On GitHub, set these repository secrets:

- `POSTMAN_SSL_CLIENT_CERT_B64`
- `POSTMAN_SSL_CLIENT_KEY_B64`
- `POSTMAN_SSL_CLIENT_PASSPHRASE` (optional)
- `POSTMAN_SSL_EXTRA_CA_CERTS_B64` (optional)

When you pass the matching inputs to the action with a token that has `secrets:write`, the action can auto-persist these secrets for the generated workflow.

GitLab CI:

```yaml
variables:
  POSTMAN_SSL_CLIENT_CERT_B64: $POSTMAN_SSL_CLIENT_CERT_B64
  POSTMAN_SSL_CLIENT_KEY_B64: $POSTMAN_SSL_CLIENT_KEY_B64
  POSTMAN_SSL_CLIENT_PASSPHRASE: $POSTMAN_SSL_CLIENT_PASSPHRASE
  POSTMAN_SSL_EXTRA_CA_CERTS_B64: $POSTMAN_SSL_EXTRA_CA_CERTS_B64
```

Bitbucket Pipelines:

```yaml
definitions:
  variables:
    POSTMAN_SSL_CLIENT_CERT_B64: "$POSTMAN_SSL_CLIENT_CERT_B64"
    POSTMAN_SSL_CLIENT_KEY_B64: "$POSTMAN_SSL_CLIENT_KEY_B64"
    POSTMAN_SSL_CLIENT_PASSPHRASE: "$POSTMAN_SSL_CLIENT_PASSPHRASE"
    POSTMAN_SSL_EXTRA_CA_CERTS_B64: "$POSTMAN_SSL_EXTRA_CA_CERTS_B64"
```

> **Note:** Bitbucket secured variables have a size ceiling, so large cert chains may need to be split or stored elsewhere.

Azure DevOps:

```yaml
steps:
  - script: npx postman-repo-sync-action
    env:
      POSTMAN_SSL_CLIENT_CERT_B64: $(POSTMAN_SSL_CLIENT_CERT_B64)
      POSTMAN_SSL_CLIENT_KEY_B64: $(POSTMAN_SSL_CLIENT_KEY_B64)
      POSTMAN_SSL_CLIENT_PASSPHRASE: $(POSTMAN_SSL_CLIENT_PASSPHRASE)
      POSTMAN_SSL_EXTRA_CA_CERTS_B64: $(POSTMAN_SSL_EXTRA_CA_CERTS_B64)
```

> **Note:** Azure DevOps secret variables must be mapped into step `env`; do not reference them directly on the CLI.

### CLI Usage (Non-GitHub CI)

The `postman-repo-sync` CLI is available for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems that need the repo sync workflow outside GitHub Actions. GitHub Actions users should continue using the `action.yml` interface.

Install it globally:

```bash
npm install -g postman-repo-sync-action
```

Basic usage:

```bash
postman-repo-sync \
  --project-name core-payments \
  --workspace-id ws-123 \
  --baseline-collection-id col-baseline \
  --smoke-collection-id col-smoke \
  --contract-collection-id col-contract \
  --postman-api-key "$POSTMAN_API_KEY" \
  --result-json ./postman-repo-sync-result.json \
  --dotenv-path ./postman-repo-sync.env \
  --repo-write-mode commit-only
```

The CLI auto-detects the CI provider from environment variables and uses that context to resolve the repository branch, commit SHA, and repo URL. `--repo-write-mode` defaults to `commit-and-push`; use `commit-only` when push credentials are not configured.

JSON is written to stdout. Use `--result-json` to write the same JSON payload to a file, or `--dotenv-path` to emit shell-sourceable `KEY=VALUE` output with the `POSTMAN_REPO_SYNC_` prefix. All logs go to stderr, so stdout stays reserved for JSON output.

GitLab CI:

```yaml
repo_sync:
  image: node:20
  script:
    - npm install -g postman-repo-sync-action
    - postman-repo-sync --project-name core-payments --workspace-id ws-123 --baseline-collection-id col-baseline --smoke-collection-id col-smoke --contract-collection-id col-contract --postman-api-key "$POSTMAN_API_KEY" --result-json postman-repo-sync-result.json --dotenv-path postman-repo-sync.env --repo-write-mode commit-and-push
  artifacts:
    paths:
      - postman-repo-sync-result.json
      - postman-repo-sync.env
```

Bitbucket Pipelines:

```yaml
image: node:20

pipelines:
  default:
    - step:
        name: Postman repo sync
        script:
          - npm install -g postman-repo-sync-action
          - postman-repo-sync --project-name core-payments --workspace-id ws-123 --baseline-collection-id col-baseline --smoke-collection-id col-smoke --contract-collection-id col-contract --postman-api-key "$POSTMAN_API_KEY" --result-json postman-repo-sync-result.json --dotenv-path postman-repo-sync.env --repo-write-mode commit-and-push
        artifacts:
          - postman-repo-sync-result.json
          - postman-repo-sync.env
```

Azure DevOps:

```yaml
steps:
  - script: |
      npm install -g postman-repo-sync-action
      postman-repo-sync --project-name core-payments --workspace-id ws-123 --baseline-collection-id col-baseline --smoke-collection-id col-smoke --contract-collection-id col-contract --postman-api-key "$(POSTMAN_API_KEY)" --result-json $(Build.ArtifactStagingDirectory)/postman-repo-sync-result.json --dotenv-path $(Build.ArtifactStagingDirectory)/postman-repo-sync.env --repo-write-mode commit-and-push
    displayName: Postman repo sync
```

The CLI accepts the same repo-context signals as the action and auto-detects branch, SHA, and repo URL from provider-specific environment variables when available.

## Protected-branch repos: commit-only + customer-managed PR

If your repository enforces branch protection rules requiring all changes through pull requests, use `repo-write-mode: commit-only` to avoid direct pushes to `main`.

### How it works

1. **Create a sync branch:** Start the workflow on a temporary branch (e.g., `postman-sync/YYYYMMDD-HHmmss`) — this branch is unprotected.
2. **Run with commit-only:** Execute the action with `repo-write-mode: commit-only`. Artifacts are committed to the branch but **not** pushed to `main`.
3. **Create PR:** Your workflow uses `gh pr create` (or your platform's API) to open a pull request targeting `main`.
4. **Review & merge:** Your team reviews the PR and merges when ready to apply the artifacts.

### Understanding Postman vs. Repository state

**When the action completes successfully:**
- ✅ **Postman side:** Collections exported, environments synced, monitors/mocks created
- ⏳ **Repository side:** Artifacts committed to feature branch, PR opened, **merge still pending** your team's review

This separation is intentional:
- **Debug independently:** Verify Postman workspace health without repository concerns
- **Flexible approval:** Let your team's PR review process control when artifacts apply
- **Idempotent reruns:** Reuse existing Postman assets (workspace ID, collection IDs) when retrying repo operations

### Tracking merge state

Use the composite action's phase status outputs to distinguish Postman success from repo merge state:

```yaml
steps:
  - uses: postman-cs/postman-api-onboarding-action@v0
    id: onboarding
    with:
      repo-write-mode: commit-only
      # ... other inputs

  - name: Check sync state
    run: |
      echo "Bootstrap: ${{ steps.onboarding.outputs.bootstrap-status }}"
      echo "Repo Sync: ${{ steps.onboarding.outputs.repo-sync-status }}"
      echo "Commit SHA: ${{ steps.onboarding.outputs.commit-sha }}"
```

When `repo-sync-status` is `success` but your PR is pending, the artifacts are safely staged awaiting approval.

## Usage

```yaml
jobs:
  repo-sync:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: write
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
          system-env-map-json: '{"prod":"uuid-prod","stage":"uuid-stage"}'
          env-runtime-urls-json: '{"prod":"https://api.example.com","stage":"https://stage-api.example.com"}'
          environment-uids-json: '{}'
          repo-write-mode: commit-and-push
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          gh-fallback-token: ${{ secrets.GH_FALLBACK_TOKEN }}

  repo-sync-existing:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: write
      variables: write
    steps:
      - uses: actions/checkout@v4
      - uses: postman-cs/postman-repo-sync-action@v0
        with:
          project-name: core-payments
          workspace-id: ws-123
          baseline-collection-id: col-baseline
          smoke-collection-id: col-smoke
          contract-collection-id: col-contract
          generate-ci-workflow: false
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

## Current-ref push semantics

When `repo-write-mode=commit-and-push`, the action pushes back to the current checked out ref instead of hardcoding `main`. Resolution order is `current-ref`, then `GITHUB_HEAD_REF`, then `GITHUB_REF_NAME`. Pull request merge refs are normalized to `GITHUB_HEAD_REF`. Pushes use `HEAD:refs/heads/<resolved-branch>`.

If the action writes `.github/workflows/ci.yml`, provide a credential source that can update workflow files. The action prefers `gh-fallback-token` first for workflow-file pushes, then falls back to `github-token`.

### Collection v3 export

Collections are exported in the Postman Collection v3 format, producing a multi-file YAML directory structure under `postman/collections/`. Each collection (Baseline, Smoke, Contract) gets its own directory containing `collection.yaml` and nested folder/request YAML files. The `.postman/resources.yaml` manifest maps each v3 collection directory to its Postman UID.

The generated CI workflow reads `.postman/resources.yaml` directly to resolve the smoke/contract collection IDs and environment ID for Postman CLI runs. It does not depend on repository variables for those asset mappings.

To match the app scaffold more closely, repo-sync also ensures these directories exist under `postman/`:

- `collections`
- `environments`
- `flows`
- `globals`
- `mocks`
- `specs`

It also writes `postman/globals/workspace.globals.yaml` when missing.

Folder and request **names are truncated to 120 characters** per path segment when writing files (with an ellipsis). That avoids `ENAMETOOLONG` when Postman item names are very long (for example, copied from long OpenAPI operation summaries).

### Local spec metadata

Repo-sync now scans the repository for local OpenAPI files and records them in `.postman/resources.yaml` under `localResources.specs`.

- If `spec-path` is provided, it is used as the preferred local spec for `cloudResources.specs` and `.postman/workflows.yaml`.
- If `spec-path` is omitted and exactly one local OpenAPI file is found, that file is used automatically.
- If the local spec target is ambiguous or missing, repo-sync skips the spec cloud map and `workflows.yaml` rather than emitting incorrect relationships.

When a local spec file and exported collections are both available, repo-sync writes `.postman/workflows.yaml` with `syncSpecToCollection` entries so the spec↔collection relationship metadata matches the app more closely.

### Lifecycle and versioning

`collection-sync-mode` controls collection lifecycle behavior:

- `refresh` (default): always refresh assets and rewrite `.postman/resources.yaml` for the checked-out ref.
- `reuse`: reuse existing assets from explicit inputs or the checked-out ref's `.postman/resources.yaml`.
- `version`: require a release label (`release-label` input or `github-ref-name`), suffix collection export directories and mock/monitor names with that release label, and reuse only the checked-out ref's `.postman/resources.yaml` mappings.

`spec-sync-mode` supports `update` (default) and `version`. If either sync mode is `version`, this action requires a derived or explicit release label.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `generate-ci-workflow` | `true` | Set to `false` for existing repos that already own their CI workflow layout. |
| `ci-workflow-path` | `.github/workflows/ci.yml` | Redirect generated CI to a non-conflicting path for existing repos. |
| `project-name` | | Service name used for environments, mock servers, and monitors. |
| `workspace-id` | | Workspace identifier used for workspace-link and export metadata. |
| `baseline-collection-id` | | Baseline collection exported into the repo and used for mock generation. |
| `monitor-type` | `cloud` | Type of monitor to create (`cloud` or `cli`). `cli` uses GitHub Actions cron. |
| `smoke-collection-id` | | Smoke collection used for monitor creation. |
| `contract-collection-id` | | Contract collection exported into the repo. |
| `collection-sync-mode` | `refresh` | Collection lifecycle mode: `refresh`, `reuse`, or `version`. |
| `spec-sync-mode` | `update` | Spec lifecycle mode: `update` or `version`. |
| `release-label` | | Optional release label for versioned naming. Falls back to `github-ref-name` when omitted. |
| `spec-path` | | Optional repo-root-relative path to the local spec file for `resources.yaml` and `workflows.yaml` metadata. |
| `environments-json` | `["prod"]` | Environment slugs to create or update. |
| `repo-url` | | Explicit repository URL (GitHub or GitLab). Defaults to `https://github.com/$GITHUB_REPOSITORY` on GitHub Actions, or `$CI_PROJECT_URL` on GitLab CI. |
| `integration-backend` | `bifrost` | Public open-alpha starts with Bifrost only. |
| `workspace-link-enabled` | `true` | Keeps workspace linking in scope. |
| `environment-sync-enabled` | `true` | Keeps environment association in scope by default for the open-alpha demonstration path. |
| `system-env-map-json` | `{}` | JSON map of environment slug to system environment id. |
| `environment-uids-json` | `{}` | Optional explicit JSON map of environment slug to Postman environment uid. |
| `env-runtime-urls-json` | `{}` | JSON map of environment slug to runtime base URL. |
| `artifact-dir` | `postman` | Root directory for exported Postman artifacts. |
| `repo-write-mode` | `commit-and-push` | Generates files and pushes with current-ref semantics. |
| `current-ref` | | Optional explicit ref override for detached checkouts. |
| `committer-name` | `Postman CSE` | Commit author name for sync commits. |
| `committer-email` | `help@postman.com` | Commit author email for sync commits. |
| `postman-api-key` | | Postman API key for environment, mock, and monitor work. |
| `postman-access-token` | | Postman access token for Bifrost and system environment association. |
| `ssl-client-cert` | | Base64-encoded client certificate for mTLS-enabled API testing. |
| `ssl-client-key` | | Base64-encoded private key paired with `ssl-client-cert`. |
| `ssl-client-passphrase` | | Optional passphrase for the client key. |
| `ssl-extra-ca-certs` | | Base64-encoded extra CA certificates used to trust private certificate chains. |
| `github-token` | | GitHub token for commits, workflow updates, and optional secret persistence. |
| `gh-fallback-token` | | Fallback GitHub token for workflow-file and variable APIs. |
| `ci-workflow-base64` | | Optional base64-encoded workflow content that overrides the built-in CI template. |

### Contract smoke monitoring

This repo includes `.github/workflows/contract-smoke.yml`, a scheduled live contract check for the Postman and Bifrost endpoints used by repo-sync.

Configure these repository secrets before enabling the workflow:

- `SMOKE_ORG_API_KEY`
- `SMOKE_ORG_ACCESS_TOKEN`
- `SMOKE_NON_ORG_API_KEY`

The smoke workflow verifies `/me`, `/teams`, and Bifrost API key creation so upstream auth or response-shape changes are caught before they break repo-sync runs.

### Obtaining `postman-api-key`

The `postman-api-key` is a Postman API key (PMAK) used for all standard Postman API operations — creating workspaces, uploading specs, generating collections, exporting artifacts, and managing environments.

**To generate one:**

1. Open the Postman desktop app or web UI.
2. Go to **Settings** (gear icon) → **Account Settings** → **API Keys**.
3. Click **Generate API Key**, give it a label, and copy the key (starts with `PMAK-`).
4. Set it as a GitHub secret:
   ```bash
   gh secret set POSTMAN_API_KEY --repo <owner>/<repo>
   ```

> **Note:** The PMAK is a long-lived key tied to your Postman account. It does not require periodic renewal like the `postman-access-token`.

### Obtaining `postman-access-token` (Open Alpha)

> **⚠️ Open-alpha limitation:** The `postman-access-token` input requires a manually-extracted session token. There is currently no public API to exchange a Postman API key (PMAK) for an access token programmatically. This manual step will be eliminated before GA.

The `postman-access-token` is a Postman session token (`x-access-token`) required for internal API operations that the standard PMAK API key cannot perform — specifically workspace ↔ repo git sync (Bifrost) and system environment associations. Without it, those steps are silently skipped.

**To obtain and configure the token:**

1. **Log in via the Postman CLI** (requires a browser):
   ```bash
   postman login
   ```
   This opens a browser window for Postman's PKCE OAuth flow. Complete the sign-in.

2. **Extract the access token** from the CLI credential store:
   ```bash
   cat ~/.postman/postmanrc | jq -r '.login._profiles[].accessToken'
   ```

3. **Set it as a GitHub secret** on your repository or organization:
   ```bash
   # Repository-level secret
   gh secret set POSTMAN_ACCESS_TOKEN --repo <owner>/<repo>

   # Organization-level secret (recommended for multi-repo use)
   gh secret set POSTMAN_ACCESS_TOKEN --org <org> --visibility selected --repos <repo1>,<repo2>
   ```
   Paste the token value when prompted.

> **Important:** This token is session-scoped and will expire. When it does, operations that depend on it (workspace linking, system environment associations) will silently degrade. You will need to repeat the login and secret update process. There is no automated refresh mechanism.

> **Note:** `postman login --with-api-key` stores a PMAK — **not** the session token these APIs require. You must use the interactive browser login.

## Outputs

| Output | Meaning |
| --- | --- |
| `integration-backend` | Resolved integration backend for the run. |
| `resolved-current-ref` | Resolved push target based on current-ref semantics. |
| `workspace-link-status` | `success`, `skipped`, or `failed`. |
| `environment-sync-status` | `success`, `skipped`, or `failed`. |
| `environment-uids-json` | JSON map of environment slug to Postman environment uid. |
| `mock-url` | Created mock server URL. |
| `monitor-id` | Created smoke monitor UID. |
| `repo-sync-summary-json` | JSON summary of repo materialization and workspace sync outputs. |
| `commit-sha` | Commit SHA produced by repo-write-mode when a sync commit is created. |

## Local development

```bash
npm install
npm test
npm run typecheck
npm run build
```

`npm run build` produces the committed `dist/index.cjs` action bundle used by `action.yml`.

## Open-Alpha Release Strategy

- Open-alpha channel tags use `v0.x.y`.
- Consumers can pin immutable tags such as `v0.2.0` for reproducibility.
- Moving tag `v0` is used only as the rolling open-alpha channel.

## REST Migration Seam

The public input and output contract is backend-neutral. `integration-backend` defaults to `bifrost`, and backend-specific metadata remains internal so a future REST implementation can replace the backend without changing caller workflow syntax.
