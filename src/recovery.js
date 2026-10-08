import { hostname } from 'node:os';
import { readState, writeState, listState, safeName } from './state.js';
import { processIsAlive } from './locks.js';

export const currentOwner = () => ({ pid: process.pid, host: hostname() });
const folders = { run: 'runs', workflow: 'workflows' };
function folderFor(kind) {
  if (!Object.hasOwn(folders, kind)) throw new Error('Recovery kind must be run or workflow.');
  return folders[kind];
}
async function ownerStatus(owner) {
  if (!owner || owner.host !== hostname()) return 'unknown';
  const alive = await processIsAlive(owner.pid);
  return alive === false ? 'absent' : alive === true ? 'active' : 'unknown';
}
export async function inspectActivity(root) {
  const entries = [];
  for (const [kind, folder] of Object.entries(folders)) {
    for (const filename of await listState(root, folder)) {
      const record = await readState(root, folder, filename);
      if (record.status !== 'running') continue;
      entries.push({ kind, id: filename.slice(0, -5), name: record.agent || record.name, started: record.started, owner: record.owner || null, processStatus: await ownerStatus(record.owner) });
    }
  }
  return entries;
}
export async function recoverActivity(root, kind, id, approve = async () => false) {
  const folder = folderFor(kind), filename = `${safeName(id)}.json`;
  const record = await readState(root, folder, filename);
  if (record.status !== 'running') throw new Error('Only records still marked running can be recovered.');
  if (await ownerStatus(record.owner) !== 'absent') throw new Error('Recovery requires a confirmed absent process on this host. Active, legacy, and other-host records are left unchanged.');
  if (!await approve({ type: 'recover-activity', kind, id, owner: record.owner, started: record.started, action: 'Mark interrupted; preserve history and files; do not replay tools.' })) throw new Error('Recovery declined.');
  const latest = await readState(root, folder, filename);
  if (JSON.stringify(latest) !== JSON.stringify(record) || await ownerStatus(latest.owner) !== 'absent') throw new Error('Activity changed during approval; inspect it again.');
  const at = new Date().toISOString();
  const recovered = { ...record, status: 'interrupted', finished: at, error: 'Owning process no longer exists. Work was not replayed.', recovery: { at, previousStatus: record.status, reason: 'owning-process-absent' } };
  await writeState(root, folder, filename, recovered);
  return { kind, id, status: recovered.status, recoveredAt: at };
}
