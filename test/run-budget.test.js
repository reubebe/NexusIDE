import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunBudget } from '../src/run-budget.js';
import { runAgent } from '../src/runtime.js';
import { defaults, installAgent } from '../src/agents.js';
import { saveConfig, defaultConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { availableTools, executeTool } from '../src/tools.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('later agents share the original deadline and unknown failed usage blocks further requests', async t => {
  const root = await fixture(t), budget = createRunBudget({ maxTokens: 100, maxDurationMs: 1000 });
  const agent = { ...defaults[0], memory: false, permissions: { read: true, write: false, execute: false } };
  let calls = 0;
  const provider = { name: 'fixture', model: 'fixture', async complete(messages, tools, { signal }) {
    calls++;
    if (calls === 1) { await new Promise(resolve => setTimeout(resolve, 550)); return { text: 'first', calls: [], usage: { input: 1, output: 1 } }; }
    return new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Fixture outlived deadline')), 2000); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
  } };
  await runAgent({ root, agent, task: 'first', provider, requestBudget: budget });
  await assert.rejects(runAgent({ root, agent, task: 'second', provider, requestBudget: budget }), /timeout|aborted/i);
  assert.equal(calls, 2); assert.equal(budget.snapshot().reported, false);
  const failed = createRunBudget({ maxTokens: 100 });
  await assert.rejects(runAgent({ root, agent, task: 'failure', provider: { ...provider, complete: async () => { throw new Error('transport'); } }, requestBudget: failed }), /transport/);
  assert.equal(failed.snapshot().reported, false);
  assert.throws(() => failed.reserve(), /unknown/);
});

test('dashboard deadline removes pending approval and never writes the declined file', async t => {
  const root = await fixture(t); await installAgent(root, defaults[1]);
  const model = http.createServer((req, res) => {
    req.resume(); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'write', function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'should not write' }) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => model.close(resolve)));
  await saveConfig(root, { ...structuredClone(defaultConfig), providers: { fixture: { kind: 'compatible', model: 'fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1` } }, routes: { default: 'fixture' }, limits: { ...defaultConfig.limits, maxDurationMs: 1000 } });
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const api = (name, data) => fetch(new URL(app.url).origin + '/api/' + name, { method: data ? 'POST' : 'GET', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.equal((await api('run', { agent: 'coder', task: 'write fixture' })).status, 202);
  let state, sawApproval = false;
  for (let i = 0; i < 70; i++) { state = await (await api('state')).json(); sawApproval ||= state.approvals.length > 0; if (state.jobs[0]?.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(sawApproval, true); assert.equal(state.approvals.length, 0); assert.notEqual(state.jobs[0].status, 'running');
  await assert.rejects(readFile(path.join(root, 'blocked.txt')), { code: 'ENOENT' });
});

test('motion tools require both write and execute grants and reject container mode', async () => {
  for (const permissions of [{ read: true }, { write: true }, { execute: true }]) assert.ok(!availableTools({ permissions }).some(t => t.name === 'render_animation' || t.name === 'export_video_comparison'));
  const agent = { permissions: { write: true, execute: true } };
  for (const name of ['render_animation', 'export_video_comparison']) await assert.rejects(executeTool('.', agent, name, {}, async () => true, { commandMode: 'docker' }), /host command mode/);
});
