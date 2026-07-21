import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

function namedStep(name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = releaseWorkflow.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

function npmRegistrySetupStep(): string {
  const match = releaseWorkflow.match(/ {6}- uses: actions\/setup-node@v\d+\n[\s\S]*?registry-url: 'https:\/\/registry\.npmjs\.org'\n/);
  return match?.[0] ?? '';
}

describe('release workflow publishing contract', () => {
  it('keeps v1 as the only rolling alias and v1.x as a zero-patch publish tag', () => {
    expect(releaseWorkflow).toContain('PUBLISH_TAGS=("$PKG_VERSION")');
    expect(releaseWorkflow).toContain('PUBLISH_TAGS+=("$MAJOR.$MINOR")');
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$MAJOR" ]; then');
    expect(releaseWorkflow).not.toContain('if [ "$TAG_VERSION" = "0" ]; then');
    expect(releaseWorkflow).toContain('or v$MAJOR');
    expect(releaseWorkflow).toContain('echo "npm_publish=true" >> "$GITHUB_OUTPUT"');
    expect(releaseWorkflow).toContain('echo "npm_publish=false" >> "$GITHUB_OUTPUT"');
    expect(releaseWorkflow).toContain('skipping npm publish');
    expect(releaseWorkflow).not.toContain('ALIAS_TAGS');
    expect(releaseWorkflow).not.toContain('publish_tag');
  });

  it('keeps GitHub release artifacts while making npm publication idempotent', () => {
    expect(namedStep('Publish GitHub release')).not.toMatch(/\n\s+if:/);
    // setup-node with the npm registry runs unconditionally in the publish job:
    // the tarball steps below need npm even when npm publish is skipped.
    expect(npmRegistrySetupStep()).toContain("registry-url: 'https://registry.npmjs.org'");
    expect(namedStep('Check npm package version')).toContain('id: npm_package');
    expect(namedStep('Check npm package version')).toContain("if: needs.validate.outputs.npm_publish == 'true'");
    expect(namedStep('Check npm package version')).toContain('npm view "$PKG_NAME@$PKG_VERSION" version');
    expect(namedStep('Check npm package version')).toContain('already_published=true');
    expect(namedStep('Publish to npm')).toContain("if: needs.validate.outputs.npm_publish == 'true' && steps.npm_package.outputs.already_published != 'true'");
    expect(namedStep('Attach npm tarball to release')).not.toMatch(/\n\s+if:/);
    expect(namedStep('Upload tarball and SEA binary')).not.toMatch(/\n\s+if:/);
  });

  it('builds, smoke-tests, and attaches the self-contained SEA binary on release', () => {
    // Tag pushes do not trigger sea-binary.yml, so the release job must build and
    // execute the binary before any publish/upload, and ship it as a release asset.
    expect(namedStep('Build self-contained SEA binary')).toContain('bash scripts/build-sea.sh');
    const smoke = namedStep('Smoke test SEA binary with an empty environment');
    expect(smoke).toContain('env -i PATH=/nonexistent');
    expect(smoke).toContain('postman-repo-sync-${VERSION}-linux-x64');
    expect(smoke).toContain('version not embedded');
    expect(namedStep('Upload tarball and SEA binary')).toContain(
      'build/sea/postman-repo-sync-*-linux-x64'
    );
  });

  it('gates covered release tags on the central live e2e before any publish step', () => {
    expect(releaseWorkflow).toContain('echo "gate_required=true" >> "$GITHUB_OUTPUT"');
    expect(releaseWorkflow).toContain('echo "gate_required=false" >> "$GITHUB_OUTPUT"');
    expect(releaseWorkflow).toContain(
      "if: ${{ needs.validate.outputs.gate_required == 'true' }}"
    );
    expect(releaseWorkflow).toContain(
      "if: ${{ always() && needs.validate.result == 'success' && (needs.validate.outputs.gate_required != 'true' || needs.live-e2e-gate.result == 'success') }}"
    );
    expect(releaseWorkflow).toContain('node .github/scripts/wait-for-e2e-gate.mjs');
  });

  it('keeps a single automatic rolling major alias job after publish', () => {
    // Next immutable release must force-move stale v2 (or current major) alias.
    expect(releaseWorkflow).toMatch(/^ {2}advance-major-alias:/m);
    expect(releaseWorkflow).toContain('Force-move rolling major alias tag');
    expect(releaseWorkflow).toContain('git tag -fa "$MAJOR"');
    expect(releaseWorkflow).toContain('git push origin "$MAJOR" --force');
    expect(releaseWorkflow).toContain("needs.validate.outputs.npm_publish == 'true'");
    expect(releaseWorkflow.match(/^ {2}advance-major-alias:/gm) ?? []).toHaveLength(1);
  });
});
