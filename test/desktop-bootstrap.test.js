import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, lstat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { prepareDesktopWorkspace } from '../src/desktop-workspace.js';
import { parseDesktopArguments } from '../src/desktop-bootstrap.js';
import { initializeWorkspace } from '../src/workspace-init.js';
import { readState, writeState } from '../src/state.js';
import { listAgents, loadAgent } from '../src/agents.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nexus-desktop-setup-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'Project With Spaces'), dataRoot = path.join(base, 'Application Data');
  await mkdir(root);
  return { base, root, dataRoot };
}

test('shared first-run setup creates missing defaults without replacing project state', async t => {
  const { root } = await fixture(t);
  const first = await initializeWorkspace(root);
  assert.equal(first.created.length, 7);
  assert.equal(first.teamCreated, true);
  const architect = await loadAgent(root, 'architect');
  architect.instructions = 'Keep my customized agent.';
  await writeState(root, 'agents', 'architect.json', architect);
  const team = { custom: 'Keep my team definition.' };
  await writeState(root, 'teams', 'development.json', team);
  await writeState(root, 'config', 'project.json', { private: 'Keep configuration untouched.' });
  const again = await initializeWorkspace(root);
  assert.deepEqual(again.created, []);
  assert.equal(again.kept.length, 7);
  assert.equal(again.teamCreated, false);
  assert.equal((await loadAgent(root, 'architect')).instructions, architect.instructions);
  assert.deepEqual(await readState(root, 'teams', 'development.json'), team);
  assert.deepEqual(await readState(root, 'config', 'project.json'), { private: 'Keep configuration untouched.' });
});

test('desktop setup stores bounded app metadata separately from project state', async t => {
  const { root, dataRoot } = await fixture(t);
  const result = await prepareDesktopWorkspace(root, { dataRoot });
  assert.equal((await listAgents(result.root)).length, 7);
  const settings = await readState(result.dataRoot, 'desktop', 'settings.json');
  assert.equal(settings.lastWorkspace, result.root);
  assert.equal(settings.recentWorkspaces.length, 1);
  assert.equal(settings.version, 1);
  assert.equal(settings.token, undefined);
  assert.equal((await lstat(path.join(dataRoot, '.nexus', 'desktop', 'settings.json'))).mode & 0o777, 0o600);
  settings.recentWorkspaces = [null, false, 'relative', ...Array.from({ length: 15 }, (_, i) => path.join(root, String(i)))];
  await writeState(dataRoot, 'desktop', 'settings.json', settings);
  await prepareDesktopWorkspace(root, { dataRoot });
  assert.equal((await readState(dataRoot, 'desktop', 'settings.json')).recentWorkspaces.length, 10);
});

test('desktop setup refuses bundle workspaces and linked state/data directories', async t => {
  const { base, root, dataRoot } = await fixture(t);
  await assert.rejects(prepareDesktopWorkspace(root, { dataRoot, installationRoot: root }), /outside the application/);
  await mkdir(dataRoot);
  const link = path.join(base, 'data-link');
  await symlink(dataRoot, link);
  await assert.rejects(prepareDesktopWorkspace(root, { dataRoot: link }), /real directory/);
  await symlink(dataRoot, path.join(root, '.nexus'));
  await assert.rejects(prepareDesktopWorkspace(root, { dataRoot }), /symbolic links/);
  await assert.rejects(prepareDesktopWorkspace('relative', { dataRoot }), /absolute/);
});

test('desktop bootstrap rejects missing, duplicate and unknown arguments', () => {
  for (const args of [[], ['--workspace'], ['__proto__', '/tmp'], ['--workspace', '/tmp', '--workspace', '/other'], ['--workspace', '/tmp', '--token', 'secret']]) assert.throws(() => parseDesktopArguments(args));
  assert.deepEqual(parseDesktopArguments(['--workspace', '/tmp/project', '--data-root', '/tmp/data']), { workspace: '/tmp/project', dataRoot: '/tmp/data' });
});

test('desktop bootstrap starts authenticated local service with minimal PATH and closes on parent EOF', async t => {
  const { root, dataRoot } = await fixture(t);
  const script = path.join(dataRoot, 'bootstrap-link.js');
  await mkdir(dataRoot);
  await symlink(fileURLToPath(new URL('../src/desktop-bootstrap.js', import.meta.url)), script);
  const child = spawn(process.execPath, [script, '--workspace', root, '--data-root', dataRoot], {
    cwd: os.tmpdir(), env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(() => { child.stdin.destroy(); child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const signal = AbortSignal.timeout(15000);
  const [line] = await once(lines, 'line', { signal });
  const ready = JSON.parse(line), url = new URL(ready.url), token = url.hash.slice(1);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal((await fetch(url.origin + '/api/state', { signal })).status, 401);
  const state = await fetch(url.origin + '/api/state', { headers: { authorization: `Bearer ${token}` }, signal });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).agents.length, 7);
  assert.equal((await fetch(url.origin + '/app.js', { signal })).status, 200);
  child.stdin.end();
  const exit = await Promise.race([exited, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Bootstrap shutdown timed out.')), { once: true }))]);
  assert.equal(exit[0], 0, stderr);
  await assert.rejects(fetch(url.origin, { signal: AbortSignal.timeout(1000) }));
  assert.equal(stderr.includes(token), false);
  assert.equal((await readFile(path.join(dataRoot, '.nexus', 'desktop', 'settings.json'), 'utf8')).includes(token), false);
});
