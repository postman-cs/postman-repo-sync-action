# Credentials

Use a [service-account](https://learning.postman.com/docs/administration/service-accounts/) Postman API key as the durable secret, then mint short-lived credentials in CI with `postman-cs/postman-resolve-service-token-action@v1`.

```yaml
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

## Auth matrix

| Credential | Used for | Primary source | Notes |
| --- | --- | --- | --- |
| `postman-api-key` | Postman API operations for collections, environments, mocks, monitors, and exports. | `POSTMAN_API_KEY` repository secret backed by a service-account PMAK. | Required unless `postman-access-token` can generate a replacement PMAK at runtime. |
| `postman-access-token` | Workspace repository linking, system environment association, and generated PMAK creation. | `postman-resolve-service-token-action` output `token`. | The preflight warns when this is a non-service-account access token. |
| `team-id` | Team context for org-mode integration calls. | `postman-resolve-service-token-action` output `team-id`. | Omit it only when `POSTMAN_TEAM_ID` is set or auto-detection is enough for the team. |
| `github-token` | Commits, pushes, and generated workflow updates. | `${{ secrets.GITHUB_TOKEN }}` with workflow `permissions`. | Needs `contents: write` for commits and pushes. Needs `actions: write` when writing `.github/workflows/*`. |
| `gh-fallback-token` | Repository APIs that the default `GITHUB_TOKEN` cannot perform. | Fine-grained PAT or GitHub App token. | Use for Actions secret persistence, protected workflow-file updates, or repositories where `GITHUB_TOKEN` is intentionally restricted. |

## `postman-api-key`

Create a service-account [Postman API key](https://learning.postman.com/docs/reference/postman-api/authentication/) in Postman and store it as the `POSTMAN_API_KEY` repository secret. The same key can be passed to `postman-resolve-service-token-action` and to repo sync. For rotation and revocation, see Postman's [managing API keys](https://learning.postman.com/docs/administration/managing-your-team/managing-api-keys/) guide.

If the PMAK is missing or expired and `postman-access-token` is available, repo sync can generate a replacement PMAK. To persist that generated key back to the repository, provide a `github-token` or `gh-fallback-token` that can manage Actions secrets.

## `postman-access-token`

The primary path is `postman-resolve-service-token-action`, which mints a fresh service-account access token at runtime and returns it as `steps.<id>.outputs.token`.

Legacy fallback: for local compatibility checks, the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-auth/) can expose a user session token:

```bash
postman login
cat ~/.postman/postmanrc | jq -r '.login._profiles[].accessToken'
```

Do not use that CLI-derived token as the normal CI credential. It expires with the user session, and repo sync logs a warning when preflight resolves a non-service-account access token.

If `postman-access-token` is omitted, workspace linking, system environment association, and generated PMAK creation are skipped. Artifact export can still run with `postman-api-key` alone.

## Credential preflight

The `credential-preflight` input accepts only these values:

| Value | Behavior |
| --- | --- |
| `warn` | Default. Logs identity notes and continues when `postman-api-key` and `postman-access-token` resolve to different parent orgs. |
| `enforce` | Fails before repo sync work when the credentials resolve to different parent orgs. |

Both modes resolve the access-token session when possible and warn if the token is not a service-account token. There is no public opt-out for credential preflight.

## GitHub permissions

For the default `GITHUB_TOKEN`, set permissions on the job:

```yaml
permissions:
  contents: write
  actions: write
```

`contents: write` is required when `repo-write-mode` commits or pushes generated artifacts. `actions: write` is required when the generated CI workflow is written under `.github/workflows/`. If the workflow must also write repository secrets, pass `gh-fallback-token` with permission to manage Actions secrets.
