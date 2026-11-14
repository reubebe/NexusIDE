import { createHash } from 'node:crypto';
import { realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { statePath, writeState, readState, listState } from './state.js';
export async function acquireWorkspace(root, workspace, id) {
  const canonical = await realpath(workspace), registryRoot = await realpath(root);
  const name = createHash('sha256').update(canonical).digest('hex') + '.json';
  const lock = { id, pid: process.pid, workspace: canonical, started: new Date().toISOString(), ...(registryRoot !== canonical ? { registryRoot } : {}) };
  const acquired = [];
  const release = async () => {
    // Parent registries retain observability; the workspace owns exclusion even
    // when a separate CLI opens that worktree with a different state root.
    let failure;
    for (const directory of [...acquired].reverse()) {
      try { if (JSON.stringify(await readState(directory, 'locks', name)) === JSON.stringify(lock)) await unlink(await statePath(directory, 'locks', name)); }
      catch (error) { failure ||= error; }
    }
    if (failure) throw failure;
  };
  try {
    for (const directory of [...new Set([canonical, registryRoot])]) {
      await writeState(directory, 'locks', name, lock, { exclusive: true });
      acquired.push(directory);
    }
  } catch (error) {
    await release();
    if (error.code === 'EEXIST') throw new Error('Another write-capable run holds this workspace. Use a separate worktree or wait. A crashed process may leave a lock in .nexus/locks.');
    throw error;
  }
  return release;
}

export async function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; return null; }
}

export async function inspectWorkspaceLocks(root) {
  const names = await listState(root, 'locks');
  const locks = [];
  for (const filename of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
    const lock = await readState(root, 'locks', filename);
    const alive = await processIsAlive(lock.pid);
    locks.push({ key: filename.slice(0, 64), pid: lock.pid, workspace: lock.workspace, started: lock.started, runId: lock.id, status: alive === false ? 'stale' : alive === true ? 'active' : 'unknown' });
  }
  return locks;
}

export async function removeStaleWorkspaceLock(root, key, approve = async () => false) {
  if (typeof key !== 'string' || !/^[a-f0-9]{8,64}$/.test(key)) throw new Error('Use at least 8 hexadecimal characters from the listed lock key.');
  const matches = (await inspectWorkspaceLocks(root)).filter(lock => lock.key.startsWith(key));
  if (matches.length !== 1) throw new Error(matches.length ? 'Lock key is ambiguous; provide more characters.' : 'No matching lock found.');
  const [lock] = matches;
  if (lock.status !== 'stale') throw new Error(`Lock is ${lock.status}; only locks whose process is confirmed absent can be removed.`);
  const filename = `${lock.key}.json`;
  const before = await readState(root, 'locks', filename);
  if (before.id !== lock.runId || before.pid !== lock.pid || before.workspace !== lock.workspace || before.started !== lock.started) throw new Error('Lock changed; inspect it again.');
  if ((await approve({ type: 'remove-stale-lock', ...lock })) !== true) throw new Error('Lock removal declined.');
  const current = await readState(root, 'locks', filename);
  if (JSON.stringify(current) !== JSON.stringify(before) || await processIsAlive(lock.pid) !== false) throw new Error('Lock changed or its process is active; inspect it again.');
  // New cross-project locks have an authority in the workspace and an identical
  // parent registry. Recovering from either interface removes both, only after
  // comparing their complete records. Legacy single-file locks remain supported.
  const directories = current.registryRoot
    ? [...new Set([current.registryRoot, current.workspace])]
    : [await realpath(root)];
  if (current.registryRoot) {
    if (directories.some(directory => typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) || !directories.includes(await realpath(root))) throw new Error('Lock registry does not belong to this project.');
    if (createHash('sha256').update(current.workspace).digest('hex') !== lock.key) throw new Error('Lock workspace does not match its key.');
  }
  const existing = [];
  for (const directory of directories) {
    try {
      if (await realpath(directory) !== directory) throw new Error('Lock directory changed; inspect it again.');
      if (JSON.stringify(await readState(directory, 'locks', filename)) !== JSON.stringify(current)) throw new Error('Lock changed during approval; inspect it again.');
      existing.push(directory);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const directory of existing) await unlink(await statePath(directory, 'locks', filename));
  return lock;
}
