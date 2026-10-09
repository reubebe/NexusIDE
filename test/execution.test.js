import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess, commandEnvironment } from '../src/process.js';
import { createWorktree, resolveWorktree, inspectWorktree } from '../src/worktrees.js';
import { executeTool } from '../src/tools.js';
import { defaults } from '../src/agents.js';
import { runAgent } from '../src/runtime.js';

async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-execution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('command approval and execute permission are mandatory', async t => {
  const root = await temp(t);
  const args = { command: process.execPath, args: ['-e', 'console.log("ran")'], path: '.' };
  await assert.rejects(executeTool(root, defaults[1], 'run_command', args, async () => true), /Permission denied/);
  const agent = { ...defaults[1], permissions: { ...defaults[1].permissions, execute: true } };
  assert.match(await executeTool(root, agent, 'run_command', args, async () => false), /declined/);
  const result = JSON.parse(await executeTool(root, agent, 'run_command', args, async request => { assert.equal(request.type, 'command'); return true; }));
  assert.equal(result.code, 0);
  assert.match(result.output, /ran/);
  assert.equal(commandEnvironment().NEXUS_API_KEY, undefined);
});
test('process execution captures failures and enforces time, output, and cancellation limits', async t => {
  const cwd = await temp(t);
  const failed = await runProcess(process.execPath, ['-e', 'process.exit(7)'], { cwd });
  assert.equal(failed.code, 7);
  const timeout = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, timeoutMs: 100 });
  assert.equal(timeout.stopped, 'timeout');
  const large = await runProcess(process.execPath, ['-e', 'console.log("x".repeat(10000))'], { cwd, maxBytes: 100 });
  assert.equal(large.stopped, 'output-limit');
  assert.ok(Buffer.byteLength(large.output) <= 100);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).stopped, 'cancelled');
});
test('worktrees isolate changes and report tracked and new files', async t => {
  const root = await temp(t);
  const git = async args => { const r = await runProcess('git', args, { cwd: root }); assert.equal(r.code, 0, r.output); };
  await git(['init']);
  await writeFile(path.join(root, 'app.txt'), 'original\n');
  await writeFile(path.join(root, '.env'), 'ORIGINAL_SECRET=not-in-diff');
  await git(['add', 'app.txt', '.env']);
  await git(['-c', 'user.name=Nexus Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']);
  const workspace = await createWorktree(root, 'task-one');
  assert.equal(await resolveWorktree(root, 'task-one'), workspace);
  await writeFile(path.join(workspace, 'app.txt'), 'agent edit\n');
  await writeFile(path.join(workspace, 'new.txt'), 'new file');
  await writeFile(path.join(workspace, '.env'), 'SECRET=do-not-print');
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'original\n');
  const diff = await inspectWorktree(root, 'task-one');
  assert.match(diff, /agent edit/);
  assert.match(diff, /new.txt/);
  assert.match(diff, /new file/);
  assert.doesNotMatch(diff, /do-not-print/);
  assert.doesNotMatch(diff, /not-in-diff/);
  await assert.rejects(createWorktree(root, 'task-one'));
  await assert.rejects(createWorktree(root, '../escape'));
});
test('runtime cancellation saves a cancelled transcript', async t => {
  const root = await temp(t);
  const controller = new AbortController();
  let runId;
  const provider = { name: 'test', model: 'test', complete: async () => { controller.abort(new Error('cancelled')); return { text: '', calls: [] }; } };
  await assert.rejects(runAgent({ root, agent: defaults[0], task: 'test', provider, signal: controller.signal }), /cancelled/);
  const { listState, readState } = await import('../src/state.js');
  runId = (await listState(root, 'runs'))[0];
  assert.equal((await readState(root, 'runs', runId)).status, 'cancelled');
});
