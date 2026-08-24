# Artifact Layout and Collection v3 Format

This page covers the full detail of what `postman-cs/postman-repo-sync-action` writes into a repository. The short operational version lives in the [README](../README.md).

## Directory structure

The default artifact root is `postman/`. The action ensures these directories exist:

- `postman/collections`
- `postman/environments`
- `postman/flows`
- `postman/globals`
- `postman/mocks`
- `postman/specs`

It also writes `.postman/resources.yaml`, the reusable state file. The generated CI workflow reads that file to resolve smoke collection, contract collection, and environment IDs for Postman CLI runs.

The generated files are intended to be committed when `repo-write-mode` is `commit-only` or `commit-and-push`. Review changes under `postman/` and `.postman/` the same way you review source changes, because they are the workflow's durable Postman state.

## Collection v3 multi-file YAML

Collections are exported in the Postman Collection v3 format (`$schema: https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/`) as a directory tree rather than a single JSON file. Each collection and folder has a `.resources/definition.yaml`; requests are separate `*.request.yaml` files:

```text
postman/collections/core-payments/
  .resources/definition.yaml
  <folder>/.resources/definition.yaml
  <request>.request.yaml
postman/collections/[Smoke] core-payments/
  .resources/definition.yaml
  <folder>/.resources/definition.yaml
  <request>.request.yaml
```

Definitions and request files use `$kind:` discriminators (for example, `$kind: collection` and `$kind: http-request`). The legacy `collection.yaml`/`folder.yaml`/`type:` layout is not written; `postman collection lint` rejects it. This layout keeps diffs reviewable: a change to one request shows up as a change to one file.

Environment files mirror Postman v12 Local Mode's canonical filesystem serializer: values contain `key`, optional `value`, `disabled`, `description`, `secret`, and `source` fields, and the environment can carry a valid integer `color`. Resolved `secret: true` entries omit `value`, and legacy `type: secret` values are redacted into canonical secret entries before repository serialization. Filenames use the same sanitization rules on the full stable cloud display name and remain unchanged across versioned runs; names that collide under Unicode normalization or case-folding fail closed. During legacy migration, repo-sync atomically promotes each validated YAML and `.postman/resources.yaml` before deleting a JSON file whose prior manifest UID matches. Conflicting ownership and untracked current YAML targets fail before cloud mutation; untracked legacy JSON is preserved with a warning. A failed manifest promotion leaves the legacy JSON recoverable; spec-only runs preserve environment mappings and artifacts as-is.

## Environment definition and lifecycle inputs

`environments-json` remains the legacy string-slug contract for branch-owned environments. Durable customer environments use `durable-environments-json`, a rich-object array shaped as `{slug, values}`. Rich values support `key`, `value`, `type`, and `enabled`. Empty `type: secret` slots are allowed, but populated secrets fail before cloud work. IDs, UIDs, names, paths, export metadata, unknown fields, duplicate identities, and the action-owned `x-pm-onboarding` key are rejected.

Durable operation defaults to `off`. `plan` emits a value-free projection; `apply` runs a fresh live plan and writes only on the configured durable state ref. `create-only` creates absent assets and preserves reviewed existing UIDs. `refresh` replaces the complete value set for reviewed UIDs. Exact-name discovery alone never adopts an existing environment. Preview/channel and dedicated Mock environments retain their separate action-owned lifecycle.

Note that v3 collections are run with `postman collection run` (Postman CLI). Newman cannot execute the v3 format.

## Spec and workflow metadata

`.postman/resources.yaml` is state v3 after durable provisioning. Canonical mappings remain the sole UID authority, while `environmentProvisioning` adds durable logical metadata without duplicating UIDs. State v2 remains accepted as migration input. For example:

The canonical UID maps remain `canonical.collections`, `canonical.environments`, and `canonical.specs`.

```yaml
version: 3
workspace:
  id: <workspace UID>
canonical:
  collections:
    ../postman/collections/core-payments: <collection UID>
  environments:
    ../postman/environments/<project-slug> - prod.environment.yaml: <environment UID>
  specs:
    ../openapi.yaml: <spec UID>
```

The action writes each mapping only when that resource is available. When a mapped spec and exported collections are both present, `.postman/workflows.yaml` is written with `syncSpecToCollection` metadata that ties the spec to its generated collections.

## Versioned runs

When `collection-sync-mode` or `spec-sync-mode` is `version`, the action requires a release label (`release-label` input, or a usable ref name) and:

- suffixes exported collection directories, mock names, and monitor names with the label
- writes `.postman/releases.yaml`, a release manifest with spec and collection UIDs per tag

## Sync mode reference

`collection-sync-mode` controls collection lifecycle:

| Mode | Behavior |
| --- | --- |
| `refresh` | Refresh exports and rewrite resource mappings for the current ref. |
| `version` | Require a release label and suffix exported collection directories, mock names, and monitor names with that label. |

`spec-sync-mode` supports:

| Mode | Behavior |
| --- | --- |
| `update` | Keep the current spec mapping updated. |
| `version` | Require a release label and use versioned metadata. |
