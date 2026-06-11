# Credentials

## `postman-api-key`

Create a Postman API key in Postman under **Settings -> Account Settings -> API Keys**, then store it as the `POSTMAN_API_KEY` repository secret. The API key covers standard Postman API operations: environments, mock servers, monitors, and collection export.

## `postman-access-token`

The `postman-access-token` value is a session token used for integration APIs that are not covered by the API key: workspace-to-repository linking, system environment association, and API key generation. To obtain it:

```bash
postman login
cat ~/.postman/postmanrc | jq -r '.login._profiles[].accessToken'
```

Store that value as `POSTMAN_ACCESS_TOKEN`. It expires with the Postman session and must be refreshed when integration steps start skipping or failing because of authentication.

If `postman-access-token` is omitted, the integration steps are skipped and the remaining artifact sync still runs with `postman-api-key` alone. Provide a valid `postman-api-key`, or provide `postman-access-token` so the action can generate one.

## Credential preflight

The `credential-preflight` input controls what happens when `postman-api-key` and `postman-access-token` resolve to different parent organizations:

- `warn` (default) logs a note and continues
- `enforce` fails the run before any workspace is touched
- `off` skips the identity probes entirely

## GitHub tokens

- `github-token` handles commits, pushes, workflow updates, and secret persistence. `contents: write` is required when `repo-write-mode` commits files; `actions: write` is required when the action writes workflow files.
- `gh-fallback-token` is recommended when the default `GITHUB_TOKEN` cannot update workflow files or repository secrets.
