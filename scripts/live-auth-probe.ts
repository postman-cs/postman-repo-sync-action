/**
 * Live auth probe: determines which auth header the relevant Postman surfaces
 * accept for an access token, so the access-token migration can pick the right
 * transport. Mints a token from the sandbox PMAK, then probes:
 *   - public API (api.getpostman.com) with x-access-token, Authorization Bearer
 *   - public API with X-Api-Key (control)
 *   - gateway (/ws/proxy) with the env/mock/monitor service envelopes
 *
 * Read-only: only GETs/LISTs. No assets created. Run:
 *   set -a && source ../../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     node --experimental-strip-types scripts/live-auth-probe.ts
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

async function probe(label: string, url: string, headers: Record<string, string>, init: RequestInit = {}): Promise<void> {
  try {
    const r = await fetch(url, { ...init, headers });
    const body = await r.text();
    const snippet = body.slice(0, 160).replace(/\s+/g, ' ');
    console.log(`  [${r.status}] ${label} :: ${snippet}`);
  } catch (e) {
    console.log(`  [ERR] ${label} :: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function gw(label: string, token: string, teamId: string, service: string, method: string, path: string, query?: unknown): Promise<void> {
  try {
    const r = await fetch(`${BIFROST}/ws/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': token, ...(teamId ? { 'x-entity-team-id': teamId } : {}) },
      body: JSON.stringify({ service, method, path, ...(query !== undefined ? { query } : {}) })
    });
    const body = await r.text();
    const snippet = body.slice(0, 200).replace(/\s+/g, ' ');
    console.log(`  [${r.status}] gw ${label} (${service} ${method} ${path}) :: ${snippet}`);
  } catch (e) {
    console.log(`  [ERR] gw ${label} :: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip] no key'); return; }
  const token = await mint(apiKey);
  console.log('[setup] minted access token');

  // resolve team id + a workspace id for workspace-scoped probes
  const me = await (await fetch(`${API}/me`, { headers: { 'X-Api-Key': apiKey } })).json() as Record<string, unknown>;
  const teamId = String((me.user as Record<string, unknown>)?.teamId ?? '');
  console.log(`[setup] team ${teamId}`);
  const wsResp = await (await fetch(`${API}/workspaces`, { headers: { 'X-Api-Key': apiKey } })).json() as Record<string, unknown>;
  const workspaces = Array.isArray(wsResp.workspaces) ? wsResp.workspaces : [];
  const wsId = String((workspaces[0] as Record<string, unknown>)?.id ?? '');
  console.log(`[setup] workspace ${wsId}`);

  console.log('\n== PUBLIC API auth-header probes (GET /me) ==');
  await probe('X-Api-Key (control)', `${API}/me`, { 'X-Api-Key': apiKey });
  await probe('x-access-token', `${API}/me`, { 'x-access-token': token });
  await probe('Authorization Bearer', `${API}/me`, { Authorization: `Bearer ${token}` });

  console.log('\n== PUBLIC API list endpoints with x-access-token ==');
  await probe('GET /environments x-access-token', `${API}/environments?workspace=${wsId}`, { 'x-access-token': token });
  await probe('GET /mocks x-access-token', `${API}/mocks`, { 'x-access-token': token });
  await probe('GET /monitors x-access-token', `${API}/monitors`, { 'x-access-token': token });

  console.log('\n== GATEWAY /ws/proxy service envelope probes ==');
  await gw('environment list', token, teamId, 'environment', 'get', `/environments?workspace=${wsId}`);
  await gw('environment list (POST /list)', token, teamId, 'environment', 'post', '/list/environment');
  await gw('mock list', token, teamId, 'mock', 'get', `/mocks?workspace=${wsId}`);
  await gw('monitorsV2 list', token, teamId, 'monitorsV2', 'get', `/monitors?workspace=${wsId}&type=uptime&_etc=true`);
  await gw('monitors jobTemplates', token, teamId, 'monitors', 'get', `/jobTemplates?workspace=${wsId}`);
  await gw('collection get (specification svc)', token, teamId, 'specification', 'get', `/specifications?containerType=workspace&containerId=${wsId}`);

  console.log('\n== GATEWAY env service-name alternatives ==');
  await gw('environments(plural) list', token, teamId, 'environments', 'get', `/environments?workspace=${wsId}`);
  await gw('environment-management list', token, teamId, 'environment-management', 'get', `/environments?workspace=${wsId}`);
  await gw('workspace svc environments', token, teamId, 'workspace', 'get', `/environments?workspace=${wsId}`);

  console.log('\n== GATEWAY collection-read probes ==');
  // resolve a real collection uid in the workspace via public API
  const colResp = await (await fetch(`${API}/collections?workspace=${wsId}`, { headers: { 'X-Api-Key': apiKey } })).json() as Record<string, unknown>;
  const collections = Array.isArray(colResp.collections) ? colResp.collections : [];
  const colUid = String((collections[0] as Record<string, unknown>)?.uid ?? '');
  console.log(`[setup] collection uid ${colUid || '<none>'}`);
  if (colUid) {
    await gw('collection get by uid (collection svc /collections/:uid)', token, teamId, 'collection', 'get', `/collections/${colUid}`);
    await gw('collection get by uid (collection svc /collection/:uid)', token, teamId, 'collection', 'get', `/collection/${colUid}`);
    await gw('collection get transformations (collection svc)', token, teamId, 'collection', 'get', `/collections/${colUid}/transformations`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : String(e)); process.exitCode = 1; });
