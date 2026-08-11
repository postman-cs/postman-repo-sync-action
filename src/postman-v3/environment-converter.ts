import { sanitizeFilename } from '@postman/fs-utils';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { isDeepStrictEqual } from 'node:util';

type EnvironmentYaml = {
  name: string;
  values: Array<Record<string, unknown>>;
  color?: number;
};

const ENVIRONMENT_YAML_EXT = '.environment.yaml';
const SANITIZE_OPTIONS = {
  replacement: '-',
  combineConsecutiveReplacements: true,
  maxLength: 64
};

function parseEnvironmentYaml(yaml: string): unknown {
  const parsed = loadYaml(yaml);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('environment YAML must contain a mapping');
  }
  return parsed;
}

/**
 * Adapt a sync-service environment body to the canonical environment YAML
 * contract used by Postman v12 Local Mode's environment filesystem serializer.
 * Sync values use `enabled`; disk values omit it unless false, represented as
 * `disabled: true`. Resolved secrets and legacy `type: secret` values never
 * persist `value`; both become canonical `secret: true` entries.
 */
export function convertEnvironmentToYaml(env: unknown): string {
  const body = (env ?? {}) as { name?: unknown; values?: unknown; color?: unknown };
  if (typeof body.name !== 'string' || !body.name) {
    throw new Error('sync-service environment must contain a non-empty string name');
  }
  const rawValues = Array.isArray(body.values) ? body.values : [];
  const shape: EnvironmentYaml = {
    name: body.name,
    values: rawValues.map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const secret = record.secret === true || record.type === 'secret';
      const value: Record<string, unknown> = {
        key: record.key == null ? '' : String(record.key)
      };
      if (!secret) {
        value.value = record.value == null ? '' : String(record.value);
      }
      if (record.enabled === false) {
        value.disabled = true;
      }
      if (record.description != null) {
        value.description = String(record.description);
      }
      if (secret) {
        value.secret = true;
        if (record.source != null) {
          value.source = record.source;
        }
      }
      return value;
    })
  };
  if (Number.isInteger(body.color) && Number(body.color) >= 0 && Number(body.color) < 360) {
    shape.color = Number(body.color);
  }
  return dumpYaml(shape, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });
}

function assertSafeEnvironmentIdentity(input: string): string {
  if (/[\\/]/.test(input) || Array.from(input).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) {
    throw new Error('environment name must not contain path separators or control characters');
  }
  const sanitized = sanitizeFilename(input, SANITIZE_OPTIONS);
  if (!sanitized) {
    throw new Error('environment name must produce a non-empty filesystem name');
  }
  return sanitized;
}

/**
 * Build the Postman app filename from the stable cloud display name. Repo-sync
 * deliberately rejects collisions instead of adding stateful numeric suffixes.
 */
export function environmentFileName(workspaceName: string, envName: string): string {
  assertSafeEnvironmentIdentity(envName);
  const baseName = sanitizeFilename(`${workspaceName} - ${envName}`, SANITIZE_OPTIONS);
  if (!baseName) {
    throw new Error('environment display name must produce a non-empty filesystem name');
  }
  return `${baseName}${ENVIRONMENT_YAML_EXT}`;
}

/**
 * Approximate the normalization and full case-folding used by common
 * case-insensitive filesystems. Upper-then-lower expands folds such as ß→ss
 * and ς→σ; NFD makes composed/decomposed spellings compare identically.
 */
function portableFilenameCollisionKey(fileName: string): string {
  return fileName.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD');
}

/** Fail closed before any cloud or filesystem mutation can collapse identities. */
export function assertUniqueEnvironmentFileNames(
  workspaceName: string,
  environmentNames: Iterable<string>
): void {
  const owners = new Map<string, string>();
  for (const environmentName of environmentNames) {
    const fileName = environmentFileName(workspaceName, environmentName);
    const collisionKey = portableFilenameCollisionKey(fileName);
    const owner = owners.get(collisionKey);
    if (owner !== undefined) {
      throw new Error(
        `Environment names "${owner}" and "${environmentName}" resolve to the same artifact filename ${fileName}`
      );
    }
    owners.set(collisionKey, environmentName);
  }
}

/** Validate both the v3 shape and byte-to-object round trip before promotion. */
export function assertEnvironmentYamlRoundTrip(candidate: string, expected: string): void {
  const parsedCandidate = parseEnvironmentYaml(candidate);
  const parsedExpected = parseEnvironmentYaml(expected);
  if (!isDeepStrictEqual(parsedCandidate, parsedExpected)) {
    throw new Error('environment YAML candidate changed during round-trip validation');
  }
}
