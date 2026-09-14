# Credentials

Use a [service-account](https://learning.postman.com/docs/administration/service-accounts/) Postman API key as the durable secret, then mint short-lived credentials in CI with `postman-cs/postman-resolve-service-token-action@v2`.

```yaml
- id: postman-auth
  uses: postman-cs/postman-resolve-service-token-action@v2
  with:
    postman-region: us
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}

- uses: postman-cs/postman-repo-sync-action@v2
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
| `postman-api-key` | Minting and re-minting the access token, `GET /me` validity checks, and the Postman CLI `login --with-api-key` step in the generated CI workflow. | `POSTMAN_API_KEY` repository secret backed by a service-account PMAK. | Optional when a valid `postman-access-token` is supplied; required as the mint source when it is omitted. |
| `postman-access-token` | Collection reads, environments, mocks, monitors, workspace repository linking, system environment association, and generated PMAK creation through the access-token gateway. | `postman-resolve-service-token-action` output `token`. | When omitted, repo-sync mints it from a service-account PMAK. |
| `team-id` | Team context for org-mode integration calls. | `postman-resolve-service-token-action` output `team-id`. | Omit it only when `POSTMAN_TEAM_ID` is set or auto-detection is enough for the team. |
| `github-token` | Commits, pushes, and generated workflow updates. | `${{ secrets.GITHUB_TOKEN }}` with workflow `permissions`. | Needs `contents: write` for commits and pushes. Needs `actions: write` when writing `.github/workflows/*`. |
| `gh-fallback-token` | Repository APIs that the default `GITHUB_TOKEN` cannot perform. | Fine-grained PAT or GitHub App token. | Use for Actions secret persistence, protected workflow-file updates, or repositories where `GITHUB_TOKEN` is intentionally restricted. |

## `postman-api-key`

Create a service-account [Postman API key](https://learning.postman.com/docs/reference/postman-api/authentication/) in Postman and store it as the `POSTMAN_API_KEY` repository secret. The same key can be passed to `postman-resolve-service-token-action` and to repo sync. For rotation and revocation, see the [managing API keys](https://learning.postman.com/docs/administration/managing-your-team/managing-api-keys/) guide.

If the PMAK is missing or expired and `postman-access-token` is available, repo sync can generate a replacement PMAK. To persist that generated key back to the repository, provide a `github-token` or `gh-fallback-token` that can manage Actions secrets.

## `postman-access-token`

The primary path is `postman-resolve-service-token-action`, which mints a fresh service-account access token at runtime and returns it as `steps.<id>.outputs.token`.

Legacy fallback: for local compatibility checks, the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-auth/) can expose a user session token:

```bash
postman login
cat ~/.postman/postmanrc | jq -r '.login._profiles[].accessToken'
```

Do not use that CLI-derived token as the normal CI credential. It expires with the user session, and repo sync logs a warning when preflight resolves a non-service-account access token.

`postman-access-token` is effectively required at runtime. Every asset operation (environment create/get/update, collection read, mock, monitor) plus workspace linking and system environment association runs through the access-token gateway. The caller may supply the token directly or let repo-sync mint it from a service-account `postman-api-key` (`mintAccessTokenIfNeeded`, `src/lib/postman/token-provider.ts`); the action fails only when neither yields a token. The `postman-api-key` mints/re-mints that token and logs in the Postman CLI for the generated workflow's `postman collection run` — it is never an asset-routing fallback.

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
