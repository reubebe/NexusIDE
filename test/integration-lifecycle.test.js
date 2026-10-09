import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createIntegrationLifecycle } from '../src/integration-lifecycle.js';
import { runProcess } from '../src/process.js';
import { createIntegrationConfigurator, unconfigureIntegration } from '../src/integrations.js';
import { defaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { writeState, readState } from '../src/state.js';
import { loadAgent } from '../src/agents.js';

async function git(root, args) {
  const result = await runProcess('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root });
  assert.equal(result.code, 0, result.output);
  return result.output.trim();
}
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nexus-lifecycle-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), managed = path.join(base, 'managed');
  await mkdir(source); await git(source, ['init']);
  await writeFile(path.join(source, 'main.py'), 'print("synthetic runtime")\n');
  await git(source, ['add', 'main.py']); await git(source, ['commit', '-m', 'fixture']);
  const revision = await git(source, ['rev-parse', 'HEAD']);
  const definitions = { fixture: { source, revision, executable: root => path.join(root, '.venv/bin/tool'), steps: [['fixture-setup', []]] } };
  const controls = { fail: false, onSetup: null };
  const execute = async (command, args, options) => {
    if (command !== 'fixture-setup') return runProcess(command, args, options);
    await controls.onSetup?.(options);
    options.signal?.throwIfAborted();
    if (controls.fail) return { code: 1, output: 'synthetic-secret-must-not-be-saved' };
    const bin = path.join(options.cwd, '.venv/bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'tool'), '#!/bin/sh\nexit 0\n'); await chmod(path.join(bin, 'tool'), 0o755);
    return { code: 0, output: '' };
  };
  const lifecycle = createIntegrationLifecycle({ definitions, rootFor: () => managed, execute });
  return { base, source, managed, definitions, controls, lifecycle };
}

test('staged installation is idempotent and verifies tracked source rather than only HEAD', async t => {
  const f = await fixture(t), first = await f.lifecycle.install('fixture');
  assert.equal(first.ready, true); assert.equal(first.lock, null);
  assert.notEqual(first.root, f.managed);
  assert.equal((await f.lifecycle.install('fixture')).activeVersion, first.activeVersion);
  await git(first.root, ['update-index', '--assume-unchanged', 'main.py']);
  await writeFile(path.join(first.root, 'main.py'), 'changed despite assume-unchanged\n');
  const status = await f.lifecycle.status('fixture');
  assert.equal(status.ready, false); assert.match(status.diagnostic, /Modified tracked source/);
  await assert.rejects(f.lifecycle.run('fixture', {}, () => assert.fail('tampered runtime launched')), /not ready/);
});

test('upgrade switches only after success, rollback retains absolute virtualenv paths, uninstall is recoverable', async t => {
  const f = await fixture(t), first = await f.lifecycle.install('fixture');
  const before = await readFile(path.join(first.root, '.venv/bin/tool'), 'utf8');
  await writeFile(path.join(f.source, 'main.py'), 'print("version two")\n');
  await git(f.source, ['add', 'main.py']); await git(f.source, ['commit', '-m', 'new reviewed fixture']);
  f.definitions.fixture.previousRevisions = [f.definitions.fixture.revision];
  f.definitions.fixture.revision = await git(f.source, ['rev-parse', 'HEAD']);
  await assert.rejects(f.lifecycle.upgrade('fixture'), /confirmation/);
  const second = await f.lifecycle.upgrade('fixture', { confirm: true });
  assert.notEqual(second.root, first.root); assert.equal(second.ready, true);
  assert.equal(await readFile(path.join(first.root, '.venv/bin/tool'), 'utf8'), before);
  const rolled = await f.lifecycle.rollback('fixture', { confirm: true });
  assert.equal(rolled.root, first.root); assert.equal(rolled.ready, true);
  const removed = await f.lifecycle.uninstall('fixture', { confirm: true });
  assert.equal(removed.ready, false); assert.equal(removed.retained, true);
  assert.equal(await readFile(path.join(first.root, '.venv/bin/tool'), 'utf8'), before);
  await assert.rejects(f.lifecycle.run('fixture', {}, () => assert.fail()), /not ready/);
  assert.equal((await f.lifecycle.rollback('fixture', { confirm: true })).root, first.root);
});

test('failed upgrade preserves active version and does not persist installer secrets', async t => {
  const f = await fixture(t), first = await f.lifecycle.install('fixture');
  f.controls.fail = true;
  await assert.rejects(f.lifecycle.upgrade('fixture', { confirm: true }), /fixture-setup failed/);
  const status = await f.lifecycle.status('fixture');
  assert.equal(status.activeVersion, first.activeVersion); assert.equal(status.ready, true);
  assert.equal(status.versions.filter(version => version.state === 'failed').length, 1);
  assert.equal((await readFile(path.join(status.lifecycleRoot, 'manifest.json'), 'utf8')).includes('synthetic-secret'), false);
});

test('lifecycle lease prevents competing upgrade or uninstall while a runtime is in use', async t => {
  const f = await fixture(t); await f.lifecycle.install('fixture');
  await f.lifecycle.run('fixture', {}, async (_status, trackChild) => {
    await trackChild(process.pid);
    const status = await f.lifecycle.status('fixture');
    assert.equal(status.lock.childPid, process.pid);
    await assert.rejects(f.lifecycle.uninstall('fixture', { confirm: true }), /locked/);
    await assert.rejects(f.lifecycle.recover('fixture', { confirm: true }), /active or unknown/);
  });
  assert.equal((await f.lifecycle.status('fixture')).lock, null);
});

test('cancelled upgrade leaves the prior active version and releases its lease', async t => {
  const f = await fixture(t), first = await f.lifecycle.install('fixture');
  const controller = new AbortController();
  f.controls.onSetup = () => controller.abort();
  await assert.rejects(f.lifecycle.upgrade('fixture', { confirm: true, signal: controller.signal }), { name: 'AbortError' });
  const status = await f.lifecycle.status('fixture');
  assert.equal(status.activeVersion, first.activeVersion); assert.equal(status.ready, true); assert.equal(status.lock, null);
  assert.equal(status.versions.filter(version => version.state === 'failed').length, 1);
});

test('interrupted staging recovery refuses live owners and preserves prior active source', async t => {
  const f = await fixture(t), first = await f.lifecycle.install('fixture');
  const manifestFile = path.join(first.lifecycleRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')), id = randomUUID();
  manifest.versions[id] = { state: 'staging', source: f.source, revision: f.definitions.fixture.revision };
  await writeFile(manifestFile, JSON.stringify(manifest));
  const lockFile = path.join(first.lifecycleRoot, 'lock.json');
  const deadPid = 2147483647;
  await writeFile(lockFile, JSON.stringify({ id: randomUUID(), pid: deadPid, childPid: process.pid, operation: 'install' }));
  await assert.rejects(f.lifecycle.recover('fixture', { confirm: true }), /active or unknown/);
  await writeFile(lockFile, JSON.stringify({ id: randomUUID(), pid: deadPid, operation: 'install' }));
  const recovered = await f.lifecycle.recover('fixture', { confirm: true });
  assert.equal(recovered.activeVersion, first.activeVersion);
  assert.equal(recovered.versions.find(version => version.id === id).state, 'failed');
  assert.equal(recovered.lock, null);
});

test('managed boundaries, unreviewed origins and corrupt manifests fail closed', async t => {
  const f = await fixture(t), installed = await f.lifecycle.install('fixture');
  await git(installed.root, ['remote', 'set-url', 'origin', 'https://example.invalid/unreviewed.git']);
  assert.equal((await f.lifecycle.status('fixture')).ready, false);
  await assert.rejects(f.lifecycle.rollback('fixture', { confirm: true, version: '../escape' }), /No retained/);
  await writeFile(path.join(installed.lifecycleRoot, 'manifest.json'), JSON.stringify({ version: 1, name: 'fixture', active: '../escape', history: [], versions: {} }));
  await assert.rejects(f.lifecycle.status('fixture'), /Invalid integration lifecycle manifest/);
  const other = path.join(f.base, 'other'); await mkdir(other);
  await symlink(other, f.managed);
  await assert.rejects(f.lifecycle.status('fixture'), /real directory/);
});

test('existing legacy runtime is never moved and remains rollback-ready after a staged upgrade', async t => {
  const f = await fixture(t);
  await git(f.base, ['clone', f.source, f.managed]);
  await mkdir(path.join(f.managed, '.venv/bin'), { recursive: true });
  await writeFile(path.join(f.managed, '.venv/bin/tool'), '#!/bin/sh\nexit 0\n'); await chmod(path.join(f.managed, '.venv/bin/tool'), 0o755);
  const existing = await f.lifecycle.install('fixture');
  assert.equal(existing.activeVersion, 'legacy'); assert.equal(existing.root, f.managed.replace(/^\/var\//, '/private/var/'));
  await f.lifecycle.upgrade('fixture', { confirm: true });
  assert.equal((await f.lifecycle.rollback('fixture', { confirm: true })).activeVersion, 'legacy');
});

test('unconfigure restores only recorded execution grants and protects edited profiles', async t => {
  const { base } = await fixture(t);
  const project = path.join(base, 'project'); await mkdir(project);
  const profile = { command: '/usr/bin/true', args: [], cwd: project, envKeys: [], timeoutMs: 1000 };
  const config = { ...structuredClone(defaultConfig), applications: { openmontage: profile } };
  await saveConfig(project, config);
  const agent = { version: 1, name: 'production-planner', instructions: 'Synthetic.', permissions: { read: true, write: false, execute: true }, applications: ['openmontage'] };
  await writeState(project, 'agents', 'production-planner.json', agent);
  await writeState(project, 'integration-grants', 'openmontage.json', { version: 1, name: 'openmontage', agent: agent.name, state: 'configured', profile, previousExecute: false, executionGranted: true });
  await assert.rejects(unconfigureIntegration(project, 'openmontage'), /confirmation/);
  const edited = structuredClone(config); edited.applications.openmontage.args = ['user change']; await saveConfig(project, edited);
  await assert.rejects(unconfigureIntegration(project, 'openmontage', { confirm: true }), /profile changed/);
  await saveConfig(project, config);
  assert.equal((await unconfigureIntegration(project, 'openmontage', { confirm: true })).executionRestored, true);
  assert.equal((await loadAgent(project, agent.name)).permissions.execute, false);
  assert.deepEqual((await loadAgent(project, agent.name)).applications, []);
  assert.equal((await loadConfig(project)).applications.openmontage, undefined);
  assert.equal(await readState(project, 'integration-grants', 'openmontage.json', null), null);
});

test('configure is confirmed, idempotent, journals grants and safely revokes after partial configuration', async t => {
  const f = await fixture(t); await f.lifecycle.install('fixture');
  const project = path.join(f.base, 'project'); await mkdir(project);
  f.definitions.fixture.agent = 'fixture-agent'; f.definitions.fixture.envKeys = ['SYNTHETIC_API_KEY']; f.definitions.fixture.timeoutMs = 1000;
  const api = createIntegrationConfigurator({ definitions: f.definitions, statusFor: f.lifecycle.status });
  await writeState(project, 'agents', 'fixture-agent.json', { version: 1, name: 'fixture-agent', instructions: 'Synthetic.', permissions: { read: true, write: false } });
  await assert.rejects(api.configureIntegration(project, 'fixture'), /confirmation/);
  await api.configureIntegration(project, 'fixture', { confirm: true });
  await api.configureIntegration(project, 'fixture', { confirm: true });
  const grant = await readState(project, 'integration-grants', 'fixture.json');
  assert.equal(grant.state, 'configured'); assert.equal(grant.executionGranted, true); assert.equal(grant.previousExecute, null);
  assert.equal((await loadAgent(project, 'fixture-agent')).permissions.execute, true);
  assert.deepEqual((await loadConfig(project)).applications.fixture.envKeys, ['SYNTHETIC_API_KEY']);
  assert.equal((await loadConfig(project)).applications.fixture.cwd, path.dirname(grant.profile.args[2]));
  await writeState(project, 'integration-grants', 'fixture.json', { ...grant, state: 'preparing' });
  await assert.rejects(api.configureIntegration(project, 'fixture', { confirm: true }), /incomplete integration grant/);
  await api.unconfigureIntegration(project, 'fixture', { confirm: true });
  assert.equal((await loadAgent(project, 'fixture-agent')).permissions.execute, undefined);
  assert.equal((await loadConfig(project)).applications.fixture, undefined);
});

test('process registration records a child before resolving and fails closed on registration errors', async () => {
  let pid;
  const result = await runProcess(process.execPath, ['-e', 'console.log("fixture")'], { onSpawn: async value => { pid = value; } });
  assert.equal(result.code, 0); assert.ok(pid > 0);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { onSpawn: () => { throw new Error('journal unavailable'); } }), /journal unavailable/);
});
