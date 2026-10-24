import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { saveConfig } from '../src/config.js';
import { runWorkflow, resumeWorkflow } from '../src/workflows.js';
import { projectFingerprint } from '../src/workflow-checkpoints.js';
import { defaults, installAgent } from '../src/agents.js';
import { readState, listState, writeState } from '../src/state.js';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const agent of defaults) await installAgent(root, agent);
  await writeFile(path.join(root, 'README.md'), 'project');
  return root;
}
const workflow = { version: 1, name: 'checkpoint-demo', steps: [{ id: 'plan', agent: 'architect', task: 'inspect' }, { id: 'review', agent: 'reviewer', task: 'review', dependsOn: ['plan'], approval: true }] };
async function stopped(root) {
  await assert.rejects(runWorkflow({ root, workflow, task: 'inspect', demo: true, checkpoint: true }), /failed or declined/);
  return readState(root, 'workflows', (await listState(root, 'workflows'))[0]);
}

test('resume skips completed stages and preserves distinct history with explicit approval', async t => {
  const root = await workspace(t), prior = await stopped(root), approvals = [], events = [];
  assert.equal(prior.steps.plan.status, 'completed');
  assert.equal(prior.steps.review.startedExecution, false);
  const result = await resumeWorkflow({ root, id: prior.id, approve: async r => { approvals.push(r.type); return true; }, onEvent: e => events.push(e) });
  assert.equal(result.status, 'completed'); assert.equal(result.parent, prior.id);
  assert.equal(result.steps.plan.run, prior.steps.plan.run);
  assert.deepEqual(events.filter(e => e.type === 'step-start').map(e => e.step), ['review']);
  assert.deepEqual(approvals, ['workflow-resume', 'workflow']);
  assert.deepEqual(await readState(root, 'workflows', `${prior.id}.json`), prior);
  await assert.rejects(resumeWorkflow({ root, id: prior.id, approve: async () => true }), { code: 'EEXIST' });
});

test('changed source and permission definitions invalidate resume before new model calls', async t => {
  const root = await workspace(t), prior = await stopped(root), count = (await listState(root, 'runs')).length;
  await writeFile(path.join(root, 'README.md'), 'changed');
  await assert.rejects(resumeWorkflow({ root, id: prior.id, approve: async () => true }), /changed/);
  await writeFile(path.join(root, 'README.md'), 'project');
  await writeState(root, 'agents', 'reviewer.json', { ...defaults[2], permissions: { read: true, write: true } });
  await assert.rejects(resumeWorkflow({ root, id: prior.id, approve: async () => true }), /changed/);
  assert.equal((await listState(root, 'runs')).length, count);
});

test('active and legacy runs, refused approvals, uncertain writes and excess continuations are rejected', async t => {
  const root = await workspace(t), prior = await stopped(root);
  await assert.rejects(resumeWorkflow({ root, id: prior.id }), /declined/);
  for (const patch of [{ status: 'running' }, { checkpoint: null }, { resumeDepth: 2 }]) {
    await writeState(root, 'workflows', `${prior.id}.json`, { ...prior, ...patch });
    await assert.rejects(resumeWorkflow({ root, id: prior.id, approve: async () => true }));
  }
  prior.checkpoint.workflow.steps[1].agent = 'coder'; prior.steps.review.startedExecution = true;
  await writeState(root, 'workflows', `${prior.id}.json`, prior);
  await assert.rejects(resumeWorkflow({ root, id: prior.id, approve: async () => true }), /side effects/);
});

test('snapshot detects new files, refuses links and excludes protected credential files', async t => {
  const root = await workspace(t), before = await projectFingerprint(root);
  await writeFile(path.join(root, '.env'), 'private credentials');
  // Entry count is informational; only the digest establishes file content.
  assert.equal((await projectFingerprint(root)).digest, before.digest);
  await writeFile(path.join(root, 'new.txt'), 'new');
  assert.notEqual((await projectFingerprint(root)).digest, before.digest);
  await symlink(path.join(root, 'new.txt'), path.join(root, 'link'));
  await assert.rejects(projectFingerprint(root), /Symbolic links/);
});

test('checkpoint rejects external effects and isolated execution before starting', async t => {
  const root = await workspace(t);
  await assert.rejects(runWorkflow({ root, workflow, task: 'test', demo: true, checkpoint: true, isolated: true }), /does not support/);
  await writeState(root, 'agents', 'architect.json', { ...defaults[0], memory: true });
  await assert.rejects(runWorkflow({ root, workflow, task: 'test', demo: true, checkpoint: true }), /without commands/);
  assert.deepEqual(await listState(root, 'runs'), []);
});


test('a completed approved write survives continuation without executing the builder again', async t => {
  const root = await workspace(t), requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body.model);
    const wrote = body.messages.some(m => m.role === 'tool');
    const calls = body.model === 'builder' && !wrote ? [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'README.md', content: 'approved change' }) } }] : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: calls.length ? '' : 'Observed completion.', tool_calls: calls } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await saveConfig(root, { version: 1, providers: { builder: { kind: 'compatible', model: 'builder', baseUrl }, inspector: { kind: 'compatible', model: 'inspector', baseUrl } }, routes: { coder: 'builder', reviewer: 'inspector' }, mcp: {} });
  const team = { version: 1, name: 'write-checkpoint', steps: [{ id: 'build', agent: 'coder', task: 'write' }, { id: 'inspect', agent: 'reviewer', task: 'inspect', dependsOn: ['build'], approval: true }] };
  await assert.rejects(runWorkflow({ root, workflow: team, task: 'update', checkpoint: true, approve: async r => r.type !== 'workflow' }), /failed or declined/);
  const prior = await readState(root, 'workflows', (await listState(root, 'workflows'))[0]);
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'approved change');
  assert.equal(prior.steps.build.status, 'completed');
  const result = await resumeWorkflow({ root, id: prior.id, approve: async () => true });
  assert.equal(result.status, 'completed');
  assert.deepEqual(requests, ['builder', 'builder', 'inspector']);
});

test('concurrent resume attempts claim a checkpoint only once', async t => {
  const root = await workspace(t), prior = await stopped(root);
  const results = await Promise.allSettled([1, 2].map(() => resumeWorkflow({ root, id: prior.id, approve: async () => true })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'EEXIST');
  assert.equal((await listState(root, 'runs')).length, 2);
});
