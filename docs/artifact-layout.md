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

## Collection v3 multi-file YAML

Collections are exported in the Postman Collection v3 format (`$schema: https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/`) as a directory tree rather than a single JSON file. Each collection becomes a directory containing a `collection.yaml` plus one YAML file per folder and per request:

```text
postman/collections/[Smoke] core-payments/
  collection.yaml
  <folder>.yaml
  <request>.yaml
```

This layout keeps diffs reviewable: a change to one request shows up as a change to one file. Long Postman folder and request names are truncated to 120 characters per path segment when files are written.

Note that v3 collections are run with `postman collection run` (Postman CLI). Newman cannot execute the v3 format.

## Spec and workflow metadata

When a local OpenAPI spec is found, `.postman/resources.yaml` records it under `localResources.specs`. If `spec-id` and an unambiguous local spec are available, the action also maps the spec under `cloudResources.specs`. When a mapped spec and exported collections are both present, `.postman/workflows.yaml` is written with `syncSpecToCollection` metadata that ties the spec to its generated collections.

## Versioned runs

When `collection-sync-mode` or `spec-sync-mode` is `version`, the action requires a release label (`release-label` input, or a usable ref name) and:

- suffixes exported collection directories, mock names, and monitor names with the label
- writes `.postman/releases.yaml`, a release manifest with spec and collection UIDs per tag

## Sync mode reference

`collection-sync-mode` controls collection lifecycle:

| Mode | Behavior |
| --- | --- |
| `refresh` | Refresh exports and rewrite resource mappings for the current ref. |
| `reuse` | Reuse explicit IDs or IDs already present in `.postman/resources.yaml`. |
| `version` | Require a release label and suffix exported collection directories, mock names, and monitor names with that label. |

`spec-sync-mode` supports:

| Mode | Behavior |
| --- | --- |
| `update` | Keep the current spec mapping updated. |
| `version` | Require a release label and use versioned metadata. |
