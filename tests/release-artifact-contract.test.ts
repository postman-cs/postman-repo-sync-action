import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNpmSriMatch,
  computeNpmSri,
  expectedArtifactNames,
  sha256Hex,
  validateManifest,
  validateReleaseTag,
  validateTagVersion,
  verifyReleaseArtifacts
} from '../scripts/verify-release-artifacts.mjs';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function stageReleaseDirectory(packageVersion = '2.1.10') {
  const directory = mkdtempSync(join(tmpdir(), 'repo-sync-release-'));
  const packRoot = mkdtempSync(join(tmpdir(), 'repo-sync-pack-'));
  const packageDir = join(packRoot, 'package');
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@postman-cse/onboarding-repo-sync', version: packageVersion })
  );
  const tarball = join(directory, 'release.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', packRoot, 'package']);
  const sea = `postman-repo-sync-${packageVersion}-linux-x64`;
  const seaBytes = Buffer.from(`sea-bytes-${packageVersion}`);
  writeFileSync(join(directory, sea), seaBytes);
  writeFileSync(join(directory, `${sea}.sha256`), `${digest(seaBytes)}  ${sea}\n`);
  const artifacts = expectedArtifactNames(packageVersion).map((path) => ({
    path,
    sha256: digest(readFileSync(join(directory, path)))
  }));
  const manifest = {
    schema_version: 1,
    repository: 'postman-cs/postman-repo-sync-action',
    commit_sha: 'abc123',
    tag: `v${packageVersion}`,
    package_name: '@postman-cse/onboarding-repo-sync',
    package_version: packageVersion,
    artifacts
  };
  writeFileSync(join(directory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(packRoot, { recursive: true, force: true });
  return { directory, manifest, sea };
}

describe('release artifact contract', () => {
  it('accepts exact and zero-patch minor immutable tags only', () => {
    expect(validateReleaseTag('v2.1.10', '2.1.10')).toBe(true);
    expect(validateReleaseTag('v2.1', '2.1.0')).toBe(true);
    expect(validateReleaseTag('v2', '2.1.10')).toBe(false);
    expect(validateReleaseTag('v2.2', '2.1.10')).toBe(false);
    expect(() => validateTagVersion('v2.1.10', '2.1.10')).not.toThrow();
    expect(() => validateTagVersion('v2.1', '2.1.0')).not.toThrow();
    expect(() => validateTagVersion('v2.0', '2.0.4')).toThrow(/does not match/);
  });

  it('binds manifest artifacts to repository, SHA, tag, version, checksums, and SEA sidecar', () => {
    const { directory, manifest, sea } = stageReleaseDirectory();
    try {
      expect(() =>
        validateManifest(manifest, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag,
          packageName: manifest.package_name,
          packageVersion: manifest.package_version
        })
      ).not.toThrow();
      expect(() =>
        validateManifest(manifest, directory, {
          repository: 'other/repo',
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/repository/);
      expect(() =>
        validateManifest({ ...manifest, commit_sha: 'wrong' }, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/commit_sha/);
      expect(() =>
        validateManifest({ ...manifest, tag: 'v9.9.9' }, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/tag/);
      expect(() =>
        validateManifest({ ...manifest, package_version: '9.9.9' }, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag,
          packageVersion: '2.1.10'
        })
      ).toThrow(/package_version/);
      expect(() =>
        validateManifest(
          { ...manifest, artifacts: [{ path: 'release.tgz', sha256: '0'.repeat(64) }] },
          directory,
          { repository: manifest.repository, commitSha: manifest.commit_sha, tag: manifest.tag }
        )
      ).toThrow(/allowlist|checksum|exact artifact/);
      writeFileSync(join(directory, sea), Buffer.from('tampered-sea'));
      expect(() =>
        validateManifest(manifest, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/checksum|sidecar/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects missing, extra, duplicate, and traversal artifact paths', () => {
    const { directory, manifest, sea } = stageReleaseDirectory();
    try {
      const missingSea = {
        ...manifest,
        artifacts: manifest.artifacts.filter((artifact) => artifact.path !== sea)
      };
      expect(() =>
        validateManifest(missingSea, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/allowlist|exact artifact/);

      writeFileSync(join(directory, 'extra.bin'), 'nope');
      expect(() =>
        validateManifest(manifest, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/unexpected filesystem entry/);
      rmSync(join(directory, 'extra.bin'));

      const duplicate = {
        ...manifest,
        artifacts: [...manifest.artifacts, manifest.artifacts[0]]
      };
      expect(() =>
        validateManifest(duplicate, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/duplicate artifact path/);

      const traversal = {
        ...manifest,
        artifacts: [{ path: '../escape.tgz', sha256: 'a'.repeat(64) }, ...manifest.artifacts.slice(1)]
      };
      expect(() =>
        validateManifest(traversal, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/unsafe artifact path/);

      const nested = {
        ...manifest,
        artifacts: [{ path: 'nested/release.tgz', sha256: 'a'.repeat(64) }, ...manifest.artifacts.slice(1)]
      };
      expect(() =>
        validateManifest(nested, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/unsafe artifact path/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects wrong SEA sidecar digest or filename', () => {
    const { directory, manifest, sea } = stageReleaseDirectory();
    try {
      writeFileSync(join(directory, `${sea}.sha256`), `${'b'.repeat(64)}  ${sea}\n`);
      const artifacts = expectedArtifactNames(manifest.package_version).map((path) => ({
        path,
        sha256: digest(readFileSync(join(directory, path)))
      }));
      expect(() =>
        validateManifest({ ...manifest, artifacts }, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/SEA sidecar digest/);

      writeFileSync(join(directory, `${sea}.sha256`), `${digest(readFileSync(join(directory, sea)))}  wrong-name\n`);
      const renamed = expectedArtifactNames(manifest.package_version).map((path) => ({
        path,
        sha256: digest(readFileSync(join(directory, path)))
      }));
      expect(() =>
        validateManifest({ ...manifest, artifacts: renamed }, directory, {
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/SEA sidecar text/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects tarball package identity mismatch through the verifier entrypoint', () => {
    const { directory, manifest } = stageReleaseDirectory();
    try {
      const packRoot = mkdtempSync(join(tmpdir(), 'repo-sync-wrong-pack-'));
      const packageDir = join(packRoot, 'package');
      mkdirSync(packageDir);
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: '@postman-cse/onboarding-repo-sync', version: '9.9.9' })
      );
      execFileSync('tar', ['-czf', join(directory, 'release.tgz'), '-C', packRoot, 'package']);
      rmSync(packRoot, { recursive: true, force: true });
      const artifacts = expectedArtifactNames(manifest.package_version).map((path) => ({
        path,
        sha256: digest(readFileSync(join(directory, path)))
      }));
      writeFileSync(
        join(directory, 'release-manifest.json'),
        `${JSON.stringify({ ...manifest, artifacts }, null, 2)}\n`
      );
      expect(() =>
        verifyReleaseArtifacts({
          directory,
          repository: manifest.repository,
          commitSha: manifest.commit_sha,
          tag: manifest.tag
        })
      ).toThrow(/package_version|tarball package identity|mismatch/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('computes and asserts npm SHA-512 SRI identity including mismatched fixtures', () => {
    const bytes = Buffer.from('release-tarball-bytes');
    const sri = computeNpmSri(bytes);
    expect(sri).toMatch(/^sha512-[A-Za-z0-9+/=]+$/);
    expect(() => assertNpmSriMatch(sri, sri)).not.toThrow();
    expect(() => assertNpmSriMatch(sri, computeNpmSri(Buffer.from('other')))).toThrow(
      /existing npm package integrity differs from staged tarball/
    );
    expect(sha256Hex('x')).toHaveLength(64);
  });

  it('executes the production publish inline verifier against staged artifacts', () => {
    const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
    const match = releaseWorkflow.match(
      /name: Verify staged release artifacts\n\s+run: \|\n\s+node --input-type=module - <<'NODE'\n([\s\S]*?)\n\s+NODE/
    );
    expect(match?.[1]).toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), 'inline-root-'));
    const { directory } = stageReleaseDirectory();
    const staged = join(root, 'release-artifacts');
    cpSync(directory, staged, { recursive: true });
    const inlinePath = join(root, 'inline-verify.mjs');
    writeFileSync(inlinePath, match?.[1] ?? '');
    const env = {
      ...process.env,
      GITHUB_REPOSITORY: 'postman-cs/postman-repo-sync-action',
      GITHUB_SHA: 'abc123',
      GITHUB_REF_NAME: 'v2.1.10'
    };
    try {
      execFileSync(process.execPath, [inlinePath], { cwd: root, env, stdio: 'pipe' });
      writeFileSync(join(staged, 'release.tgz'), Buffer.from('tampered'));
      expect(() => execFileSync(process.execPath, [inlinePath], { cwd: root, env, stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
