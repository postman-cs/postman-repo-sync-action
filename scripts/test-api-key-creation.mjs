import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Exercise the actual resolver source with isolated collaborators. No packages,
// credentials, network, timers, generated bundle, or credential stores required.
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../src/lib/api-key-creation.ts', import.meta.url), 'utf8');
const start = source.indexOf('export async function resolvePostmanApiKeyAndTeamId(');
const end = source.indexOf('export function createRepoSyncDependencies(', start);
assert.ok(start >= 0 && end > start);
const js = stripTypeScriptTypes((policy + '\n' + source.slice(start, end)).replace(/^export /gm, ''));

function harness({ me = { user: { id: 'synthetic-user' } }, error } = {}) {
  const calls = { create: 0, persist: 0, validate: 0, adapter: 0 };
  const context = vm.createContext({
    PostmanAssetsClient: class { async getMe() { calls.validate++; if (error) throw error; return me; } },
    createInternalIntegrationAdapter() {
      calls.adapter++;
      return { async createApiKey() { calls.create++; throw new Error('SYNTHETIC_CREATION_SENTINEL'); } };
    },
    formatOrchestrationIssue: () => 'redacted warning',
  });
  vm.runInContext(js, context);
  const inputs = { apiKeyCreation: 'deny', postmanApiKey: 'synthetic-key', postmanAccessToken: 'synthetic-session', teamId: 'synthetic-team', orgMode: true };
  const core = { info() {}, warning() {}, setSecret() { calls.persist++; } };
  const exec = { getExecOutput() { calls.persist++; throw new Error('Unexpected persistence'); } };
  return { calls, inputs, run: (extra = {}, options = {}) => context.resolvePostmanApiKeyAndTeamId({ ...inputs, ...extra }, core, exec, x => x, { env: {}, ...options }) };
}

for (const status of [401, 403]) {
  test(`rejected PMAK ${status} cannot create or persist with explicit deny`, async () => {
    const h = harness({ error: { status } });
    await assert.rejects(h.run(), /API_KEY_CREATION_DENIED/);
    assert.deepEqual(h.calls, { create: 0, persist: 0, validate: 1, adapter: 0 });
  });
}
test('missing PMAK and available session cannot create', async () => {
  const h = harness();
  await assert.rejects(h.run({ postmanApiKey: '' }, { allowApiKeyCreation: true }), /API_KEY_CREATION_DENIED/);
  assert.deepEqual(h.calls, { create: 0, persist: 0, validate: 0, adapter: 0 });
});
for (const me of [null, {}, { user: null }]) {
  test(`invalid /me payload ${JSON.stringify(me)} fails closed`, async () => {
    const h = harness({ me });
    await assert.rejects(h.run(), /API_KEY_CREATION_DENIED/);
    assert.equal(h.calls.adapter, 0);
  });
}
for (const error of [new Error('network unavailable'), { status: 500 }, { status: 429 }]) {
  test(`unexpected validation failure cannot trigger replacement (${error.status ?? 'network'})`, async () => {
    const h = harness({ error });
    await assert.rejects(h.run());
    assert.equal(h.calls.adapter, 0);
    assert.equal(h.calls.persist, 0);
  });
}
test('valid existing PMAK is reused', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.apiKey, h.inputs.postmanApiKey);
  assert.equal(h.calls.create, 0);
});
test('invalid policy is rejected before validation without reflecting input', async () => {
  const h = harness();
  await assert.rejects(h.run({ apiKeyCreation: 'synthetic-sensitive-invalid' }), e => /Unsupported api-key-creation/.test(e.message) && !e.message.includes('synthetic-sensitive-invalid'));
  assert.equal(h.calls.validate, 0);
});
test('explicit allow reaches legacy mutation only through a synthetic sentinel', async () => {
  const h = harness();
  await assert.rejects(h.run({ postmanApiKey: '', apiKeyCreation: 'allow' }), /SYNTHETIC_CREATION_SENTINEL/);
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.persist, 0);
});
test('spec-only caller gate wins over explicit allow', async () => {
  const h = harness();
  const result = await h.run({ postmanApiKey: '', apiKeyCreation: 'allow' }, { allowApiKeyCreation: false });
  assert.equal(result.apiKey, '');
  assert.equal(h.calls.adapter, 0);
});
test('spec-only input cannot be bypassed by a caller omitting the gate', async () => {
  const h = harness();
  const result = await h.run({ postmanApiKey: '', onboardingScope: 'spec-only', apiKeyCreation: 'allow' });
  assert.equal(result.apiKey, '');
  assert.equal(h.calls.adapter, 0);
});
test('explicit deny wins even if the caller permits creation', async () => {
  const h = harness();
  await assert.rejects(h.run({ postmanApiKey: '', apiKeyCreation: 'deny' }, { allowApiKeyCreation: true }), /API_KEY_CREATION_DENIED/);
  assert.equal(h.calls.adapter, 0);
});
test('all public input adapters carry the policy into the shared resolver', () => {
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  const contract = readFileSync(new URL('../src/contracts.ts', import.meta.url), 'utf8');
  assert.match(cli, /'api-key-creation'/);
  assert.match(source, /apiKeyCreation: parseApiKeyCreation\(getInput\('api-key-creation', env\)\)/);
  assert.match(source, /INPUT_API_KEY_CREATION: readInput\(actionCore, 'api-key-creation'\) \|\| 'allow'/);
  assert.match(action, /api-key-creation:[\s\S]*?default: allow/);
  assert.match(contract, /'api-key-creation':[\s\S]*?default: 'allow'/);
  assert.equal((source.match(/await internalIntegration\.createApiKey\(/g) ?? []).length, 1);
});

test('omitted policy preserves legacy creation for existing callers', async () => {
  const h = harness();
  await assert.rejects(h.run({ postmanApiKey: '', apiKeyCreation: undefined }), /SYNTHETIC_CREATION_SENTINEL/);
  assert.equal(h.calls.create, 1);
});
