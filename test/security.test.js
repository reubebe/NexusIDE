import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setSecret, getSecret } from '../src/vault.js';
import { acquireWorkspace, inspectWorkspaceLocks, removeStaleWorkspaceLock } from '../src/locks.js';
import { writeState } from '../src/state.js';
import { executeTool } from '../src/tools.js';
import { defaults } from '../src/agents.js';
import { saveConfig } from '../src/config.js';
import { searchProject } from '../src/search.js';
async function temp(t) { const p = await mkdtemp(path.join(os.tmpdir(), 'nexus-security-')); t.after(() => rm(p, { recursive: true, force: true })); return p; }
test('vault encrypts values and rejects wrong passwords and modified authentication tags', async t => {
  const root = await temp(t), password = 'test-password-long-enough';
  await setSecret(root, 'provider', 'very-sensitive-api-key', password);
  const file = path.join(root, '.nexus', 'vault', 'provider.json');
  assert.ok(!(await readFile(file, 'utf8')).includes('very-sensitive-api-key'));
  assert.equal(await getSecret(root, 'provider', password), 'very-sensitive-api-key');
  await assert.rejects(getSecret(root, 'provider', 'wrong-password-long-enough'), /Cannot unlock/);
  const data = JSON.parse(await readFile(file)); data.tag = Buffer.alloc(16).toString('base64'); await writeFile(file, JSON.stringify(data));
  await assert.rejects(getSecret(root, 'provider', password), /Cannot unlock/);
});
test('workspace locks prevent competing writers and release cleanly', async t => {
  const root = await temp(t);
  const release = await acquireWorkspace(root, root, 'first');
  await assert.rejects(acquireWorkspace(root, root, 'second'), /Another write-capable/);
  await release();
  await (await acquireWorkspace(root, root, 'third'))();
});
test('stale lock recovery requires a unique dead process and explicit approval', async t => {
  const root = await temp(t);
  const release = await acquireWorkspace(root, root, 'crashed-run');
  const [active] = await inspectWorkspaceLocks(root);
  assert.equal(active.status, 'active');
  await assert.rejects(removeStaleWorkspaceLock(root, active.key.slice(0, 8), async () => true), /only locks whose process is confirmed absent/);
  await writeState(root, 'locks', `${active.key}.json`, { id: 'crashed-run', pid: 2_147_483_647, workspace: active.workspace, started: active.started });
  const [stale] = await inspectWorkspaceLocks(root);
  assert.equal(stale.status, 'stale');
  await assert.rejects(removeStaleWorkspaceLock(root, active.key.slice(0, 8)), /declined/);
  await assert.rejects(removeStaleWorkspaceLock(root, active.key.slice(0, 4), async () => true), /at least 8/);
  const removed = await removeStaleWorkspaceLock(root, active.key, async request => request.type === 'remove-stale-lock');
  assert.equal(removed.runId, 'crashed-run');
  assert.deepEqual(await inspectWorkspaceLocks(root), []);
  await assert.rejects(release(), { code: 'ENOENT' });
});
test('file tools reject hard links and preserve optimistic write checks', async t => {
  const root = await temp(t); await writeFile(path.join(root, 'original'), 'data'); await link(path.join(root, 'original'), path.join(root, 'linked'));
  await assert.rejects(executeTool(root, defaults[0], 'read_file', { path: 'linked' }, async () => true), /singly linked/);
  await assert.rejects(executeTool(root, defaults[1], 'write_file', { path: 'linked', content: 'changed' }, async () => true), /singly linked/);
});
test('configuration rejects plaintext key fields and malformed MCP grants', async t => {
  const root = await temp(t);
  await assert.rejects(saveConfig(root, { version: 1, providers: { p: { kind: 'compatible', model: 'test', apiKey: 'secret' } }, routes: {}, mcp: {} }), /unsupported fields/);
  await assert.rejects(saveConfig(root, { version: 1, providers: {}, routes: {}, mcp: { bad: { command: 'x', args: [], tools: '*'} } }), /Invalid MCP/);
});
test('code search excludes secrets and returns line references', async t => {
  const root = await temp(t); await writeFile(path.join(root, 'app.js'), 'first\nneedle here\n'); await writeFile(path.join(root, '.env'), 'needle secret');
  const result = await searchProject(root, 'needle');
  assert.deepEqual(result.matches, [{ path: 'app.js', line: 2, text: 'needle here' }]);
});

test('redaction removes configured credentials from nested event data', async () => {
  const { redactor } = await import('../src/redaction.js');
  const redact = redactor(['my-private-key'], {});
  assert.deepEqual(redact({ messages: ['key=my-private-key'], count: 1 }), { messages: ['key=[REDACTED]'], count: 1 });
});
test('external applications require permission and approval and preserve argument boundaries', async t => {
  const root = await temp(t);
  const { runApplication } = await import('../src/applications.js');
  await saveConfig(root, { version: 1, providers: {}, routes: {}, mcp: {}, applications: { fixture: { command: process.execPath, args: ['-e', 'console.log(process.argv[1])'], cwd: root, envKeys: [], timeoutMs: 1000 } } });
  const agent = { applications: ['fixture'], permissions: { execute: true } };
  await assert.rejects(runApplication(root, { applications: ['fixture'], permissions: {} }, 'fixture', [], async () => true), /not granted/);
  assert.equal(await runApplication(root, agent, 'fixture', [], async () => false), 'Application declined.');
  const result = JSON.parse(await runApplication(root, agent, 'fixture', ['a;echo not-a-shell'], async () => true));
  assert.equal(result.output.trim(), 'a;echo not-a-shell');
});

test('Git diff tool excludes protected tracked files', async t => {
  const root = await temp(t);
  const { runProcess } = await import('../src/process.js');
  const git = async args => { const r = await runProcess('git', args, { cwd: root }); assert.equal(r.code, 0, r.output); };
  await git(['init']);
  await writeFile(path.join(root, '.env'), 'secret=old'); await writeFile(path.join(root, 'app.js'), 'old');
  await git(['add', '.env', 'app.js']);
  await git(['-c','user.name=Nexus Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','fixture']);
  await writeFile(path.join(root, '.env'), 'secret=never-expose'); await writeFile(path.join(root, 'app.js'), 'new-code');
  const result = await executeTool(root, defaults[0], 'git_diff', {}, async () => false);
  assert.match(result, /new-code/); assert.ok(!result.includes('never-expose'));
});
