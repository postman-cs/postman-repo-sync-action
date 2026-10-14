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

Note that v3 collections are run with `postman collection run` (Postman CLI). Newman cannot execute the v3 format.

## Spec and workflow metadata

`.postman/resources.yaml` is state v2. Its current mappings are canonical: `canonical.collections`, `canonical.environments`, and `canonical.specs` map repository-relative artifact paths to Postman resource UIDs. For example:

```yaml
version: 2
workspace:
  id: <workspace UID>
canonical:
  collections:
    ../postman/collections/core-payments: <collection UID>
  environments:
    ../postman/environments/core-payments - prod.environment.yaml: <environment UID>
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
