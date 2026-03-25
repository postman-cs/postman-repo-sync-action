import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { dump as dumpYaml } from 'js-yaml';

type PostmanDescription = string | { content?: string | null } | null | undefined;

interface PostmanKeyValue {
  key?: string | null;
  value?: string | number | boolean | null;
  description?: PostmanDescription;
  disabled?: boolean;
  type?: string | null;
  src?: string | string[] | null;
  contentType?: string | null;
}

interface PostmanAuth {
  type?: string | null;
  [key: string]: unknown;
}

interface PostmanScript {
  exec?: string[] | string | null;
  type?: string | null;
  src?: string | string[] | null;
  requests?: Record<string, unknown> | null;
}

interface PostmanEvent {
  listen?: string | null;
  script?: PostmanScript | null;
}

interface PostmanUrlObject {
  raw?: string | null;
  protocol?: string | null;
  host?: string[] | string | null;
  path?: string[] | string | null;
  query?: PostmanKeyValue[] | null;
  variable?: PostmanKeyValue[] | null;
}

interface PostmanBody {
  mode?: string | null;
  raw?: string | null;
  urlencoded?: PostmanKeyValue[] | null;
  formdata?: PostmanKeyValue[] | null;
  file?: { src?: string | string[] | null } | null;
  graphql?: string | null;
  options?: {
    raw?: {
      language?: string | null;
    } | null;
  } | null;
}

interface PostmanResponse {
  name?: string | null;
  id?: string | null;
  status?: string | null;
  code?: number | null;
  body?: string | null;
  header?: PostmanKeyValue[] | null;
  description?: PostmanDescription;
}

interface PostmanRequest {
  method?: string | null;
  url?: string | PostmanUrlObject | null;
  header?: PostmanKeyValue[] | null;
  body?: PostmanBody | null;
  auth?: PostmanAuth | null;
  event?: PostmanEvent[] | null;
  response?: PostmanResponse[] | null;
}

interface PostmanItem {
  name?: string | null;
  description?: PostmanDescription;
  id?: string | null;
  auth?: PostmanAuth | null;
  event?: PostmanEvent[] | null;
  request?: PostmanRequest | null;
  response?: PostmanResponse[] | null;
  item?: PostmanItem[] | null;
}

interface PostmanCollectionV2 {
  info?: {
    name?: string | null;
    description?: PostmanDescription;
    _postman_id?: string | null;
  };
  variable?: PostmanKeyValue[] | null;
  auth?: PostmanAuth | null;
  event?: PostmanEvent[] | null;
  item?: PostmanItem[] | null;
}

interface KeyValueDescriptor {
  key: string;
  value?: string | null;
  description?: string;
  disabled?: boolean;
  type?: string;
  src?: string | string[];
  contentType?: string;
}

interface QueryParamDescriptor {
  key: string | null;
  value: string | null;
  description?: string;
  disabled?: boolean;
}

interface AuthDescriptor {
  type: string;
  credentials?: KeyValueDescriptor[];
}

interface ScriptDescriptor {
  type: string;
  code: string | string[];
  language?: string;
  packages?: { id: string };
  requests?: Record<string, unknown>;
}

type RequestBodyDescriptor =
  | { type: string; content: string }
  | { type: 'file'; content: { src: string | string[] } }
  | { type: 'urlencoded' | 'formdata'; content: KeyValueDescriptor[] };

interface ResponseExampleDescriptor {
  name?: string;
  id?: string;
  description?: string;
  response: {
    statusCode: number;
    statusText: string;
    headers?: KeyValueDescriptor[];
    body: {
      type: string;
      content: string;
    };
  };
}

interface BaseNode {
  name: string;
  description?: string;
  id?: string;
  auth?: AuthDescriptor;
  scripts?: ScriptDescriptor[];
}

interface RequestNode extends BaseNode {
  kind: 'request';
  type: 'http';
  url: string;
  method: string;
  headers?: KeyValueDescriptor[];
  queryParams?: QueryParamDescriptor[];
  pathVariables?: KeyValueDescriptor[];
  body?: RequestBodyDescriptor;
  examples?: ResponseExampleDescriptor[];
}

interface FolderNode extends BaseNode {
  kind: 'folder';
  items: ItemNode[];
}

type ItemNode = RequestNode | FolderNode;

interface CollectionNode extends BaseNode {
  kind: 'collection';
  $schema: string;
  variables?: KeyValueDescriptor[];
  items: ItemNode[];
}

const AUTH_FIELDS = [
  'apikey',
  'awsv4',
  'basic',
  'bearer',
  'digest',
  'edgegrid',
  'hawk',
  'jwt',
  'oauth1',
  'oauth2',
  'ntlm',
  'asap'
] as const;

function stringifyYaml(value: unknown): string {
  return dumpYaml(value, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  });
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function asTrimmedString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function toOptionalString(value: unknown): string | undefined {
  const normalized = asTrimmedString(value);
  return normalized ? normalized : undefined;
}

function toNullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return String(value);
}

function extractDescription(value: PostmanDescription): string | undefined {
  if (typeof value === 'string') {
    return value || undefined;
  }
  if (value && typeof value === 'object') {
    return toOptionalString(value.content);
  }
  return undefined;
}

/** Keep each folder/request segment short so nested paths stay under OS limits (ENAMETOOLONG). */
export const MAX_PATH_SEGMENT_CHARS = 120;

export function sanitizePathSegment(value: string, fallback: string): string {
  let normalized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return fallback;
  }
  if (normalized.length > MAX_PATH_SEGMENT_CHARS) {
    normalized = `${normalized.slice(0, MAX_PATH_SEGMENT_CHARS - 1)}…`;
  }
  return normalized;
}

function buildUniqueRef(
  baseName: string,
  kind: 'folder' | 'request',
  usedRefs: Set<string>
): { ref: string; name: string } {
  const fallback = kind === 'folder' ? 'Folder' : 'Request';
  const safeBase = sanitizePathSegment(baseName, fallback);
  let counter = 1;

  while (true) {
    const candidateName = counter === 1 ? safeBase : `${safeBase} ${counter}`;
    const ref =
      kind === 'folder'
        ? `./${candidateName}/folder.yaml`
        : `./${candidateName}.request.yaml`;
    const refKey = ref.toLowerCase();
    if (!usedRefs.has(refKey)) {
      usedRefs.add(refKey);
      return { ref, name: candidateName };
    }
    counter += 1;
  }
}

function transformKeyValue(
  entry: PostmanKeyValue,
  options?: { allowNullValue?: boolean }
): KeyValueDescriptor | QueryParamDescriptor {
  const description = extractDescription(entry.description);
  const allowNullValue = Boolean(options?.allowNullValue);
  const keyValue = entry.key === undefined || entry.key === null ? null : String(entry.key);
  const value = allowNullValue ? toNullableString(entry.value) : toOptionalString(entry.value) ?? '';

  const descriptor: KeyValueDescriptor | QueryParamDescriptor = allowNullValue
    ? { key: keyValue, value }
    : { key: keyValue ?? '', value };

  if (description) {
    descriptor.description = description;
  }
  if (entry.disabled !== undefined) {
    descriptor.disabled = entry.disabled;
  }
  if (!allowNullValue) {
    const typedDescriptor = descriptor as KeyValueDescriptor;
    if (entry.type) {
      typedDescriptor.type = entry.type;
    }
    if (entry.src) {
      typedDescriptor.src = entry.src;
    }
    if (entry.contentType) {
      typedDescriptor.contentType = entry.contentType;
    }
  }

  return descriptor;
}

function transformAuth(auth: PostmanAuth | null | undefined): AuthDescriptor | undefined {
  const type = toOptionalString(auth?.type);
  if (!type) {
    return undefined;
  }
  if (type === 'noauth' || type === 'inherit') {
    return { type };
  }

  const credentials: KeyValueDescriptor[] = [];
  const typedAuth = auth as Record<string, unknown>;
  for (const field of AUTH_FIELDS) {
    const rawValues = typedAuth[field];
    if (!Array.isArray(rawValues)) {
      continue;
    }
    for (const entry of rawValues) {
      credentials.push(transformKeyValue(entry as PostmanKeyValue) as KeyValueDescriptor);
    }
    break;
  }

  return credentials.length > 0 ? { type, credentials } : { type };
}

function transformScripts(
  events: PostmanEvent[] | null | undefined,
  scope: 'collection' | 'request'
): ScriptDescriptor[] | undefined {
  const listenMap: Record<string, string> =
    scope === 'collection'
      ? {
          prerequest: 'http:beforeRequest',
          test: 'http:afterResponse'
        }
      : {
          prerequest: 'beforeRequest',
          test: 'afterResponse'
        };

  const scripts = asArray(events)
    .map((event) => {
      const scriptType = event.listen ? listenMap[event.listen] : undefined;
      const script = event.script;
      if (!scriptType || !script) {
        return null;
      }

      const execLines = Array.isArray(script.exec)
        ? script.exec
            .map((line) => String(line))
            .filter((line) => line.trim().length > 0)
        : typeof script.exec === 'string'
          ? [script.exec].filter((line) => line.trim().length > 0)
          : [];
      if (execLines.length === 0) {
        return null;
      }

      const descriptor: ScriptDescriptor = {
        type: scriptType,
        code: execLines.length === 1 ? execLines[0] : execLines
      };

      if (script.type === 'text/javascript') {
        descriptor.language = 'text/javascript';
      }

      const packageSource = Array.isArray(script.src)
        ? script.src.find((entry) => asTrimmedString(entry))
        : script.src;
      const packageId = toOptionalString(packageSource);
      if (packageId) {
        descriptor.packages = { id: packageId };
      }

      if (script.requests && Object.keys(script.requests).length > 0) {
        descriptor.requests = script.requests;
      }

      return descriptor;
    })
    .filter((script): script is ScriptDescriptor => Boolean(script));

  return scripts.length > 0 ? scripts : undefined;
}

function transformUrl(url: string | PostmanUrlObject | null | undefined): string {
  if (typeof url === 'string') {
    return url;
  }
  if (!url) {
    return '';
  }
  if (toOptionalString(url.raw)) {
    return String(url.raw);
  }

  const parts: string[] = [];
  const protocol = toOptionalString(url.protocol);
  if (protocol) {
    parts.push(`${protocol}://`);
  }

  const host = Array.isArray(url.host) ? url.host.join('.') : asTrimmedString(url.host);
  if (host) {
    parts.push(host);
  }

  const pathSegments = Array.isArray(url.path)
    ? url.path
    : toOptionalString(url.path)
      ? [String(url.path)]
      : [];
  if (pathSegments.length > 0) {
    const joinedPath = pathSegments.join('/');
    if (joinedPath) {
      const prefix = parts.length > 0 && !joinedPath.startsWith('/') ? '/' : '';
      parts.push(`${prefix}${joinedPath}`);
    }
  }

  const query = asArray(url.query)
    .map((entry) => {
      const key = toOptionalString(entry.key);
      if (!key) {
        return '';
      }
      const value = entry.value;
      if (value === undefined || value === null || value === '') {
        return key;
      }
      return `${key}=${String(value)}`;
    })
    .filter(Boolean)
    .join('&');
  if (query) {
    parts.push(`?${query}`);
  }

  return parts.join('');
}

function transformBody(body: PostmanBody | null | undefined): RequestBodyDescriptor | undefined {
  const mode = toOptionalString(body?.mode);
  if (!mode || mode === 'none') {
    return undefined;
  }

  if (mode === 'urlencoded' || mode === 'formdata') {
    const entries = asArray(mode === 'urlencoded' ? body?.urlencoded : body?.formdata)
      .map((entry) => transformKeyValue(entry) as KeyValueDescriptor)
      .map((entry) => {
        if (mode === 'formdata' && entry.type === 'file' && !entry.src) {
          delete entry.value;
        }
        return entry;
      });
    return entries.length > 0 ? { type: mode, content: entries } : undefined;
  }

  if (mode === 'file') {
    const fileSrc = body?.file?.src;
    if (Array.isArray(fileSrc) && fileSrc.length > 0) {
      return { type: 'file', content: { src: fileSrc } };
    }
    if (toOptionalString(fileSrc)) {
      return { type: 'file', content: { src: String(fileSrc) } };
    }
    return undefined;
  }

  const content = toOptionalString(body?.raw) ?? toOptionalString(body?.graphql);
  if (!content) {
    return undefined;
  }

  return {
    type: toOptionalString(body?.options?.raw?.language) ?? 'text',
    content
  };
}

function detectExampleBodyType(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return 'text';
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }
  if (/^<!doctype/i.test(trimmed) || /^<html/i.test(trimmed)) {
    return 'html';
  }
  if (trimmed.startsWith('<')) {
    return 'xml';
  }
  return 'text';
}

function transformResponses(
  responses: PostmanResponse[] | null | undefined
): ResponseExampleDescriptor[] | undefined {
  const examples = asArray(responses).map((response) => {
    const descriptor: ResponseExampleDescriptor = {
      response: {
        statusCode: response.code ?? 200,
        statusText: toOptionalString(response.status) ?? 'OK',
        body: {
          type: detectExampleBodyType(response.body ?? ''),
          content: response.body ?? ''
        }
      }
    };

    const name = toOptionalString(response.name);
    if (name) {
      descriptor.name = name;
    }
    const id = toOptionalString(response.id);
    if (id) {
      descriptor.id = id;
    }
    const description = extractDescription(response.description);
    if (description) {
      descriptor.description = description;
    }
    const headers = asArray(response.header).map(
      (entry) => transformKeyValue(entry) as KeyValueDescriptor
    );
    if (headers.length > 0) {
      descriptor.response.headers = headers;
    }
    return descriptor;
  });

  return examples.length > 0 ? examples : undefined;
}

function createBaseNode(
  item: {
    name?: string | null;
    description?: PostmanDescription;
    id?: string | null;
    auth?: PostmanAuth | null;
    event?: PostmanEvent[] | null;
  },
  scope: 'collection' | 'request',
  fallbackName: string
): BaseNode {
  const node: BaseNode = {
    name: toOptionalString(item.name) ?? fallbackName
  };
  const description = extractDescription(item.description);
  if (description) {
    node.description = description;
  }
  const id = toOptionalString(item.id);
  if (id) {
    node.id = id;
  }
  const auth = transformAuth(item.auth);
  if (auth) {
    node.auth = auth;
  }
  const scripts = transformScripts(item.event, scope);
  if (scripts) {
    node.scripts = scripts;
  }
  return node;
}

function transformRequestNode(item: PostmanItem): RequestNode | null {
  const request = item.request;
  if (!request) {
    return null;
  }

  const method = toOptionalString(request.method) ?? 'GET';
  const url = transformUrl(request.url);
  if (method === 'VIEW' || !url.trim()) {
    return null;
  }

  const node: RequestNode = {
    ...createBaseNode(
      {
        name: item.name,
        description: item.description,
        id: item.id,
        auth: request.auth ?? item.auth,
        event: [...asArray(item.event), ...asArray(request.event)]
      },
      'request',
      'Request'
    ),
    kind: 'request',
    type: 'http',
    url,
    method
  };

  const headers = asArray(request.header).map(
    (entry) => transformKeyValue(entry) as KeyValueDescriptor
  );
  if (headers.length > 0) {
    node.headers = headers;
  }

  if (request.url && typeof request.url === 'object') {
    const queryParams = asArray(request.url.query).map(
      (entry) => transformKeyValue(entry, { allowNullValue: true }) as QueryParamDescriptor
    );
    if (queryParams.length > 0) {
      node.queryParams = queryParams;
    }
    const pathVariables = asArray(request.url.variable).map(
      (entry) => transformKeyValue(entry) as KeyValueDescriptor
    );
    if (pathVariables.length > 0) {
      node.pathVariables = pathVariables;
    }
  }

  const body = transformBody(request.body);
  if (body) {
    node.body = body;
  }

  const examples = transformResponses(
    asArray(request.response).length > 0 ? request.response : item.response
  );
  if (examples) {
    node.examples = examples;
  }

  return node;
}

function transformItem(item: PostmanItem): ItemNode | null {
  if (item.request) {
    return transformRequestNode(item);
  }

  const children = asArray(item.item)
    .map((child) => transformItem(child))
    .filter((child): child is ItemNode => Boolean(child));

  if (
    children.length === 0 &&
    !extractDescription(item.description) &&
    !toOptionalString(item.id) &&
    !transformAuth(item.auth) &&
    !transformScripts(item.event, 'collection')
  ) {
    return null;
  }

  return {
    ...createBaseNode(item, 'collection', 'Folder'),
    kind: 'folder',
    items: children
  };
}

function transformCollection(collection: PostmanCollectionV2): CollectionNode {
  const node: CollectionNode = {
    ...createBaseNode(
      {
        name: collection.info?.name,
        description: collection.info?.description,
        id: collection.info?._postman_id,
        auth: collection.auth,
        event: collection.event
      },
      'collection',
      'Untitled Collection'
    ),
    kind: 'collection',
    $schema: 'https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/',
    items: asArray(collection.item)
      .map((item) => transformItem(item))
      .filter((item): item is ItemNode => Boolean(item))
  };

  const variables = asArray(collection.variable).map(
    (entry) => transformKeyValue(entry) as KeyValueDescriptor
  );
  if (variables.length > 0) {
    node.variables = variables;
  }

  return node;
}

function buildBaseDescriptor(
  node: BaseNode,
  type: 'collection' | 'folder'
): Record<string, unknown> {
  const descriptor: Record<string, unknown> = {
    type,
    name: node.name
  };
  if (node.description) {
    descriptor.description = node.description;
  }
  if (node.id) {
    descriptor.id = node.id;
  }
  if (node.auth) {
    descriptor.auth = node.auth;
  }
  if (node.scripts && node.scripts.length > 0) {
    descriptor.scripts = node.scripts;
  }
  return descriptor;
}

function buildRequestDescriptor(node: RequestNode): Record<string, unknown> {
  const descriptor: Record<string, unknown> = {
    type: node.type,
    name: node.name,
    url: node.url,
    method: node.method
  };
  if (node.description) {
    descriptor.description = node.description;
  }
  if (node.id) {
    descriptor.id = node.id;
  }
  if (node.headers && node.headers.length > 0) {
    descriptor.headers = node.headers;
  }
  if (node.queryParams && node.queryParams.length > 0) {
    descriptor.queryParams = node.queryParams;
  }
  if (node.pathVariables && node.pathVariables.length > 0) {
    descriptor.pathVariables = node.pathVariables;
  }
  if (node.body) {
    descriptor.body = node.body;
  }
  if (node.auth) {
    descriptor.auth = node.auth;
  }
  if (node.scripts && node.scripts.length > 0) {
    descriptor.scripts = node.scripts;
  }
  if (node.examples && node.examples.length > 0) {
    descriptor.examples = node.examples;
  }
  return descriptor;
}

async function writeRequestNode(
  node: RequestNode,
  parentDir: string,
  usedRefs: Set<string>
): Promise<{ ref: string }> {
  const { ref } = buildUniqueRef(node.name, 'request', usedRefs);
  await fs.writeFile(
    path.join(parentDir, ref.replace('./', '')),
    stringifyYaml(buildRequestDescriptor(node)),
    'utf8'
  );
  return { ref };
}

async function writeFolderNode(
  node: FolderNode,
  parentDir: string,
  usedRefs: Set<string>
): Promise<{ ref: string }> {
  const { ref, name } = buildUniqueRef(node.name, 'folder', usedRefs);
  const folderDir = path.join(parentDir, name);
  await fs.mkdir(folderDir, { recursive: true });

  const items = await writeItems(node.items, folderDir);
  const descriptor = buildBaseDescriptor(node, 'folder');
  if (items.length > 0) {
    descriptor.items = items;
  }

  await fs.writeFile(path.join(folderDir, 'folder.yaml'), stringifyYaml(descriptor), 'utf8');
  return { ref };
}

async function writeItems(items: ItemNode[], parentDir: string): Promise<Array<{ ref: string }>> {
  const refs: Array<{ ref: string }> = [];
  const usedRefs = new Set<string>();

  for (const item of items) {
    if (item.kind === 'folder') {
      refs.push(await writeFolderNode(item, parentDir, usedRefs));
    } else {
      refs.push(await writeRequestNode(item, parentDir, usedRefs));
    }
  }

  return refs;
}

export async function convertAndSplitCollection(
  v2Collection: PostmanCollectionV2,
  outputDir: string
): Promise<void> {
  const collection = transformCollection(v2Collection || {});
  await fs.mkdir(outputDir, { recursive: true });

  const descriptor = {
    $schema: collection.$schema,
    ...buildBaseDescriptor(collection, 'collection')
  } as Record<string, unknown>;

  if (collection.variables && collection.variables.length > 0) {
    descriptor.variables = collection.variables;
  }

  const items = await writeItems(collection.items, outputDir);
  if (items.length > 0) {
    descriptor.items = items;
  }

  await fs.writeFile(path.join(outputDir, 'collection.yaml'), stringifyYaml(descriptor), 'utf8');
}
