# Release Policy

## Version tags

Releases use immutable `v1.x.y` tags and a rolling `v1` alias. Git tags are the source of truth for action consumers.

- Do not force-push an existing `v1.x.y` tag.
- Move the rolling `v1` alias only after a versioned release passes validation.
- Keep `v0` tags frozen.
- Rebuild and verify `dist/` before release because GitHub Actions runs the committed bundle.

## Compatibility

Patch releases should preserve the public action contract. Behavior that changes generated files, credential requirements, or GitHub permissions needs README and docs updates in the same release.

## npm package

The npm package publishes the `postman-repo-sync` CLI from the same source. GitHub tags remain authoritative for action releases; `package.json` version is not the action release source of truth.
