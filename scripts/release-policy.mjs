import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} version
 * @returns {string}
 */
export function normalizeSemver(version) {
  const bare = String(version).replace(/^v/, '');
  const parts = bare.split('.');
  if (parts.length === 2 && parts.every((part) => /^\d+$/.test(part))) {
    return `${parts[0]}.${parts[1]}.0`;
  }
  if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part))) {
    return bare;
  }
  throw new Error(`invalid semantic version: ${version}`);
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {-1|0|1}
 */
export function compareSemver(left, right) {
  const a = normalizeSemver(left).split('.').map(Number);
  const b = normalizeSemver(right).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/**
 * True only when left is strictly older than right. Equal is not older.
 * @param {string} left
 * @param {string} right
 */
export function isSemverOlder(left, right) {
  return compareSemver(left, right) < 0;
}

/**
 * @param {{ ref: string, refName: string, packageVersion: string }} input
 * @returns {{ release_kind: 'immutable'|'alias', npm_publish: 'true'|'false' }}
 */
export function classifyRelease({ ref, refName, packageVersion }) {
  const [major, minor, patch] = String(packageVersion).split('.');
  const accepted = `expected v${packageVersion}, v${major}.${minor} when patch is zero, or v${major}`;
  if (!ref?.startsWith('refs/tags/v')) {
    throw new Error(`Release workflow must run from an accepted immutable tag; got ${ref}; ${accepted}`);
  }
  const tagVersion = String(refName ?? '').startsWith('v') ? String(refName).slice(1) : '';
  if (tagVersion === packageVersion || (patch === '0' && tagVersion === `${major}.${minor}`)) {
    return { release_kind: 'immutable', npm_publish: 'true' };
  }
  if (tagVersion === major) {
    return { release_kind: 'alias', npm_publish: 'false' };
  }
  throw new Error(`Release workflow must run from an accepted immutable tag; got ${refName}; ${accepted}`);
}

function writeOutput(key, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(output, `${key}=${value}\n`);
}

function runClassify() {
  const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const ref = process.env.GITHUB_REF ?? '';
  const refName = process.env.GITHUB_REF_NAME ?? '';
  const result = classifyRelease({ ref, refName, packageVersion });
  writeOutput('release_kind', result.release_kind);
  writeOutput('npm_publish', result.npm_publish);
  if (result.release_kind === 'alias') {
    console.log(`::notice::Rolling alias ${refName} is a no-op.`);
  }
}

function main() {
  const mode = process.argv[2];
  if (mode === 'classify') {
    runClassify();
    return;
  }
  throw new Error('usage: release-policy.mjs classify');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exit(1);
  }
}
