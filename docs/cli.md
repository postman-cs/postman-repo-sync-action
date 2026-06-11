# CLI Usage

The npm package ships a `postman-repo-sync` binary for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems.

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

The CLI auto-detects repository URL, branch, and SHA from common CI environment variables (GitHub, GitLab, Bitbucket, Azure DevOps). It writes JSON to stdout, writes the same JSON to `--result-json`, and optionally writes shell-sourceable `POSTMAN_REPO_SYNC_*` values to `--dotenv-path`. Logs go to stderr.

CLI flags mirror the action inputs (kebab-case, prefixed with `--`). See the Inputs table in the [README](../README.md) for the full list.
