import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeWorkspace } from '../src/workspace-init.js';
import { loadAgent } from '../src/agents.js';
import { readState, writeState } from '../src/state.js';
import { runWorkflow } from '../src/workflows.js';
import { availableTools, executeTool } from '../src/tools.js';
import { startServer } from '../src/server.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-advanced-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('library upgrade preserves custom agents and teams and resolves every workflow role', async t => {
  const root = await fixture(t);
  await initializeWorkspace(root);
  const custom = { ...(await loadAgent(root, 'learning-tutor')), instructions: 'User custom instruction', permissions: { read: true, write: false, execute: false } };
  await writeState(root, 'agents', 'learning-tutor.json', custom);
  const customTeam = { version: 1, name: 'evidence-learning', steps: [{ id: 'custom', agent: 'architect', task: 'User task' }] };
  await writeState(root, 'teams', 'evidence-learning.json', customTeam);
  const result = await initializeWorkspace(root);
  assert.deepEqual(result.created, []); assert.deepEqual(result.teams.created, []);
  assert.deepEqual(await loadAgent(root, 'learning-tutor'), custom);
  assert.deepEqual(await readState(root, 'teams', 'evidence-learning.json'), customTeam);
  for (const name of ['evidence-learning', 'ontology-review', 'evidence-review']) {
    const team = await readState(root, 'teams', name + '.json');
    for (const step of team.steps) assert.ok(await loadAgent(root, step.agent));
  }
});
test('three bundled workflows complete offline with persisted stage handoffs (synthetic, not AI quality)', async t => {
  const root = await fixture(t); await initializeWorkspace(root);
  await writeFile(path.join(root, 'notes.txt'), 'Synthetic source: one plus one is two.');
  for (const name of ['evidence-learning', 'ontology-review', 'evidence-review']) {
    const workflow = await readState(root, 'teams', name + '.json');
    const result = await runWorkflow({ root, workflow, task: 'Inspect notes.txt', demo: true });
    assert.equal(result.status, 'completed');
    assert.equal(Object.keys(result.steps).length, workflow.steps.length);
    for (const step of Object.values(result.steps)) {
      assert.equal(step.status, 'completed');
      assert.equal((await readState(root, 'runs', step.run + '.json')).status, 'completed');
    }
  }
});
test('media tool requires write and execution, respects sandbox mode and denied approval', async t => {
  const root = await fixture(t); await initializeWorkspace(root);
  const agent = await loadAgent(root, 'video-evidence-reviewer');
  for (const permissions of [{read:true,write:false,execute:true},{read:true,write:true,execute:false}]) {
    assert.ok(!availableTools({ ...agent, permissions }).some(x => x.name === 'preview_media_edit'));
    await assert.rejects(executeTool(root, { ...agent, permissions }, 'preview_media_edit', {}, async () => true), /Permission denied/);
  }
  for (const name of ['change-verifier', 'security-analyst']) assert.ok(availableTools(await loadAgent(root, name)).every(x => !['run_command', 'write_file', 'preview_media_edit', 'create_visualization'].includes(x.name)));
  await assert.rejects(executeTool(root, agent, 'preview_media_edit', {}, async () => true, { commandMode: 'container' }), /host command mode/);
  await writeFile(path.join(root, 'clip.mp4'), 'synthetic invalid media');
  const plan = { version:1, title:'declined', clips:[{path:'clip.mp4',start:0,end:1}] };
  let approvals = 0;
  await assert.rejects(executeTool(root, agent, 'preview_media_edit', {plan}, async request => { approvals++; assert.equal(request.network, false); return false; }), /declined/);
  assert.equal(approvals, 1);
  assert.ok(!(await readdir(root)).includes('nexus-visual-output'));
});
test('authenticated library endpoint installs missing definitions idempotently', async t => {
  const root = await fixture(t);
  const app = await startServer({ root, port: 0, accountHome: root });
  t.after(() => app.close());
  const url = new URL(app.url), token = url.hash.slice(1); url.hash = ''; url.pathname = '/api/agent-library';
  assert.equal((await fetch(url, {method:'POST'})).status, 401);
  const request = () => fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token } });
  const first = await request(); assert.equal(first.status, 200);
  assert.equal((await first.json()).created.length, 35);
  const second = await request(); assert.equal(second.status, 200); assert.deepEqual((await second.json()).created, []);
});
