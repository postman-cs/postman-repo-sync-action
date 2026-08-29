# Release Policy

## Source of truth

Git tags and GitHub releases are the public release identifiers for this action. `package.json` versions support npm packaging, but consumers should select action versions by Git tag. The committed `dist/` bundle is part of the released artifact because GitHub Actions runs it verbatim from the tag.

## Tag policy

- Immutable releases use exact `vN.x.y` tags derived from `package.json`.
- When the package patch is zero, a zero-patch `vN.x` tag is also an accepted immutable publish form.
- The rolling current-major `vN` alias moves to the latest compatible `vN.x.y` release.
- Existing release tags are never force-pushed or rewritten.
- `v0` tags stay frozen at the last `v0` release.
- Every immutable release tag has a GitHub release with generated notes.

## Release checks

Releases are cut automatically. Merging to `main` runs `.github/workflows/auto-release.yml`,
which derives the next version from the conventional-commit history, then runs
`scripts/release-cut.mjs`: bump, rebuild `dist/`, run the gate set, commit, and tag.

The tag is created only after the exact bytes of the release commit pass every
gate, so a failed cut leaves no tag and burns no version number. The next merge
retries on a fresh version, skipping any already-tagged one.

Auto-release plans against the latest immutable tag before choosing recovery.
An immutable tag whose GitHub release is missing must finish publication before
another version is cut. A stale rolling alias is replayed only when there is no
new release-worthy change; otherwise the new immutable release supersedes the
failed evidence attempt and must pass its own exact-tag E2E gate before the alias
can advance. Recovery never duplicates an active release run.

Do not push `vX.Y.Z` tags by hand. The pre-push hook refuses them, because a
hand-pushed tag becomes a public identifier before any gate has run against it.

To see what the next merge would cut:

```sh
node scripts/release-cut.mjs --plan
```

The same gates run locally before any push:

1. `npm test`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run build`
5. `npm run verify:dist`
6. `npm run docs:tables` when `action.yml` changes, then confirm the `README.md` tables still match.
7. Confirm `SECURITY.md`, `SUPPORT.md`, and this file still describe the release surface.

## npm package

The CLI publishes as `@postman-cs/onboarding-repo-sync` with versions that match the GitHub release tag. The rolling current-major `vN` alias updates the action channel and skips npm publishing.

## Compatibility

Patch releases preserve the public action contract. Behavior that changes generated files, credential requirements, or GitHub permissions ships with README and docs updates in the same release.

## Security fixes

Security fixes ship on the latest immutable `vN.x.y` release on the current supported major (tracked by the rolling `vN` alias). Older immutable tags stay published for reproducibility. See [Security Policy](SECURITY.md).
