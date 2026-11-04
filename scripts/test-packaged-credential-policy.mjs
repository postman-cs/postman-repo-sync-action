import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(process.argv[2] ?? '.');
const action = require(resolve(root, 'dist/index.cjs'));
let writes = 0;
let fetches = 0;
let validation = 'unauthorized';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  fetches++;
  // A closed fake: every unexpected request throws before any network activity.
  assert.equal(String(url), 'https://synthetic.invalid/me');
  assert.equal(options.method, 'GET');
  if (validation === 'unauthorized') return new globalThis.Response('{}', { status: 401 });
  return globalThis.Response.json({ user: { id: 'synthetic-user' } });
};
const core = { info() {}, warning() {}, setSecret() { writes++; } };
const exec = { async getExecOutput() { writes++; throw new Error('Unexpected persistence'); } };
const base = {
  apiKeyCreation: 'deny', postmanApiKey: '', postmanAccessToken: 'synthetic-token',
  postmanApiBase: 'https://synthetic.invalid', teamId: 'synthetic-team', orgMode: true,
};
try {
  const parsed = action.resolveInputs({
    INPUT_PROJECT_NAME: 'synthetic-project', INPUT_WORKSPACE_ID: 'synthetic-workspace',
    INPUT_MOCK_VISIBILITY: 'public', INPUT_ENVIRONMENTS_JSON: '["prod"]',
  });
  assert.equal(parsed.apiKeyCreation, 'allow');
  const unsafeAlias = 'synthetic-sensitive-alias\n::error::forged';
  assert.throws(() => action.resolveInputs({
    INPUT_PROJECT_NAME: 'synthetic-project', INPUT_WORKSPACE_ID: 'synthetic-workspace',
    INPUT_MOCK_VISIBILITY: 'public', INPUT_ENVIRONMENTS_JSON: '["prod"]',
    INPUT_API_KEY_CREATION: 'deny', 'INPUT_API-KEY-CREATION': unsafeAlias,
  }), error => /Conflicting api-key-creation input aliases/.test(error.message)
    && !error.message.includes(unsafeAlias) && !error.message.includes('synthetic-sensitive-alias')
    && !error.message.includes('forged'));

  for (const postmanApiKey of ['', 'synthetic-invalid-key']) {
    await assert.rejects(action.resolvePostmanApiKeyAndTeamId(
      { ...base, postmanApiKey }, core, exec, x => x,
      { allowApiKeyCreation: true, env: {} }
    ), /API_KEY_CREATION_DENIED/);
  }
  assert.equal(fetches, 1);
  assert.equal(writes, 0);
  validation = 'valid';
  const result = await action.resolvePostmanApiKeyAndTeamId(
    { ...base, postmanApiKey: 'synthetic-existing-key' }, core, exec, x => x, { env: {} }
  );
  assert.equal(result.apiKey, 'synthetic-existing-key');
  assert.equal(writes, 0);
  console.log('Packaged credential policy: legacy allow default, explicit deny, missing/rejected key rejection, existing-key reuse, zero mutations; PASS');
} finally {
  globalThis.fetch = originalFetch;
}
