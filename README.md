# postman-repo-sync-action

Public open-alpha GitHub Action that owns Postman-to-repo sync concerns split out of `api-catalog-demo-infra/.github/actions/finalize`.

## Scope

Retained from finalize:

- Create or update Postman environments from runtime URLs.
- Associate Postman environments to system environments through Bifrost.
- Create mock servers and smoke monitors from generated collections.
- Export Postman collections in the Collection v3 multi-file YAML directory structure under `postman/collections/` (e.g., `[Baseline] <name>/collection.yaml`, nested folder and request YAML files). Persist repo variables and export environments into the repository under `postman/` and `.postman/`.
- Link the Postman workspace to the GitHub repository through Bifrost.
- Commit synced artifacts and push them back to the current checked out ref.

Removed from finalize:

- Generate Fern docs or write documentation URLs back to GitHub.
- Store AWS deployment orchestration concerns in the public action interface.
- Push directly to `main`.

For existing repositories, use `generate-ci-workflow: false` to avoid touching workflow files, or set `ci-workflow-path` to materialize the generated pipeline under a non-conflicting filename such as `.github/workflows/postman-sync.yml`.

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

### Monitors: CLI vs cloud

- **No `monitor-cron`** (default): A CLI monitor is created (no Postman cloud schedule). The generated CI workflow includes a **Run Smoke Monitor** step that runs `postman monitor run` on every pipeline run (push/PR), so tests run in your CI without consuming scheduled monitor runs.
- **`monitor-cron` set**: A cloud monitor is created and runs on that schedule from Postman's infrastructure.

The action outputs `monitor-type` (`cli` or `cloud`) so callers can branch if needed.

### Collection v3 export

Collections are exported in the Postman Collection v3 format, producing a multi-file YAML directory structure under `postman/collections/`. Each collection (Baseline, Smoke, Contract) gets its own directory containing `collection.yaml` and nested folder/request YAML files. The `.postman/resources.yaml` manifest maps each v3 collection directory to its Postman UID.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `generate-ci-workflow` | `true` | Set to `false` for existing repos that already own their CI workflow layout. |
| `ci-workflow-path` | `.github/workflows/ci.yml` | Redirect generated CI to a non-conflicting path for existing repos. |
| `project-name` | | Service name used for environments, mock servers, and monitors. |
| `workspace-id` | | Workspace identifier used for workspace-link and export metadata. |
| `baseline-collection-id` | | Baseline collection exported into the repo and used for mock generation. |
| `smoke-collection-id` | | Smoke collection used for monitor creation. |
| `contract-collection-id` | | Contract collection exported into the repo. |
| `monitor-id` | | Existing smoke monitor ID. When set the action skips monitor creation. |
| `mock-url` | | Existing mock server URL. When set the action skips mock creation. |
| `monitor-cron` | `""` | Cron expression for monitor scheduling (e.g. `0 */6 * * *`). When empty a **CLI monitor** is created (runs only when triggered by the generated CI step). When set, a **cloud monitor** runs on that schedule. |
| `environments-json` | `["prod"]` | Environment slugs to create or update. |
| `repo-url` | | Explicit repository URL. Defaults to `https://github.com/${GITHUB_REPOSITORY}` at runtime when omitted. |
| `integration-backend` | `bifrost` | Public open-alpha starts with Bifrost only. |
| `workspace-link-enabled` | `true` | Keeps workspace linking in scope. |
| `environment-sync-enabled` | `true` | Keeps environment association in scope by default for the open-alpha demonstration path. |
| `system-env-map-json` | `{}` | JSON map of environment slug to system environment id. |
| `environment-uids-json` | `{}` | JSON map of environment slug to Postman environment uid. |
| `env-runtime-urls-json` | `{}` | JSON map of environment slug to runtime base URL. |
| `artifact-dir` | `postman` | Root directory for exported Postman artifacts. |
| `repo-write-mode` | `commit-and-push` | Generates files and pushes with current-ref semantics. |
| `current-ref` | | Optional explicit ref override for detached checkouts. |
| `committer-name` | `Postman FDE` | Commit author name for sync commits. |
| `committer-email` | `fde@postman.com` | Commit author email for sync commits. |
| `postman-api-key` | | Postman API key for environment, mock, and monitor work. |
| `postman-access-token` | | Postman access token for Bifrost and system environment association. |
| `github-token` | | GitHub token for repo variables and commits. |
| `gh-fallback-token` | | Fallback GitHub token for workflow-file and variable APIs. |
| `github-auth-mode` | `github_token_first` | GitHub auth mode for repo variable APIs. |
| `ci-workflow-base64` | | Optional base64-encoded workflow content that overrides the built-in CI template. |

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
| `monitor-type` | `cli` (triggered from CI) or `cloud` (runs on a Postman schedule). |
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
