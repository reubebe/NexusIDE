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
