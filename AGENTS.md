# postman-repo-sync-action

Syncs Postman artifacts into git: exports collections as Collection v3 multi-file YAML, creates/updates envs w/ runtime URLs, creates mock servers + smoke monitors, links workspace to repo via Bifrost, generates CI workflow, commits/pushes. Dual entry: GitHub Action + CLI.

## Structure

```
src/
  index.ts                  # Orchestration: envs -> mocks -> monitors -> export -> CI -> commit
  cli.ts                    # CLI adapter
  lib/
    postman/
      postman-assets-client.ts     # API client (envs, mocks, monitors, export)
      internal-integration-adapter.ts  # Bifrost (linking, system env association)
    github/repo-mutation.ts        # Git commit/push, ref resolution
    repo/context.ts                   # CI auto-detect (GitHub/GitLab/Bitbucket/Azure)
    ci-workflow-template.ts        # Generated ci.yml template
    ssl-validation.ts              # mTLS cert validation
    retry.ts, secrets.ts, http-error.ts
  postman-v3/converter.ts          # Collection -> canonical v3 YAML (@postman libs)
tests/
```

## Collection v3 Invariant

- **Source = access-token gateway.** `GET /v3/collections/:id/export` (canonical v3). PMAK only mints access-token — never data calls.
- **Always write v3, never v2.** Allowed v2->v3. Forbidden: raw v2 write, v3->v2 down-convert. v3 read = v3 write directly. Old `v3-export-to-v2.ts` deleted.
- **converter.ts uses `@postman/runtime.models` + `@postman/v3.export`** — `transform(V2->V3)` + `splitCollection`. Same pipeline as `postman collection migrate`. Entry points:
  - `convertAndSplitAnyCollection(payload, dir)` — auto-detects v2/v3, routes
  - `convertAndSplitCollection(v2, dir)` — v2.1 -> canonical v3
  - `convertAndSplitV3Collection(v3Export, dir)` — gateway v3 -> canonical v3, written directly
- Output: canonical layout w/ definition file, folder dirs, request YAML, `$kind:` markers. Legacy `collection.yaml`/`type:` rejected by `postman collection lint` (FMT015). `splitCollection` owns long-name truncation + duplicate-sibling naming.

## Commands

```bash
npm ci && npm test && npm run typecheck && npm run build
npm run verify:dist:assert  # CI: inspect dist; no build
npm run verify:dist         # build, diff, inspect
```

## Key Behaviors

- **Collection v3 export**: `converter.ts` transforms single-JSON collections into baseline dir + `[Smoke] name` + `[Contract] name` dirs w/ nested folder/request YAML.
- **Env management**: Creates envs per slug in `environments-json`, injects runtime URLs from `env-runtime-urls-json`, associates w/ system envs via Bifrost.
- **Mock/Monitor**: Creates mock from baseline, smoke monitor from smoke collection. Reuse via `mock-url`, `monitor-id`. Scheduling via `monitor-cron`.
- **CI workflow**: Writes Postman CLI-based smoke/contract test workflow. `generate-ci-workflow` flag + `ci-workflow-path` control.
- **Repo mutation**: Commits artifacts under `postman/` + `.postman/` (resources.yaml, releases.yaml). Modes: `none`, `commit-only`, `commit-and-push`. Identity: `Postman CSE <help@postman.com>`.
- **mTLS**: Passes SSL cert/key to generated CI workflow.
- **Git provider**: Auto-detects GitHub/GitLab/Bitbucket/Azure from env. Explicit `repo-url` supported.

## Artifact Layout

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
  resources.yaml  # PostmanResourcesConfig
  releases.yaml   # versioned runs: release manifest w/ spec/collection UIDs per tag
```

## Gotchas

- `build`: typecheck, then bundle. Bundle adds CLI shebang + mode 755. CI bundles once; typecheck once; dist gate only inspects.
- Collection v3 uses `$schema: https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/` — not v2.1 JSON
- `commit-and-push` needs write perms on checked-out ref
- `repo-mutation.ts` handles detached HEAD via `current-ref` input

## CI

`.github/workflows/ci.yml` bundles once. One runner, at most two checks. Typecheck once. Dist read-only. No pack race. Every check prints `::group::` even on failure.

See workspace `../../docs/CI.md` for shared rationale.

## Anti-Patterns

- Never commit AWS credentials, Postman tokens, or secrets; mask before logging
