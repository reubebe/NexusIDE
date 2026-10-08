import { createHash } from 'node:crypto';
import { realpath, unlink } from 'node:fs/promises';
import { statePath, writeState, readState, listState } from './state.js';
export async function acquireWorkspace(root, workspace, id) {
  const canonical = await realpath(workspace);
  const name = createHash('sha256').update(canonical).digest('hex') + '.json';
  try { await writeState(root, 'locks', name, { id, pid: process.pid, workspace: canonical, started: new Date().toISOString() }, { exclusive: true }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Another write-capable run holds this workspace. Use a separate worktree or wait. A crashed process may leave a lock in .nexus/locks.'); throw e; }
  return async () => { const lock = await readState(root, 'locks', name); if (lock.id === id) await unlink(await statePath(root, 'locks', name)); };
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
  if (!await approve({ type: 'remove-stale-lock', ...lock })) throw new Error('Lock removal declined.');
  const filename = `${lock.key}.json`;
  const current = await readState(root, 'locks', filename);
  if (current.id !== lock.runId || current.pid !== lock.pid || current.workspace !== lock.workspace || await processIsAlive(lock.pid) !== false) throw new Error('Lock changed or its process is active; inspect it again.');
  await unlink(await statePath(root, 'locks', filename));
  return lock;
}
