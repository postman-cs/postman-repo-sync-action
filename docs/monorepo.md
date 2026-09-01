# Monorepo onboarding

Use one workflow under the repository-root `.github/workflows/` directory. GitHub does not load
workflow files stored inside service directories.

## Layout

```text
services/
  payments/
    openapi.yaml
    src/
    postman/
    .postman/
  orders/
    openapi.yaml
    src/
    postman/
    .postman/
.github/workflows/postman-monorepo.yml
```

Pass `working-directory: services/<service>` to the API onboarding composite or to bootstrap,
smoke-flow, and repo-sync individually. Relative inputs and generated `postman/` and `.postman/`
artifacts then belong to that service. The action rejects absolute paths, lexical traversal, missing
directories, non-directories, and symlinks that resolve outside the checkout.

Repo-sync discovers the parent Git repository while it runs inside the service directory. Its path
guards prevent a sync commit from staging a sibling service. `generate-ci-workflow` still defaults to
`true` at the repository root, but defaults to `false` when `working-directory` is set. An explicit
`generate-ci-workflow: true` with `working-directory` fails because the resulting nested workflow
would be ignored by GitHub.

## Dispatcher

Start from the composite action's
[monorepo dispatcher example](https://github.com/postman-cs/postman-api-onboarding-action/blob/main/examples/monorepo-dispatcher.yml).
It uses full Git history to handle push and pull-request ranges, emits JSON matrices for changed
services, serializes onboarding jobs that commit to the shared branch, and runs collection checks in
parallel.

The code-change detector excludes each service's `postman/**` and `.postman/**` trees so repo-sync's
artifact commit does not start another onboarding run. It also skips onboarding when the head commit
uses repo-sync's default `Postman <support@postman.com>` committer identity. Keep the path exclusion as
the primary guard and the committer check as a backstop.

Use one workspace per service by default and set `project-name` to the service name. A shared Postman
workspace is supported by passing the same workspace ID to each service, but artifact state remains
service-local.

## Credentials

Store a service-account PMAK in the repository-level `POSTMAN_API_KEY` secret. Each action can mint
its short-lived access token from that key. Collection runs still require `postman login
--with-api-key`; they do not accept the access token as a login replacement.

## Locked-down runners

The npm CLIs accept the same `--working-directory services/<service>` flag. Run them from the
monorepo root so the flag is resolved against the checkout boundary:

```sh
postman-bootstrap --working-directory services/payments --project-name payments --spec-path openapi.yaml
postman-smoke-flow --working-directory services/payments --project-name payments
postman-repo-sync --working-directory services/payments --project-name payments --generate-ci-workflow false
```

See [Self-contained binary](self-contained-binary.md) for proxy, host allowlist, and downstream
Postman CLI requirements.
