import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverProviders, discoverModels, applyProviderSelection, isAgentModel } from '../src/provider-catalog.js';
import { defaultConfig, validateConfig, saveConfig, loadConfig, routeProvider } from '../src/config.js';
import { startServer } from '../src/server.js';

test('catalog detects only named keys and distinguishes example credentials without exposing values', () => {
  const result = discoverProviders({ OPENAI_API_KEY: 'private-test-value', ANTHROPIC_API_KEY: 'your-anthropic-key', GEMINI_API_KEY: '  ', UNRELATED_SECRET: 'other-secret' });
  assert.equal(result.find(p => p.id === 'openai').credential, 'available');
  assert.equal(result.find(p => p.id === 'anthropic').credential, 'placeholder');
  assert.equal(result.find(p => p.id === 'gemini').credential, 'missing');
  assert.equal(new Set(result.filter(p => !p.local).map(p => p.keyEnv)).size, 9);
  assert.ok(!JSON.stringify(result).includes('private-test-value'));
  assert.ok(!JSON.stringify(result).includes('other-secret'));
});

test('Ollama discovery uses only the fixed local endpoint without keys, redirects, or cloud models', async () => {
  const local = discoverProviders({ OLLAMA_API_KEY: 'private-cloud-key', OPENAI_API_KEY: 'private-openai-key' }).find(p => p.id === 'ollama');
  assert.equal(local.local, true); assert.equal(local.credential, 'not-required'); assert.equal(local.service, 'unknown');
  assert.equal(Object.hasOwn(local, 'keyEnv'), false);
  const result = await discoverModels('ollama', { env: { OLLAMA_HOST: 'https://example.com', OPENAI_API_KEY: 'private-key' }, fetchImpl: async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:11434/api/tags');
    assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ models: [{ name: 'qwen3:8b' }, { model: 'gpt-oss:20b' }, { name: 'qwen3:8b' }, { name: 'nomic-embed-text:latest' },
      { name: 'qwen3:cloud' }, { name: 'gpt-oss:120b-cloud' }, { name: 'remote-model', remote_host: 'https://ollama.com' }, { name: '<script>' }] });
  } });
  assert.deepEqual(result.models, ['gpt-oss:20b', 'qwen3:8b']);
  assert.equal(result.service, 'ready'); assert.match(result.note, /does not verify agent compatibility/);
  await assert.rejects(discoverModels('ollama:2', { fetchImpl: () => assert.fail('Local provider has no numbered accounts') }), /Unknown provider/);
});

test('Ollama discovery gives safe recovery instructions for absent service, malformed lists and oversized responses', async () => {
  for (const fetchImpl of [async () => { throw new Error('private transport details'); }, async () => Response.json({ error: 'private body' }, { status: 503 }),
    async () => Response.json({ models: null }), async () => Response.json({ models: [], padding: 'x'.repeat(1024 * 1024) })]) {
    await assert.rejects(discoverModels('ollama', { env: {}, fetchImpl }), error => {
      assert.match(error.message, /Open Ollama or run ollama serve/); assert.doesNotMatch(error.message, /private/); return true;
    });
  }
  const empty = await discoverModels('ollama', { env: {}, fetchImpl: async () => Response.json({ models: [] }) });
  assert.equal(empty.service, 'ready'); assert.deepEqual(empty.models, []); assert.match(empty.note, /Pull a tool-capable model/);
});

test('Ollama selection is explicit and immutable, has no key, and sends no cloud credentials at runtime', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-local-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = structuredClone(defaultConfig);
  const selected = applyProviderSelection(config, { provider: 'ollama', model: 'gpt-oss:20b', route: 'coder' }, {});
  validateConfig(selected);
  assert.deepEqual(config, defaultConfig); assert.equal(selected.routes.default, config.routes.default);
  const profile = selected.providers[selected.routes.coder];
  assert.equal(profile.baseUrl, 'http://127.0.0.1:11434/v1'); assert.equal(Object.hasOwn(profile, 'keyEnv'), false);
  assert.deepEqual(applyProviderSelection(selected, { provider: 'ollama', model: 'gpt-oss:20b', route: 'coder' }, {}), selected);
  const again = applyProviderSelection(selected, { provider: 'ollama', model: 'qwen3:8b', route: 'default' }, {});
  assert.equal(again.routes.coder, selected.routes.coder);
  await saveConfig(root, selected);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:11434/v1/chat/completions'); assert.equal(options.headers.authorization, undefined);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Local reply.' } }] });
  });
  const provider = await routeProvider(root, { name: 'coder' }, { env: { OPENAI_API_KEY: 'private-cloud-key', NEXUS_API_KEY: 'another-private-key' } });
  await provider.complete([{ role: 'user', content: 'Test.' }]);
  assert.deepEqual(provider.sensitiveValues, []);
  assert.throws(() => applyProviderSelection(config, { provider: 'ollama', model: 'gpt-oss:120b-cloud' }, {}), /installed local/);
});

test('numbered accounts are discovered independently, ordered numerically, and never expose key values', () => {
  const env = { OPENAI_API_KEY: 'private-default', OPENAI_API_KEY2: 'private-second', OPENAI_API_KEY10: 'private-tenth',
    ANTHROPIC_API_KEY2: 'your-anthropic-key', GEMINI_API_KEY2: '', OPENAI_API_KEY1: 'ignored', OPENAI_API_KEY02: 'ignored',
    OPENAI_API_KEY100: 'ignored', OPENAI_API_KEY_WORK: 'ignored', UNRELATED_API_KEY2: 'ignored' };
  const entries = discoverProviders(env);
  assert.deepEqual(entries.filter(p => p.providerId === 'openai').map(p => [p.id, p.keyEnv, p.account]), [
    ['openai', 'OPENAI_API_KEY', 1], ['openai:2', 'OPENAI_API_KEY2', 2], ['openai:10', 'OPENAI_API_KEY10', 10],
  ]);
  assert.equal(entries.find(p => p.id === 'anthropic:2').credential, 'placeholder');
  assert.equal(entries.find(p => p.id === 'gemini:2').credential, 'missing');
  assert.equal(entries.some(p => p.keyEnv === 'UNRELATED_API_KEY2'), false);
  assert.doesNotMatch(JSON.stringify(entries), /private-default|private-second|private-tenth|ignored|your-anthropic-key/);
});

test('all provider and region presets use the selected account for model discovery, without falling back', async () => {
  for (const p of discoverProviders({}).filter(p => !p.local)) {
    const env = { [p.keyEnv]: 'first-private-key', [p.keyEnv + '2']: 'second-private-key' };
    const result = await discoverModels(`${p.id}:2`, { env, fetchImpl: async (url, options) => {
      assert.equal(options.headers[p.kind === 'anthropic' ? 'x-api-key' : 'authorization'], p.kind === 'anthropic' ? 'second-private-key' : 'Bearer second-private-key');
      assert.equal(String(url).startsWith(p.modelsUrl || p.baseUrl), true);
      return Response.json(p.modelsUrl ? { output: { total: 1, models: [{ model: 'account-two-model' }] } } : { data: [{ id: 'account-two-model' }] });
    } });
    assert.deepEqual(result.models, ['account-two-model']);
    await assert.rejects(discoverModels(`${p.id}:2`, { env: { [p.keyEnv]: 'first-private-key' }, fetchImpl: () => assert.fail('Must not fall back to account one') }), /Set a real/);
  }
  for (const id of ['openai:0', 'openai:1', 'openai:02', 'openai:100', 'openai:2:3', 'openai:WORK', 'openai:2\n', 'unknown:2']) {
    await assert.rejects(discoverModels(id, { env: {}, fetchImpl: () => assert.fail('Invalid ID must not fetch') }), /Unknown provider/);
  }
});

test('two accounts can route separate agents to the same model with distinct runtime credentials', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-numbered-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { OPENAI_API_KEY: 'first-runtime-key', OPENAI_API_KEY2: 'second-runtime-key' };
  let config = applyProviderSelection(structuredClone(defaultConfig), { provider: 'openai', model: 'same-model', route: 'coder' }, env);
  config = applyProviderSelection(config, { provider: 'openai:2', model: 'same-model', route: 'reviewer' }, env);
  validateConfig(config);
  assert.notEqual(config.routes.coder, config.routes.reviewer);
  assert.equal(config.providers[config.routes.reviewer].keyEnv, 'OPENAI_API_KEY2');
  assert.equal(config.providers[config.routes.reviewer].tokenLimitField, 'max_completion_tokens');
  assert.deepEqual(applyProviderSelection(config, { provider: 'openai:2', model: 'same-model', route: 'reviewer' }, env), config);
  await saveConfig(root, config);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent.push(options.headers.authorization);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }] });
  });
  for (const name of ['coder', 'reviewer']) {
    const provider = await routeProvider(root, { name }, { env });
    await provider.complete([{ role: 'user', content: 'Synthetic connection test.' }]);
  }
  assert.deepEqual(sent, ['Bearer first-runtime-key', 'Bearer second-runtime-key']);
  assert.doesNotMatch(JSON.stringify(config), /first-runtime-key|second-runtime-key/);
  await assert.rejects(routeProvider(root, { name: 'reviewer' }, { env: { OPENAI_API_KEY: env.OPENAI_API_KEY } }), /OPENAI_API_KEY2/);
});

test('each preset uses only its own credential and fixed HTTPS endpoint', async () => {
  for (const p of discoverProviders({}).filter(p => !p.local)) {
    let requested;
    const result = await discoverModels(p.id, { env: { [p.keyEnv]: 'fixture-secret' }, fetchImpl: async (url, options) => {
      requested = String(url);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers[p.kind === 'anthropic' ? 'x-api-key' : 'authorization'], p.kind === 'anthropic' ? 'fixture-secret' : 'Bearer fixture-secret');
      const entries = [{ id: 'text-model' }, { id: 'text-model' }, { id: '<script>' }, { id: 'text-embedding-3-small' }];
      return Response.json(p.modelsUrl ? { output: { total: 4, models: entries.map(item => ({ model: item.id })) } } : { data: entries });
    } });
    assert.ok(requested.startsWith(p.modelsUrl || `${p.baseUrl}/models`));
    assert.deepEqual(result.models, ['text-model']);
  }
});

test('Qwen uses the documented model catalog response and bounded pagination', async () => {
  let calls = 0;
  const result = await discoverModels('qwen', { env: { DASHSCOPE_API_KEY: 'fixture' }, fetchImpl: async url => {
    calls++;
    assert.equal(url.pathname, '/api/v1/models');
    assert.equal(url.searchParams.get('page_no'), String(calls));
    assert.equal(url.searchParams.get('features'), 'function-calling');
    return Response.json({ output: { total: 2, models: [{ model: calls === 1 ? 'qwen-plus' : 'qwen-flash' }] } });
  } });
  assert.equal(calls, 2);
  assert.deepEqual(result.models, ['qwen-flash', 'qwen-plus']);
});

test('discovery handles pagination and never returns remote error bodies or network credentials', async () => {
  let count = 0;
  const result = await discoverModels('anthropic', { env: { ANTHROPIC_API_KEY: 'fixture' }, fetchImpl: async url => {
    count++;
    if (count === 2) assert.equal(url.searchParams.get('after_id'), 'claude-a');
    return Response.json({ data: [{ id: count === 1 ? 'claude-a' : 'claude-b' }], has_more: count === 1, last_id: 'claude-a' });
  } });
  assert.deepEqual(result.models, ['claude-a', 'claude-b']);
  await assert.rejects(discoverModels('openai', { env: { OPENAI_API_KEY: 'fixture' }, fetchImpl: async () => Response.json({ error: 'secret-value' }, { status: 401 }) }), /HTTP 401/);
  await assert.rejects(discoverModels('openai', { env: { OPENAI_API_KEY: 'fixture' }, fetchImpl: async () => { throw new Error('secret-value'); } }), /Could not load models/);
  await assert.rejects(discoverModels('https://attacker.invalid'), /Unknown provider/);
  await assert.rejects(discoverModels('openai', { env: { OPENAI_API_KEY: 'your-openai-key' } }), /Set a real/);
  assert.equal(isAgentModel('gpt-5-codex'), false);
  assert.equal(isAgentModel('gpt-4.1'), true);
  assert.equal(isAgentModel('qwen2.5-72b-instruct'), true);
  assert.equal(isAgentModel('gpt-3.5-turbo-instruct'), false);
  assert.equal(isAgentModel('qwen3.5-27b', 'qwen'), false);
  assert.equal(isAgentModel('qwen-plus', 'qwen'), true);
});

test('selection preserves config and unrelated routes; runtime resolves the selected environment key', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-provider-picker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = structuredClone(defaultConfig);
  config.providers.local = { kind: 'demo', model: 'offline-script' };
  config.routes.default = 'local';
  const env = { OPENAI_API_KEY: 'fixture-secret' };
  const selected = applyProviderSelection(config, { provider: 'openai', model: 'gpt-4.1', route: 'coder' }, env);
  validateConfig(selected);
  assert.equal(config.routes.coder, undefined);
  assert.equal(selected.routes.default, 'local');
  const repeated = applyProviderSelection(selected, { provider: 'openai', model: 'gpt-4.1', route: 'coder' }, env);
  assert.deepEqual(repeated, selected, 'identical saves should not accumulate profiles');
  const shared = applyProviderSelection(selected, { provider: 'openai', model: 'gpt-4.1', route: 'reviewer' }, env);
  assert.equal(shared.routes.reviewer, selected.routes.coder);
  assert.deepEqual(selected.mcp, config.mcp);
  assert.ok(!JSON.stringify(selected).includes('fixture-secret'));
  const again = applyProviderSelection(selected, { provider: 'openai', model: 'gpt-4.1-mini', route: 'default' }, env);
  assert.equal(again.routes.coder, selected.routes.coder);
  await saveConfig(root, again);
  const provider = await routeProvider(root, { name: 'coder' }, { env });
  assert.equal(provider.model, 'gpt-4.1');
  assert.equal(provider.options.tokenLimitField, 'max_completion_tokens');
  assert.deepEqual(provider.sensitiveValues, ['fixture-secret']);
});

test('dashboard discovery and selection require authentication and persist no credentials', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-provider-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'fixture-private-key';
  t.after(() => { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; });
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const origin = new URL(app.url).origin;
  assert.equal((await fetch(`${origin}/api/providers`)).status, 401);
  const headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
  const discovery = await (await fetch(`${origin}/api/providers`, { headers })).text();
  assert.ok(!discovery.includes('fixture-private-key'));
  const result = await fetch(`${origin}/api/providers/select`, { method: 'POST', headers, body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat' }) });
  assert.equal(result.status, 200);
  const config = await loadConfig(root);
  assert.equal(config.providers[config.routes.default].keyEnv, 'DEEPSEEK_API_KEY');
  assert.ok(!JSON.stringify(config).includes('fixture-private-key'));
});
