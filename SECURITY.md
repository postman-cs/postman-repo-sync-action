# Security Policy

## Supported Versions

Only the latest `v1.x.y` release (tracked by the rolling `v1` alias) receives security fixes. Older tags remain published for reproducibility and are never retroactively modified.

## Reporting a Vulnerability

Please do not open a public issue for security reports.

- Preferred: use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").
- Alternative: email [security@postman.com](mailto:security@postman.com) and mention the repository name.

You should receive an acknowledgement within five business days. Please include reproduction steps, the action version tag, and any relevant (redacted) workflow logs.

## Scope Notes

- This action handles Postman API keys, service-account access tokens, generated API keys, GitHub tokens, and optional mTLS certificate material. They are masked in action logs; never echo them in your own workflow steps.
- Use `postman-resolve-service-token-action` to mint service-account access tokens in CI. User/session access tokens are a legacy fallback and cause a repo-sync preflight warning when detected.
- Keep `credential-preflight` at `warn` or `enforce`. There is no public opt-out because mismatched Postman credentials can create assets in one team while linking or governance runs under another.
- Reports about secrets exposed in your own workflow configuration are out of scope for this repository. Rotate the credential in Postman or GitHub immediately.
- Do not include raw tokens, unredacted workflow logs, private collection contents, or certificate private keys in vulnerability reports.
