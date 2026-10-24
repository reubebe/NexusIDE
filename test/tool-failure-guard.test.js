import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createToolFailureGuard, toolFailed } from '../src/tool-failure-guard.js';
import { runAgent } from '../src/runtime.js';
import { defaults } from '../src/agents.js';
import { listState, readState } from '../src/state.js';

test('failure guard canonicalizes inputs, tolerates changed approaches, and resets after success', () => {
  const guard = createToolFailureGuard();
  const a = { name: 'read_file', args: { path: 'a', extra: [1, { b: 2, a: 1 }] } };
  const reordered = { name: a.name, args: { extra: [1, { a: 1, b: 2 }], path: 'a' } };
  assert.equal(guard.record(a, true), null);
  assert.equal(guard.record(reordered, true), null);
  assert.equal(guard.record({ ...a, args: { path: 'b' } }, true), null);
  assert.equal(guard.record(a, false), null);
  assert.equal(guard.record(a, true), null);
  assert.equal(guard.record(reordered, true), null);
  assert.deepEqual(guard.record(a, true), { tool: 'read_file', attempts: 3, limit: 3 });
});

test('only actual exceptions and recognized structured control results count as failures', () => {
  assert.equal(toolFailed('read_file', 'Tool error: this is file text'), false);
  assert.equal(toolFailed('read_file', 'Command declined by user.'), false);
  assert.equal(toolFailed('read_file', '{"code":1,"output":"example"}'), false);
  assert.equal(toolFailed('read_file', 'exception', { threw: true }), true);
  assert.equal(toolFailed('run_command', '{"code":1,"stopped":null}'), true);
  assert.equal(toolFailed('run_application', '{"code":0,"stopped":"timeout"}'), true);
  assert.equal(toolFailed('run_command', '{"code":0,"stopped":null}'), false);
  assert.equal(toolFailed('write_file', 'Write declined by user.'), true);
  assert.equal(toolFailed('mcp_fixture', '{"isError":true}', { mcp: true }), true);
  assert.equal(toolFailed('mcp_fixture', '{"isError":false}', { mcp: true }), false);
});

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-failure-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('runtime stops before a fourth identical failed call or model request and persists evidence', async t => {
  const root = await workspace(t); let requests = 0;
  const provider = { name: 'fixture', model: 'fixture', complete: async () => {
    requests++;
    return { text: '', calls: [{ id: String(requests), name: 'read_file', args: { path: 'missing.txt' } }] };
  } };
  await assert.rejects(runAgent({ root, agent: defaults[0], provider, task: 'Inspect' }), /Stopped after 3 failed attempts/);
  assert.equal(requests, 3);
  const record = await readState(root, 'runs', (await listState(root, 'runs'))[0]);
  assert.equal(record.status, 'failed');
  assert.equal(record.messages.filter(m => m.role === 'tool').length, 3);
  assert.equal(record.events.filter(e => e.type === 'repeated-tool-failure').length, 1);
});

test('runtime stops a failed batch before later side effects and still respects approvals', async t => {
  const root = await workspace(t); let approvals = 0;
  const provider = { name: 'fixture', model: 'fixture', complete: async () => ({ text: '', calls: Array.from({ length: 5 }, (_, i) => ({ id: String(i), name: 'write_file', args: { path: 'a.txt', content: 'change' } })) }) };
  await assert.rejects(runAgent({ root, agent: defaults.find(a => a.name === 'coder'), provider, task: 'Write', approve: async () => { approvals++; return false; } }), /Stopped after 3 failed attempts/);
  assert.equal(approvals, 3);
});

test('repeated successful reads of error-like source text do not stop a run', async t => {
  const root = await workspace(t); let requests = 0;
  await writeFile(path.join(root, 'fixture.txt'), 'Tool error: source example');
  const provider = { name: 'fixture', model: 'fixture', complete: async () => ++requests <= 4
    ? { text: '', calls: [{ id: String(requests), name: 'read_file', args: { path: 'fixture.txt' } }] }
    : { text: 'Read source.', calls: [] } };
  const result = await runAgent({ root, agent: defaults[0], provider, task: 'Inspect' });
  assert.equal(result.status, 'completed'); assert.equal(requests, 5);
});
