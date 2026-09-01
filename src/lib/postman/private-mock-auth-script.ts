import { tokenizer } from 'acorn';

const LEGACY_PRIVATE_MOCK_AUTH_MARKER = 'postman-enterprise-automation: private-mock-auth';
const PRIVATE_MOCK_AUTH_V2_MARKER = `${LEGACY_PRIVATE_MOCK_AUTH_MARKER}-v2`;
const PRIVATE_MOCK_AUTH_V3_MARKER = `${LEGACY_PRIVATE_MOCK_AUTH_MARKER}-v3`;

export const PRIVATE_MOCK_AUTH_VARIABLE = 'postmanPrivateMockApiKey';
export const PRIVATE_MOCK_AUTH_ROOT_TYPE = 'http:beforeRequest';
export const PRIVATE_MOCK_AUTH_ROOT_MARKER = `${LEGACY_PRIVATE_MOCK_AUTH_MARKER}-root`;

const LEGACY_PRIVATE_MOCK_AUTH_SCRIPT = [
  `// ${LEGACY_PRIVATE_MOCK_AUTH_MARKER}`,
  `var privateMockApiKey = pm.variables.get('${PRIVATE_MOCK_AUTH_VARIABLE}');`,
  "var privateMockHost = String(pm.request.url && pm.request.url.getHost ? pm.request.url.getHost() : '');",
  "if (privateMockApiKey && /(^|\\.)mock\\.pstmn\\.io$/i.test(privateMockHost)) {",
  "  pm.request.headers.upsert({ key: 'x-api-key', value: privateMockApiKey });",
  "}"
].join('\n');

const PRIVATE_MOCK_AUTH_V2_SCRIPT = [
  `// ${PRIVATE_MOCK_AUTH_V2_MARKER}`,
  `var privateMockApiKey = pm.variables.get('${PRIVATE_MOCK_AUTH_VARIABLE}');`,
  "var privateMockHostValue = pm.request.url && pm.request.url.getHost ? pm.request.url.getHost() : '';",
  "var privateMockHost = Array.isArray(privateMockHostValue) ? privateMockHostValue.join('.') : String(privateMockHostValue);",
  "var isPrivateMockHost = /(^|\\.)mock\\.pstmn\\.io$/i.test(privateMockHost);",
  "if (isPrivateMockHost && privateMockApiKey) {",
  "  pm.request.headers.upsert({ key: 'x-api-key', value: privateMockApiKey });",
  "} else if (isPrivateMockHost) {",
  `  console.warn('This mock server is private. Set the ${PRIVATE_MOCK_AUTH_VARIABLE} variable to a Postman API key with access to it, or the request returns 401.');`,
  "}"
].join('\n');

const PRIVATE_MOCK_AUTH_V3_SCRIPT = [
  `// ${PRIVATE_MOCK_AUTH_V3_MARKER}`,
  `var privateMockApiKey = pm.variables.get('${PRIVATE_MOCK_AUTH_VARIABLE}');`,
  "var privateMockHost = '';",
  "try {",
  "  var privateMockUrl = pm.variables.replaceIn(pm.request.url.toString());",
  "  privateMockHost = new URL(privateMockUrl).hostname;",
  "} catch (error) {",
  "  console.warn('Could not resolve the request URL for private mock authentication; x-api-key was not added.');",
  "}",
  "var isPrivateMockHost = /(^|\\.)mock\\.pstmn\\.io$/i.test(privateMockHost);",
  "if (isPrivateMockHost && privateMockApiKey) {",
  "  pm.request.headers.upsert({ key: 'x-api-key', value: privateMockApiKey });",
  "} else if (isPrivateMockHost) {",
  `  console.warn('This mock server is private. Set the ${PRIVATE_MOCK_AUTH_VARIABLE} variable to a Postman API key with access to it, or the request returns 401.');`,
  "}"
].join('\n');

export const PRIVATE_MOCK_AUTH_ROOT_SCRIPT = [
  `// ${PRIVATE_MOCK_AUTH_ROOT_MARKER}`,
  `var privateMockApiKey = pm.variables.get('${PRIVATE_MOCK_AUTH_VARIABLE}');`,
  "var privateMockHost = '';",
  "try {",
  "  var privateMockUrl = pm.variables.replaceIn(pm.request.url.toString());",
  "  privateMockHost = new URL(privateMockUrl).hostname;",
  "} catch (error) {",
  "  console.warn('Could not resolve the request URL for private mock authentication; x-api-key was not added.');",
  "}",
  "var isPrivateMockHost = /(^|\\.)mock\\.pstmn\\.io$/i.test(privateMockHost);",
  "if (isPrivateMockHost && privateMockApiKey) {",
  "  pm.request.headers.upsert({ key: 'x-api-key', value: privateMockApiKey });",
  "} else if (isPrivateMockHost) {",
  `  console.warn('This mock server is private. Set the ${PRIVATE_MOCK_AUTH_VARIABLE} variable to a Postman API key with access to it, or the request returns 401.');`,
  "}"
].join('\n');

export const MANAGED_ITEM_AUTH_BLOCKS: readonly string[] = [
  LEGACY_PRIVATE_MOCK_AUTH_SCRIPT,
  PRIVATE_MOCK_AUTH_V2_SCRIPT,
  PRIVATE_MOCK_AUTH_V3_SCRIPT
];

/** Managed collection-root hook: exact type + byte-exact script only (no marker containment). */
export function isManagedPrivateMockAuthRootHook(script: { type?: unknown; code?: unknown }): boolean {
  return String(script.type ?? '') === PRIVATE_MOCK_AUTH_ROOT_TYPE &&
    String(script.code ?? '') === PRIVATE_MOCK_AUTH_ROOT_SCRIPT;
}

function markTopLevelScriptBytes(source: string): Uint8Array {
  const topLevel = new Uint8Array(source.length);
  topLevel.fill(1);
  const excluded: Array<{ start: number; end: number }> = [];
  try {
    const tokens = tokenizer(source, {
      ecmaVersion: 'latest',
      allowHashBang: true,
      onComment: (isBlock, _text, start, end) => {
        // Line comments begin every managed block and remain eligible. Block
        // comments are opaque so embedded byte-exact examples cannot match.
        if (isBlock) excluded.push({ start, end });
      }
    });
    while (true) {
      const token = tokens.getToken();
      const label = token.type.label;
      if (label === 'eof') break;
      if (label === 'string' || label === 'regexp' || label === 'template' || label === '`') {
        excluded.push({ start: token.start, end: token.end });
      }
    }
  } catch {
    // Malformed customer JavaScript is not a safe surface for source surgery.
    topLevel.fill(0);
    return topLevel;
  }
  for (const range of excluded) {
    topLevel.fill(0, range.start, range.end);
  }
  return topLevel;
}

function isWholeLineTopLevelMatch(
  source: string,
  startIndex: number,
  block: string,
  topLevel: Uint8Array
): boolean {
  if (!source.startsWith(block, startIndex)) {
    return false;
  }
  if (startIndex > 0 && source[startIndex - 1] !== '\n') {
    return false;
  }

  const endIndex = startIndex + block.length;
  for (let lineStart = startIndex; lineStart < endIndex; ) {
    if (!topLevel[lineStart]) {
      return false;
    }
    const nextNewline = source.indexOf('\n', lineStart);
    if (nextNewline === -1 || nextNewline >= endIndex - 1) {
      break;
    }
    lineStart = nextNewline + 1;
  }

  return true;
}

function findManagedBlockRanges(source: string): Array<{ end: number; start: number }> {
  const topLevel = markTopLevelScriptBytes(source);
  const ranges: Array<{ end: number; start: number }> = [];

  for (let i = 0; i < source.length; i++) {
    if (i > 0 && source[i - 1] !== '\n') {
      continue;
    }
    for (const block of MANAGED_ITEM_AUTH_BLOCKS) {
      if (!isWholeLineTopLevelMatch(source, i, block, topLevel)) {
        continue;
      }
      ranges.push({ start: i, end: i + block.length });
      break;
    }
  }

  return ranges;
}

export function countManagedItemAuthBlocks(code: string): number {
  if (typeof code !== 'string' || !code) {
    return 0;
  }
  return findManagedBlockRanges(code).length;
}

function deleteRangeWithSeam(source: string, start: number, end: number): string {
  let before = source.slice(0, start);
  let after = source.slice(end);
  const beforeHadNl = before.endsWith('\n');
  const afterHadNl = after.startsWith('\n');
  if (beforeHadNl) {
    before = before.slice(0, -1);
  }
  if (afterHadNl) {
    after = after.slice(1);
  }
  if (beforeHadNl && afterHadNl && before.length > 0 && after.length > 0) {
    return `${before}\n${after}`;
  }
  return `${before}${after}`;
}

export function stripManagedItemAuthBlocks(code: string): string {
  if (typeof code !== 'string' || !code) {
    return '';
  }

  const ranges = findManagedBlockRanges(code);
  if (ranges.length === 0) {
    return code;
  }

  ranges.sort((left, right) => right.start - left.start);
  let next = code;
  for (const range of ranges) {
    next = deleteRangeWithSeam(next, range.start, range.end);
  }
  return next;
}
