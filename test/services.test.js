import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { writeState, readState } from '../src/state.js';
import { remember, recall } from '../src/memory.js';
import { importSkill, skillResource } from '../src/skills.js';
import { importMarkdownAgent } from '../src/imports.js';
import { defaults, installAgent } from '../src/agents.js';
import { validateWorkflow, runWorkflow, resumeWorkflow } from '../src/workflows.js';
import { defaultConfig, saveConfig, routeProvider } from '../src/config.js';
import { startServer } from '../src/server.js';
import { dockerArguments } from '../src/sandbox.js';

async function temp(t) { const p = await mkdtemp(path.join(os.tmpdir(), 'nexus-services-')); t.after(() => rm(p, { recursive: true, force: true })); return p; }
test('state storage rejects traversal and symlinks', async t => {
  const root = await temp(t), outside = await temp(t);
  await symlink(outside, path.join(root, '.nexus'));
  await assert.rejects(writeState(root, 'config', 'project.json', {}), /symbolic/);
  await assert.rejects(readState(root, '../config', 'x.json'), /Invalid name/);
});
test('scoped memory does not leak another agent’s notes', async t => {
  const root = await temp(t);
  await remember(root, { text: 'shared architecture' });
  await remember(root, { text: 'private architecture', scope: 'agent', agent: 'architect' });
  assert.equal((await recall(root, 'architecture', 'coder')).length, 1);
  assert.equal((await recall(root, 'architecture', 'architect')).length, 2);
});
test('skill import preserves resources without executing them or granting permissions', async t => {
  const root = await temp(t), skill = path.join(root, 'example'); await mkdir(skill);
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: example\ndescription: Example skill\nallowed-tools: Bash\n---\nRead the reference.');
  await writeFile(path.join(skill, 'script.sh'), 'touch SHOULD_NOT_EXIST');
  const imported = await importSkill(root, skill);
  assert.match(imported.digest, /^[a-f0-9]{64}$/);
  assert.match(await skillResource(root, { skills: ['example'] }, 'example', 'script.sh'), /touch/);
  await assert.rejects(skillResource(root, { skills: [] }, 'example'), /not granted/);
  await assert.rejects(readFile(path.join(root, 'SHOULD_NOT_EXIST')));
});
test('foreign agent import retains text, disables execution, and records compatibility', async t => {
  const root = await temp(t), file = path.join(root, 'agent.md');
  await writeFile(file, '---\nname: Test Agent\ntools: Bash\n---\nExact original instructions.');
  const report = await importMarkdownAgent(root, file);
  assert.equal(report.agent.instructions, 'Exact original instructions.');
  assert.equal(report.agent.permissions.execute, false);
  assert.equal(report.compatibility, 'instructions-only');
});
test('DAG rejects cycles and runs sequential handoffs plus parallel reviews', async t => {
  const root = await temp(t);
  for (const a of defaults) await installAgent(root, a);
  assert.throws(() => validateWorkflow({ version: 1, name: 'bad', steps: [{ id: 'x', agent: 'coder', task: 'task', dependsOn: ['x'] }] }), /cycle/);
  const workflow = { version: 1, name: 'test', steps: [{ id: 'plan', agent: 'architect', task: 'plan' }, { id: 'review-a', agent: 'reviewer', task: 'review', dependsOn: ['plan'] }, { id: 'review-b', agent: 'reviewer', task: 'review', dependsOn: ['plan'] }] };
  const result = await runWorkflow({ root, workflow, task: 'demo task', demo: true });
  assert.equal(result.status, 'completed');
  assert.equal(Object.keys(result.steps).length, 3);
});
test('dashboard denies unauthenticated and cross-origin calls, accepts authenticated demo', async t => {
  const root = await temp(t); await installAgent(root, defaults[0]);
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const origin = new URL(app.url).origin;
  assert.equal((await fetch(origin + '/api/state')).status, 401);
  const headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(origin + '/api/state', { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => { const req = http.get(origin + '/api/state', { headers: { ...headers, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(wrongHost, 403);
  const response = await fetch(origin + '/api/run', { method: 'POST', headers, body: JSON.stringify({ agent: 'architect', task: 'demo', demo: true }) });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  for (let tries = 0; tries < 100; tries++) {
    const state = await (await fetch(origin + '/api/state', { headers })).json();
    const job = state.jobs.find(j => j.id === id);
    if (job.status !== 'running') { assert.equal(job.status, 'completed'); assert.ok(state.runs.length); return; }
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('Demo did not complete');
});
test('provider routes treat prototype names as ordinary user-defined names', async t => {
  const root = await temp(t), agent = { ...defaults[0], name: 'constructor' };
  assert.equal((await routeProvider(root, agent, { env: { NEXUS_PROVIDER: 'demo' } })).name, 'demo');
  await assert.rejects(routeProvider(root, agent, { providerName: 'constructor' }), /Unknown provider profile: constructor/);
  await saveConfig(root, { ...structuredClone(defaultConfig), providers: { constructor: { kind: 'demo', model: 'fixture' } }, routes: { constructor: 'constructor' } });
  assert.equal((await routeProvider(root, agent)).profile, 'constructor');
});
test('workflow executes and resumes valid step names inherited by ordinary objects', async t => {
  const root = await temp(t); await installAgent(root, defaults[0]);
  const workflow = { version: 1, name: 'prototype-steps', steps: [
    { id: 'constructor', agent: 'architect', task: 'Inspect the fixture' },
    { id: 'toString', agent: 'architect', task: 'Review the fixture', dependsOn: ['constructor'], approval: true },
  ] };
  await assert.rejects(runWorkflow({ root, workflow, task: 'Fixture', demo: true, checkpoint: true }), /failed or declined/);
  const { listState } = await import('../src/state.js');
  const previous = await readState(root, 'workflows', (await listState(root, 'workflows'))[0]);
  assert.equal(previous.steps.constructor.status, 'completed');
  let reviewedPending;
  const completed = await resumeWorkflow({ root, id: previous.id, approve: async request => {
    if (request.type === 'workflow-resume') reviewedPending = request.pending;
    return true;
  } });
  assert.deepEqual(reviewedPending, ['toString']);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.steps.constructor.run, previous.steps.constructor.run);
  assert.equal(completed.steps.toString.status, 'completed');
});
test('Docker execution requires digest pinning and disables network and privilege escalation', () => {
  assert.throws(() => dockerArguments('/tmp/project', '/tmp/project', 'node', [], 'node:latest', 'test'), /digest/);
  const args = dockerArguments('/tmp/project', '/tmp/project', 'node', [], 'node@sha256:' + 'a'.repeat(64), 'test');
  for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pull=never']) assert.ok(args.includes(flag));
});

test('planner stores a validated workflow and forces approval for write-capable steps', async t => {
  const root = await temp(t); for (const a of defaults) await installAgent(root, a);
  const { planTask } = await import('../src/planner.js');
  const provider = { name: 'fixture', model: 'test', complete: async () => ({ text: JSON.stringify({ version: 1, name: 'ignored', steps: [{ id: 'build', agent: 'coder', task: 'Implement requested change' }] }), calls: [] }) };
  const result = await planTask({ root, task: 'Build it', provider });
  assert.equal(result.status, 'planned');
  assert.equal(result.workflow.steps[0].approval, true);
  assert.equal((await readState(root, 'teams', result.name + '.json')).steps[0].agent, 'coder');
});
