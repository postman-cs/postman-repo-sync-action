# Support

## Usage help

Open a GitHub issue for setup questions, confusing errors, or documentation gaps. Include:

- the action version tag, such as `v1` or `v1.0.3`
- the workflow step using this action
- the selected `postman-region`
- whether `credential-preflight` is `warn` or `enforce`
- redacted logs from the failing step

Do not include Postman API keys, access tokens, GitHub tokens, collection secrets, or certificate private keys.

## Marketplace workflow checks

Before opening an issue, verify:

- `actions/checkout` runs before repo sync
- the job has `contents: write` when `repo-write-mode` commits or pushes
- the job has `actions: write` when `generate-ci-workflow` writes under `.github/workflows/`
- `postman-region` matches the target Postman team
- the access token came from `postman-resolve-service-token-action` unless you are doing a legacy local compatibility check

## Security reports

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).
