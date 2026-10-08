import { mkdir, lstat, realpath, open, rename, unlink, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { boundedRead } from './bounded-read.js';

export const MAX_STATE_BYTES = 20_000_000;

export function safeName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value) || value.includes('..')) throw new Error('Invalid name.');
  return value;
}
export async function statePath(root, ...parts) {
  parts.forEach(safeName);
  let current = await realpath(root);
  for (const part of ['.nexus', ...parts]) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('State paths cannot be symbolic links.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return current;
}
export async function stateDir(root, ...parts) {
  const target = await statePath(root, ...parts);
  await mkdir(target, { recursive: true, mode: 0o700 });
  return statePath(root, ...parts);
}
export async function readState(root, folder, name, fallback) {
  try {
    const file = await open(await statePath(root, folder, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      return JSON.parse((await boundedRead(file, MAX_STATE_BYTES, { allowUnlinkedSnapshot: true })).toString('utf8'));
    } finally { await file.close(); }
  } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function writeState(root, folder, name, data, { exclusive = false } = {}) {
  const serialized = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error('State file exceeds the 20 MB storage limit.');
  await stateDir(root, folder);
  const target = await statePath(root, folder, name);
  const temporary = exclusive ? target : `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
    if (!exclusive) { await statePath(root, folder, name); await rename(temporary, target); }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export async function listState(root, folder) {
  try { return (await readdir(await statePath(root, folder))).filter(f => f.endsWith('.json')).sort(); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
