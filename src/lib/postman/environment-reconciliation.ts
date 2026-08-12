import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { load as loadYaml } from 'js-yaml';

import { assertPathWithinCwd } from '../repo/path-sandbox.js';
import { environmentFileName } from './environment-yaml.js';

export type CloudResourceMap = Record<string, string>;

export type PostmanResourcesState = {
  /** State schema version. Absent = v1 (legacy). v2 is canonical-only. */
  version?: number;
  workspace?: {
    id?: string;
  };
  localResources?: Record<string, string[]>;
  cloudResources?: {
    collections?: CloudResourceMap;
    environments?: CloudResourceMap;
    specs?: CloudResourceMap;
  };
  canonical?: {
    collections?: CloudResourceMap;
    environments?: CloudResourceMap;
    specs?: CloudResourceMap;
  };
} & Record<string, unknown>;

/** Contract violation raised when tracked state exists but cannot be trusted. */
export class StateUnreadableError extends Error {
  readonly code = 'CONTRACT_STATE_UNREADABLE';
  constructor(message: string) {
    super(`CONTRACT_STATE_UNREADABLE: ${message}`);
    this.name = 'StateUnreadableError';
  }
}

function normalizeToPosix(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/\\/g, '/');
}

export function canonicalizeManifestRef(value: string): string {
  return path.posix.normalize(normalizeToPosix(value).trim());
}

export function legacyEnvironmentManifestRef(
  artifactDir: string,
  environmentName: string
): string {
  return canonicalizeManifestRef(
    `../${artifactDir}/environments/${environmentName}.postman_environment.json`
  );
}

export function currentEnvironmentManifestRef(
  artifactDir: string,
  projectName: string,
  environmentName: string
): string {
  return canonicalizeManifestRef(
    `../${artifactDir}/environments/${environmentFileName(projectName, environmentName)}`
  );
}

export function environmentManifestRefMatches(
  ref: string,
  projectName: string,
  environmentName: string
): boolean {
  const canonicalRef = canonicalizeManifestRef(ref);
  return canonicalRef.endsWith(
    `/environments/${environmentFileName(projectName, environmentName)}`
  ) || canonicalRef.endsWith(
    `/environments/${environmentName}.postman_environment.json`
  );
}

export function getEnvironmentUidsFromResources(
  resourcesState: PostmanResourcesState | null,
  projectName: string,
  environmentNames: Iterable<string>
): Record<string, string> {
  const cloudEnvironments = resourcesState?.cloudResources?.environments;
  if (!cloudEnvironments) {
    return {};
  }

  const entries = Object.entries(cloudEnvironments).map(([filePath, uid]) => [
    canonicalizeManifestRef(filePath),
    uid
  ] as const);
  const resolved: Record<string, string> = Object.create(null) as Record<string, string>;

  for (const environmentName of environmentNames) {
    const matches = entries.filter(([filePath]) =>
      environmentManifestRefMatches(filePath, projectName, environmentName)
    );
    const uids = [...new Set(matches.map(([, uid]) => uid))];
    if (uids.length > 1) {
      throw new StateUnreadableError(
        `environment "${environmentName}" has conflicting current and legacy UIDs in .postman/resources.yaml`
      );
    }
    if (uids[0]) {
      resolved[environmentName] = uids[0];
    }
  }

  return resolved;
}

export function getPreservedEnvironmentFileNames(
  resourcesState: PostmanResourcesState | null,
  artifactDir: string,
  projectName: string,
  environmentNames: Iterable<string>,
  workspaceId: string
): string[] {
  const trackedWorkspaceId = resourcesState?.workspace?.id?.trim();
  if (!trackedWorkspaceId || trackedWorkspaceId !== workspaceId.trim()) {
    return [];
  }

  const requestedNames = [...environmentNames];
  const targetDirectory = canonicalizeManifestRef(`../${artifactDir}/environments`);
  return Object.keys(resourcesState?.cloudResources?.environments ?? {})
    .map(canonicalizeManifestRef)
    .filter((ref) => path.posix.dirname(ref) === targetDirectory)
    .filter((ref) => ref.endsWith('.environment.yaml'))
    .filter((ref) => !requestedNames.some((name) =>
      environmentManifestRefMatches(ref, projectName, name)
    ))
    .map((ref) => path.posix.basename(ref));
}

export function getExistingEnvironmentFileNames(
  artifactDir: string,
  projectName: string,
  environmentNames: Iterable<string>
): string[] {
  const environmentDirectory = `${artifactDir}/environments`;
  assertPathWithinCwd(environmentDirectory, 'environment directory');
  if (!existsSync(environmentDirectory)) {
    return [];
  }

  const requestedFileNames = new Set(
    [...environmentNames].map((name) => environmentFileName(projectName, name))
  );
  return readdirSync(environmentDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((fileName) => fileName.endsWith('.environment.yaml'))
    .filter((fileName) => !requestedFileNames.has(fileName));
}

function manifestRefToRepoPath(ref: string): string {
  const canonicalRef = canonicalizeManifestRef(ref);
  const repoPath = path.posix.normalize(path.posix.join('.postman', canonicalRef));
  assertPathWithinCwd(repoPath, 'tracked environment artifact');
  return repoPath;
}

function assertTrackedCurrentEnvironmentArtifact(
  ref: string,
  projectName: string,
  environmentName: string
): void {
  const currentPath = manifestRefToRepoPath(ref);
  if (!existsSync(currentPath)) {
    throw new StateUnreadableError(
      `current environment artifact ${canonicalizeManifestRef(ref)} is tracked but missing; refusing to reuse its UID without logical identity evidence before cloud mutation`
    );
  }
  try {
    const parsed = loadYaml(readFileSync(currentPath, 'utf8')) as {
      name?: unknown;
      values?: unknown;
    } | null;
    if (
      parsed?.name !== `${projectName} - ${environmentName}` ||
      !Array.isArray(parsed.values)
    ) {
      throw new Error('logical environment identity does not match');
    }
  } catch {
    throw new StateUnreadableError(
      `current environment artifact ${canonicalizeManifestRef(ref)} is tracked but does not belong to logical environment "${environmentName}"; preserving it without cloud mutation`
    );
  }
}

function getTrackedEnvironmentArtifactUid(
  resourcesState: PostmanResourcesState | null | undefined,
  expectedRef: string,
  artifactKind: 'legacy' | 'current'
): string | undefined {
  const normalizedExpectedRef = canonicalizeManifestRef(expectedRef);
  const matches = Object.entries(resourcesState?.cloudResources?.environments ?? {})
    .filter(([ref]) => canonicalizeManifestRef(ref) === normalizedExpectedRef)
    .map(([, uid]) => uid);
  const uniqueUids = [...new Set(matches)];
  if (uniqueUids.length > 1) {
    throw new StateUnreadableError(
      `${artifactKind} environment artifact ${normalizedExpectedRef} has conflicting UIDs in .postman/resources.yaml`
    );
  }
  return uniqueUids[0];
}

export function getTrackedLegacyEnvironmentUid(
  resourcesState: PostmanResourcesState | null | undefined,
  artifactDir: string,
  environmentName: string
): string | undefined {
  return getTrackedEnvironmentArtifactUid(
    resourcesState,
    legacyEnvironmentManifestRef(artifactDir, environmentName),
    'legacy'
  );
}

export function assertEnvironmentArtifactOwnership(
  resourcesState: PostmanResourcesState | null,
  artifactDir: string,
  projectName: string,
  environmentNames: Iterable<string>,
  explicitEnvironmentUids: Record<string, string>,
  includeLegacyOwnership: boolean
): void {
  const trackedEnvironmentEntries = Object.entries(
    resourcesState?.cloudResources?.environments ?? {}
  ).map(([ref, uid]) => [canonicalizeManifestRef(ref), uid] as const);
  for (const environmentName of environmentNames) {
    const explicitUid = Object.prototype.hasOwnProperty.call(
      explicitEnvironmentUids,
      environmentName
    )
      ? explicitEnvironmentUids[environmentName]
      : undefined;
    const legacyRef = legacyEnvironmentManifestRef(artifactDir, environmentName);
    const trackedLegacyUid = includeLegacyOwnership
      ? getTrackedLegacyEnvironmentUid(resourcesState, artifactDir, environmentName)
      : undefined;
    if (explicitUid && trackedLegacyUid && trackedLegacyUid !== explicitUid) {
      throw new StateUnreadableError(
        `legacy environment artifact ${legacyRef} belongs to ${trackedLegacyUid}, not explicit UID ${explicitUid}`
      );
    }

    const currentRef = currentEnvironmentManifestRef(
      artifactDir,
      projectName,
      environmentName
    );
    const trackedCurrentUid = getTrackedEnvironmentArtifactUid(
      resourcesState,
      currentRef,
      'current'
    );
    if (explicitUid && trackedCurrentUid && trackedCurrentUid !== explicitUid) {
      throw new StateUnreadableError(
        `current environment artifact ${currentRef} belongs to ${trackedCurrentUid}, not explicit UID ${explicitUid}`
      );
    }

    for (const [trackedRef, trackedUid] of trackedEnvironmentEntries) {
      if (
        trackedRef.endsWith('.environment.yaml') &&
        environmentManifestRefMatches(trackedRef, projectName, environmentName)
      ) {
        if (explicitUid && trackedUid !== explicitUid) {
          throw new StateUnreadableError(
            `current environment artifact ${trackedRef} belongs to ${trackedUid}, not explicit UID ${explicitUid}`
          );
        }
        assertTrackedCurrentEnvironmentArtifact(trackedRef, projectName, environmentName);
      }
    }

    const currentPath = `${artifactDir}/environments/${environmentFileName(projectName, environmentName)}`;
    assertPathWithinCwd(currentPath, 'environment target');
    if (existsSync(currentPath) && !trackedCurrentUid) {
      throw new StateUnreadableError(
        `current environment artifact ${currentRef} exists but is not tracked in .postman/resources.yaml; preserving it without cloud mutation`
      );
    }
  }
}
