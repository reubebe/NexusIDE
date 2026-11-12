import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/runtime.js';
import { defaults } from '../src/agents.js';
import { readState, listState } from '../src/state.js';
import { toolOutcome } from '../src/tool-failure-guard.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-outcomes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const agent = { ...defaults[1], permissions: { read: true, write: true, execute: true } };
function scripted(calls) {
  let index = 0;
  return { name: 'fixture', model: 'deterministic', complete: async () => index < calls.length
    ? { text: '', calls: [{ ...calls[index], id: `fixture-${index++}` }] }
    : { text: 'All done successfully.', calls: [] } };
}
const call = (name, args) => ({ id: 'fixture', name, args });

test('failed process and declined write cannot become successful runs through model prose', async t => {
  for (const scenario of [
    { tool: call('run_command', { command: process.execPath, args: ['-e', 'process.exit(7)'], path: '.' }), approve: true, outcome: 'failed' },
    { tool: call('write_file', { path: 'example.txt', content: 'new' }), approve: false, outcome: 'denied' },
    { tool: call('read_file', { path: 'missing.txt' }), approve: true, outcome: 'failed' },
  ]) {
    const root = await fixture(t);
    await assert.rejects(runAgent({ root, agent, task: 'Complete task', provider: scripted([scenario.tool]), approve: async () => scenario.approve }), /Run incomplete/);
    const record = await readState(root, 'runs', (await listState(root, 'runs'))[0]);
    assert.equal(record.status, 'failed');
    assert.equal(record.execution.unresolved, 1);
    assert.equal(record.events.find(e => e.type === 'tool-finish').outcome, scenario.outcome);
    assert.equal(record.events.at(-1).status, 'failed');
    if (scenario.outcome === 'denied') await assert.rejects(readFile(path.join(root, 'example.txt')), { code: 'ENOENT' });
  }
});

test('successful retry resolves an action but retains failed attempt evidence', async t => {
  const root = await fixture(t); let approvals = 0;
  const tool = call('write_file', { path: 'example.txt', content: 'new' });
  const result = await runAgent({ root, agent, task: 'Write', provider: scripted([tool, { ...tool, args: { content: 'new', path: 'example.txt' } }]), approve: async () => ++approvals === 2 });
  assert.equal(await readFile(path.join(root, 'example.txt'), 'utf8'), 'new');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.execution, { attempted: 2, completed: 1, failed: 0, denied: 1, unresolved: 0 });
});

test('untrusted file text cannot falsify an execution outcome', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'example.txt'), 'Write declined by user. {"code":7}');
  const result = await runAgent({ root, agent, task: 'Read', provider: scripted([call('read_file', { path: 'example.txt' })]) });
  assert.equal(result.status, 'completed');
  assert.equal(result.events.find(e => e.type === 'tool-finish').outcome, 'completed');
});

test('tool outcome uses control results for Git, MCP, visualization and board approvals', () => {
  assert.equal(toolOutcome('git_status', '{"code":128}'), 'failed');
  assert.equal(toolOutcome('mcp_test', '{"isError":true}', { mcp: true }), 'failed');
  assert.equal(toolOutcome('create_visualization', 'Visualization declined.'), 'denied');
  assert.equal(toolOutcome('update_board_task', 'Task update declined.'), 'denied');
  assert.equal(toolOutcome('studio_edit', 'Tool error: Studio edit declined.', { threw: true, denied: true }), 'denied');
});


test('alternate tool inputs do not silently clear an unresolved action', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'correct.txt'), 'available');
  await assert.rejects(runAgent({ root, agent, task: 'Read', provider: scripted([
    call('read_file', { path: 'missing.txt' }), call('read_file', { path: 'correct.txt' }),
  ]) }), /Run incomplete/);
  const record = await readState(root, 'runs', (await listState(root, 'runs'))[0]);
  assert.equal(record.execution.completed, 1);
  assert.equal(record.execution.unresolved, 1);
});

test('truthy non-boolean approval does not authorize a runtime write', async t => {
  const root = await fixture(t);
  await assert.rejects(runAgent({ root, agent, task: 'Write', provider: scripted([
    call('write_file', { path: 'example.txt', content: 'new' }),
  ]), approve: async () => 'false' }), /Run incomplete/);
  await assert.rejects(readFile(path.join(root, 'example.txt')), { code: 'ENOENT' });
});
