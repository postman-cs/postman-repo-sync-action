import { sanitizeFilename } from '@postman/fs-utils';
import { dump as dumpYaml } from 'js-yaml';

const EXTENSION = '.environment.yaml';
const SEPARATOR = ' - ';
const MAX_BASENAME_BYTES = 64;
const SANITIZE_OPTIONS = {
  replacement: '-',
  combineConsecutiveReplacements: true
};

function assertWellFormed(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new Error(`${label} must contain well-formed Unicode`);
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      throw new Error(`${label} must contain well-formed Unicode`);
    }
  }
}

function safeEnvironmentName(value: string): string {
  assertWellFormed(value, 'environment name');
  const hasInvalidCharacter = [...value].some((char) => {
    const code = char.charCodeAt(0);
    return char === '/' || char === '\\' || code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
  if (!value || hasInvalidCharacter) {
    throw new Error('environment name must be non-empty and contain no path separators or control characters');
  }
  return sanitizeFilename(value, {
    ...SANITIZE_OPTIONS,
    maxLength: MAX_BASENAME_BYTES - Buffer.byteLength(SEPARATOR)
  });
}

/** Stable v12-style filename that reserves the logical environment suffix. */
export function environmentFileName(projectName: string, environmentName: string): string {
  assertWellFormed(projectName, 'project name');
  const suffix = safeEnvironmentName(environmentName);
  const projectBudget = Math.max(
    0,
    MAX_BASENAME_BYTES - Buffer.byteLength(SEPARATOR) - Buffer.byteLength(suffix)
  );
  const prefix = sanitizeFilename(projectName, { ...SANITIZE_OPTIONS, maxLength: projectBudget });
  return `${prefix ? `${prefix}${SEPARATOR}` : ''}${suffix}${EXTENSION}`;
}

export function assertUniqueEnvironmentFileNames(
  projectName: string,
  environmentNames: Iterable<string>
): void {
  const owners = new Map<string, string>();
  for (const environmentName of environmentNames) {
    const fileName = environmentFileName(projectName, environmentName);
    const key = fileName.normalize('NFD').toUpperCase().toLowerCase();
    const owner = owners.get(key);
    if (owner) {
      throw new Error(
        `Environment identities "${owner}" and "${environmentName}" resolve to the same artifact filename ${fileName}`
      );
    }
    owners.set(key, environmentName);
  }
}

export function environmentManifestRef(
  artifactDir: string,
  projectName: string,
  environmentName: string
): string {
  return `../${artifactDir}/environments/${environmentFileName(projectName, environmentName)}`;
}

export function legacyEnvironmentManifestRef(artifactDir: string, environmentName: string): string {
  return `../${artifactDir}/environments/${environmentName}.postman_environment.json`;
}

/** Convert a sync-service environment body to canonical filesystem YAML. */
export function serializeEnvironmentYaml(payload: unknown, displayName: string): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('sync-service environment must contain an object body');
  }
  const body = payload as { values?: unknown; color?: unknown };
  if (!Array.isArray(body.values)) {
    throw new Error('sync-service environment must contain a values array');
  }
  const values = body.values.map((entry) => {
    const input = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    const secret = input.secret === true || input.type === 'secret';
    const output: Record<string, unknown> = {
      key: input.key == null ? '' : String(input.key)
    };
    if (secret) {
      output.secret = true;
      if (input.source != null) output.source = input.source;
    } else {
      output.value = input.value == null ? '' : String(input.value);
    }
    if (input.enabled === false) output.disabled = true;
    if (input.description != null) output.description = String(input.description);
    return output;
  });
  const environment: Record<string, unknown> = { name: displayName, values };
  if (Number.isInteger(body.color) && Number(body.color) >= 0 && Number(body.color) < 360) {
    environment.color = Number(body.color);
  }
  return dumpYaml(environment, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });
}
