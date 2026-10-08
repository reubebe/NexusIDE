import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaults, installAgent, loadAgent, validateAgent } from '../src/agents.js';
import { executeTool, resolveProjectPath } from '../src/tools.js';
import { createProvider } from '../src/providers.js';
import { runAgent } from '../src/runtime.js';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('agent import rejects unsupported fields and preserves existing agents', async t => {
  const root = await workspace(t);
  await installAgent(root, defaults[0]);
  await assert.rejects(installAgent(root, defaults[0]), { code: 'EEXIST' });
  assert.deepEqual(await loadAgent(root, 'architect'), defaults[0]);
  assert.throws(() => validateAgent({ ...defaults[0], hooks: ['shell'] }), /Unsupported/);
});
test('file tools block traversal, protected paths, and symlinks', async t => {
  const root = await workspace(t);
  await symlink(os.tmpdir(), path.join(root, 'outside'));
  for (const file of ['../secret', '.env', '.git/config', '.nexus/runs/log', 'outside/file']) {
    await assert.rejects(resolveProjectPath(root, file));
  }
  await assert.rejects(executeTool(root, defaults[0], 'write_file', { path: 'x', content: 'x' }, async () => true), /Permission denied/);
});
test('writes require approval and detect concurrent edits', async t => {
  const root = await workspace(t);
  const file = path.join(root, 'a.txt');
  await writeFile(file, 'original');
  const args = { path: 'a.txt', content: 'new' };
  await executeTool(root, defaults[1], 'write_file', args, async () => false);
  assert.equal(await readFile(file, 'utf8'), 'original');
  await assert.rejects(executeTool(root, defaults[1], 'write_file', args, async () => { await writeFile(file, 'user edit'); return true; }), /changed during approval/);
  await executeTool(root, defaults[1], 'write_file', args, async () => true);
  assert.equal(await readFile(file, 'utf8'), 'new');
});
test('demo completes a tool cycle and persists history', async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'README.md'), 'hello');
  const record = await runAgent({ root, agent: defaults[0], task: 'inspect', provider: createProvider({ NEXUS_PROVIDER: 'demo' }) });
  assert.equal(record.status, 'completed');
  assert.match(record.messages.at(-1).content, /README.md/);
  const saved = JSON.parse(await readFile(path.join(root, '.nexus', 'runs', `${record.id}.json`)));
  assert.equal(saved.status, 'completed');
});
test('failed provider calls persist failure state', async t => {
  const root = await workspace(t);
  await assert.rejects(runAgent({ root, agent: defaults[0], task: 'inspect', provider: { name: 'fake', model: 'test', complete: async () => { throw new Error('offline'); } } }), /offline/);
  const dir = path.join(root, '.nexus', 'runs');
  const saved = JSON.parse(await readFile(path.join(dir, (await readdir(dir))[0])));
  assert.equal(saved.status, 'failed');
});
test('provider adapters serialize tool results and parse tool requests', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const kind of ['compatible', 'anthropic']) {
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test-model');
      assert.equal(body.messages.at(-1).role, kind === 'anthropic' ? 'user' : 'tool');
      assert.match(url, kind === 'anthropic' ? /messages$/ : /chat\/completions$/);
      return Response.json(kind === 'anthropic' ? { content: [{ type: 'tool_use', id: '2', name: 'read_file', input: { path: 'README.md' } }] } : { choices: [{ message: { tool_calls: [{ id: '2', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }] });
    };
    const provider = createProvider({ NEXUS_PROVIDER: kind, NEXUS_MODEL: 'test-model', NEXUS_API_KEY: 'fake' });
    const reply = await provider.complete([{ role: 'system', content: 'instructions' }, { role: 'user', content: 'inspect' }, { role: 'assistant', content: '', calls: [{ id: '1', name: 'list_files', args: { path: '.' } }] }, { role: 'tool', id: '1', content: 'README.md' }], []);
    assert.equal(reply.calls[0].args.path, 'README.md');
  }
});

test('runtime persists model waiting status before the provider responds', async t => {
  const root = await workspace(t);
  let request;
  const record = await runAgent({ root, agent: defaults[0], task: 'inspect',
    onEvent: event => { if (event.type === 'model-request') request = event; },
    provider: { name: 'fixture', model: 'waiting-model', complete: async () => {
      assert.equal(request.model, 'waiting-model');
      const files = await readdir(path.join(root, '.nexus/runs'));
      const saved = JSON.parse(await readFile(path.join(root, '.nexus/runs', files[0]), 'utf8'));
      assert.equal(saved.status, 'running');
      assert.equal(saved.events.at(-1).type, 'model-request');
      return { text: 'Done', calls: [] };
    } }
  });
  assert.equal(record.status, 'completed');
  assert.deepEqual(record.events.filter(e => e.type.startsWith('model-')).map(e => e.type), ['model-request', 'model-response']);
});
