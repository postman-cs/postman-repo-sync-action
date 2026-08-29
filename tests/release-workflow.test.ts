import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

  it('keeps rolling-major as the only rolling alias and zero-patch-minor as a publish tag via the pure classifier', () => {
    const policy = readFileSync(join(process.cwd(), 'scripts/release-policy.mjs'), 'utf8');
    expect(policy).toContain("patch === '0' && tagVersion === `${major}.${minor}`");
    expect(policy).toContain("tagVersion === major");
    expect(policy).toContain("release_kind: 'immutable'");
    expect(policy).toContain("release_kind: 'alias'");
    expect(policy).toContain("npm_publish: 'true'");
    expect(policy).toContain("npm_publish: 'false'");
    expect(releaseWorkflow).toContain('node scripts/release-policy.mjs classify');
  });

  it('uses default shallow checkout for classify and verify-package; publish stays checkout-free', () => {
    // Alias job bounded fetch (checkout fetch-depth:1, no fetch-tags:true, depth-one ref fetch)
    // is asserted by the advance-major-alias contract below; do not restate it here.
    const classify = job('classify');
    const verify = job('verify-package');
    const publish = job('publish');
    expect(classify).toContain('actions/checkout@v7');
    expect(classify).not.toContain('fetch-depth:');
    expect(verify).toContain('actions/checkout@v7');
    expect(verify).not.toContain('fetch-depth:');
    expect(publish).not.toContain('actions/checkout');
  });

  it('classifies tags before npm ci and isolates publication to staged artifacts', () => {
    expect(releaseWorkflow.indexOf('Classify release tag')).toBeLessThan(releaseWorkflow.indexOf('npm ci'));
    expect(releaseWorkflow).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
    expect(releaseWorkflow).toMatch(/verify-package:[\s\S]*?permissions:\n\s+contents: read/);
    const publish = job('publish');
    expect(publish).toMatch(/permissions:\n\s+contents: write\n\s+id-token: write/);
    expect(publish).toContain('actions/download-artifact@v8');
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
    expect(verify).toContain('registry-url:');
    expect(verify).toContain('https://registry.npmjs.org');
    expect(verify).toContain('node .github/scripts/prefetch-vendored-deps.mjs');
    expect(verify).toContain('DEPS_REPO: ${{ secrets.DEPS_REPO }}');
    expect(verify).toContain('DEPS_TOKEN: ${{ secrets.DEPS_TOKEN }}');
    expect(verify).not.toContain('NPM_TOKEN');
    expect(verify).toContain('npm run bundle');
    expect(verify.indexOf('npm run bundle')).toBeLessThan(verify.indexOf('Run gates'));
    expect(verify).toContain('MAX_PARALLEL_GATES=2');
    expect(verify).toContain('run lint npm run lint');
    expect(verify).toContain('run test npm test');
    expect(verify).toContain('run typecheck npm run typecheck');
    expect(verify).toContain('run dist npm run verify:dist:assert');
    expect(verify).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(verify).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(verify).not.toContain('rhysd/actionlint/main/');
    expect(verify).toContain('rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/');
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
    expect(smoke).toMatch(
      /out="\$\(env -i PATH=\/nonexistent "\$BIN" 2>&1 \|\| true\)"/
    );
    expect(smoke.indexOf('2>&1 || true')).toBeLessThan(smoke.indexOf('grep -qE'));
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

  it('verifies local artifacts before the authoritative GitHub Release and soft-fails only npm publication', () => {
    const publish = job('publish');
    expect(publish).not.toContain("node --input-type=module - <<'NODE'");
    expect(publish).not.toContain("<<'NODE'");
    expect(publish).toContain(
      'tar -xOf release-artifacts/release.tgz package/scripts/verify-release-artifacts.mjs'
    );
    expect(publish).toContain("VERIFIER=\"$RUNNER_TEMP/verify-release-artifacts.mjs\"");
    expect(publish).toMatch(/EXPECTED_SHA256='[a-f0-9]{64}'/);
    expect(publish).toContain('test "$ACTUAL_SHA256" = "$EXPECTED_SHA256"');
    expect(publish).toContain('node "$VERIFIER" release-artifacts');
    expect(publish.indexOf('EXPECTED_SHA256=')).toBeLessThan(publish.indexOf('node "$VERIFIER" release-artifacts'));
    expect(publish.indexOf('tar -xOf release-artifacts/release.tgz')).toBeLessThan(
      publish.indexOf('node "$VERIFIER" release-artifacts')
    );
    expect(publish.indexOf('node "$VERIFIER" release-artifacts')).toBeLessThan(
      publish.indexOf('Publish GitHub release assets')
    );
    expect(publish.indexOf('Verify staged release artifacts')).toBeLessThan(
      publish.indexOf('Publish GitHub release assets')
    );
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toMatch(/\bnpm pack\b/);
    expect(publish).not.toContain('cache:');
    expect(publish).not.toContain('npm run bundle');
    expect(publish).not.toContain('npm test');
    expect(publish).toContain('npm view "$PKG@$VERSION" dist.integrity');
    expect(publish).toContain("sha512-'+crypto.createHash('sha512')");
    expect(publish).toContain('Published npm integrity differs from staged tarball');
    expect(publish).toContain('npm (error|ERR!) code E404');
    expect(publish).toContain('npm view failed with a non-E404 error; refusing to publish or mutate GitHub');
    expect(publish.indexOf('softprops/action-gh-release')).toBeLessThan(
      publish.indexOf('id: npm-publish')
    );
    expect(publish).toContain('published: ${{ steps.npm-publish.outputs.published }}');
    expect(publish).toContain('continue-on-error: true');
    expect(publish).toContain("sed -i '/_authToken/d' \"${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}\"");
    expect(publish).not.toContain('NODE_AUTH_TOKEN');
    expect(publish).toContain("if: steps.npm-publish.outputs.published == 'true'");
    expect(publish).toContain("if: steps.npm-publish.outputs.published != 'true'");
    expect(publish).toContain('Report npm publish skipped');
    expect(publish.indexOf('id: npm-publish')).toBeLessThan(publish.indexOf('Verify npm registry identity'));
    expect(publish.indexOf('Verify npm registry identity')).toBeLessThan(publish.indexOf('Report npm publish skipped'));
    expect(publish).toContain('release-artifacts/release.tgz');
    expect(publish).toContain('release-artifacts/release-manifest.json');
    expect(publish).toContain('release-artifacts/postman-repo-sync-*-linux-x64');
    expect(publish).toContain('release-artifacts/postman-repo-sync-*-linux-x64.sha256');
    expect(publish).not.toContain('release-artifacts/*');
    expect(releaseWorkflow.indexOf('  publish:')).toBeLessThan(releaseWorkflow.indexOf('  advance-major-alias:'));
  });

  it('does not race the closed release proof with a mutable post-release monitor', () => {
    expect(job('dispatch-live-monitor')).toBe('');
    expect(releaseWorkflow).not.toContain('dispatch-live-monitor:');
    expect(releaseWorkflow).not.toContain('node .github/scripts/dispatch-e2e-monitor.mjs');
    expect(releaseWorkflow).not.toContain('live-e2e-gate:');
  });

  it('awaits exact closed immutable-provider E2E evidence before moving the rolling alias', () => {
    const verifier = job('verify-release-e2e');
    expect(verifier).toContain('needs: [classify, verify-package, publish]');
    expect(verifier).not.toContain('continue-on-error');
    expect(verifier).toContain('E2E_GATE_MODE: enforce');
    expect(verifier).toContain('E2E_GATE_ACTION: postman-repo-sync-action');
    expect(verifier).toContain('E2E_GATE_SUITE: branch-aware');
    expect(verifier).toContain('E2E_GATE_REF: ${{ github.ref_name }}');
    expect(verifier).toContain('E2E_GATE_RELEASE_COMMIT: ${{ github.sha }}');
    expect(verifier).toContain(
      'E2E_GATE_SOURCE_DIGEST: ${{ needs.verify-package.outputs.release_tgz_sha256 }}'
    );
    expect(verifier).toContain('E2E_GATE_PROVIDER_TAG: e2e-provider-v1.2.0');
    expect(verifier).toContain(
      'E2E_GATE_PROVIDER_COMMIT: 53c5d10093b7dafb165d3caafbe3f1d70dec687d'
    );
    expect(verifier).toContain(
      'E2E_GATE_PROVIDER_SOURCE_DIGEST: 8c7ee211fccd2869f3901fcbc5ed154d6dea8e3d0d7d2e5312f6c0b57b4f6b78'
    );
    expect(verifier).not.toContain('__FILL_PROVIDER_');
    expect(verifier).toContain(
      'E2E_GATE_PEER_TAGS: \'{"postman-cs/postman-api-onboarding-action":"v3.5.8","postman-cs/postman-bootstrap-action":"v2.21.6","postman-cs/postman-insights-onboarding-action":"v2.5.2","postman-cs/postman-resolve-service-token-action":"v2.2.4","postman-cs/postman-smoke-flow-action":"v3.7.4"}\''
    );
    expect(verifier).not.toContain('E2E_GATE_REGISTRY_REVISION');
    expect(verifier).not.toContain('E2E_GATE_CONTRACT_SCENARIOS');
    expect(verifier).not.toContain('E2E_GATE_WORKFLOW_REF: main');
    expect(verifier).toContain(
      'manifest_sha256: ${{ steps.verifier.outputs.e2e_manifest_sha256 }}'
    );
    expect(verifier).toContain(
      'provider_commit: ${{ steps.verifier.outputs.e2e_provider_commit }}'
    );
    expect(verifier).toContain('provider_tag: ${{ steps.verifier.outputs.e2e_provider_tag }}');
    expect(verifier).toContain('node .github/scripts/verify-e2e-release.mjs');
    expect(verifier).toContain('outcome: ${{ steps.verifier.outputs.e2e_outcome }}');
    expect(job('advance-major-alias')).toContain(
      "needs.verify-release-e2e.outputs.outcome == 'success'"
    );
    expect(releaseWorkflow.indexOf('  verify-release-e2e:')).toBeLessThan(
      releaseWorkflow.indexOf('  advance-major-alias:')
    );
  });

  it('keeps a single non-regressing rolling major alias job after publish with bounded fetch', () => {
    const alias = job('advance-major-alias');
    expect(alias).toMatch(/^ {2}advance-major-alias:/m);
    expect(alias).toMatch(/permissions:\n\s+contents: read/);
    expect(alias).toContain('Advance rolling major alias without regression');
    expect(alias).toContain('require(\'./package.json\').version');
    expect(alias).toContain('isSemverOlder');
    expect(alias).toContain('scripts/release-policy.mjs');
    expect(alias).toContain('Candidate $CANDIDATE is older than current alias');
    expect(alias).toContain('actions/checkout@v7');
    expect(alias).toContain('token: ${{ secrets.RELEASE_WORKFLOW_TOKEN }}');
    expect(alias).toContain('fetch-depth: 1');
    expect(alias).toContain('git ls-remote --exit-code --tags origin "refs/tags/$MAJOR"');
    expect(alias).toContain('git fetch --depth=1 --no-tags origin "refs/tags/$MAJOR:refs/tags/$MAJOR"');
    expect(alias).toContain('failed to probe rolling alias');
    expect(alias).not.toContain('fetch-tags: true');
    expect(alias).not.toContain('fetch-tags:true');
    expect(alias.indexOf('isSemverOlder')).toBeLessThan(alias.indexOf('git push origin "$MAJOR" --force'));
    expect(alias).toContain('git tag -fa "$MAJOR"');
    expect(alias).toContain('git push origin "$MAJOR" --force');
    expect(alias).toContain("needs.classify.outputs.release_kind == 'immutable'");
    expect(alias).toContain('needs: [classify, publish, verify-release-e2e]');
    expect(alias).toContain("needs.verify-release-e2e.result == 'success'");
    expect(alias).toContain("needs.verify-release-e2e.outputs.outcome == 'success'");
    expect(alias).toContain(
      'VERIFIED_E2E_MANIFEST_SHA256: ${{ needs.verify-release-e2e.outputs.manifest_sha256 }}'
    );
    expect(alias).toContain(
      'VERIFIED_E2E_PROVIDER_COMMIT: ${{ needs.verify-release-e2e.outputs.provider_commit }}'
    );
    expect(alias).toContain(
      'VERIFIED_E2E_PROVIDER_TAG: ${{ needs.verify-release-e2e.outputs.provider_tag }}'
    );
    expect(alias).toContain('[[ "$VERIFIED_E2E_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]');
    expect(alias).toContain("[ \"$VERIFIED_E2E_PROVIDER_TAG\" = 'e2e-provider-v1.2.0' ]");
    expect(alias).toContain(
      "[ \"$VERIFIED_E2E_PROVIDER_COMMIT\" = '53c5d10093b7dafb165d3caafbe3f1d70dec687d' ]"
    );
    expect(alias).toContain(
      'git ls-remote --exit-code --tags origin "$RELEASE_TAG_REF" "${RELEASE_TAG_REF}^{}"'
    );
    expect(alias).toContain('[ "$REMOTE_RELEASE_COMMIT" = "$GITHUB_SHA" ]');
    for (const validation of [
      '[[ "$VERIFIED_E2E_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]',
      "[ \"$VERIFIED_E2E_PROVIDER_TAG\" = 'e2e-provider-v1.2.0' ]",
      "[ \"$VERIFIED_E2E_PROVIDER_COMMIT\" = '53c5d10093b7dafb165d3caafbe3f1d70dec687d' ]",
      '[ "$REMOTE_RELEASE_COMMIT" = "$GITHUB_SHA" ]'
    ]) {
      expect(alias.indexOf(validation)).toBeLessThan(alias.indexOf('git tag -fa "$MAJOR"'));
      expect(alias.indexOf(validation)).toBeLessThan(alias.indexOf('git push origin "$MAJOR" --force'));
    }
    expect(releaseWorkflow.match(/^ {2}advance-major-alias:/gm) ?? []).toHaveLength(1);
  });

  it('dispatches sibling-release to the composite after immutable publish and alias advance', () => {
    const notify = job('notify-composite');
    expect(notify).toContain(
      'needs: [classify, publish, verify-release-e2e, advance-major-alias]'
    );
    expect(notify).toContain(
      "!cancelled() && needs.classify.outputs.release_kind == 'immutable' && needs.publish.result == 'success' && needs.verify-release-e2e.result == 'success' && needs.verify-release-e2e.outputs.outcome == 'success' && needs['advance-major-alias'].result == 'success'"
    );
    expect(notify).toMatch(/permissions:\s*\{\}/);
    expect(notify).toContain(
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0'
    );
    expect(notify).toContain('continue-on-error: true');
    expect(notify).toContain('app-id: ${{ secrets.SUITE_PIN_BOT_APP_ID }}');
    expect(notify).toContain('private-key: ${{ secrets.SUITE_PIN_BOT_PRIVATE_KEY }}');
    expect(notify).toContain('owner: postman-cs');
    expect(notify).toContain('repositories: postman-api-onboarding-action');
    expect(notify).toContain('event_type=sibling-release');
    expect(notify).toContain('client_payload[repository]=${GITHUB_REPOSITORY}');
    expect(notify).toContain(
      'client_payload[run]=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}'
    );
    expect(notify).not.toContain('github.event.workflow_run');
    expect(notify).toContain(
      "App token unavailable (secrets missing or mint failed); the composite's daily cron will pick this release up."
    );
    expect(notify).toContain('exit 0');
    expect(releaseWorkflow).not.toContain('github.event.workflow_run');
    expect(releaseWorkflow.indexOf('  notify-composite:')).toBeGreaterThan(
      releaseWorkflow.indexOf('  advance-major-alias:')
    );
  });
});

const aliasRunBody: string = (() => {
  const parsed = parse(releaseWorkflow) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  return (
    parsed.jobs['advance-major-alias'].steps.find(
      (step) => step.name === 'Advance rolling major alias without regression'
    )?.run ?? ''
  );
})();

interface AliasShellResult {
  status: number;
  output: string;
  mutations: string[];
}

function executeAliasShell(overrides: Record<string, string> = {}): AliasShellResult {
  const tmpDir = mkdtempSync(join(tmpdir(), 'release-alias-'));
  const scriptPath = join(tmpDir, 'alias.sh');
  const mutationPrefix = '__ALIAS_GIT_MUTATION__:';
  const gitShim = `git() {
case "\${1:-}" in
  rev-parse) printf '%s\\n' "$GITHUB_SHA" ;;
  ls-remote)
    if [ "$#" -eq 6 ]; then
      printf '%s\\trefs/tags/%s\\n' "$GIT_STUB_RELEASE_TAG_OBJECT" "$GITHUB_REF_NAME"
      printf '%s\\trefs/tags/%s^{}\\n' "$GIT_STUB_RELEASE_COMMIT" "$GITHUB_REF_NAME"
    elif [[ " $* " == *" --exit-code "* ]]; then
      return 2
    fi
    ;;
  config) ;;
  tag|push) printf '${mutationPrefix}%s\\n' "$*" ;;
  *) printf 'unexpected git call: %s\\n' "$*" >&2; return 90 ;;
esac
}
`;
  // A shell function is deterministic on Unix and Git Bash alike. In
  // particular, Git Bash prepends its own /mingw64/bin/git ahead of Windows
  // PATH entries, so executable and .bat stubs can silently hit the real
  // remote alias instead of exercising the release step.
  writeFileSync(scriptPath, `${gitShim}\n${aliasRunBody}`);
  try {
    const result = spawnSync('bash', ['--noprofile', '--norc', scriptPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BASH_ENV: '',
        ENV: '',
        GITHUB_REF_NAME: 'v9.9.9',
        GITHUB_SHA: 'a'.repeat(40),
        GIT_STUB_RELEASE_COMMIT: 'a'.repeat(40),
        GIT_STUB_RELEASE_TAG_OBJECT: '1'.repeat(40),
        VERIFIED_E2E_MANIFEST_SHA256: 'c'.repeat(64),
        VERIFIED_E2E_PROVIDER_COMMIT: '53c5d10093b7dafb165d3caafbe3f1d70dec687d',
        VERIFIED_E2E_PROVIDER_TAG: 'e2e-provider-v1.2.0',
        ...overrides
      },
      timeout: 10_000
    });
    const mutations = (result.stdout ?? '')
      .split('\n')
      .filter((line) => line.startsWith(mutationPrefix))
      .map((line) => line.slice(mutationPrefix.length).trim());
    return {
      status: result.status ?? -1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      mutations
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('release alias evidence shell', () => {
  it('executes the exact alias step only after all evidence and tag checks pass', () => {
    expect(aliasRunBody).toContain('VERIFIED_E2E_MANIFEST_SHA256');
    const result = executeAliasShell();
    expect(result.status).toBe(0);
    expect(result.mutations).toHaveLength(2);
    expect(result.mutations[0]).toMatch(/^tag -fa v\d+ /);
    expect(result.mutations[1]).toMatch(/^push origin v\d+ --force$/);
  });

  it.each([
    ['missing manifest', { VERIFIED_E2E_MANIFEST_SHA256: '' }, 'manifest digest'],
    ['non-lowercase manifest', { VERIFIED_E2E_MANIFEST_SHA256: 'C'.repeat(64) }, 'manifest digest'],
    ['provider tag mismatch', { VERIFIED_E2E_PROVIDER_TAG: 'e2e-provider-v9.9.9' }, 'provider tag mismatch'],
    ['provider commit mismatch', { VERIFIED_E2E_PROVIDER_COMMIT: 'f'.repeat(40) }, 'provider commit mismatch'],
    ['moved release tag', { GIT_STUB_RELEASE_COMMIT: 'e'.repeat(40) }, 'immutable release tag moved']
  ])('fails closed on %s before any alias mutation', (_name, overrides, message) => {
    const result = executeAliasShell(overrides);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(message);
    expect(result.mutations).toEqual([]);
  });
});

/**
 * C6 / Q1 — executable proof for the notify-composite notification branches.
 *
 * Rather than only text-inspecting the dispatch step, this harness extracts the
 * actual `run` body from the workflow YAML, substitutes the compile-time GitHub
 * expressions (${{ github.* }}) with deterministic values, and executes the
 * real inline shell through bash (Git Bash on Windows) with a stub `gh` on PATH.
 * The stub records every invocation so we can assert observable dispatch /
 * no-dispatch behaviour on both branches of the token-guard.
 */
describe('release workflow notify-composite dispatch execution', () => {
  const dispatchRunBody: string = (() => {
    const parsed = parse(releaseWorkflow) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const step = parsed.jobs['notify-composite'].steps.find(
      (s) => s.name === 'Dispatch sibling-release to the composite'
    );
    return step?.run ?? '';
  })();

  interface ExecutedShellResult {
    status: number;
    stdout: string;
    stderr: string;
    ghCalls: string[];
  }

  function executeDispatchShell(ghToken: string): ExecutedShellResult {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-shell-'));
    const logFile = join(tmpDir, 'gh-call.log');

    // Stub gh: one line per invocation, args space-joined.  The stub is shared
    // across platforms — on Windows we also emit a .bat wrapper so Git Bash's
    // PATH resolution finds it even without extensionless executable support.
    const bashStub = `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$GH_CALL_LOG"\nexit 0\n`;
    writeFileSync(join(tmpDir, 'gh'), bashStub);
    chmodSync(join(tmpDir, 'gh'), 0o755);

    if (process.platform === 'win32') {
      writeFileSync(
        join(tmpDir, 'gh.bat'),
        '@echo off\r\n>>"%GH_CALL_LOG%" echo %*\r\nexit /b 0\r\n'
      );
    }

    const script = dispatchRunBody
      .replace(/\$\{\{\s*github\.server_url\s*\}\}/g, 'https://github.com')
      .replace(/\$\{\{\s*github\.repository\s*\}\}/g, 'postman-cs/postman-repo-sync-action')
      .replace(/\$\{\{\s*github\.run_id\s*\}\}/g, '0123456789');

    const scriptPath = join(tmpDir, 'dispatch.sh');
    writeFileSync(scriptPath, script);

    const result = spawnSync('bash', ['--noprofile', '--norc', scriptPath], {
      cwd: tmpDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GH_TOKEN: ghToken,
        GITHUB_REPOSITORY: 'postman-cs/postman-repo-sync-action',
        GH_CALL_LOG: logFile,
        PATH: `${tmpDir}${delimiter}${process.env.PATH ?? ''}`,
      },
      timeout: 30000,
    });

    const log = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '';
    const ghCalls = log
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return {
      status: result.status ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ghCalls,
    };
  }

  it('extracts the dispatch run body straight from the live workflow YAML', () => {
    expect(dispatchRunBody).toContain('set -euo pipefail');
    expect(dispatchRunBody).toContain('gh api repos/postman-cs/postman-api-onboarding-action/dispatches');
    expect(dispatchRunBody).toContain('event_type=sibling-release');
    expect(dispatchRunBody).toContain('client_payload[repository]=${GITHUB_REPOSITORY}');
    expect(dispatchRunBody).toContain(
      'client_payload[run]=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}'
    );
  });

  it('substitutes compile-time GitHub expressions to deterministic values', () => {
    const script = dispatchRunBody
      .replace(/\$\{\{\s*github\.server_url\s*\}\}/g, 'https://github.com')
      .replace(/\$\{\{\s*github\.repository\s*\}\}/g, 'postman-cs/postman-repo-sync-action')
      .replace(/\$\{\{\s*github\.run_id\s*\}\}/g, '0123456789');

    expect(script).not.toContain('${{');
    expect(script).toContain(
      'client_payload[run]=https://github.com/postman-cs/postman-repo-sync-action/actions/runs/0123456789'
    );
  });

  it('executes the dispatch shell with a non-empty GH_TOKEN: exit 0, single gh call with exact payload', () => {
    const result = executeDispatchShell('test-token-value');

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('App token unavailable');
    expect(result.ghCalls).toHaveLength(1);

    const call = result.ghCalls[0];
    expect(call).toContain('repos/postman-cs/postman-api-onboarding-action/dispatches');
    expect(call).toContain('event_type=sibling-release');
    expect(call).toContain('client_payload[repository]=postman-cs/postman-repo-sync-action');
    expect(call).toContain(
      'client_payload[run]=https://github.com/postman-cs/postman-repo-sync-action/actions/runs/0123456789'
    );
  });

  it('executes the dispatch shell with an empty GH_TOKEN: exit 0, cron-backstop notice, zero gh calls', () => {
    const result = executeDispatchShell('');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::notice::');
    expect(result.stdout).toContain(
      "App token unavailable (secrets missing or mint failed); the composite's daily cron will pick this release up."
    );
    expect(result.ghCalls).toHaveLength(0);
  });
});
