# postman-repo-sync-action

Public beta GitHub Action that owns Postman-to-repo sync concerns split out of `api-catalog-demo-infra/.github/actions/finalize`.

## Scope

Retained from finalize:

- Create or update Postman environments from runtime URLs.
- Associate Postman environments to system environments through Bifrost.
- Create mock servers and smoke monitors from generated collections.
- Persist repo variables and export existing Postman collections and environments into the repository under `postman/` and `.postman/`.
- Link the Postman workspace to the GitHub repository through Bifrost.
- Commit synced artifacts and push them back to the current checked out ref.

Removed from finalize:

- Generate Fern docs or write documentation URLs back to GitHub.
- Store AWS deployment orchestration concerns in the public action interface.
- Push directly to `main`.

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
```

## Current-ref push semantics

When `repo-write-mode=commit-and-push`, the action pushes back to the current checked out ref instead of hardcoding `main`. Resolution order is `current-ref`, then `GITHUB_HEAD_REF`, then `GITHUB_REF_NAME`. Pull request merge refs are normalized to `GITHUB_HEAD_REF`. Pushes use `HEAD:refs/heads/<resolved-branch>`.

If the action writes `.github/workflows/ci.yml`, provide a credential source that can update workflow files. The beta prefers `gh-fallback-token` first for workflow-file pushes, then falls back to `github-token`.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `workspace-id` | | Workspace identifier used for workspace-link and export metadata. |
| `repo-url` | | Explicit repository URL. Defaults to `https://github.com/${GITHUB_REPOSITORY}` at runtime when omitted. |
| `integration-backend` | `bifrost` | Public beta starts with Bifrost only. |
| `workspace-link-enabled` | `true` | Keeps workspace linking in scope. |
| `environment-sync-enabled` | `true` | Keeps environment association in scope by default for the beta demonstration path. |
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

## Beta Release Strategy

- Beta channel tags use `v0.x.y`.
- Consumers can pin immutable tags such as `v0.2.0` for reproducibility.
- Moving tag `v0` is used only as the rolling beta channel.

## REST Migration Seam

The public input and output contract is backend-neutral. `integration-backend` defaults to `bifrost`, and backend-specific metadata remains internal so a future REST implementation can replace the backend without changing caller workflow syntax.
