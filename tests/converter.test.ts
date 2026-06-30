import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  convertAndSplitAnyCollection,
  convertAndSplitCollection,
  convertAndSplitV3Collection
} from '../src/postman-v3/converter.js';

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rs-converter-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  // best-effort cleanup; tmp is fine to leave if rm races
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const v2Collection = {
  info: {
    name: 'Demo',
    _postman_id: 'abc-123',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
  },
  variable: [{ key: 'base', value: 'https://api.example.com' }],
  item: [
    {
      name: 'Folder A',
      item: [
        {
          name: 'Get thing',
          request: {
            method: 'GET',
            header: [{ key: 'Accept', value: 'application/json' }],
            url: { raw: 'https://api.example.com/things/:id', path: ['things', ':id'], variable: [{ key: 'id', value: '1' }] }
          },
          response: []
        }
      ]
    },
    {
      name: 'Create thing',
      request: {
        method: 'POST',
        body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
        url: { raw: 'https://api.example.com/things' }
      },
      event: [{ listen: 'test', script: { exec: ['pm.test("ok",()=>{})'] } }]
    }
  ]
};

describe('convertAndSplitCollection (v2 -> canonical v3)', () => {
  it('emits the canonical v3 layout, never the legacy collection.yaml/type dialect', async () => {
    const dir = freshDir();
    await convertAndSplitCollection(v2Collection, dir);
    const files = walk(dir).map((f) => f.slice(dir.length + 1));

    // canonical markers present
    expect(files).toContain(join('.resources', 'definition.yaml'));
    expect(files.some((f) => f.endsWith('.request.yaml'))).toBe(true);
    // legacy dialect absent
    expect(existsSync(join(dir, 'collection.yaml'))).toBe(false);
    expect(files.some((f) => f.endsWith('folder.yaml'))).toBe(false);

    const def = readFileSync(join(dir, '.resources', 'definition.yaml'), 'utf8');
    expect(def).toContain('$kind: collection');
    expect(def).not.toContain('type: collection');

    const reqFile = walk(dir).find((f) => f.endsWith('Create thing.request.yaml'))!;
    const req = readFileSync(reqFile, 'utf8');
    expect(req).toContain('$kind: http-request');
    expect(req).toContain('method: POST');
    expect(req).toContain('afterResponse'); // v2 test event -> v3 script phase
    expect(req).not.toContain('type: http');
  });

  it('maps a v2 graphql body to a graphql-request (not an invalid body.type:graphql)', async () => {
    const dir = freshDir();
    await convertAndSplitCollection(
      {
        info: { name: 'GQ', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [
          {
            name: 'gql',
            request: {
              method: 'POST',
              url: { raw: 'https://api.example.com/graphql' },
              body: { mode: 'graphql', graphql: { query: 'query{me{id}}', variables: '{}' } }
            }
          }
        ]
      },
      dir
    );
    const reqFile = walk(dir).find((f) => f.endsWith('gql.request.yaml'))!;
    const req = readFileSync(reqFile, 'utf8');
    expect(req).toContain('$kind: graphql-request');
    expect(req).toContain('query: query{me{id}}');
    expect(req).not.toContain('type: graphql');
  });
});

describe('convertAndSplitV3Collection (v3 export -> v3, no v2 round-trip)', () => {
  const v3Export = {
    id: '12345678-abc-123',
    name: 'Demo',
    $kind: 'collection',
    variables: [{ key: 'base', value: 'https://api.example.com' }],
    items: [
      {
        $kind: 'http-request',
        id: '99-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        name: 'Get',
        method: 'GET',
        url: 'https://api.example.com/x',
        headers: [{ key: 'Accept', value: 'application/json' }]
      }
    ]
  };

  it('writes canonical v3 directly and normalizes public uids to bare model ids', async () => {
    const dir = freshDir();
    await convertAndSplitV3Collection(v3Export, dir);
    const reqFile = walk(dir).find((f) => f.endsWith('Get.request.yaml'))!;
    const req = readFileSync(reqFile, 'utf8');
    expect(req).toContain('$kind: http-request');
    expect(req).toContain('method: GET');
    // owner prefix on the request id is stripped (matches the v2->v3 path)
    expect(req).not.toContain('99-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

describe('convertAndSplitAnyCollection (auto-detect)', () => {
  it('routes a v2 payload through the v2 -> v3 transform', async () => {
    const dir = freshDir();
    await convertAndSplitAnyCollection(v2Collection, dir);
    expect(existsSync(join(dir, '.resources', 'definition.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'collection.yaml'))).toBe(false);
  });

  it('routes a v3 export payload directly to v3', async () => {
    const dir = freshDir();
    await convertAndSplitAnyCollection(
      { id: 'x', name: 'V3', $kind: 'collection', items: [] },
      dir
    );
    expect(existsSync(join(dir, '.resources', 'definition.yaml'))).toBe(true);
  });
});
