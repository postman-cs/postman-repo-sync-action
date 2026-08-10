import { dump as dumpYaml } from 'js-yaml';

/**
 * Reshape a sync-service environment body into the canonical v3 YAML shape the
 * v12 Postman client emits in Local Mode — `{name, values: [{key, value}]}` —
 * and serialize as YAML. Peer to `convertAndSplitAnyCollection` in `converter.ts`
 * for environments; matches the same "canonical v3 on disk" goal for the only
 * asset type still emitted as legacy V2 JSON.
 *
 * The client-emitted shape omits `type` and `enabled` on each value. Secret
 * handling stays with the caller (see `sanitizeMockEnvironmentArtifact` in
 * `src/index.ts`), which zeros secret values before this reshape.
 */
export function convertEnvironmentToYaml(env: unknown): string {
  const body = (env ?? {}) as { name?: unknown; values?: unknown };
  const rawValues = Array.isArray(body.values) ? body.values : [];
  const shape = {
    name: typeof body.name === 'string' ? body.name : '',
    values: rawValues.map((entry) => {
      const record = (entry ?? {}) as { key?: unknown; value?: unknown };
      return {
        key: typeof record.key === 'string' ? record.key : '',
        value: typeof record.value === 'string' ? record.value : ''
      };
    })
  };
  return dumpYaml(shape, { lineWidth: -1, noRefs: true });
}

/**
 * Slugify a name for use inside an environment filename. Mirrors the v12
 * client's on-disk convention: lowercase, whitespace and unsafe characters
 * collapsed to `-`, leading/trailing punctuation trimmed. Character class kept
 * in sync with `buildBranchSlug` in `src/lib/repo/branch-decision.ts`, adapted
 * to lowercase-only for filesystem stability across case-insensitive stores.
 */
export function slugifyEnvironmentName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
}

/**
 * Build the on-disk filename for a user-facing environment artifact:
 * `<workspace-slug> - <env-slug>.environment.yaml`. Round-trip parity with the
 * v12 client, which emits the same filename shape in Local Mode.
 */
export function environmentFileName(workspaceName: string, envName: string): string {
  return `${slugifyEnvironmentName(workspaceName)} - ${slugifyEnvironmentName(envName)}.environment.yaml`;
}
