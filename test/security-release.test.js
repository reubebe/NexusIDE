import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runProcess } from '../src/process.js';
import { createIntegrationLifecycle } from '../src/integration-lifecycle.js';
import { createIntegrationConfigurator } from '../src/integrations.js';
import { startServer } from '../src/server.js';
import { acquireWorkspace } from '../src/locks.js';
import { defaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { readState, writeState } from '../src/state.js';
import { loadAgent } from '../src/agents.js';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-release-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function git(root, args) {
  const result = await runProcess('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root });
  assert.equal(result.code, 0, result.output);
  return result.output.trim();
}
const agent = { version: 1, name: 'fixture-agent', instructions: 'Synthetic review fixture.', permissions: { read: true, write: false, execute: false } };

test('integration pin verification ignores Git replacement refs and rejects substituted source', async t => {
  const base = await temporary(t), source = path.join(base, 'source'), managed = path.join(base, 'managed');
  await mkdir(source);
  await git(source, ['init']);
  await writeFile(path.join(source, 'main.py'), 'print("reviewed source")\n');
  await git(source, ['add', 'main.py']); await git(source, ['commit', '-m', 'reviewed fixture']);
  const revision = await git(source, ['rev-parse', 'HEAD']);
  await git(base, ['clone', source, managed]);
  await mkdir(path.join(managed, '.venv/bin'), { recursive: true });
  const executable = path.join(managed, '.venv/bin/tool');
  await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o755);
  const lifecycle = createIntegrationLifecycle({ definitions: { fixture: { source, revision, executable: root => path.join(root, '.venv/bin/tool'), steps: [] } }, rootFor: () => managed });
  assert.equal((await lifecycle.status('fixture')).ready, true);
  await writeFile(path.join(managed, 'main.py'), 'print("unreviewed substitute")\n');
  await git(managed, ['add', 'main.py']); await git(managed, ['commit', '-m', 'unreviewed substitute']);
  const substitute = await git(managed, ['rev-parse', 'HEAD']);
  // Change only the ref: preserve the substitute checkout and introduce a
  // replacement that a plain ls-tree would mistake for the reviewed commit.
  await git(managed, ['update-ref', 'HEAD', revision]);
  await git(managed, ['replace', revision, substitute]);
  assert.equal(await git(managed, ['rev-parse', 'HEAD']), revision);
  assert.notEqual(await git(managed, ['ls-tree', 'HEAD']), await git(managed, ['--no-replace-objects', 'ls-tree', 'HEAD']));
  const result = await lifecycle.status('fixture');
  assert.equal(result.sourceVerified, false);
  assert.match(result.sourceReason, /Modified tracked source/);
  await assert.rejects(lifecycle.run('fixture', {}, () => assert.fail('substituted source launched')), /not ready/);
});

test('dashboard configuration and agent writes honor integration and workspace leases', async t => {
  const root = await temporary(t);
  await saveConfig(root, structuredClone(defaultConfig));
  await writeState(root, 'agents', 'fixture-agent.json', agent);
  const beforeConfig = await loadConfig(root), beforeAgent = await loadAgent(root, agent.name);
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, origin = new URL(app.url).origin;
  const update = (endpoint, data) => fetch(`${origin}/api/${endpoint}`, { method: 'PUT', headers, body: JSON.stringify(data) });
  const release = await acquireWorkspace(root, root, randomUUID());
  try {
    for (const [endpoint, data] of [['config', beforeConfig], ['agent', { ...agent, instructions: 'Changed instructions.' }]]) {
      const result = await update(endpoint, data);
      assert.equal(result.status, 400);
      assert.match((await result.json()).error, /holds this workspace/);
    }
    assert.deepEqual(await loadConfig(root), beforeConfig);
    assert.deepEqual(await loadAgent(root, agent.name), beforeAgent);
  } finally { await release(); }
  assert.equal((await update('config', beforeConfig)).status, 200);
  assert.equal((await update('agent', { ...agent, instructions: 'Changed instructions.' })).status, 200);
  assert.equal((await loadAgent(root, agent.name)).instructions, 'Changed instructions.');
});

test('configure rejects corrupt existing grant metadata without rewriting permissions or receipt', async t => {
  const root = await temporary(t);
  await saveConfig(root, structuredClone(defaultConfig));
  await writeState(root, 'agents', 'fixture-agent.json', agent);
  const api = createIntegrationConfigurator({ definitions: { fixture: { agent: agent.name, envKeys: [], timeoutMs: 1000 } }, statusFor: async () => ({ ready: true, managedRoot: path.join(root, 'runtime') }) });
  const before = await loadConfig(root);
  const valid = { version: 1, name: 'fixture', agent: agent.name, state: 'configured', profile: {}, previousExecute: false, executionGranted: true };
  const corruptReceipts = [{ version: 2 }, { name: 'other' }, { agent: 'other' }, { previousExecute: 'false' }, { executionGranted: null }, { profile: [] }, { profile: null }].map(changed => ({ ...valid, ...changed }));
  for (const corrupt of [...corruptReceipts, false, 0, 'configured', []]) {
    await writeState(root, 'integration-grants', 'fixture.json', corrupt);
    await assert.rejects(api.configureIntegration(root, 'fixture', { confirm: true }), /Invalid integration grant receipt/);
    assert.deepEqual(await readState(root, 'integration-grants', 'fixture.json'), corrupt);
    assert.deepEqual(await loadConfig(root), before);
    assert.equal((await loadAgent(root, agent.name)).permissions.execute, false);
  }
});
