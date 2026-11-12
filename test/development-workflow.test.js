import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installAgent, defaults } from '../src/agents.js';
import { saveConfig } from '../src/config.js';
import { runWorkflow } from '../src/workflows.js';
import { runProcess } from '../src/process.js';
import { listState, readState } from '../src/state.js';

// Scripted loopback inference verifies orchestration, not real-model ability.
// Acceptance assertions are authored here, outside the model response script.
const original = 'exports.add = (a, b) => a - b;\n';
const corrected = 'exports.add = (a, b) => a + b;\n';
const acceptance = `const test = require('node:test');
const assert = require('node:assert/strict');
const { add } = require('./arithmetic.cjs');
for (const [a, b, expected] of [[2, 3, 5], [-2, -3, -5], [0, 7, 7], [0.5, 0.25, 0.75], [10, -3, 7]]) {
  test('add ' + a + ' and ' + b, () => assert.equal(add(a, b), expected));
}
`;
const hash = value => createHash('sha256').update(value).digest('hex');
const team = { version: 1, name: 'development-benchmark', steps: [
  { id: 'build', agent: 'coder', task: 'Inspect and fix addition in arithmetic.cjs. Preserve acceptance.cjs.', approval: true },
  { id: 'test', agent: 'tester', task: 'Run the existing acceptance.cjs tests and report the actual result.', dependsOn: ['build'] },
  { id: 'review', agent: 'reviewer', task: 'Inspect the source and diff against the builder and test reports.', dependsOn: ['build', 'test'] },
] };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-development-benchmark-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'arithmetic.cjs'), original);
  await writeFile(path.join(root, 'acceptance.cjs'), acceptance, { mode: 0o444 });
  const git = async args => {
    const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Nexus Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root });
    assert.equal(result.code, 0, result.output);
  };
  await git(['init']); await git(['add', 'arithmetic.cjs', 'acceptance.cjs']); await git(['commit', '-m', 'failing acceptance fixture']);
  for (const agent of defaults.filter(a => ['coder', 'reviewer'].includes(a.name))) await installAgent(root, agent);
  await installAgent(root, { version: 1, name: 'tester', instructions: 'Run existing tests only; never modify test files.', permissions: { read: true, write: false, execute: true } });
  const requests = [], failures = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), results = body.messages.filter(m => m.role === 'tool');
      requests.push(body.model);
      let calls = [], content = '';
      const call = (name, args) => ({ id: `${body.model}-${results.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      if (body.model === 'coder-fixture') {
        if (!results.length) calls = [call('read_file', { path: 'arithmetic.cjs' })];
        else if (results.length === 1) {
          assert.equal(results[0].content, original);
          calls = [call('write_file', { path: 'arithmetic.cjs', content: corrected })];
        } else content = 'Builder reports arithmetic.cjs changed; independent tests are still required.';
      } else if (body.model === 'tester-fixture') {
        assert.match(body.messages.find(m => m.role === 'user').content, /Builder reports arithmetic.cjs changed/);
        if (!results.length) calls = [call('run_command', { command: process.execPath, args: ['--test', 'acceptance.cjs'], path: '.' })];
        else {
          const actual = JSON.parse(results[0].content);
          assert.equal(actual.code, 0, actual.output); assert.equal(actual.stopped, null);
          assert.match(actual.output, /# pass 5/);
          content = 'Tester observed acceptance.cjs exit 0, five passing tests.';
        }
      } else if (body.model === 'reviewer-fixture') {
        const handoff = body.messages.find(m => m.role === 'user').content;
        assert.match(handoff, /Builder reports arithmetic.cjs changed/);
        assert.match(handoff, /Tester observed acceptance.cjs exit 0/);
        if (!results.length) calls = [call('read_file', { path: 'arithmetic.cjs' })];
        else if (results.length === 1) calls = [call('git_diff', {})];
        else {
          assert.equal(results[0].content, corrected);
          const diff = JSON.parse(results[1].content);
          assert.equal(diff.code, 0); assert.match(diff.output, /a \+ b/); assert.doesNotMatch(diff.output, /diff --git a\/acceptance/);
          content = 'Reviewer inspected arithmetic.cjs and the tracked diff; only the intended addition expression changed.';
        }
      } else throw new Error('Unexpected model route');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, tool_calls: calls }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } catch (error) { failures.push(error); res.writeHead(500); res.end('Fixture assertion failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await saveConfig(root, { version: 1, providers: Object.fromEntries(['coder', 'tester', 'reviewer'].map(name => [name, { kind: 'compatible', model: `${name}-fixture`, baseUrl }])), routes: { coder: 'coder', tester: 'tester', reviewer: 'reviewer' }, mcp: {} });
  return { root, requests, failures };
}

test('deterministic development benchmark fixes a bug, executes immutable acceptance tests and reviews handoffs', async t => {
  const { root, requests, failures } = await fixture(t), approvals = [];
  const before = await runProcess(process.execPath, ['--test', 'acceptance.cjs'], { cwd: root });
  assert.notEqual(before.code, 0); assert.match(before.output, /# fail 5/);
  const result = await runWorkflow({ root, workflow: team, task: 'Repair addition and validate the existing test suite.', allowCommands: true, approve: async request => {
    approvals.push(request.type || 'write');
    if (request.type === 'workflow') return request.step === 'build';
    if (request.type === 'command') return request.command === process.execPath && JSON.stringify(request.args) === JSON.stringify(['--test', 'acceptance.cjs']);
    return request.path === 'arithmetic.cjs' && request.before === original && request.after === corrected;
  } });
  assert.deepEqual(failures, []);
  assert.equal(result.status, 'completed');
  assert.deepEqual(Object.values(result.steps).map(s => s.status), ['completed', 'completed', 'completed']);
  assert.deepEqual(approvals, ['workflow', 'write', 'command']);
  assert.deepEqual(requests, ['coder-fixture', 'coder-fixture', 'coder-fixture', 'tester-fixture', 'tester-fixture', 'reviewer-fixture', 'reviewer-fixture', 'reviewer-fixture']);
  assert.equal(await readFile(path.join(root, 'arithmetic.cjs'), 'utf8'), corrected);
  assert.equal(hash(await readFile(path.join(root, 'acceptance.cjs'))), hash(acceptance));
  const verified = await runProcess(process.execPath, ['--test', 'acceptance.cjs'], { cwd: root });
  assert.equal(verified.code, 0, verified.output); assert.match(verified.output, /# pass 5/);
  const tester = await readState(root, 'runs', `${result.steps.test.run}.json`);
  assert.equal(JSON.parse(tester.messages.find(m => m.role === 'tool').content).code, 0);
  assert.deepEqual(await listState(root, 'locks'), []);
});

test('declined benchmark write cannot be completed by model prose or start dependent stages', async t => {
  const { root, requests, failures } = await fixture(t);
  await assert.rejects(runWorkflow({ root, workflow: team, task: 'Repair addition.', allowCommands: true, approve: async request => request.type === 'workflow' }), /failed or declined/);
  assert.deepEqual(failures, []);
  assert.deepEqual(requests, ['coder-fixture', 'coder-fixture', 'coder-fixture']);
  const record = await readState(root, 'workflows', (await listState(root, 'workflows'))[0]);
  assert.equal(record.status, 'failed'); assert.equal(record.steps.build.status, 'failed');
  assert.equal(Object.hasOwn(record.steps, 'test'), false); assert.equal(Object.hasOwn(record.steps, 'review'), false);
  assert.equal(await readFile(path.join(root, 'arithmetic.cjs'), 'utf8'), original);
  assert.equal(hash(await readFile(path.join(root, 'acceptance.cjs'))), hash(acceptance));
  assert.deepEqual(await listState(root, 'locks'), []);
});
