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
  const match = releaseWorkflow.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n  [a-zA-Z0-9_-]+:|\\n?$)`));
  return match?.[0] ?? '';
}

function job(name: string): string {
  return releaseWorkflow.match(new RegExp(`  ${name}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`))?.[0] ?? '';
}

describe('release workflow publishing contract', () => {
  it('classifies with the pure policy helper and emits release_kind plus npm_publish', () => {
    const classify = job('classify');
    expect(classify).toContain('npm_publish: ${{ steps.release_tag.outputs.npm_publish }}');
    expect(classify).toContain('release_kind: ${{ steps.release_tag.outputs.release_kind }}');
    expect(classify).toContain('node scripts/release-policy.mjs classify');
    expect(classify).not.toContain('npm ci');
    expect(classify.indexOf('actions/checkout@v7')).toBeLessThan(classify.indexOf('actions/setup-node@v7'));
    expect(classify.indexOf('actions/setup-node@v7')).toBeLessThan(
      classify.indexOf('node scripts/release-policy.mjs classify')
    );
    expect(releaseWorkflow.indexOf('Classify release tag')).toBeLessThan(releaseWorkflow.indexOf('npm ci'));
    expect(job('verify-package')).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
    expect(job('publish')).toContain(
      "needs.classify.outputs.release_kind == 'immutable' && needs.verify-package.result == 'success'"
    );
  });

  it('keeps v1 as the only rolling alias and v1.x as a zero-patch publish tag via the pure classifier', () => {
    const policy = readFileSync(join(process.cwd(), 'scripts/release-policy.mjs'), 'utf8');
    expect(policy).toContain("patch === '0' && tagVersion === `${major}.${minor}`");
    expect(policy).toContain("tagVersion === major");
    expect(policy).toContain("release_kind: 'immutable'");
    expect(policy).toContain("release_kind: 'alias'");
    expect(policy).toContain("npm_publish: 'true'");
    expect(policy).toContain("npm_publish: 'false'");
    expect(releaseWorkflow).toContain('node scripts/release-policy.mjs classify');
  });

  it('classifies tags before npm ci and isolates publication to staged artifacts', () => {
    expect(releaseWorkflow.indexOf('Classify release tag')).toBeLessThan(releaseWorkflow.indexOf('npm ci'));
    expect(releaseWorkflow).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
    expect(releaseWorkflow).toMatch(/verify-package:[\s\S]*?permissions:\n\s+contents: read/);
    const publish = job('publish');
    expect(publish).toMatch(/permissions:\n\s+contents: write\n\s+id-token: write/);
    expect(publish).toContain('actions/download-artifact@v7');
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toMatch(/\bnpm pack\b/);
    expect(publish).not.toContain('cache:');
    expect(publish).not.toContain('npm run bundle');
    expect(publish).not.toContain('npm test');
    expect(releaseWorkflow).toContain('release-${{ github.repository }}');
    expect(releaseWorkflow).toContain('cancel-in-progress: false');
  });

  it('uses uncached verify-package gates with one bundle, max-two parallelism, and no Go', () => {
    const verify = job('verify-package');
    expect(verify).toContain('contents: read');
    expect(verify).not.toContain('cache: npm');
    expect(verify).not.toContain('cache:');
    expect(verify).toContain('npm ci');
    expect(verify.match(/^\s*- run: npm ci$/gm) ?? []).toHaveLength(1);
    expect(verify).toContain('npm run bundle');
    expect(verify.indexOf('npm run bundle')).toBeLessThan(verify.indexOf('Run gates'));
    expect(verify).toContain('MAX_PARALLEL_GATES=2');
    expect(verify).toContain('run lint npm run lint');
    expect(verify).toContain('run test npm test');
    expect(verify).toContain('run typecheck npm run typecheck');
    expect(verify).toContain('run dist npm run verify:dist:assert');
    expect(verify).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(verify).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(verify).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(verify).not.toContain('actions/setup-go');
    expect(verify).not.toContain('go install github.com/rhysd/actionlint');
    expect(verify).toContain("const paths = ['release.tgz', sea, `${sea}.sha256`]");
    expect(verify).toContain('node scripts/verify-release-artifacts.mjs release-artifacts');
    expect(verify.indexOf('Verify release artifact contract')).toBeLessThan(verify.indexOf('upload-artifact@v7'));
  });

  it('builds, smoke-tests, and attaches the self-contained SEA binary on release', () => {
    expect(namedStep('Build self-contained SEA binary')).toContain('bash scripts/build-sea.sh');
    const smoke = namedStep('Smoke test SEA binary with an empty environment');
    expect(smoke).toContain('env -i PATH=/nonexistent');
    expect(smoke).toContain('postman-repo-sync-${VERSION}-linux-x64');
    expect(smoke).toContain('test "$(env -i PATH=/nonexistent');
    expect(smoke).toContain("NODE_OPTIONS='--this-flag-does-not-exist'");
    expect(smoke).toContain('test "$(NODE_OPTIONS=');
    const proxySmoke = namedStep('Smoke test SEA proxy routing');
    expect(proxySmoke).toContain('scripts/assert-sea-proxy.mjs');
    expect(proxySmoke).toContain('iapub.postman.co:443');
    expect(seaWorkflow).toContain('scripts/assert-sea-proxy.mjs');
    expect(seaProxyScript).toContain("socket.on('error'");
    expect(releaseWorkflow).toContain('cp "build/sea/${SEA}" "build/sea/${SEA}.sha256" release-artifacts/');
    expect(seaBuildScript).toContain('shasum -a 256');
    expect(seaBuildScript).toContain('.sha256');
    expect(seaWorkflow).toContain('build/sea/postman-repo-sync-*-linux-x64.sha256');
  });

  it('documents proxy activation, telemetry egress, and checksum verification', () => {
    expect(seaDocs).toContain('NODE_USE_ENV_PROXY=1');
    expect(seaDocs).toContain('events.pm-cse.dev');
    expect(seaDocs).toContain('POSTMAN_ACTIONS_TELEMETRY=off');
    expect(seaDocs).toContain('shasum -a 256 -c');
  });

  it('verifies the full artifact/SRI contract before any GitHub mutation and publishes exact assets', () => {
    const publish = job('publish');
    expect(publish).toContain('exact artifact allowlist mismatch');
    expect(publish).toContain('tarball package identity mismatch');
    expect(publish).toContain('SEA sidecar digest does not match executable and manifest');
    expect(publish).toContain("artifact.path.includes('..')");
    expect(publish).toContain('unexpected filesystem entry');
    expect(publish.indexOf('Verify staged release artifacts')).toBeLessThan(
      publish.indexOf('Publish npm package or verify registry identity')
    );
    expect(publish).toContain('npm view "$PKG@$VERSION" dist.integrity');
    expect(publish).toContain("sha512-'+crypto.createHash('sha512')");
    expect(publish).toContain('Published npm integrity differs from staged tarball');
    expect(publish).toContain('npm (error|ERR!) code E404');
    expect(publish).toContain('npm view failed with a non-E404 error; refusing to publish or mutate GitHub');
    expect(publish.indexOf('npm publish ./release-artifacts/release.tgz --provenance --access public')).toBeLessThan(
      publish.indexOf('softprops/action-gh-release')
    );
    expect(publish).toContain('release-artifacts/release.tgz');
    expect(publish).toContain('release-artifacts/release-manifest.json');
    expect(publish).toContain('release-artifacts/postman-repo-sync-*-linux-x64');
    expect(publish).toContain('release-artifacts/postman-repo-sync-*-linux-x64.sha256');
    expect(publish).not.toContain('release-artifacts/*');
    expect(releaseWorkflow.indexOf('  publish:')).toBeLessThan(releaseWorkflow.indexOf('  advance-major-alias:'));
  });

  it('dispatches the post-release monitor without blocking publication', () => {
    const monitor = job('dispatch-live-monitor');
    expect(monitor).toContain('continue-on-error: true');
    expect(monitor).toContain('contents: read');
    expect(monitor).toContain('actions/checkout@v7');
    expect(monitor).toContain("needs.classify.outputs.release_kind == 'immutable' && needs.publish.result == 'success'");
    expect(monitor).toContain('E2E_GATE_REF: ${{ github.ref_name }}');
    expect(monitor).toContain('node .github/scripts/dispatch-e2e-monitor.mjs');
    expect(monitor.indexOf('actions/checkout@v7')).toBeLessThan(
      monitor.indexOf('node .github/scripts/dispatch-e2e-monitor.mjs')
    );
    expect(releaseWorkflow).not.toContain('live-e2e-gate:');
  });

  it('keeps a single non-regressing rolling major alias job after publish with bounded fetch', () => {
    const alias = job('advance-major-alias');
    expect(alias).toMatch(/^ {2}advance-major-alias:/m);
    expect(alias).toContain('Advance rolling major alias without regression');
    expect(alias).toContain('require(\'./package.json\').version');
    expect(alias).toContain('isSemverOlder');
    expect(alias).toContain('scripts/release-policy.mjs');
    expect(alias).toContain('Candidate $CANDIDATE is older than current alias');
    expect(alias).toContain('git ls-remote --exit-code --tags origin "refs/tags/$MAJOR"');
    expect(alias).toContain('git fetch --depth=1 --no-tags origin "refs/tags/$MAJOR:refs/tags/$MAJOR"');
    expect(alias).toContain('failed to probe rolling alias');
    expect(alias).not.toContain('fetch-tags: true');
    expect(alias).not.toContain('fetch-tags:true');
    expect(alias.indexOf('isSemverOlder')).toBeLessThan(alias.indexOf('git push origin "$MAJOR" --force'));
    expect(alias).toContain('git tag -fa "$MAJOR"');
    expect(alias).toContain('git push origin "$MAJOR" --force');
    expect(alias).toContain("needs.classify.outputs.release_kind == 'immutable'");
    expect(releaseWorkflow.match(/^ {2}advance-major-alias:/gm) ?? []).toHaveLength(1);
  });
});
