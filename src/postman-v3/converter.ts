import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import * as V2 from '@postman/runtime.models/v2';
import { transform, FormatVersion } from '@postman/runtime.models/transforms';
import { splitCollection } from '@postman/v3.export';

type JsonRecord = Record<string, unknown>;

/**
 * Convert a Postman v2.1 collection into the canonical Collection v3 multi-file
 * tree using `@postman/runtime.models` and `@postman/v3.export` — the same pipeline `postman
 * collection migrate` and the app run internally:
 *
 *   `@postman/runtime.models` transform(V2 -> V3)  -> in-memory v3 IR
 *   `@postman/v3.export` splitCollection(v3 IR)    -> { files: [{path, content}] }
 *
 * The emitted layout is the canonical one the current CLI and app read
 * (`.resources/definition.yaml`, folder directories, `<name>.request.yaml`,
 * `$kind:` discriminators) — NOT the legacy hand-rolled `collection.yaml`/
 * `folder.yaml`/`type:` dialect, which `postman collection lint` now rejects
 * (FMT015). Long names and duplicate siblings are handled by `splitCollection`,
 * so there is no local path sanitization here.
 */
function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Bridge a gap in the published `@postman/runtime.models` v2->v3 transform: the
 * v2 model has no GraphQLRequest, so a v2 graphql body (`{mode:'graphql'}`)
 * transforms into an `http-request` carrying `body.type:'graphql'`, which the v3
 * schema/lint rejects. `postman collection migrate` emits a `graphql-request`
 * node instead (top-level `query`/`variables`, no `body`); mirror that here so
 * the output lints clean. Headers/auth/scripts/url are left untouched.
 *
 * In practice repo-sync only ever converts OAS-derived HTTP collections, so this
 * rarely fires — it keeps the converter correct for any v2 collection a caller
 * might point at. Drop once the published transform models v2 graphql natively.
 */
function normalizeGraphqlRequests(node: JsonRecord): void {
  if (!node || typeof node !== 'object') return;
  const body = node.body as JsonRecord | undefined;
  if (node.$kind === 'http-request' && body && body.type === 'graphql') {
    const content = (body.content ?? {}) as JsonRecord;
    node.$kind = 'graphql-request';
    node.query = typeof content.query === 'string' ? content.query : '';
    node.variables = typeof content.variables === 'string' ? content.variables : '';
    delete node.body;
  }
  for (const key of ['items', 'children'] as const) {
    for (const child of asArray(node[key] as JsonRecord[] | undefined)) {
      normalizeGraphqlRequests(child);
    }
  }
}

/**
 * Transform a v2.1 collection and write its canonical v3 tree into `outputDir`.
 * `outputDir` is treated as the collection root, so the collection's own files
 * land directly under it (`outputDir/.resources/definition.yaml`, ...) — the
 * leading collection-name segment `splitCollection` prepends via `rootPath` is
 * stripped to preserve repo-sync's `postman/collections/<dir>/` convention.
 */
export async function convertAndSplitCollection(
  v2Collection: JsonRecord,
  outputDir: string
): Promise<void> {
  // `V2.Collection` is the runtime Model<T> descriptor the transform dispatches
  // on; `parse` normalizes the raw JSON (fills defaults the transform requires).
  const model = (V2 as unknown as { Collection: { parse: (v: unknown) => unknown } }).Collection;
  const parsed = model.parse(v2Collection ?? {});
  const v3 = transform(model as never, FormatVersion.V3, parsed as never) as unknown as JsonRecord;

  for (const item of asArray(v3.items as JsonRecord[] | undefined)) {
    normalizeGraphqlRequests(item);
  }

  await writeSplitCollection(v3 as never, outputDir);
}

/**
 * Normalize a public uid (`<owner>-<uuid>`, 45 chars) on any `id` field of a
 * v3 export node down to the bare model id (`<uuid>`, 36 chars) so the on-disk
 * tree matches the v2->v3 path byte-for-byte. The gateway v3 export emits
 * public uids on `id`; `splitCollection` writes them straight to disk, so
 * without this the request/folder yaml would carry the owner prefix.
 */
function normalizeV3ExportIds(node: JsonRecord): void {
  if (!node || typeof node !== 'object') return;
  const id = typeof node.id === 'string' ? node.id : null;
  if (id && /^\d+-[0-9a-f-]{36}$/.test(id)) {
    node.id = id.slice(id.indexOf('-') + 1);
  }
  for (const key of ['items', 'children', 'examples', 'variables'] as const) {
    for (const child of asArray(node[key] as JsonRecord[] | undefined)) {
      normalizeV3ExportIds(child);
    }
  }
}

/**
 * Write a v3 collection that is ALREADY in the canonical v3 IR shape (e.g. the
 * access-token gateway's `GET /v3/collections/:id/export` payload, unwrapped
 * from `data.collection`) directly to `outputDir` as the canonical multi-file
 * v3 tree. This skips the v2->v3 transform entirely — the gateway export IS v3,
 * so round-tripping it back through v2 would be the wrong direction. Empirically
 * byte-identical to `convertAndSplitCollection` on the same collection (live
 * re-probed 2026-06-30; see `scripts/live-write-probe.ts`).
 *
 * `outputDir` is treated as the collection root, matching
 * `convertAndSplitCollection`.
 */
export async function convertAndSplitV3Collection(
  v3Collection: JsonRecord,
  outputDir: string
): Promise<void> {
  const v3: JsonRecord = v3Collection ? structuredCloneSafe(v3Collection) : {};
  normalizeV3ExportIds(v3);
  for (const item of asArray(v3.items as JsonRecord[] | undefined)) {
    normalizeGraphqlRequests(item);
  }
  await writeSplitCollection(v3 as never, outputDir);
}

/**
 * Detect a collection payload's wire version and write the canonical v3 tree
 * either way — the single entry point the sync path should call.
 *
 * The gateway `GET /v3/collections/:id/export` returns v3, but some customers'
 * collections are still authored/served as v2.1 (`{info:{schema}, item:[...]}`).
 * Both converge to canonical v3 on disk: v2 is run through the official v2->v3
 * transform; v3 is written directly. Output is NEVER v2 — there is no v3->v2
 * down-convert anywhere in this module.
 */
export async function convertAndSplitAnyCollection(
  collection: JsonRecord,
  outputDir: string
): Promise<void> {
  if (isV2Collection(collection)) {
    await convertAndSplitCollection(collection, outputDir);
  } else {
    await convertAndSplitV3Collection(collection, outputDir);
  }
}

/**
 * True when the payload is a v2.1 collection (`{info, item:[...]}`) rather than a
 * v3 export (`{$kind:'collection', items:[...]}`). v3 markers win: a payload that
 * carries `$kind` or an `items` array is v3 even if it also has stray fields.
 */
function isV2Collection(collection: unknown): boolean {
  if (!collection || typeof collection !== 'object') return false;
  const record = collection as JsonRecord;
  if (record.$kind !== undefined || Array.isArray(record.items)) return false;
  return record.info !== undefined || Array.isArray(record.item);
}

/** structuredClone may be unavailable on older runtimes; fall back to JSON. */
function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * SHA-256 over canonical sorted relative file paths + raw bytes for a Collection
 * v3 tree. Matches bootstrap's local-artifact digest so prebuilt manifests can
 * be reused without a cloud export round-trip.
 */
export function computeArtifactDigest(
  files: Array<{ relative: string; bytes: Buffer | string }>
): string {
  const hash = createHash('sha256');
  const sorted = [...files].sort((a, b) => a.relative.localeCompare(b.relative));
  for (const file of sorted) {
    hash.update(file.relative);
    hash.update('\0');
    hash.update(typeof file.bytes === 'string' ? Buffer.from(file.bytes, 'utf8') : file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Recursively list every file (posix-relative to `base`) under `dir`.
 */
async function listFilesRelative(dir: string, base: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRelative(abs, base)));
    } else if (entry.isFile()) {
      out.push(path.relative(base, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * Remove now-empty directories under `dir` bottom-up (leaves `dir` itself in
 * place). Best-effort: a non-empty directory rejects and is skipped.
 */
async function pruneEmptyDirs(dir: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const child = path.join(dir, entry.name);
      await pruneEmptyDirs(child);
      try {
        await fs.rmdir(child);
      } catch {
        // not empty — keep it
      }
    }
  }
}

async function writeSplitCollection(v3: never, outputDir: string): Promise<void> {
  const { files, rootPath } = await splitCollection(v3);

  await fs.mkdir(outputDir, { recursive: true });

  // Files that existed before this write. Any not re-emitted below is a stale
  // artifact of a prior sync (a request/folder removed upstream) and must be
  // deleted so the on-disk tree is an exact mirror of the current collection —
  // an additive-only write would leave orphaned yaml behind.
  const preexisting = new Set(await listFilesRelative(outputDir, outputDir));

  const written = new Set<string>();
  for (const file of files) {
    let rel = file.path;
    if (rootPath && rel.startsWith(rootPath)) {
      rel = rel.slice(rootPath.length);
    }
    rel = rel.replace(/^\/+/, '');
    if (!rel) continue;
    const dest = path.join(outputDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.content, 'utf8');
    written.add(rel.split(path.sep).join('/'));
  }

  for (const rel of preexisting) {
    if (written.has(rel)) continue;
    await fs.rm(path.join(outputDir, rel), { force: true });
  }
  await pruneEmptyDirs(outputDir);
}
