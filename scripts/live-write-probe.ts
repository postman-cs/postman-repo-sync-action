/**
 * Live WRITE probe for the gateway mock/monitor services: locks the request
 * path + body shape and the response envelope for create/run/delete so the
 * PostmanGatewayAssetsClient can parse them. Creates one mock and one monitor,
 * captures the exact response JSON, then deletes both. Sandbox-only (team
 * 10490519, wipeable). Run:
 *   set -a && source ../../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     node --experimental-strip-types scripts/live-write-probe.ts
 */
const API = 'https://api.getpostman.com';
const BIFROST = 'https://bifrost-premium-https-v4.gw.postman.com';

async function mint(apiKey: string): Promise<string> {
  const r = await fetch(`${API}/service-account-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ apiKey })
  });
  if (!r.ok) throw new Error(`mint failed ${r.status}`);
  const p = (await r.json()) as Record<string, unknown>;
  const direct = typeof p.access_token === 'string' ? p.access_token : '';
  const session = p.session && typeof p.session === 'object'
    ? (p.session as Record<string, unknown>).token : undefined;
  const t = direct || (typeof session === 'string' ? session : '');
  if (!t) throw new Error('no token in mint response');
  return t;
}

async function gw(
  token: string, teamId: string, service: string, method: string, path: string, body?: unknown
): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${BIFROST}/ws/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token, ...(teamId ? { 'x-entity-team-id': teamId } : {}) },
    body: JSON.stringify({ service, method, path, ...(body !== undefined ? { body } : {}) })
  });
  const text = await r.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 300); }
  return { status: r.status, json };
}

function show(label: string, res: { status: number; json: unknown }): void {
  console.log(`\n[${res.status}] ${label}\n${JSON.stringify(res.json, null, 2).slice(0, 900)}`);
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip] no key'); return; }
  const token = await mint(apiKey);
  const me = await (await fetch(`${API}/me`, { headers: { 'X-Api-Key': apiKey } })).json() as Record<string, unknown>;
  const teamId = String((me.user as Record<string, unknown>)?.teamId ?? '');
  const wsResp = await (await fetch(`${API}/workspaces`, { headers: { 'X-Api-Key': apiKey } })).json() as Record<string, unknown>;
  const workspaces = Array.isArray(wsResp.workspaces) ? wsResp.workspaces : [];
  const wsId = String((workspaces[0] as Record<string, unknown>)?.id ?? '');
  const colResp = await (await fetch(`${API}/collections?workspace=${wsId}`, { headers: { 'X-Api-Key': apiKey } })).json() as Record<string, unknown>;
  const collections = Array.isArray(colResp.collections) ? colResp.collections : [];
  const colUid = String((collections[0] as Record<string, unknown>)?.uid ?? '');
  console.log(`[setup] team ${teamId} ws ${wsId} col ${colUid || '<none>'}`);
  if (!colUid) { console.log('[skip] no collection to bind'); return; }

  // --- MOCK create / list / delete ---
  const mockName = `probe-mock-${teamId}`;
  const mockCreate = await gw(token, teamId, 'mock', 'post', `/mocks?workspace=${wsId}`, {
    mock: { name: mockName, collection: colUid, private: false }
  });
  show('mock CREATE (body {mock:{...}})', mockCreate);
  // try the bare-body variant only if wrapped failed
  let mockUid = extractUid(mockCreate.json);
  if (!mockUid) {
    const alt = await gw(token, teamId, 'mock', 'post', `/mocks?workspace=${wsId}`, {
      name: mockName, collection: colUid, private: false
    });
    show('mock CREATE (bare body)', alt);
    mockUid = extractUid(alt.json);
  }
  const mockList = await gw(token, teamId, 'mock', 'get', `/mocks?workspace=${wsId}`);
  show('mock LIST', mockList);
  if (mockUid) {
    show('mock DELETE', await gw(token, teamId, 'mock', 'delete', `/mocks/${mockUid}`));
  }

  // --- MONITOR create / list / run / delete ---
  const monName = `probe-mon-${teamId}`;
  const monCreate = await gw(token, teamId, 'monitorsV2', 'post', `/monitors?workspace=${wsId}`, {
    monitor: { name: monName, collection: colUid, schedule: { cron: '0 0 * * 0', timezone: 'UTC' } }
  });
  show('monitor CREATE (body {monitor:{...}})', monCreate);
  let monUid = extractUid(monCreate.json);
  if (!monUid) {
    const alt = await gw(token, teamId, 'monitorsV2', 'post', `/monitors?workspace=${wsId}`, {
      name: monName, collection: colUid, schedule: { cron: '0 0 * * 0', timezone: 'UTC' }
    });
    show('monitor CREATE (bare body)', alt);
    monUid = extractUid(alt.json);
  }
  const monList = await gw(token, teamId, 'monitorsV2', 'get', `/monitors?workspace=${wsId}`);
  show('monitor LIST', monList);
  if (monUid) {
    show('monitor RUN', await gw(token, teamId, 'monitorsV2', 'post', `/monitors/${monUid}/run`));
    show('monitor DELETE', await gw(token, teamId, 'monitorsV2', 'delete', `/monitors/${monUid}`));
  }
}

function extractUid(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const o = json as Record<string, unknown>;
  const data = (o.data && typeof o.data === 'object') ? o.data as Record<string, unknown> : undefined;
  const mock = (o.mock && typeof o.mock === 'object') ? o.mock as Record<string, unknown> : undefined;
  const mon = (o.monitor && typeof o.monitor === 'object') ? o.monitor as Record<string, unknown> : undefined;
  for (const rec of [data, mock, mon, o]) {
    if (rec) {
      const uid = rec.uid ?? rec.id;
      if (typeof uid === 'string' && uid.trim()) return uid.trim();
    }
  }
  return '';
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : String(e)); process.exitCode = 1; });
