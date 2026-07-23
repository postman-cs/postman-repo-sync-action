export interface ReleaseManifest {
  schema_version: number;
  repository: string;
  commit_sha: string;
  tag: string;
  package_name: string;
  package_version: string;
  artifacts: Array<{ path: string; sha256: string }>;
}

export function sha256Hex(bytes: Buffer | string): string;
export function computeNpmSri(bytes: Buffer | string): string;
export function assertNpmSriMatch(expected: string, actual: string): void;
export function validateTagVersion(tag: string, packageVersion: string): void;
export function validateReleaseTag(tag: string, version: string): boolean;
export function expectedArtifactNames(packageVersion: string): string[];
export function validateManifest(
  manifest: unknown,
  directory: string,
  expected: {
    repository: string;
    commitSha: string;
    tag: string;
    packageName?: string;
    packageVersion?: string;
  }
): ReleaseManifest | Record<string, unknown>;
export function validateSeaSidecar(
  directory: string,
  packageVersion: string,
  artifacts: Array<{ path: string; sha256: string }>
): void;
export function readTarballPackageIdentity(directory: string): { name: string; version: string };
export function verifyReleaseArtifacts(input: {
  directory?: string;
  repository: string;
  commitSha: string;
  tag: string;
}): ReleaseManifest | Record<string, unknown>;
