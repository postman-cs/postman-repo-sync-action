/**
 * Live auth + read-route probe for the access-token gateway. Mints a token from
 * the sandbox PMAK via the production `AccessTokenProvider`, stands up a
 * disposable workspace + spec-generated collection + sync environment (so the
 * read probes hit real ids, not borrowed `workspaces[0]`/`collections[0]`),
 * then exercises the VERIFIED gateway read routes through
 * `AccessTokenGatewayClient` / `PostmanGatewayAssetsClient`:
 *
 *   - sync POST /list/environment?workspace=:ws   (env list — POST, not GET)
 *   - sync GET  /environment/:id/sync?since_id=0  (env get-one)
 *   - collection GET /v3/collections/:id/export   (collection read — v3 IR)
 *   - mock GET /mocks?workspace=:ws
 *   - monitorsV2 GET /monitors?workspace=:ws
 *
 * The gateway client owns org-mode header policy (`x-entity-team-id` only when
 * org-mode), so this probe does NOT set it manually. Team id comes from the
 * mint-time `/me` (resolve-service-token's source), not from a downstream PMAK
 * `/teams` enumeration. Run-scoped teardown deletes the disposable workspace.
 *
 * Run:
 *   set -a && source ../../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     node --experimental-strip-types scripts/live-auth-probe.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';
import { HttpError } from '../src/lib/http-error.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;

type JsonRecord = Record<string, unknown>;

function snippet(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, 240).replace(/\s+/g, ' ');
}

function toModelId(uid: string): string {
  const parts = String(uid ?? '').trim().split('-');
  return parts.length >= 6 ? parts.slice(1).join('-') : parts.join('-');
}

const SPEC_CONTENT = [
  'openapi: 3.0.3',
  'info:',
  '  title: Auth Probe API',
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
): Promise<{ status: number; text: string }> {
  const r = await gateway.request({ service, method, path, ...(body !== undefined ? { body } : {}) });
  const text = await r.text().catch(() => '');
  return { status: r.status, text };
}

async function probeRead(
  gateway: AccessTokenGatewayClient,
  label: string,
  service: string,
  method: 'get' | 'post',
  path: string,
  body?: unknown
): Promise<void> {
  try {
    const r = await gwRaw(gateway, service, method, path, body);
    const ok = r.status >= 200 && r.status < 300;
    console.log(`  [${r.status}${ok ? ' OK' : ''}] ${label} (${service} ${method} ${path}) :: ${snippet(r.text)}`);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 0;
    console.log(`  [${status || 'ERR'}] ${label} (${service} ${method} ${path}) :: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function deleteWorkspace(apiKey: string, workspaceId: string): Promise<void> {
  try {
    const r = await fetch(`${API}/workspaces/${workspaceId}`, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } });
    console.log(`  [teardown] DELETE /workspaces/${workspaceId} -> ${r.status}`);
  } catch (error) {
    console.log(`  [teardown] workspace ${workspaceId} delete failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) {
    console.log('[skip] No POSTMAN_API_KEY / POSTMAN_E2E_API_KEY_NON_ORG_MODE set; skipping auth probe.');
    return;
  }

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  console.log('[setup] minted access token');

  const gateway = new AccessTokenGatewayClient({ tokenProvider: provider });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workspaceName = `auth-probe-${stamp}`;
  const createdWorkspaces = new Set<string>();

  try {
    console.log('\n== setup: disposable workspace ==');
    const wsCreate = await gwRaw(gateway, 'workspaces', 'post', '/workspaces', { name: workspaceName, visibilityStatus: 'personal' });
    const wsId = String((JSON.parse(wsCreate.text || '{}').data || {}).id || '');
    if (!wsId) {
      console.error(`[FAIL] workspace create: status ${wsCreate.status} :: ${snippet(wsCreate.text)}`);
      return;
    }
    createdWorkspaces.add(wsId);
    await gwRaw(gateway, 'workspaces', 'put', `/workspaces/${wsId}/visibility`, { visibilityStatus: 'team' });
    console.log(`[setup] workspace ${wsId}`);

    console.log('\n== setup: spec + gateway collection generation ==');
    const specCreate = await gwRaw(gateway, 'specification', 'post', `/specifications?containerType=workspace&containerId=${wsId}`, {
      name: 'Auth Probe API',
      type: 'OPENAPI:3.0',
      files: [{ path: 'index.yaml', content: SPEC_CONTENT, type: 'ROOT' }]
    });
    const specId = String((JSON.parse(specCreate.text || '{}').data || {}).id || '');
    if (!specId) {
      console.error(`[FAIL] spec create: status ${specCreate.status} :: ${snippet(specCreate.text)}`);
      return;
    }
    await gwRaw(gateway, 'specification', 'post', `/specifications/${specId}/collections`, { name: 'Auth Probe Collection', options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' } });
    let collectionUid = '';
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const task = await gateway.requestJson<JsonRecord>({ service: 'specification', method: 'get', path: '/tasks', query: { entityId: specId, entityType: 'specification', type: 'collection-generation' } });
      const status = String((task?.data as JsonRecord | undefined)?.[Object.keys(task?.data || {})[0]] ?? '');
      if (status && !['in-progress', 'pending', 'queued'].includes(status.toLowerCase())) break;
    }
    const specCols = await gateway.requestJson<JsonRecord>({ service: 'specification', method: 'get', path: `/specifications/${specId}/collections` });
    const entries = Array.isArray(specCols?.data) ? (specCols.data as JsonRecord[]) : [];
    collectionUid = String(entries[0]?.collection ?? entries[0]?.id ?? '');
    console.log(`[setup] collection uid ${collectionUid || '<none>'}`);

    const assets = new PostmanGatewayAssetsClient({ gateway, workspaceId: wsId });
    const envUid = await assets.createEnvironment(wsId, 'auth-probe-env', [{ key: 'baseUrl', value: 'https://example.com', enabled: true }]);
    console.log(`[setup] env uid ${envUid}`);

    console.log('\n== VERIFIED gateway read routes (x-access-token; no PMAK) ==');
    await probeRead(gateway, 'sync env list (POST /list/environment)', 'sync', 'post', `/list/environment?workspace=${wsId}`);
    await probeRead(gateway, 'sync env get-one (GET /environment/:id/sync)', 'sync', 'get', `/environment/${toModelId(envUid)}/sync?since_id=0`);
    if (collectionUid) {
      await probeRead(gateway, 'collection v3 export (GET /v3/collections/:id/export)', 'collection', 'get', `/v3/collections/${toModelId(collectionUid)}/export`);
      await probeRead(gateway, 'collection v2 read (GET /collections/:uid — expect 404)', 'collection', 'get', `/collections/${collectionUid}`);
    }
    await probeRead(gateway, 'mock list (GET /mocks)', 'mock', 'get', `/mocks?workspace=${wsId}`);
    await probeRead(gateway, 'monitorsV2 list (GET /monitors)', 'monitorsV2', 'get', `/monitors?workspace=${wsId}`);

    console.log('\n== production client read methods ==');
    const envData = await assets.getEnvironment(envUid);
    console.log(`  [ok] getEnvironment values=${snippet((envData as JsonRecord | null)?.values)}`);
    if (collectionUid) {
      const v3 = await assets.getCollection(collectionUid);
      const items = Array.isArray((v3 as JsonRecord | null)?.items) ? (v3 as JsonRecord).items : [];
      console.log(`  [ok] getCollection v3 IR items=${items.length}`);
    }
  } finally {
    console.log('\n[teardown] deleting created workspaces...');
    for (const id of createdWorkspaces) {
      await deleteWorkspace(apiKey, id);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
