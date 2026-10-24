import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderPicker } from '../ui/provider-picker.js';

const config = () => ({ version: 1, providers: { local: { kind: 'demo', model: 'offline-script' } }, routes: { default: 'local' }, mcp: {} });
const catalog = [{ id: 'openai', keyEnv: 'OPENAI_API_KEY', credential: 'available' }, { id: 'gemini', keyEnv: 'GEMINI_API_KEY', credential: 'available' }];
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function ready(api) {
  const picker = createProviderPicker(api);
  await picker.loadConfig();
  await picker.refreshProviders();
  picker.provider = 'openai'; picker.model = 'test-model';
  return picker;
}

test('picker loads saved routes without making cloud requests, and respects pinned agents', async () => {
  const requests = [];
  const picker = await ready(async route => { requests.push(route); return route === 'config' ? config() : { providers: catalog }; });
  assert.deepEqual(requests, ['config', 'providers']);
  assert.match(picker.selectionStatus, /offline-script/);
  picker.setAgents([{ name: 'coder', provider: 'local' }]); picker.route = 'coder';
  assert.equal(picker.canConnect, false);
  assert.match(picker.selectionStatus, /Pinned/);
  picker.setAgents([{ name: 'coder' }]);
  assert.equal(picker.canConnect, true);
  assert.match(picker.selectionStatus, /Inherited/);
  picker.setAgents([{ name: 'new-agent' }]);
  assert.equal(picker.route, 'default');
});

test('prototype-named agents inherit only explicitly configured routes and profiles', async () => {
  const current = config();
  const picker = await ready(async route => route === 'config' ? current : { providers: catalog });
  picker.setAgents([{ name: 'constructor' }]); picker.route = 'constructor';
  assert.match(picker.selectionStatus, /constructor: offline-script/);
  assert.match(picker.selectionStatus, /Inherited from the workspace default/);
  current.providers.constructor = { kind: 'demo', model: 'explicit-constructor-model' };
  current.routes.constructor = 'constructor';
  assert.match(picker.selectionStatus, /constructor: explicit-constructor-model/);
  assert.match(picker.selectionStatus, /Applies to new tasks/);
});

test('missing prototype-named pinned profiles are reported as unavailable instead of inherited objects', async () => {
  const picker = await ready(async route => route === 'config' ? config() : { providers: catalog });
  for (const provider of ['constructor', 'toString', '__proto__']) {
    picker.setAgents([{ name: 'coder', provider }]); picker.route = 'coder';
    assert.match(picker.selectionStatus, /provider profile .* is unavailable/);
    assert.doesNotMatch(picker.selectionStatus, /undefined|runtime environment settings/);
    assert.equal(picker.canConnect, false);
  }
});

test('provider save preserves advanced edits typed while it is in flight and blocks competing saves', async () => {
  const saving = deferred(); let current = config();
  const picker = await ready(async (route, method, body) => {
    if (route === 'providers') return { providers: catalog };
    if (route === 'config') return structuredClone(current);
    assert.equal(route, 'providers/select'); assert.equal(method, 'POST');
    await saving.promise;
    current.providers.remote = { kind: 'compatible', model: body.model };
    current.routes.default = 'remote';
  });
  const result = picker.connect();
  picker.setDraft('new draft typed during save');
  await assert.rejects(picker.saveConfig(), /current connection save/);
  await assert.rejects(picker.connect(), /current connection save/);
  saving.resolve(); await result;
  assert.equal(picker.draft, 'new draft typed during save');
  assert.equal(picker.dirty, true);
  assert.match(picker.selectionStatus, /test-model/);
  assert.equal(picker.busy, false);
});

test('advanced save acknowledges only the submitted draft and keeps later edits dirty', async () => {
  const saving = deferred();
  const picker = await ready(async (route, method) => {
    if (method === 'PUT') return saving.promise;
    return route === 'config' ? config() : { providers: catalog };
  });
  const draft = JSON.stringify({ ...config(), limits: { maxSteps: 10, maxContextChars: 12000 } });
  picker.setDraft(draft);
  const result = picker.saveConfig();
  picker.setDraft(draft + ' ');
  saving.resolve(); await result;
  assert.equal(picker.saved, draft);
  assert.equal(picker.dirty, true);
  await assert.rejects(picker.connect(), /advanced connection edits/);
});

test('stale model responses cannot replace the newer selected provider', async () => {
  const first = deferred(), second = deferred();
  const picker = await ready(async route => {
    if (route.includes('models?')) return route.endsWith('openai') ? first.promise : second.promise;
    return route === 'config' ? config() : { providers: catalog };
  });
  const a = picker.selectProvider('openai');
  const b = picker.selectProvider('gemini');
  second.resolve({ models: ['gemini-model'], note: 'second' }); await b;
  first.resolve({ models: ['openai-model'], note: 'first' }); await a;
  assert.equal(picker.provider, 'gemini');
  assert.deepEqual(picker.models, ['gemini-model']);
  assert.equal(picker.note, 'second');
  assert.equal(picker.loading, false);
});

test('account switching clears models, ignores stale responses, and saves the exact credential route', async () => {
  const account1 = { id: 'openai', providerId: 'openai', account: 1, label: 'OpenAI · Account 1', keyEnv: 'OPENAI_API_KEY', kind: 'compatible', baseUrl: 'https://api.openai.com/v1', credential: 'available' };
  const account2 = { ...account1, id: 'openai:2', account: 2, label: 'OpenAI · Account 2', keyEnv: 'OPENAI_API_KEY2' };
  const first = deferred(), second = deferred(), selections = [];
  let current = config(), available = [account1, account2];
  const picker = await ready(async (route, method, body) => {
    if (route === 'providers') return { providers: available };
    if (route === 'config') return structuredClone(current);
    if (route === 'providers/models?provider=openai') return first.promise;
    if (route === 'providers/models?provider=openai%3A2') return second.promise;
    assert.equal(route, 'providers/select'); assert.equal(method, 'POST');
    selections.push(body);
    current.providers['picker-openai-account-2-hash'] = { kind: account2.kind, baseUrl: account2.baseUrl, keyEnv: account2.keyEnv, model: body.model };
    current.routes[body.route] = 'picker-openai-account-2-hash';
  });
  picker.models = ['previous-account-model']; picker.model = '__custom__'; picker.customModel = 'private-model';
  const a = picker.selectProvider('openai');
  const b = picker.selectProvider('openai:2');
  assert.deepEqual(picker.models, []);
  assert.equal(picker.modelId, ''); assert.equal(picker.customModel, ''); assert.equal(picker.canConnect, false);
  second.resolve({ models: ['account-2-model'], note: 'second account' }); await b;
  picker.model = 'account-2-model';
  first.resolve({ models: ['account-1-model'], note: 'first account' }); await a;
  assert.equal(picker.provider, 'openai:2');
  assert.deepEqual(picker.models, ['account-2-model']); assert.equal(picker.note, 'second account');
  await picker.connect();
  assert.deepEqual(selections, [{ provider: 'openai:2', model: 'account-2-model', route: 'default' }]);
  assert.match(picker.selectionStatus, /account-2-model · OpenAI · Account 2 \(OPENAI_API_KEY2\)/);
  assert.doesNotMatch(picker.selectionStatus, /picker-openai-account-2-hash/);

  available = [account1];
  await picker.refreshProviders();
  assert.equal(picker.provider, ''); assert.equal(picker.canConnect, false); assert.deepEqual(picker.models, []);
  assert.match(picker.selectionStatus, /OpenAI · Account 2 \(OPENAI_API_KEY2; key missing\)/);
  assert.doesNotMatch(picker.selectionStatus, /Account 1/);
});

test('saved account summary reports placeholders without mislabelling custom endpoints or vault credentials', async () => {
  const account = { id: 'openai:2', account: 2, label: 'OpenAI · Account 2', keyEnv: 'OPENAI_API_KEY2', kind: 'compatible', baseUrl: 'https://api.openai.com/v1', credential: 'placeholder' };
  const current = config();
  current.providers.remote = { kind: account.kind, baseUrl: `${account.baseUrl}/`, keyEnv: account.keyEnv, model: 'test-model' };
  current.routes.default = 'remote';
  const picker = await ready(async route => route === 'config' ? current : { providers: [account] });
  assert.match(picker.selectionStatus, /Account 2 \(OPENAI_API_KEY2; example key\)/);
  current.providers.remote.baseUrl = 'https://example.com/v1';
  assert.match(picker.selectionStatus, /remote \(OPENAI_API_KEY2\)/);
  assert.doesNotMatch(picker.selectionStatus, /Account 2/);
  current.providers.remote.baseUrl = account.baseUrl;
  current.providers.remote.keySecret = 'saved-credential';
  assert.match(picker.selectionStatus, /remote \(vault: saved-credential\)/);
  assert.doesNotMatch(picker.selectionStatus, /Account 2/);
});

test('stale catalog refresh is ignored and model errors offer manual entry', async () => {
  const first = deferred(), second = deferred(); let requests = 0;
  const picker = createProviderPicker(async route => {
    if (route === 'providers') return ++requests === 1 ? first.promise : second.promise;
    if (route === 'config') return config();
    throw new Error('Model listing unavailable.');
  });
  await picker.loadConfig();
  const a = picker.refreshProviders(), b = picker.refreshProviders();
  second.resolve({ providers: catalog }); await b;
  first.resolve({ providers: [] }); await a;
  assert.deepEqual(picker.catalog, catalog);
  await picker.selectProvider('openai');
  assert.equal(picker.model, '__custom__'); assert.equal(picker.canConnect, false);
  picker.customModel = 'model-id'; assert.equal(picker.canConnect, true);
});

test('failed save releases busy state without discarding the advanced draft', async () => {
  const picker = await ready(async (route, method) => {
    if (method === 'PUT') throw new Error('Workspace busy');
    return route === 'config' ? config() : { providers: catalog };
  });
  picker.setDraft(JSON.stringify(config()));
  await assert.rejects(picker.saveConfig(), /Workspace busy/);
  assert.equal(picker.busy, false); assert.equal(picker.dirty, true);
});

const ollama = { id: 'ollama', label: 'Ollama', kind: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true, credential: 'not-required', service: 'unknown' };

test('local picker checks installed models on selection, requires an explicit save, and labels its saved route', async () => {
  const listing = deferred(), requests = [], selections = [];
  let current = config();
  const picker = createProviderPicker(async (route, method, body) => {
    requests.push(route);
    if (route === 'config') return structuredClone(current);
    if (route === 'providers') return { providers: [...catalog, ollama] };
    if (route === 'providers/models?provider=ollama') return listing.promise;
    assert.equal(route, 'providers/select'); assert.equal(method, 'POST'); selections.push(body);
    current.providers.ollama = { kind: ollama.kind, baseUrl: ollama.baseUrl, model: body.model };
    current.routes[body.route] = 'ollama';
  });
  await picker.loadConfig(); await picker.refreshProviders();
  assert.deepEqual(requests, ['config', 'providers']); assert.equal(picker.localService, 'unknown');
  const loading = picker.selectProvider('ollama');
  assert.equal(picker.canConnect, false); assert.match(picker.note, /No API key/);
  listing.resolve({ models: ['gpt-oss:20b'], note: 'Installed local models.' }); await loading;
  assert.equal(picker.localService, 'ready'); assert.equal(picker.model, ''); assert.equal(picker.canConnect, false);
  assert.deepEqual(selections, []); assert.equal(current.routes.default, 'local');
  picker.model = '__custom__'; picker.customModel = 'not-installed'; assert.equal(picker.canConnect, false);
  picker.model = 'gpt-oss:20b'; assert.equal(picker.canConnect, true);
  await picker.connect();
  assert.deepEqual(selections, [{ provider: 'ollama', model: 'gpt-oss:20b', route: 'default' }]);
  assert.match(picker.selectionStatus, /gpt-oss:20b · Ollama \(local · no API key\)/);
});

test('local service errors block saving, can recover, and do not overwrite a later cloud selection', async () => {
  let list = async () => { throw new Error('Open Ollama or run ollama serve, then refresh models.'); };
  const picker = createProviderPicker(async route => {
    if (route === 'config') return config();
    if (route === 'providers') return { providers: [...catalog, ollama] };
    if (route.endsWith('ollama')) return list();
    return { models: ['cloud-model'], note: 'Cloud listing.' };
  });
  await picker.loadConfig(); await picker.refreshProviders();
  await picker.selectProvider('ollama', 'gpt-oss:20b');
  assert.equal(picker.localService, 'unavailable'); assert.equal(picker.model, ''); assert.equal(picker.canConnect, false); assert.match(picker.note, /Open Ollama/);
  list = async () => ({ models: ['gpt-oss:20b'], note: 'Ready.' });
  await picker.selectProvider('ollama', 'gpt-oss:20b'); assert.equal(picker.canConnect, true);
  const pending = deferred(); list = () => pending.promise;
  const localRequest = picker.selectProvider('ollama');
  await picker.selectProvider('gemini'); picker.model = 'cloud-model';
  pending.resolve({ models: ['gpt-oss:20b'], note: 'Stale local response.' }); await localRequest;
  assert.equal(picker.localService, 'unknown'); assert.equal(picker.provider, 'gemini'); assert.equal(picker.note, 'Cloud listing.'); assert.equal(picker.canConnect, true);
});

test('credential summary separates environment detection from access verification and local service', async () => {
  const picker = createProviderPicker(async route => route === 'config' ? config() : { providers: [ollama,
    { id: 'gemini', label: 'Google · Gemini · Account 1', keyEnv: 'GEMINI_API_KEY', credential: 'available' },
    { id: 'openai', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', credential: 'missing' }] });
  await picker.loadConfig(); await picker.refreshProviders();
  assert.match(picker.credentialSummary, /Google · Gemini · Account 1 \(GEMINI_API_KEY\)/);
  assert.match(picker.credentialSummary, /does not verify account access/);
  assert.match(picker.credentialSummary, /Ollama needs no API key/);
  assert.doesNotMatch(picker.credentialSummary, /OPENAI_API_KEY/);
  picker.catalog = [ollama]; assert.match(picker.credentialSummary, /No cloud API keys detected/);
});
