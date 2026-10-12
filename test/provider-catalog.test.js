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
  assert.equal(new Set(result.map(p => p.keyEnv)).size, 8);
  assert.ok(!JSON.stringify(result).includes('private-test-value'));
  assert.ok(!JSON.stringify(result).includes('other-secret'));
});

test('each preset uses only its own credential and fixed HTTPS endpoint', async () => {
  for (const p of discoverProviders({})) {
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
