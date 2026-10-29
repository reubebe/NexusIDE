import { readdir, lstat, realpath } from 'node:fs/promises';
import { protectedName, resolveProjectPath } from './file-policy.js';
import { readState, writeState } from './state.js';
import path from 'node:path';

export async function projectFiles(root, relative = '.') {
  const target = await resolveProjectPath(root, relative);
  const entries = (await readdir(target, { withFileTypes: true })).filter(e => !e.isSymbolicLink() && !protectedName(e.name) && (e.isFile() || e.isDirectory()));
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries.slice(0, 500)) {
    try { const stat = await lstat(path.join(target, entry.name)); if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) continue;
      files.push({ name: entry.name, directory: stat.isDirectory(), size: stat.size, modified: stat.mtime.toISOString() });
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return { path: relative, entries: files.map(f => f.name + (f.directory ? '/' : '')), metadata: files, truncated: entries.length > 500 };
}
export async function projectPins(root, input) {
  root = await realpath(root);
  if (input !== undefined) {
    if (!Array.isArray(input) || input.length > 20 || input.some(p => typeof p !== 'string' || p.length > 1000)) throw new Error('Use at most 20 project-relative folder pins.');
    const pins = [];
    for (const p of input) { const target = await resolveProjectPath(root, p); if (!(await lstat(target)).isDirectory()) throw new Error('Pins must name existing project folders.'); pins.push(path.relative(root, target) || '.'); }
    await writeState(root, 'preferences', 'file-pins.json', [...new Set(pins)]);
  }
  const saved = await readState(root, 'preferences', 'file-pins.json', []), pins = [];
  for (const p of saved) { try { const target = await resolveProjectPath(root, p); if ((await lstat(target)).isDirectory()) pins.push(p); } catch { /* Hide moved, removed or newly protected pins. */ } }
  return pins;
}
