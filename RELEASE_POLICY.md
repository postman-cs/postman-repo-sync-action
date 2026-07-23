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

Run the package validators from this directory before pushing an immutable tag:

1. Confirm the working tree is clean.
2. `npm test`
3. `npm run typecheck`
4. `npm run lint`
5. `npm run build`
6. `npm run verify:dist`
7. `npm run docs:tables` when `action.yml` changes, then confirm the `README.md` tables still match.
8. Confirm `SECURITY.md`, `SUPPORT.md`, and this file still describe the release surface.

## npm package

The CLI publishes as `@postman-cse/onboarding-repo-sync` with versions that match the GitHub release tag. The rolling current-major `vN` alias updates the action channel and skips npm publishing.

## Compatibility

Patch releases preserve the public action contract. Behavior that changes generated files, credential requirements, or GitHub permissions ships with README and docs updates in the same release.

## Security fixes

Security fixes ship on the latest immutable `vN.x.y` release on the current supported major (tracked by the rolling `vN` alias). Older immutable tags stay published for reproducibility. See [Security Policy](SECURITY.md).
