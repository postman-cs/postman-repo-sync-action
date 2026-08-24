# CLI Usage

The npm package ships a `postman-repo-sync` binary for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems.

```bash
npm install -g @postman/onboarding-repo-sync

postman-repo-sync \
  --project-name core-payments \
  --postman-region us \
  --workspace-id ws-123 \
  --baseline-collection-id col-baseline \
  --smoke-collection-id col-smoke \
  --contract-collection-id col-contract \
  --postman-api-key "$POSTMAN_API_KEY" \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN" \
  --team-id "$POSTMAN_TEAM_ID" \
  --result-json postman-repo-sync-result.json \
  --dotenv-path postman-repo-sync.env \
  --repo-write-mode commit-only
```

The CLI auto-detects repository URL, branch, and SHA from common CI environment variables (GitHub, GitLab, Bitbucket, Azure DevOps). It writes JSON to stdout, writes the same JSON to `--result-json`, and optionally writes shell-sourceable `POSTMAN_REPO_SYNC_*` values to `--dotenv-path`. Logs go to stderr.

For every non-gated execution — including `--repo-write-mode none`, which still generates artifact and CI files — `--result-json` must stay outside generated or staged paths: the artifact root, `.postman/`, generated CI/preview-GC workflow files, and a staged legacy provision workflow. Path checks resolve symlink aliases and compare path components, so a sibling such as `postman-results/result.json` remains valid beside the default `postman/` artifact root.

Use the same `postman-region` value as the target Postman team. For CI, prefer a service-account access token minted immediately before the CLI runs, then pass that token through `POSTMAN_ACCESS_TOKEN` and the resolved team ID through `POSTMAN_TEAM_ID`.

CLI flags mirror the action inputs (kebab-case, prefixed with `--`). See the Inputs table in the [README](../README.md) for the full list.

Durable environment definitions are passed as one shell-quoted JSON argument. They use repo-sync's `{slug, values}` schema rather than a raw exported Postman environment:

```bash
DURABLE_ENVIRONMENTS_JSON='[{"slug":"dev-refresh","values":[{"key":"baseUrl","value":"https://dev-refresh.example.com"},{"key":"variable1","value":"value1"},{"key":"jwtToken","value":"","type":"secret"}]}]'

postman-repo-sync \
  --project-name core-payments \
  --workspace-id ws-123 \
  --durable-environments-json "$DURABLE_ENVIRONMENTS_JSON" \
  --durable-environment-operation apply \
  --durable-environment-policy create-only \
  --durable-project-key core-payments \
  --durable-state-ref develop \
  --repo-write-mode commit-and-push
```

Never place a JWT or other credential value in this JSON. Keep the secret slot empty and inject the runtime value into `postman collection run` from the CI secret provider. Durable definitions are isolated from legacy `--environments-json` and `--env-runtime-urls-json`. Apply requires `commit-and-push` publication from the configured durable state ref; `commit-only` is rejected because a fresh runner could not recover the binding. An untracked exact-name environment requires explicit reviewed UID adoption.
