/**
 * Live WRITE probe for gateway mock + monitor services against the same path
 * e2e uses: mint access token → disposable workspace → spec upload → gateway
 * collection generation → sync env import → PostmanGatewayAssetsClient
 * createMock/createMonitor (public uid in, model id on the wire) → teardown.
 *
 * Unlike the old probe, this does NOT bind to pre-existing workspace/collection
 * list entries — it creates a fresh spec-generated collection so ACS permission
 * + id-space behavior matches bootstrap → repo-sync e2e.
 *
 * Sandbox-only (team 10490519, wipeable). Run:
 *   set -a && source ../../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     npx --yes tsx scripts/live-write-probe.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import {
  PostmanGatewayAssetsClient,
  requirePublicMock
} from '../src/lib/postman/postman-gateway-assets-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveInputs, runRepoSync } from '../src/index.js';
import { HttpError } from '../src/lib/http-error.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;

type JsonRecord = Record<string, unknown>;

function snippet(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, 240).replace(/\s+/g, ' ');
}

function recordShape(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return typeof value;
  const record = value as JsonRecord;
  const fields = Object.keys(record).sort();
  const visibility = ([
    ['private', record.private],
    ['isPublic', record.isPublic],
    ['visibility', record.visibility],
    ['active', record.active],
    ['published', record.published]
  ] as Array<[string, unknown]>)
    .filter(([, field]) => field !== undefined)
    .map(([key, field]) => `${String(key)}=${JSON.stringify(field)}`)
    .join(',');
  const config = record.config && typeof record.config === 'object' && !Array.isArray(record.config)
    ? Object.entries(record.config as JsonRecord)
        .filter(([, field]) => ['boolean', 'number', 'string'].includes(typeof field))
        .map(([key, field]) => `${key}=${JSON.stringify(field)}`)
        .join(',')
    : '';
  return `keys=${fields.join(',')}${visibility ? ` scalars=${visibility}` : ''}${config ? ` config=${config}` : ''}`;
}

function mockRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = value as JsonRecord;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.mocks)) return record.mocks;
  return [record.data ?? record.mock ?? record];
}

/** Public uid (6 hyphen groups) → bare model id (5 groups); mirrors PostmanGatewayAssetsClient. */
function toModelId(uid: string): string {
  const trimmed = String(uid ?? '').trim();
  const parts = trimmed.split('-');
  return parts.length >= 6 ? parts.slice(1).join('-') : trimmed;
}

function resolveCollectionUid(entries: JsonRecord[]): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const uid = String(
      entry?.collection ?? entry?.collectionId ?? entry?.id ?? entry?.uid ?? ''
    ).trim();
    if (uid) return uid;
  }
  return '';
}

const SPEC_CONTENT = [
  'openapi: 3.0.3',
  'info:',
  '  title: Write Probe API',
  '  version: 1.0.0',
  'paths:',
  '  /ping:',
  '    get:',
  '      summary: Ping',
  '      operationId: ping',
  '      responses:',
  "        '200':",
  '          description: OK'
].join('\n');

async function gwRaw(
  gateway: AccessTokenGatewayClient,
  service: string,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  body?: unknown
): Promise<{ status: number; json: JsonRecord | null; text: string }> {
  const response = await gateway.request({ service, method, path, ...(body !== undefined ? { body } : {}) });
  const text = await response.text().catch(() => '');
  let json: JsonRecord | null;
  try {
    json = text.trim() ? (JSON.parse(text) as JsonRecord) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

async function deleteWorkspace(apiKey: string, workspaceId: string): Promise<void> {
  try {
    const r = await fetch(`${API}/workspaces/${workspaceId}`, {
      method: 'DELETE',
      headers: { 'X-Api-Key': apiKey }
    });
    console.log(`  [teardown] DELETE /workspaces/${workspaceId} -> ${r.status}`);
  } catch (error) {
    console.log(
      `  [teardown] workspace ${workspaceId} delete failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) {
    console.log('[skip] No POSTMAN_API_KEY / POSTMAN_E2E_API_KEY_NON_ORG_MODE set; skipping write probe.');
    return;
  }

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  console.log('[setup] minted access token');

  const gateway = new AccessTokenGatewayClient({ tokenProvider: provider });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workspaceName = `write-probe-${stamp}`;

  let workspaceId: string;
  let publicCollectionUid: string;
  let mockUid = '';
  let privateMockUid: string | undefined;
  let mockEnvironmentUid = '';
  let monitorUid = '';
  const createdWorkspaces = new Set<string>();
  let failed = false;

  const fail = (label: string, detail: string): void => {
    failed = true;
    console.error(`[FAIL] ${label}: ${detail}`);
  };

  try {
    console.log('\n== setup: disposable workspace ==');
    const wsCreate = await gwRaw(gateway, 'workspaces', 'post', '/workspaces', {
      name: workspaceName,
      visibilityStatus: 'personal'
    });
    workspaceId = String((wsCreate.json?.data as JsonRecord | undefined)?.id ?? wsCreate.json?.id ?? '').trim();
    if (!workspaceId) {
      fail('workspace create', `status ${wsCreate.status} :: ${snippet(wsCreate.text)}`);
      return;
    }
    createdWorkspaces.add(workspaceId);
    console.log(`[setup] workspace ${workspaceId}`);

    const vis = await gwRaw(gateway, 'workspaces', 'put', `/workspaces/${workspaceId}/visibility`, {
      visibilityStatus: 'team'
    });
    if (vis.status >= 400) {
      fail('workspace visibility', `status ${vis.status} :: ${snippet(vis.text)}`);
      return;
    }

    console.log('\n== setup: spec + gateway collection generation (e2e path) ==');
    const specCreate = await gwRaw(
      gateway,
      'specification',
      'post',
      `/specifications?containerType=workspace&containerId=${workspaceId}`,
      {
        name: 'Write Probe API',
        type: 'OPENAPI:3.0',
        files: [{ path: 'index.yaml', content: SPEC_CONTENT, type: 'ROOT' }]
      }
    );
    const specId = String((specCreate.json?.data as JsonRecord | undefined)?.id ?? specCreate.json?.id ?? '').trim();
    if (!specId) {
      fail('spec create', `status ${specCreate.status} :: ${snippet(specCreate.text)}`);
      return;
    }
    console.log(`[setup] spec ${specId}`);

    const gen = await gwRaw(gateway, 'specification', 'post', `/specifications/${specId}/collections`, {
      name: 'Write Probe Collection',
      options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' }
    });
    const taskId = String((gen.json?.data as JsonRecord | undefined)?.taskId ?? '').trim();
    console.log(`  [generate taskId] ${taskId || '<none>'} (status ${gen.status})`);

    if (taskId) {
      for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        const task = await gateway.requestJson<JsonRecord>({
          service: 'specification',
          method: 'get',
          path: '/tasks',
          query: { entityId: specId, entityType: 'specification', type: 'collection-generation' }
        });
        const status = String((task?.data as JsonRecord | undefined)?.[taskId] ?? '').toLowerCase();
        if (i === 0 || (status && status !== 'in-progress' && status !== 'pending' && status !== 'queued')) {
          console.log(`  [task ${taskId}] ${status || 'unknown'}`);
        }
        if (status && status !== 'in-progress' && status !== 'pending' && status !== 'queued') {
          break;
        }
      }
    }

    const specCols = await gateway.requestJson<JsonRecord>({
      service: 'specification',
      method: 'get',
      path: `/specifications/${specId}/collections`
    });
    const colEntries = Array.isArray(specCols?.data) ? (specCols.data as JsonRecord[]) : [];
    publicCollectionUid = resolveCollectionUid(colEntries);
    if (!publicCollectionUid) {
      fail('collection resolve', `no uid in spec collections list :: ${snippet(specCols)}`);
      return;
    }
    const modelId = toModelId(publicCollectionUid);
    console.log(`[setup] collection publicUid=${publicCollectionUid} modelId=${modelId}`);

    const assets = new PostmanGatewayAssetsClient({ gateway, workspaceId });

    console.log('\n== collection read probe matrix (getCollection candidates; never PMAK) ==');
    const readRows: Array<{ label: string; service: string; method: 'get' | 'post'; path: string; body?: unknown }> = [
      { label: 'A collection GET /collections/:uid (full)', service: 'collection', method: 'get', path: `/collections/${publicCollectionUid}` },
      { label: 'B collection GET /collections/:modelId', service: 'collection', method: 'get', path: `/collections/${modelId}` },
      { label: 'C collection GET /v3/collections/:modelId/export', service: 'collection', method: 'get', path: `/v3/collections/${modelId}/export` },
      { label: 'C2 collection GET /v3/collections/:uid/export', service: 'collection', method: 'get', path: `/v3/collections/${publicCollectionUid}/export` },
      { label: 'D sync GET /collection/:uid/sync?since_id=0', service: 'sync', method: 'get', path: `/collection/${publicCollectionUid}/sync?since_id=0` },
      { label: 'D2 sync GET /collection/:modelId/sync?since_id=0', service: 'sync', method: 'get', path: `/collection/${modelId}/sync?since_id=0` },
      { label: 'E sync GET /collection/:uid?populate=true', service: 'sync', method: 'get', path: `/collection/${publicCollectionUid}?populate=true` },
      { label: 'F sync POST /list/collection?workspace=:ws', service: 'sync', method: 'post', path: `/list/collection?workspace=${workspaceId}` }
    ];
    for (const row of readRows) {
      try {
        const r = await gwRaw(gateway, row.service, row.method, row.path, row.body);
        const ok = r.status >= 200 && r.status < 300;
        console.log(`  [${r.status}${ok ? ' OK' : ''}] ${row.label} :: ${snippet(r.text)}`);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 0;
        console.log(`  [${status || 'ERR'}] ${row.label} :: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log('\n== getCollection: gateway v3 export (production path) ==');
    try {
      const v3 = await assets.getCollection(publicCollectionUid);
      const items = Array.isArray((v3 as JsonRecord | null)?.items) ? (v3 as JsonRecord).items : [];
      console.log(`  [ok] getCollection returned v3 IR with ${items.length} top-level item(s)`);
    } catch (error) {
      fail('getCollection', error instanceof Error ? error.message : String(error));
    }

    console.log('\n== setup: sync environment import ==');
    const envUid = await assets.createEnvironment(workspaceId, 'probe-env', [
      { key: 'baseUrl', value: 'https://example.com', enabled: true }
    ]);
    console.log(`[setup] env uid ${envUid}`);

    console.log('\n== env update via sync PUT /environment/:uid (changed value) ==');
    try {
      await assets.updateEnvironment(envUid, 'probe-env', [
        { key: 'baseUrl', value: 'https://upserted.example.com', enabled: true }
      ]);
      console.log('  [ok] updateEnvironment completed');
      const fetched = await assets.getEnvironment(envUid);
      const fetchedValues = (fetched as JsonRecord | null)?.values;
      console.log(`  [get] after update values=${snippet(fetchedValues)}`);
    } catch (error) {
      fail('updateEnvironment', error instanceof Error ? error.message : String(error));
    }

    console.log('\n== id-space regression (raw gateway, optional diagnostic) ==');
    const mockNeg = await gwRaw(gateway, 'mock', 'post', `/mocks?workspace=${workspaceId}`, {
      name: `probe-neg-mock-${stamp}`,
      collection: publicCollectionUid,
      private: false,
      environment: toModelId(envUid)
    }).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 0;
      return { status, json: null, text: error instanceof Error ? error.message : String(error) };
    });
    console.log(
      `  [${mockNeg.status}] mock CREATE with public uid in collection (expect 403) :: ${snippet(mockNeg.text)}`
    );
    if (mockNeg.status < 400) {
      console.warn('  [warn] negative control passed unexpectedly — backend may have changed id-space rules');
    }

    const monNeg = await gwRaw(gateway, 'monitorsV2', 'post', `/monitors?workspace=${workspaceId}`, {
      name: `probe-neg-mon-${stamp}`,
      type: 'collection-based',
      collection: { id: publicCollectionUid },
      environment: envUid ? { id: toModelId(envUid) } : undefined,
      schedule: { cronPattern: '0 0 * * 0', timeZone: 'UTC' }
    }).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 0;
      return { status, json: null, text: error instanceof Error ? error.message : String(error) };
    });
    console.log(
      `  [${monNeg.status}] monitor CREATE with public uid in collection.id (expect 403) :: ${snippet(monNeg.text)}`
    );
    if (monNeg.status < 400) {
      console.warn('  [warn] monitor negative control passed unexpectedly — backend may have changed id-space rules');
    }

    console.log('\n== mock: PostmanGatewayAssetsClient (production path) ==');
    const publicMockName = `probe-mock-${stamp}`;
    try {
      const mock = await assets.createMock(
        workspaceId,
        publicMockName,
        publicCollectionUid,
        envUid
      );
      mockUid = mock.uid;
      console.log(`  [ok] createMock uid=${mock.uid} url=${mock.url}`);
    } catch (error) {
      fail('createMock', error instanceof Error ? error.message : String(error));
    }

    const privateMockName = `probe-private-mock-${stamp}`;
    const privateCreate = await gwRaw(gateway, 'mock', 'post', `/mocks?workspace=${workspaceId}`, {
      name: privateMockName,
      collection: publicCollectionUid,
      environment: envUid,
      private: true
    });
    const privateRecord = privateCreate.json?.data ?? privateCreate.json;
    privateMockUid = String((privateRecord as JsonRecord | null)?.id ?? '').trim();
    console.log(`  [${privateCreate.status}] private mock create :: ${recordShape(privateRecord)}`);

    const rawMockList = await gwRaw(gateway, 'mock', 'get', `/mocks?workspace=${workspaceId}`);
    console.log(`  [${rawMockList.status}] raw mock list envelope :: ${recordShape(rawMockList.json)}`);
    for (const [index, record] of mockRecords(rawMockList.json).entries()) {
      console.log(`  [shape] mock list record ${index + 1} :: ${recordShape(record)}`);
    }
    for (const [label, uid] of [['public', mockUid], ['private', privateMockUid]] as const) {
      if (!uid) continue;
      const get = await gwRaw(gateway, 'mock', 'get', `/mocks/${uid}`);
      console.log(`  [${get.status}] ${label} mock get envelope :: ${recordShape(get.json)}`);
      for (const record of mockRecords(get.json)) {
        console.log(`  [shape] ${label} mock get record :: ${recordShape(record)}`);
      }
    }

    const mocks = await assets.listMocks();
    console.log(`  [ok] listMocks count=${mocks.length}`);
    const foundMock = await assets.findMockByCollection(publicCollectionUid, envUid, publicMockName);
    if (!foundMock?.uid) {
      fail('findMockByCollection', 'did not rediscover mock by public uid');
    } else {
      console.log(`  [ok] findMockByCollection uid=${foundMock.uid}`);
    }
    const foundPrivateMock = await assets.findMockByCollection(
      publicCollectionUid,
      envUid,
      privateMockName
    );
    try {
      if (foundPrivateMock) requirePublicMock(foundPrivateMock);
      fail('private mock policy', 'private mock was accepted as public');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('MOCK_NOT_PUBLIC')) {
        fail('private mock policy', message);
      } else {
        console.log('  [ok] private mock rejected with MOCK_NOT_PUBLIC');
      }
    }

    if (mockUid && privateMockUid) {
      const runtimeApiKey = process.env.POSTMAN_API_KEY;
      const runtimeAccessToken = provider.current();
      const [publicCall, privateCall, privateApiKeyCall, privateAccessTokenCall] = await Promise.all([
        fetch(`https://${mockUid}.mock.pstmn.io`).catch(() => null),
        fetch(`https://${privateMockUid}.mock.pstmn.io`).catch(() => null),
        runtimeApiKey
          ? fetch(`https://${privateMockUid}.mock.pstmn.io`, {
              headers: { 'x-api-key': runtimeApiKey }
            }).catch(() => null)
          : null,
        runtimeAccessToken
          ? fetch(`https://${privateMockUid}.mock.pstmn.io`, {
              headers: { 'x-access-token': runtimeAccessToken }
            }).catch(() => null)
          : null
      ]);
      console.log(`  [anonymous] public mock status=${publicCall?.status ?? 'transport-error'}`);
      console.log(`  [anonymous] private mock status=${privateCall?.status ?? 'transport-error'}`);
      console.log(`  [x-api-key] private mock status=${privateApiKeyCall?.status ?? 'not-configured'}`);
      console.log(`  [x-access-token] private mock status=${privateAccessTokenCall?.status ?? 'not-configured'}`);
      if (publicCall && [401, 403].includes(publicCall.status)) {
        fail('public mock anonymous call', `unexpected status ${publicCall.status}`);
      }
      if (privateCall && ![401, 403, 404].includes(privateCall.status)) {
        fail('private mock anonymous call', `unexpected status ${privateCall.status}`);
      }
      if (privateApiKeyCall && [401, 403].includes(privateApiKeyCall.status)) {
        fail('private mock x-api-key call', `unexpected auth status ${privateApiKeyCall.status}`);
      }
      if (privateAccessTokenCall && [401, 403].includes(privateAccessTokenCall.status)) {
        fail('private mock x-access-token call', `unexpected auth status ${privateAccessTokenCall.status}`);
      }
    }

    console.log('\n== repo-sync manual-validation environment (production orchestration) ==');
    if (mockUid) {
      const originalCwd = process.cwd();
      const runDir = mkdtempSync(join(tmpdir(), 'repo-sync-mock-environment-'));
      try {
        process.chdir(runDir);
        const inputs = resolveInputs({
          INPUT_PROJECT_NAME: 'Write Probe',
          INPUT_WORKSPACE_ID: workspaceId,
          INPUT_BASELINE_COLLECTION_ID: publicCollectionUid,
          INPUT_ENVIRONMENTS_JSON: '["prod"]',
          INPUT_ENVIRONMENT_UIDS_JSON: JSON.stringify({ prod: envUid }),
          INPUT_ENV_RUNTIME_URLS_JSON: '{"prod":"https://example.com"}',
          INPUT_MOCK_URL: `https://${mockUid}.mock.pstmn.io`,
          INPUT_MOCK_ENVIRONMENT_ENABLED: 'true',
          INPUT_MONITOR_TYPE: 'cli',
          INPUT_REPO_WRITE_MODE: 'none',
          INPUT_GENERATE_CI_WORKFLOW: 'false',
          INPUT_WORKSPACE_LINK_ENABLED: 'false',
          INPUT_ENVIRONMENT_SYNC_ENABLED: 'false',
          INPUT_POSTMAN_ACCESS_TOKEN: provider.current()
        });
        const core = { info: () => undefined, warning: console.warn, setOutput: () => undefined };
        const first = await runRepoSync(inputs, { core, postman: assets });
        mockEnvironmentUid = first['mock-environment-uid'];
        const runtimeUids = JSON.parse(first['environment-uids-json']) as Record<string, string>;
        const resources = readFileSync('.postman/resources.yaml', 'utf8');
        const artifactExists = existsSync('postman/mocks/manual-validation.postman_environment.json');
        if (!mockEnvironmentUid || runtimeUids.prod !== envUid || Object.keys(runtimeUids).length !== 1) {
          fail('mock environment output', JSON.stringify({ mockEnvironmentUid, runtimeUids }));
        } else if (resources.includes(mockEnvironmentUid) || !artifactExists) {
          fail('mock environment isolation', `stateContainsUid=${resources.includes(mockEnvironmentUid)} artifactExists=${artifactExists}`);
        } else {
          console.log(`  [ok] mock environment uid emitted outside runtime map; artifact=${artifactExists}`);
        }
        const second = await runRepoSync(inputs, { core, postman: assets });
        if (second['mock-environment-uid'] !== mockEnvironmentUid) {
          fail('mock environment idempotency', 'second run returned a different environment uid');
        } else {
          console.log('  [ok] second run reused the same mock environment uid');
        }
      } finally {
        process.chdir(originalCwd);
        rmSync(runDir, { recursive: true, force: true });
      }
    }

    console.log('\n== monitor: PostmanGatewayAssetsClient (production path) ==');
    try {
      monitorUid = await assets.createMonitor(
        workspaceId,
        `probe-mon-${stamp}`,
        publicCollectionUid,
        envUid,
        '0 0 * * 0'
      );
      console.log(`  [ok] createMonitor uid=${monitorUid}`);
    } catch (error) {
      fail('createMonitor', error instanceof Error ? error.message : String(error));
    }

    const monitors = await assets.listMonitors();
    console.log(`  [ok] listMonitors count=${monitors.length}`);
    const foundMonitor = await assets.findMonitorByCollection(
      publicCollectionUid,
      envUid,
      `probe-mon-${stamp}`
    );
    if (!foundMonitor?.uid) {
      fail('findMonitorByCollection', 'did not rediscover monitor by public uid');
    } else {
      console.log(`  [ok] findMonitorByCollection uid=${foundMonitor.uid}`);
    }

    if (monitorUid) {
      try {
        await assets.runMonitor(monitorUid);
        console.log(`  [ok] runMonitor ${monitorUid}`);
      } catch (error) {
        fail('runMonitor', error instanceof Error ? error.message : String(error));
      }
    }

    console.log('\n== cleanup: delete mock + monitor before workspace teardown ==');
    if (mockUid) {
      const del = await gwRaw(gateway, 'mock', 'delete', `/mocks/${mockUid}`);
      console.log(`  [${del.status}] DELETE mock ${mockUid}`);
    }
    if (privateMockUid) {
      const del = await gwRaw(gateway, 'mock', 'delete', `/mocks/${privateMockUid}`);
      console.log(`  [${del.status}] DELETE private mock ${privateMockUid}`);
    }
    if (mockEnvironmentUid) {
      await assets.deleteEnvironment(mockEnvironmentUid);
      console.log(`  [ok] DELETE mock environment ${mockEnvironmentUid}`);
    }
    if (monitorUid) {
      const del = await gwRaw(gateway, 'monitorsV2', 'delete', `/monitors/${monitorUid}`);
      console.log(`  [${del.status}] DELETE monitor ${monitorUid}`);
    }
  } finally {
    console.log('\n[teardown] deleting created workspaces...');
    for (const id of createdWorkspaces) {
      await deleteWorkspace(apiKey, id);
    }
  }

  if (failed) {
    process.exitCode = 1;
    console.error('\n[result] write probe FAILED');
  } else {
    console.log('\n[result] write probe complete.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
