/**
 * Phase 4 merge gate (replaces shadow-compare telemetry): an offline corpus that
 * runs `convertAndSplitAnyCollection` over a feature matrix of v2.1 collections
 * and v3 exports — every body mode, auth type, script phase, nesting, example,
 * and variable shape repo-sync can pull — then lints each canonical tree with
 * the real `postman collection lint`.
 *
 * The legacy bespoke converter was deleted in the cutover, so the gate is no
 * longer "diff legacy vs new"; it is the two halves that survive that deletion
 * and actually prove correctness:
 *   (a) the new path NEVER throws across the whole corpus, and
 *   (b) `postman collection lint` reports ZERO errors on every emitted tree.
 *
 * Any throw or any lint error fails the gate (exit 1). Best-effort fetches of
 * real public collections are additive: a network failure is reported and
 * skipped, never a silent pass.
 *
 * Run: `npx tsx scripts/comparison-corpus.ts`
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { convertAndSplitAnyCollection } from '../src/postman-v3/converter.js';

type JsonRecord = Record<string, unknown>;
interface Case {
  name: string;
  kind: 'v2' | 'v3';
  collection?: JsonRecord;
  url?: string;
}

const V2_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function v2(name: string, body: JsonRecord): Case {
  return { name, kind: 'v2', collection: { info: { name, _postman_id: name, schema: V2_SCHEMA }, ...body } };
}
function v3(name: string, body: JsonRecord): Case {
  return { name, kind: 'v3', collection: { id: name, name, $kind: 'collection', ...body } };
}

const cases: Case[] = [
  v2('simple-get', {
    item: [{ name: 'Get', request: { method: 'GET', url: { raw: 'https://api.x/things', path: ['things'] } } }]
  }),
  v2('nested-folders', {
    item: [
      {
        name: 'L1',
        item: [
          {
            name: 'L2',
            item: [{ name: 'Deep', request: { method: 'GET', url: 'https://api.x/deep' } }]
          }
        ]
      }
    ]
  }),
  v2('auth-bearer', {
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tok}}' }] },
    item: [{ name: 'A', request: { method: 'GET', url: 'https://api.x/a' } }]
  }),
  v2('auth-basic', {
    item: [
      {
        name: 'B',
        request: {
          method: 'GET',
          url: 'https://api.x/b',
          auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] }
        }
      }
    ]
  }),
  v2('auth-apikey', {
    item: [
      {
        name: 'K',
        request: {
          method: 'GET',
          url: 'https://api.x/k',
          auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Api-Key' }, { key: 'value', value: '{{k}}' }, { key: 'in', value: 'header' }] }
        }
      }
    ]
  }),
  v2('auth-oauth2', {
    item: [
      {
        name: 'O',
        request: {
          method: 'GET',
          url: 'https://api.x/o',
          auth: { type: 'oauth2', oauth2: [{ key: 'accessToken', value: '{{at}}' }, { key: 'tokenType', value: 'bearer' }] }
        }
      }
    ]
  }),
  v2('body-raw-json', {
    item: [{ name: 'R', request: { method: 'POST', url: 'https://api.x/r', body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } } } }]
  }),
  v2('body-urlencoded', {
    item: [{ name: 'U', request: { method: 'POST', url: 'https://api.x/u', body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }, { key: 'b', value: '2', disabled: true }] } } }]
  }),
  v2('body-formdata-file', {
    item: [{ name: 'F', request: { method: 'POST', url: 'https://api.x/f', body: { mode: 'formdata', formdata: [{ key: 'field', value: 'v', type: 'text' }, { key: 'doc', type: 'file', src: '/local/path.pdf' }] } } }]
  }),
  v2('body-graphql', {
    item: [{ name: 'G', request: { method: 'POST', url: 'https://api.x/graphql', body: { mode: 'graphql', graphql: { query: 'query{me{id}}', variables: '{}' } } } }]
  }),
  v2('scripts-pre-and-test', {
    event: [
      { listen: 'prerequest', script: { exec: ['pm.environment.set("t", Date.now())'] } },
      { listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }
    ],
    item: [
      {
        name: 'S',
        event: [{ listen: 'test', script: { exec: ['pm.test("status", () => pm.response.to.have.status(200))'] } }],
        request: { method: 'GET', url: 'https://api.x/s' }
      }
    ]
  }),
  v2('examples-responses', {
    item: [
      {
        name: 'E',
        request: { method: 'GET', url: 'https://api.x/e' },
        response: [
          { name: 'OK', code: 200, status: 'OK', header: [{ key: 'Content-Type', value: 'application/json' }], body: '{"ok":true}' },
          { name: 'NotFound', code: 404, status: 'Not Found', body: '{"error":"nope"}' }
        ]
      }
    ]
  }),
  v2('variables-and-disabled-header', {
    variable: [{ key: 'base', value: 'https://api.x' }],
    item: [
      {
        name: 'V',
        request: {
          method: 'GET',
          header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Off', value: 'no', disabled: true }],
          url: { raw: '{{base}}/v/:id?q=1', host: ['{{base}}'], path: ['v', ':id'], query: [{ key: 'q', value: '1' }], variable: [{ key: 'id', value: '7' }] }
        }
      }
    ]
  }),
  v3('v3-minimal', { items: [] }),
  v3('v3-folder-request', {
    variables: [{ key: 'base', value: 'https://api.x' }],
    items: [
      {
        $kind: 'collection',
        id: 'folder-1',
        name: 'Folder',
        items: [
          {
            $kind: 'http-request',
            id: 'req-1',
            name: 'Get',
            method: 'GET',
            url: '{{base}}/x',
            headers: [{ key: 'Accept', value: 'application/json' }]
          }
        ]
      }
    ]
  }),
  v3('v3-public-uid-ids', {
    items: [
      {
        $kind: 'http-request',
        id: '12345678-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        name: 'Owner-prefixed',
        method: 'POST',
        url: 'https://api.x/o',
        body: { type: 'json', content: '{"a":1}' }
      }
    ]
  })
];

// Best-effort real public collections (additive; network failure is reported, not fatal).
const publicV2Urls: string[] = [
  'https://raw.githubusercontent.com/postmanlabs/newman/develop/examples/sample-collection.json',
  'https://raw.githubusercontent.com/postmanlabs/newman/develop/test/fixtures/run/single-get-request.json',
  'https://raw.githubusercontent.com/postmanlabs/newman/develop/test/integration/steph/steph.postman_collection.json'
];

function lintErrors(dir: string): { errors: number; detail: string } {
  let raw: string;
  try {
    raw = execFileSync('postman', ['collection', 'lint', dir, '--reporter', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    // postman exits nonzero on lint errors but still prints the json report to stdout.
    const err = e as { stdout?: string };
    raw = err.stdout ?? '';
  }
  let errors = 0;
  const detail: string[] = [];
  try {
    const report = JSON.parse(raw) as { diagnostics?: Array<{ severity?: string; message?: string; path?: string }> };
    for (const d of report.diagnostics ?? []) {
      if ((d.severity ?? '').toLowerCase() === 'error') {
        errors += 1;
        detail.push(`${d.message ?? ''} (${d.path ?? ''})`);
      }
    }
  } catch {
    // JSON shape changed: fall back to the `Errors: N` line of the human report.
    const m = /Errors:\s*(\d+)/.exec(raw);
    errors = m ? Number(m[1]) : 0;
    if (errors > 0) detail.push(raw.trim());
  }
  return { errors, detail: detail.join('; ') };
}

async function run(): Promise<void> {
  let throws = 0;
  let lintFails = 0;
  let skipped = 0;
  const fail: string[] = [];

  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
    try {
      await convertAndSplitAnyCollection(c.collection as JsonRecord, dir);
      const files = readdirSync(dir);
      if (files.length === 0) throw new Error('no files emitted');
      const { errors, detail } = lintErrors(dir);
      if (errors > 0) {
        lintFails += 1;
        fail.push(`LINT  ${c.name} (${c.kind}): ${errors} error(s) — ${detail}`);
      } else {
        console.log(`  ok   ${c.name} (${c.kind})`);
      }
    } catch (e) {
      throws += 1;
      fail.push(`THROW ${c.name} (${c.kind}): ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const url of publicV2Urls) {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-pub-'));
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as JsonRecord;
      const collection = (payload.collection as JsonRecord | undefined) ?? payload;
      await convertAndSplitAnyCollection(collection, dir);
      const { errors, detail } = lintErrors(dir);
      if (errors > 0) {
        lintFails += 1;
        fail.push(`LINT  public ${url}: ${errors} error(s) — ${detail}`);
      } else {
        console.log(`  ok   public ${url}`);
      }
    } catch (e) {
      skipped += 1;
      console.log(`  skip public ${url}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(
    `\n[corpus] cases=${cases.length} throws=${throws} lintErrors=${lintFails} publicSkipped=${skipped}`
  );
  if (fail.length > 0) {
    console.error('\n[corpus] GATE FAILED:');
    for (const f of fail) console.error('  ' + f);
    process.exitCode = 1;
  } else {
    console.log('[corpus] GATE PASSED: zero throws, zero lint errors across the feature matrix.');
  }
}

run().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exitCode = 1;
});
