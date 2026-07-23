import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SAFE_BASENAME = /^[A-Za-z0-9._-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * @param {Buffer|string} bytes
 * @returns {string}
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {Buffer|string} bytes
 * @returns {string}
 */
export function computeNpmSri(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/**
 * @param {string} expected
 * @param {string} actual
 */
export function assertNpmSriMatch(expected, actual) {
  if (expected !== actual) {
    throw new Error('existing npm package integrity differs from staged tarball');
  }
}

/**
 * @param {string} tag
 * @param {string} packageVersion
 */
export function validateTagVersion(tag, packageVersion) {
  const [major, minor, patch] = packageVersion.split('.');
  if (tag !== `v${packageVersion}` && !(patch === '0' && tag === `v${major}.${minor}`)) {
    throw new Error(`tag ${tag} does not match package version ${packageVersion}`);
  }
}

/**
 * @param {string} tag
 * @param {string} version
 * @returns {boolean}
 */
export function validateReleaseTag(tag, version) {
  try {
    validateTagVersion(tag, version);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} packageVersion
 * @returns {string[]}
 */
export function expectedArtifactNames(packageVersion) {
  const sea = `postman-repo-sync-${packageVersion}-linux-x64`;
  return ['release.tgz', sea, `${sea}.sha256`];
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`manifest ${label} must be a non-empty string`);
  }
}

/**
 * @param {unknown} manifest
 * @param {string} directory
 * @param {{ repository: string, commitSha: string, tag: string, packageName?: string, packageVersion?: string }} expected
 */
export function validateManifest(manifest, directory, expected) {
  if (!manifest || typeof manifest !== 'object') throw new Error('invalid manifest schema');
  const body = /** @type {Record<string, unknown>} */ (manifest);
  if (body.schema_version !== 1) throw new Error('invalid manifest schema');
  assertString(body.repository, 'repository');
  assertString(body.commit_sha, 'commit_sha');
  assertString(body.tag, 'tag');
  assertString(body.package_name, 'package_name');
  assertString(body.package_version, 'package_version');
  if (!Array.isArray(body.artifacts)) throw new Error('invalid manifest schema');

  for (const [key, value] of Object.entries({
    repository: expected.repository,
    commit_sha: expected.commitSha,
    tag: expected.tag
  })) {
    if (body[key] !== value) throw new Error(`manifest ${key} mismatch`);
  }
  if (expected.packageName !== undefined && body.package_name !== expected.packageName) {
    throw new Error('manifest package_name mismatch');
  }
  if (expected.packageVersion !== undefined && body.package_version !== expected.packageVersion) {
    throw new Error('manifest package_version mismatch');
  }

  const packageVersion = String(body.package_version);
  const expectedNames = expectedArtifactNames(packageVersion);
  const seen = new Set();
  /** @type {Array<{ path: string, sha256: string }>} */
  const artifacts = [];
  for (const entry of body.artifacts) {
    if (!entry || typeof entry !== 'object') throw new Error('invalid artifact manifest entry');
    const artifact = /** @type {Record<string, unknown>} */ (entry);
    assertString(artifact.path, 'artifact.path');
    assertString(artifact.sha256, 'artifact.sha256');
    const path = String(artifact.path);
    const digest = String(artifact.sha256);
    if (
      path !== basename(path) ||
      path.includes('..') ||
      path.includes('/') ||
      path.includes('\\') ||
      !SAFE_BASENAME.test(path)
    ) {
      throw new Error(`unsafe artifact path ${path}`);
    }
    if (!SHA256_HEX.test(digest)) throw new Error(`invalid artifact sha256 for ${path}`);
    if (seen.has(path)) throw new Error(`duplicate artifact path ${path}`);
    seen.add(path);
    artifacts.push({ path, sha256: digest });
  }

  if (artifacts.length !== expectedNames.length || expectedNames.some((name) => !seen.has(name))) {
    throw new Error(`exact artifact allowlist mismatch; expected ${expectedNames.join(', ')}`);
  }

  const onDisk = new Set(readdirSync(directory));
  if (!onDisk.has('release-manifest.json')) throw new Error('missing release-manifest.json');
  for (const name of expectedNames) {
    if (!onDisk.has(name)) throw new Error(`missing artifact ${name}`);
  }
  for (const name of onDisk) {
    if (name === 'release-manifest.json') continue;
    if (!seen.has(name)) throw new Error(`unexpected filesystem entry ${name}`);
  }

  for (const artifact of artifacts) {
    const fullPath = join(directory, artifact.path);
    if (!existsSync(fullPath)) throw new Error(`missing artifact ${artifact.path}`);
    if (sha256Hex(readFileSync(fullPath)) !== artifact.sha256) {
      throw new Error(`checksum mismatch for ${artifact.path}`);
    }
  }

  validateTagVersion(String(body.tag), packageVersion);
  validateSeaSidecar(directory, packageVersion, artifacts);
  return body;
}

/**
 * @param {string} directory
 * @param {string} packageVersion
 * @param {Array<{ path: string, sha256: string }>} artifacts
 */
export function validateSeaSidecar(directory, packageVersion, artifacts) {
  const sea = `postman-repo-sync-${packageVersion}-linux-x64`;
  const sidecarName = `${sea}.sha256`;
  const seaEntry = artifacts.find((artifact) => artifact.path === sea);
  const sidecarEntry = artifacts.find((artifact) => artifact.path === sidecarName);
  if (!seaEntry || !sidecarEntry) throw new Error('SEA executable and sidecar are required');
  const sidecarText = readFileSync(join(directory, sidecarName), 'utf8').trim();
  const [digest = '', filename = ''] = sidecarText.split(/\s+/);
  if (!SHA256_HEX.test(digest) || filename !== sea) {
    throw new Error(`SEA sidecar text must be "<sha256> ${sea}"`);
  }
  const actual = sha256Hex(readFileSync(join(directory, sea)));
  if (
    digest !== actual ||
    digest !== seaEntry.sha256 ||
    sidecarEntry.sha256 !== sha256Hex(readFileSync(join(directory, sidecarName)))
  ) {
    throw new Error('SEA sidecar digest does not match executable and manifest');
  }
}

/**
 * @param {string} directory
 */
export function readTarballPackageIdentity(directory) {
  const tarball = join(directory, 'release.tgz');
  const packageJson = JSON.parse(
    execFileSync('tar', ['-xOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  );
  return { name: packageJson.name, version: packageJson.version };
}

/**
 * @param {{ directory?: string, repository: string, commitSha: string, tag: string }} input
 */
export function verifyReleaseArtifacts({ directory = '.', repository, commitSha, tag }) {
  const manifestPath = join(directory, 'release-manifest.json');
  if (!existsSync(manifestPath)) throw new Error('release-manifest.json is required');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const identity = readTarballPackageIdentity(directory);
  validateManifest(manifest, directory, {
    repository,
    commitSha,
    tag,
    packageName: identity.name,
    packageVersion: identity.version
  });
  if (manifest.package_name !== identity.name || manifest.package_version !== identity.version) {
    throw new Error('tarball package identity mismatch');
  }
  return manifest;
}

function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error('usage: node scripts/verify-release-artifacts.mjs <directory>');
  verifyReleaseArtifacts({
    directory,
    repository: process.env.GITHUB_REPOSITORY ?? '',
    commitSha: process.env.GITHUB_SHA ?? '',
    tag: process.env.GITHUB_REF_NAME ?? ''
  });
  console.log('release artifact manifest verified');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
