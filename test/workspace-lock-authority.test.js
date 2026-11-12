import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireWorkspace, inspectWorkspaceLocks, removeStaleWorkspaceLock } from '../src/locks.js';
import { listState, readState, writeState } from '../src/state.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-lock-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'worktree'); await mkdir(workspace);
  return { root, workspace };
}
async function makeStale(root, workspace) {
  await acquireWorkspace(root, workspace, 'orphan');
  const [name] = await listState(root, 'locks');
  const lock = { ...await readState(root, 'locks', name), pid: 2_147_483_647 };
  for (const directory of [root, workspace]) await writeState(directory, 'locks', name, lock);
  return { name, key: name.slice(0, -5), lock };
}

test('workspace authority excludes independent CLI and workflow writers across state roots', async t => {
  const { root, workspace } = await fixture(t);
  const release = await acquireWorkspace(root, workspace, 'workflow');
  assert.equal((await inspectWorkspaceLocks(root))[0].runId, 'workflow');
  assert.equal((await inspectWorkspaceLocks(workspace))[0].runId, 'workflow');
  await assert.rejects(acquireWorkspace(workspace, workspace, 'cli'), /Another write-capable/);
  await release();
  const localRelease = await acquireWorkspace(workspace, workspace, 'cli');
  await assert.rejects(acquireWorkspace(root, workspace, 'workflow'), /Another write-capable/);
  assert.deepEqual(await listState(root, 'locks'), []);
  await localRelease();
  assert.deepEqual(await listState(workspace, 'locks'), []);
});

test('simultaneous cross-interface acquisition admits exactly one writer', async t => {
  const { root, workspace } = await fixture(t);
  const results = await Promise.allSettled([
    acquireWorkspace(root, workspace, 'workflow'), acquireWorkspace(workspace, workspace, 'cli'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await results.find(result => result.status === 'fulfilled').value();
  for (const directory of [root, workspace]) assert.deepEqual(await listState(directory, 'locks'), []);
});

test('stale paired locks recover from either interface and require approval', async t => {
  const { root, workspace } = await fixture(t);
  for (const interfaceRoot of [root, workspace]) {
    const { key } = await makeStale(root, workspace);
    await assert.rejects(removeStaleWorkspaceLock(interfaceRoot, key), /declined/);
    await removeStaleWorkspaceLock(interfaceRoot, key, async () => true);
    for (const directory of [root, workspace]) assert.deepEqual(await listState(directory, 'locks'), []);
  }
});

test('recovery rejects changed registries and never removes a replacement authority', async t => {
  const { root, workspace } = await fixture(t);
  const { name, key, lock } = await makeStale(root, workspace);
  await assert.rejects(removeStaleWorkspaceLock(root, key, async () => {
    await writeState(root, 'locks', name, { ...lock, registryRoot: workspace });
    return true;
  }), /Lock changed/);
  await writeState(root, 'locks', name, lock);
  const replacement = { ...lock, id: 'replacement', pid: process.pid };
  await writeState(workspace, 'locks', name, replacement);
  await assert.rejects(removeStaleWorkspaceLock(root, key, async () => true), /Lock changed/);
  assert.deepEqual(await readState(workspace, 'locks', name), replacement);
  assert.deepEqual(await readState(root, 'locks', name), lock);
});

test('orphan registry recovery tolerates a deleted worktree and rejects a foreign registry root', async t => {
  const { root, workspace } = await fixture(t);
  const { name, key, lock } = await makeStale(root, workspace);
  await writeState(root, 'locks', name, { ...lock, registryRoot: workspace });
  await assert.rejects(removeStaleWorkspaceLock(root, key, async () => true), /does not belong/);
  await writeState(root, 'locks', name, lock);
  await rm(workspace, { recursive: true });
  await removeStaleWorkspaceLock(root, key, async () => true);
  assert.deepEqual(await listState(root, 'locks'), []);
});

test('registry collision rolls back only the newly acquired workspace authority', async t => {
  const { root, workspace } = await fixture(t);
  const { name, lock } = await makeStale(root, workspace);
  await rm(path.join(workspace, '.nexus'), { recursive: true });
  await assert.rejects(acquireWorkspace(root, workspace, 'new-run'), /Another write-capable/);
  assert.deepEqual(await listState(workspace, 'locks'), []);
  assert.deepEqual(await readState(root, 'locks', name), lock);
});
