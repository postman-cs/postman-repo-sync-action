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
- **Always write canonical environment YAML, never v2 JSON.** Repo-sync mirrors Postman v12 Local Mode's environment filesystem serializer: ordered `key`, optional `value`, `disabled`, `description`, `secret`, and `source` fields, plus a valid environment `color`. Resolved `secret: true` entries never persist `value`; every legacy `type: secret` value is redacted and emitted as canonical `secret: true` without `type`.
- **environment-converter.ts owns the adapter**: `convertEnvironmentToYaml(body)` reconciles the sync-service body with the Local Mode on-disk shape and dumps with `indent: 2`, `lineWidth: -1`, `noRefs: true`, and `sortKeys: false`. `environmentFileName(project, envName)` applies the same `sanitizeFilename` options to the full stable `${project} - ${envName}` cloud display name.
- **Atomic migration on write**: repo-sync writes every environment YAML to a confined same-filesystem candidate, validates and atomically promotes it, then atomically promotes `resources.yaml`, and only then deletes an exact confined legacy `<env>.postman_environment.json` whose prior manifest UID matches. Conflicting ownership fails before cloud mutation; untracked files are preserved with a warning. The fixed mock artifact is action-owned. Spec-only runs preserve environment mappings and files unchanged.
- **Stable identity**: environment filenames use the stable project name even on versioned runs. Logical names map explicitly to filenames; empty filesystem names, path separators/control characters, truncation collisions, and Unicode-normalized/case-folded filename collisions fail before cloud mutation.
- **Mock env exception**: `manual-validation.environment.yaml` under `postman/mocks/` skips the cloud display-name convention — the mock env is action-synthetic and never emitted by the app.

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
