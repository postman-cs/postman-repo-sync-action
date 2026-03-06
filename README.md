# postman-repo-sync-action

Public beta scaffold for the JavaScript GitHub Action that owns Postman-to-repo sync concerns split out of `api-catalog-demo-infra/.github/actions/finalize`.

## Beta scope

This Phase 1 scaffold defines the contract only. The runtime entrypoint is intentionally minimal and exposes the planned beta surface without performing the remote Postman, GitHub, or git side effects yet.

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

## Current-ref push semantics

When `repo-write-mode=commit-and-push`, the action pushes back to the current checked out ref instead of hardcoding `main`. Resolution order is `current-ref`, then `GITHUB_HEAD_REF`, then `GITHUB_REF_NAME`. If no ref can be resolved, the beta implementation reports an empty `resolved-current-ref` output and leaves the caller to decide whether to fail the workflow.

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
| `repo-write-mode` | `commit-and-push` | Plans generated file writes and a push using current-ref semantics. |
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
| `workspace-link-status` | `planned` or `skipped`. |
| `environment-sync-status` | `planned` or `skipped`. |
| `environment-uids-json` | JSON map of environment slug to Postman environment uid. |
| `mock-url` | Mock server URL placeholder for the beta contract. |
| `monitor-id` | Smoke monitor ID placeholder for the beta contract. |
| `repo-sync-summary-json` | JSON summary of repo materialization and workspace sync planning. |
| `commit-sha` | Commit SHA placeholder for repo-write-mode. |
