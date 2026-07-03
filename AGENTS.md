# postman-repo-sync-action

Syncs Postman artifacts into a git repository: exports collections as Collection v3 multi-file YAML, creates/updates environments with runtime URLs, creates mock servers and smoke monitors, links workspace to repo via Bifrost, generates CI workflow, and commits/pushes results. Dual entry: GitHub Action and CLI.

## Structure

```
src/
  index.ts                  # Main orchestration: envs -> mocks -> monitors -> export -> CI -> commit
  cli.ts                    # CLI adapter for non-GitHub CI
  lib/
    postman/
      postman-assets-client.ts     # Postman API client (envs, mocks, monitors, collection export)
      internal-integration-adapter.ts  # Bifrost adapter (workspace linking, system env association)
    github/
      repo-mutation.ts             # Git commit/push logic, ref resolution
    repo/
      context.ts                   # CI provider auto-detection (GitHub, GitLab, Bitbucket, Azure)
    ci-workflow-template.ts        # Template for generated .github/workflows/ci.yml
    ssl-validation.ts              # mTLS cert material validation
    retry.ts, secrets.ts, http-error.ts  # Shared utilities (duplicated from bootstrap)
  postman-v3/
    converter.ts                   # Collection -> canonical v3 multi-file YAML (official @postman libs)
tests/
```

## Collection conversion invariant (do not violate)

- **Source = access-token gateway.** Collections are pulled via the gateway `GET /v3/collections/:id/export` (returns canonical v3). PMAK is used ONLY to mint the access-token — never for any data call.
- **Always write v3, never v2.** Allowed: v2->v3. Forbidden: writing raw v2 (v2->v2) and down-converting v3->v2. Anything read as v3 is written as v3 directly — never round-tripped through v2. (The old `v3-export-to-v2.ts` down-map was deleted for this reason.)
- **converter.ts uses `@postman/runtime.models` + `@postman/v3.export`** — `transform(V2->V3)` + `splitCollection` — the same pipeline `postman collection migrate` runs. We do NOT hand-roll conversion. Entry points:
  - `convertAndSplitAnyCollection(payload, dir)` — the sync path's entry; auto-detects v2 vs v3 and routes.
  - `convertAndSplitCollection(v2, dir)` — v2.1 -> canonical v3 (for customers still on v2).
  - `convertAndSplitV3Collection(v3Export, dir)` — gateway v3 export -> canonical v3, written directly.
- Output is the canonical layout (`.resources/definition.yaml`, folder dirs, `<name>.request.yaml`, `$kind:`); the legacy `collection.yaml`/`type:` dialect is rejected by current `postman collection lint` (FMT015). `splitCollection` owns long-name truncation + duplicate-sibling naming.

## Commands

```bash
npm ci && npm test && npm run typecheck && npm run build
npm run verify:dist  # CI/hook gate: rebuild + git diff (dev runs build)
```

## Key Behaviors

- **Collection v3 export**: `converter.ts` transforms single-JSON Postman collections into a directory tree: `postman/collections/name/collection.yaml` for the baseline collection and `[Smoke] name` / `[Contract] name` directories for generated assertion collections, with nested folder/request YAML files.
- **Environment management**: Creates Postman environments per slug in `environments-json`, injects runtime URLs from `env-runtime-urls-json`, associates with system environments via Bifrost.
- **Mock/Monitor creation**: Creates mock server from baseline collection, smoke monitor from smoke collection. Supports reuse via `mock-url` and `monitor-id` inputs. Monitor scheduling via `monitor-cron`.
- **CI workflow generation**: Writes a Postman CLI-based smoke/contract test workflow. Controlled by `generate-ci-workflow` flag and `ci-workflow-path`.
- **Repo mutation**: Commits exported artifacts under `postman/` and `.postman/` (resources.yaml, releases.yaml). Modes: `none`, `commit-only`, `commit-and-push`. Identity: `Postman CSE <help@postman.com>`.
- **mTLS support**: Passes SSL cert/key material through to generated CI workflow for APIs requiring client certificates.
- **Git provider support**: Auto-detects GitHub/GitLab/Bitbucket/Azure DevOps from env vars. Explicit `repo-url` also supported.

## Artifact Layout (written to target repo)

```
postman/
  collections/
    name/collection.yaml
    [Smoke] name/collection.yaml
    [Contract] name/collection.yaml
  environments/
    prod.postman_environment.json
  mocks/
.postman/
  resources.yaml  # PostmanResourcesConfig: workspace, localResources, cloudResources
  releases.yaml   # (versioned runs only) release manifest with spec/collection UIDs per tag
```

## Gotchas

- `repo-sync` build script runs `typecheck` before esbuild (unlike other actions)
- Collection v3 format uses `$schema: https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/` -- not the standard v2.1 JSON format
- `commit-and-push` mode requires write permissions on the checked-out ref
- `repo-mutation.ts` handles detached HEAD via `current-ref` input

## CI

`.github/workflows/ci.yml` runs a single `gate` job that fans out lint, test, typecheck, dist, commitlint, and actionlint
as backgrounded shell processes on one runner: wall-clock is `max(gate)`, not
`sum`, setup runs once, and every gate prints its result under a `::group::`
block even when another fails.

See the workspace `docs/CI.md` for the shared rationale.
