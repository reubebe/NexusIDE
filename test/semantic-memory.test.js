import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rebuildMemoryIndex, semanticRecall, validateEmbedding } from '../src/semantic-memory.js';
import { remember, forget } from '../src/memory.js';
import { saveConfig, defaultConfig } from '../src/config.js';
import { writeState } from '../src/state.js';

test('semantic retrieval excludes other agents, deleted notes and changed notes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-semantic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let invalid = false;
  const server = http.createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    const request = JSON.parse(input);
    assert.equal(request.truncate, false);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embeddings: request.input.map(text => invalid ? [0, 0] : text.includes('visual') || text.includes('interface') ? [1, 0] : [0, 1]) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { ...structuredClone(defaultConfig), embeddings: { model: 'fixture', url: `http://127.0.0.1:${server.address().port}/api/embed` } };
  await saveConfig(root, config);
  const project = await remember(root, { text: 'visual style' });
  await remember(root, { text: 'private visual plan', scope: 'agent', agent: 'architect' });
  const own = await remember(root, { text: 'implementation detail', scope: 'agent', agent: 'coder' });
  assert.equal((await rebuildMemoryIndex(root)).indexed, 3);
  const found = await semanticRecall(root, 'interface', 'coder');
  assert.equal(found.matches[0].id, project.id);
  assert.equal(found.matches.length, 2);
  assert.ok(found.matches.every(n => n.scope === 'project' || n.agent === 'coder'));
  await forget(root, project.id);
  await writeState(root, 'memory', own.id + '.json', { ...own, text: 'changed note' });
  const stale = await semanticRecall(root, 'interface', 'coder');
  assert.equal(stale.matches.length, 0);
  assert.equal(stale.stale, 1);
  invalid = true;
  await assert.rejects(rebuildMemoryIndex(root), /vector norm/);
  config.embeddings.model = 'new-model'; await saveConfig(root, config);
  await assert.rejects(semanticRecall(root, 'interface', 'coder'), /Rebuild/);
});

test('embedding configuration refuses remote services and embedded credentials', () => {
  for (const url of ['https://example.com/api/embed', 'http://127.0.0.1/api/embed?secret=x', 'http://user:pass@localhost/api/embed', 'http://localhost/other']) assert.throws(() => validateEmbedding({ model: 'fixture', url }));
});


test('runtime semantic search needs memory grant and approval before embedding a query', async t => {
  const { runAgent } = await import('../src/runtime.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-semantic-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = [];
  const server = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const { input } = JSON.parse(data); inputs.push(...input);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embeddings: input.map(() => [1, 0]) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await saveConfig(root, { ...structuredClone(defaultConfig), embeddings: { model: 'fixture', url: `http://127.0.0.1:${server.address().port}/api/embed` } });
  await remember(root, { text: 'shared architecture' });
  await remember(root, { text: 'own plan', scope: 'agent', agent: 'reviewer' });
  await remember(root, { text: 'other private plan', scope: 'agent', agent: 'architect' });
  await rebuildMemoryIndex(root); inputs.length = 0;
  for (const [memory, allow] of [[false, true], [true, false], [true, true]]) {
    let calls = 0, approvals = 0;
    const agent = { version: 1, name: 'reviewer', instructions: 'Review', permissions: { read: true, write: false }, memory };
    const provider = { name: 'fixture', model: 'fixture', complete: async (messages, tools) => {
      assert.equal(tools.some(t => t.name === 'search_memory_semantic'), memory);
      return calls++ === 0 ? { text: '', calls: [{ id: 'search', name: 'search_memory_semantic', args: { query: 'semantic request' } }] } : { text: 'Done', calls: [] };
    } };
    const record = await runAgent({ root, agent, task: 'inspect', provider, approve: async request => {
      approvals++; assert.equal(request.type, 'semantic-memory'); assert.equal(request.agent, 'reviewer'); return allow;
    } });
    const result = record.messages.find(m => m.role === 'tool').content;
    assert.equal(approvals, memory ? 1 : 0);
    if (memory && allow) {
      assert.equal(JSON.parse(result).matches.length, 2);
      assert.equal(result.includes('other private plan'), false);
    } else assert.equal(inputs.length, 0);
    assert.ok(record.events.some(e => e.type === 'approval') === memory);
  }
  assert.deepEqual(inputs, ['semantic request']);
});
