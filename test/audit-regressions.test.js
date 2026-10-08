import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, link, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boundedRead } from '../src/bounded-read.js';
import { MAX_STATE_BYTES, readState, writeState, listState } from '../src/state.js';
import { defaults, installAgent } from '../src/agents.js';
import { executeTool } from '../src/tools.js';
import { runWorkflow } from '../src/workflows.js';
import { runProcess } from '../src/process.js';
import { createProvider } from '../src/providers.js';
import { startServer, readJsonBody } from '../src/server.js';
import { defaultConfig, saveConfig } from '../src/config.js';
import { rebuildProjectIndex, semanticProjectSearch } from '../src/project-index.js';
import { configureIntegration, integrationStatus } from '../src/integrations.js';
import { doctor } from '../src/doctor.js';
import { connectMcp } from '../src/mcp.js';
import { renderWhenChanged } from '../ui/render-cache.js';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function dashboard(t, root) {
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const api = async (endpoint, method = 'GET', body) => fetch(new URL(app.url).origin + '/api/' + endpoint, { method, headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, api };
}
async function waitFor(check) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Condition did not become true');
}

test('identical dashboard polls preserve interactive nodes and failed renders remain retryable', () => {
  const selector = {}, approvals = {}; let renders = 0;
  assert.equal(renderWhenChanged(selector, 'agents-v1', () => { renders++; }), true);
  assert.equal(renderWhenChanged(selector, 'agents-v1', () => { renders++; }), false);
  assert.equal(renderWhenChanged(approvals, 'agents-v1', () => { renders++; }), true);
  assert.throws(() => renderWhenChanged(selector, 'agents-v2', () => { throw new Error('render failed'); }));
  assert.equal(renderWhenChanged(selector, 'agents-v2', () => { renders++; }), true);
  assert.equal(renders, 3);
});

test('dashboard JSON decoding preserves Unicode split across chunks and caps bytes rather than characters', async () => {
  const req = chunks => ({ headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield* chunks; } });
  const data = Buffer.from(JSON.stringify({ text: 'Research 🌎' }));
  assert.deepEqual(await readJsonBody(req([...data].map(byte => Buffer.from([byte])))), { text: 'Research 🌎' });
  await assert.rejects(readJsonBody(req([Buffer.from(JSON.stringify({ text: '🌎'.repeat(60000) }))])), /too large/);
});

test('bounded descriptor reads reject growth without reading the growing file', async () => {
  let stats = 0, allocated = 0;
  const handle = {
    stat: async () => ({ isFile: () => true, nlink: 1, size: stats++ ? 1000000 : 3, mtimeMs: 1, ctimeMs: 1 }),
    read: async buffer => { allocated = buffer.length; buffer.fill(65); return { bytesRead: buffer.length }; },
  };
  await assert.rejects(boundedRead(handle, 100), /changed while reading/);
  assert.equal(allocated, 4);
});

test('oversized state updates preserve the previous readable record and leave no temporary file', async t => {
  const root = await workspace(t);
  await writeState(root, 'config', 'test.json', { original: true });
  await assert.rejects(writeState(root, 'config', 'test.json', { content: 'x'.repeat(MAX_STATE_BYTES) }), /storage limit/);
  assert.deepEqual(await readState(root, 'config', 'test.json'), { original: true });
  assert.deepEqual(await readdir(path.join(root, '.nexus/config')), ['test.json']);
});

test('state reads reject hard-linked files', async t => {
  const root = await workspace(t);
  await writeState(root, 'config', 'test.json', { original: true });
  await link(path.join(root, '.nexus/config/test.json'), path.join(root, 'duplicate.json'));
  await assert.rejects(readState(root, 'config', 'test.json'), /singly linked/);
});

test('state readers accept complete snapshots during concurrent atomic replacements', async t => {
  const root = await workspace(t);
  await writeState(root, 'runs', 'concurrent.json', { version: 0, content: 'x'.repeat(100000) });
  await Promise.all([
    (async () => { for (let version = 1; version <= 30; version++) await writeState(root, 'runs', 'concurrent.json', { version, content: 'x'.repeat(100000) }); })(),
    (async () => { for (let i = 0; i < 60; i++) { const value = await readState(root, 'runs', 'concurrent.json'); assert.ok(Number.isInteger(value.version)); assert.equal(value.content.length, 100000); } })(),
  ]);
});

test('cancelling during an approval prevents an approved file write', async t => {
  const root = await workspace(t), controller = new AbortController();
  await assert.rejects(executeTool(root, defaults[1], 'write_file', { path: 'cancelled.txt', content: 'must not exist' }, async () => { controller.abort(); return true; }, { signal: controller.signal }), /abort/i);
  await assert.rejects(readFile(path.join(root, 'cancelled.txt')), { code: 'ENOENT' });
});

test('text file tools refuse binary files without corrupting their contents', async t => {
  const root = await workspace(t), binary = Buffer.from([255, 254, 0, 1]);
  await writeFile(path.join(root, 'binary.bin'), binary);
  await assert.rejects(executeTool(root, defaults[0], 'read_file', { path: 'binary.bin' }, async () => true), /binary/);
  await assert.rejects(executeTool(root, defaults[1], 'write_file', { path: 'binary.bin', content: 'replacement' }, async () => true), /binary/);
  assert.deepEqual(await readFile(path.join(root, 'binary.bin')), binary);
});

test('protected paths cannot be bypassed with case variants on macOS filesystems', async t => {
  const root = await workspace(t);
  for (const candidate of ['.ENV', '.NEXUS/config/project.json', '.GiT/config', '.SsH/id_rsa', '.NPMRC']) {
    await assert.rejects(executeTool(root, defaults[0], 'read_file', { path: candidate }, async () => false), /Protected path/);
  }
});

test('cancelling a workflow gate creates neither an isolated worktree nor a run', async t => {
  const root = await workspace(t), controller = new AbortController();
  await installAgent(root, defaults[1]);
  const workflow = { version: 1, name: 'cancel-gate', steps: [{ id: 'build', agent: 'coder', task: 'build', approval: true }] };
  await assert.rejects(runWorkflow({ root, workflow, task: 'test', demo: true, isolated: true, signal: controller.signal, approve: async () => { controller.abort(); return true; } }));
  assert.deepEqual(await listState(root, 'runs'), []);
  const record = await readState(root, 'workflows', (await listState(root, 'workflows'))[0]);
  assert.equal(record.status, 'cancelled');
  assert.equal(record.steps.build.status, 'cancelled');
  await assert.rejects(readdir(path.join(root, '.nexus/worktrees')), { code: 'ENOENT' });
});

test('MCP cancellation after connection approval does not spawn a server', async t => {
  const root = await workspace(t), controller = new AbortController();
  await saveConfig(root, { ...structuredClone(defaultConfig), mcp: { fixture: { command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("spawned", "bad")'], tools: [] } } });
  await assert.rejects(connectMcp(root, { mcp: ['fixture'] }, async () => { controller.abort(); return true; }, controller.signal), /abort/i);
  await assert.rejects(readFile(path.join(root, 'spawned')), { code: 'ENOENT' });
});

test('dashboard serializes terminal starts and permits restart after a natural exit', async t => {
  const root = await workspace(t), { api } = await dashboard(t, root);
  const starts = await Promise.all([api('terminal/start', 'POST', {}), api('terminal/start', 'POST', {})]);
  assert.deepEqual(starts.map(r => r.status).sort(), [201, 409]);
  await api('terminal/input', 'POST', { input: 'exit\n' });
  await waitFor(async () => !(await (await api('terminal/output')).json()).running);
  assert.equal((await api('terminal/start', 'POST', {})).status, 201);
  await api('terminal/stop', 'POST', {});
  assert.equal((await api('terminal/start', 'POST', {})).status, 201);
  await api('terminal/input', 'POST', { input: 'printf NEXUS_RESTART_OK\n' });
  await waitFor(async () => (await (await api('terminal/output')).json()).output.includes('NEXUS_RESTART_OK'));
  assert.equal((await (await api('terminal/output')).json()).running, true);
});

test('dashboard shutdown waits for a cancelled pending approval to persist and release its lock', async t => {
  const root = await workspace(t); await installAgent(root, defaults[1]);
  await writeState(root, 'teams', 'pending.json', { version: 1, name: 'pending', steps: [{ id: 'gate', agent: 'coder', task: 'write', approval: true }] });
  const { app, api } = await dashboard(t, root);
  assert.equal((await api('run', 'POST', { team: 'pending', task: 'test shutdown', demo: true })).status, 202);
  await waitFor(async () => (await (await api('state')).json()).approvals.length === 1);
  await app.close(); await app.close();
  const records = await listState(root, 'workflows'); assert.equal(records.length, 1);
  assert.equal((await readState(root, 'workflows', records[0])).status, 'cancelled');
  assert.deepEqual(await listState(root, 'locks'), []);
});

test('provider adapters reject truncated or blocked completions instead of reporting success', async t => {
  for (const [kind, body] of [['compatible', { choices: [{ finish_reason: 'length', message: { content: 'Incomplete' } }] }], ['anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Incomplete' }] }]]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(body));
    const provider = createProvider({ NEXUS_PROVIDER: kind, NEXUS_MODEL: 'fixture', NEXUS_API_KEY: 'synthetic' });
    await assert.rejects(provider.complete([{ role: 'system', content: 'test' }, { role: 'user', content: 'test' }], []), /did not complete/);
    t.mock.restoreAll();
  }
});

test('empty project indexes return no matches without contacting the embedding endpoint', async t => {
  const root = await workspace(t);
  await saveConfig(root, { ...structuredClone(defaultConfig), embeddings: { model: 'fixture', url: 'http://127.0.0.1:1/api/embed' } });
  const index = await rebuildProjectIndex(root); assert.equal(index.indexed, 0);
  assert.deepEqual((await semanticProjectSearch(root, 'nothing')).matches, []);
});

test('semantic project retrieval refuses directories replaced by symlinks', async t => {
  const root = await workspace(t), outside = await workspace(t);
  await mkdir(path.join(root, 'docs')); await writeFile(path.join(root, 'docs/note.md'), 'fixture');
  await saveConfig(root, { ...structuredClone(defaultConfig), embeddings: { model: 'fixture', url: 'http://127.0.0.1:1/api/embed' } });
  t.mock.method(globalThis, 'fetch', async (_url, options) => Response.json({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }));
  await rebuildProjectIndex(root);
  await writeFile(path.join(outside, 'note.md'), 'fixture');
  await rm(path.join(root, 'docs'), { recursive: true });
  await symlink(outside, path.join(root, 'docs'));
  await assert.rejects(semanticProjectSearch(root, 'fixture'), /Symbolic links/);
});

test('Git reads do not execute configured filesystem monitors or content filters', async t => {
  const root = await workspace(t);
  const git = async args => { const result = await runProcess('git', args, { cwd: root }); assert.equal(result.code, 0, result.output); };
  await git(['init', '-q']); await git(['config', 'user.email', 'fixture@example.invalid']); await git(['config', 'user.name', 'Fixture']);
  await writeFile(path.join(root, 'note.txt'), 'before'); await git(['add', '.']); await git(['commit', '-qm', 'fixture']);
  await writeFile(path.join(root, '.gitattributes'), '*.txt filter=fixture\n');
  await writeFile(path.join(root, 'note.txt'), 'after');
  await git(['config', 'filter.fixture.clean', 'touch FILTER_EXECUTED; cat']);
  await git(['config', 'core.fsmonitor', 'touch MONITOR_EXECUTED']);
  for (const tool of ['git_status', 'git_diff']) {
    const result = JSON.parse(await executeTool(root, defaults[0], tool, {}, async () => false));
    assert.equal(result.code, 0, result.output);
  }
  for (const name of ['FILTER_EXECUTED', 'MONITOR_EXECUTED']) await assert.rejects(readFile(path.join(root, name)), { code: 'ENOENT' });
});

test('integration readiness requires the reviewed source pin, not merely an executable', async t => {
  const root = await workspace(t);
  await mkdir(path.join(root, '.venv/bin'), { recursive: true });
  await writeFile(path.join(root, '.venv/bin/python'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const status = await integrationStatus('openmontage', { runtimeRoot: root });
  assert.equal(status.executableAvailable, true); assert.equal(status.ready, false);
  assert.match(status.expectedRevision, /^[a-f0-9]{40}$/);
  await assert.rejects(configureIntegration(root, 'openmontage', { runtimeRoot: root }), /not installed/);
  assert.deepEqual(await listState(root, 'config'), []);
  await assert.rejects(integrationStatus('constructor'), /Unknown integration/);
});

test('doctor preserves separate MCP and application connections sharing a name', async t => {
  const root = await workspace(t);
  await saveConfig(root, { ...structuredClone(defaultConfig), mcp: { fixture: { command: process.execPath, args: [], tools: [] } }, applications: { fixture: { command: process.execPath, args: [] } } });
  const result = await doctor(root);
  assert.deepEqual(result.connections.filter(c => c.name === 'fixture').map(c => c.kind), ['mcp', 'application']);
});
