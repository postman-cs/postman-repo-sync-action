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
    secrets.ts                    # Secret handling
  @postman-cse/automation-core    # Shared gateway transport, retry, and HttpError
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

## Environment v3 Invariant

- **Source = access-token gateway.** `GET /environment/:uid/sync?since_id=0` returns the sync-service env body.
- **Always write v3 YAML, never v2 JSON.** The v12 Postman client emits `{name, values:[{key,value}]}` YAML in Local Mode; matching that keeps repo-sync's output round-trip-compatible with the client and avoids the v12 "Upgrade to v3" warning banner.
- **environment-converter.ts owns the reshape**: `convertEnvironmentToYaml(body)` reduces to `{name, values:[{key,value}]}` and dumps via `js-yaml`. `slugifyEnvironmentName` and `environmentFileName(workspace, envName)` build the on-disk `<workspace-slug> - <env-slug>.environment.yaml` filename the client uses.
- **Migration on write**: repo-sync unlinks any paired legacy `<env>.postman_environment.json` alongside every YAML write, and `buildResourcesManifest` strips legacy JSON keys from prior state so the manifest only tracks the new extension.
- **Mock env exception**: `manual-validation.environment.yaml` under `postman/mocks/` skips the workspace-slug prefix — the mock env is action-synthetic and never emitted by the v12 client.

## Commands

```bash
npm ci
npm test
npm run typecheck
npm run build
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
    <project-slug> - prod.environment.yaml
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

## Releases

Tags are an **output** of passing run, never input. Never push release tags by hand; `.githooks/pre-push` rejects them.

- `.github/workflows/auto-release.yml` runs on every push to `main` and drives `scripts/release-cut.mjs`.
- `node scripts/release-cut.mjs --plan` reports pending cut (fetch tags first). `--execute` bumps, rebuilds `dist/`, runs typecheck/lint/test, commits, re-verifies committed bytes, then tags last.
- Version comes from highest tag ever cut, not `package.json`. Existing tags are burnt and skipped, so failed cut never reuses or rewinds version.
- Conventional-commit type picks bump; `chore`/`ci`/`build`/`test`/`style` alone cut nothing.
- release commit lives only on tag. `release.yml` reads tagged commit; `main` keeps advancing through pull requests.
- `RELEASE_POLICY.md` holds full contract.

## Anti-Patterns

- Never commit AWS credentials, Postman tokens, or secrets; mask before logging
