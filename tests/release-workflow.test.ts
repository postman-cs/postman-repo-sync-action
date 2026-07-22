import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const seaWorkflow = readFileSync(join(process.cwd(), '.github/workflows/sea-binary.yml'), 'utf8');
const seaBuildScript = readFileSync(join(process.cwd(), 'scripts/build-sea.sh'), 'utf8');
const seaProxyScript = readFileSync(join(process.cwd(), 'scripts/assert-sea-proxy.mjs'), 'utf8');
const seaDocs = readFileSync(join(process.cwd(), 'docs/self-contained-binary.md'), 'utf8');

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
    // Hermetic-runtime guard: the smoke must prove ambient NODE_OPTIONS is ignored.
    expect(smoke).toContain("NODE_OPTIONS='--this-flag-does-not-exist'");
    expect(smoke).toContain('honored ambient NODE_OPTIONS');
    const proxySmoke = namedStep('Smoke test SEA proxy routing');
    expect(proxySmoke).toContain('scripts/assert-sea-proxy.mjs');
    expect(proxySmoke).toContain('iapub.postman.co:443');
    expect(seaWorkflow).toContain('scripts/assert-sea-proxy.mjs');
    expect(seaProxyScript).toContain("socket.on('error'");
    expect(namedStep('Upload tarball and SEA binary')).toContain(
      'build/sea/postman-repo-sync-*-linux-x64'
    );
    expect(seaBuildScript).toContain('shasum -a 256');
    expect(seaBuildScript).toContain('.sha256');
    expect(seaWorkflow).toContain('build/sea/postman-repo-sync-*-linux-x64.sha256');
    expect(namedStep('Upload tarball and SEA binary')).toContain(
      'build/sea/postman-repo-sync-*-linux-x64.sha256'
    );
  });

  it('documents proxy activation, telemetry egress, and checksum verification', () => {
    expect(seaDocs).toContain('NODE_USE_ENV_PROXY=1');
    expect(seaDocs).toContain('events.pm-cse.dev');
    expect(seaDocs).toContain('POSTMAN_ACTIONS_TELEMETRY=off');
    expect(seaDocs).toContain('shasum -a 256 -c');
  });

  it('publishes after validate only and monitors live e2e post-publish', () => {
    expect(releaseWorkflow).not.toContain('gate_required');
    expect(releaseWorkflow).not.toContain('live-e2e-gate:');
    expect(releaseWorkflow).not.toContain('wait-for-e2e-gate.mjs');
    expect(releaseWorkflow).toMatch(/^ {2}publish:\n(?:.*\n)*? {4}needs: validate$/m);
    expect(releaseWorkflow).toContain('dispatch-live-monitor:');
    expect(releaseWorkflow).toContain('node .github/scripts/dispatch-e2e-monitor.mjs');
    expect(releaseWorkflow).toContain('continue-on-error: true');
    expect(releaseWorkflow).toContain(
      "if: ${{ needs.validate.outputs.npm_publish == 'true' && needs.publish.result == 'success' }}"
    );
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
