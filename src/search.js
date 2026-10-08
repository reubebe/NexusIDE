import { readdir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { protectedName } from './file-policy.js';
import { boundedRead } from './bounded-read.js';
const excluded = new Set(['.git', '.nexus', '.research', '.ssh', 'node_modules', 'dist', 'build', '.venv', '__pycache__']);
export async function searchProject(root, query, { limit = 100 } = {}) {
  if (typeof query !== 'string' || !query || query.length > 200) throw new Error('Search query must contain 1–200 characters.');
  const matches = []; let visited = 0, bytes = 0, truncated = false;
  async function walk(directory, prefix = '', depth = 0) {
    if (depth > 20) { truncated = true; return; }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (visited >= 2000 || matches.length >= limit || bytes >= 10000000) { truncated = true; return; }
      if (entry.isSymbolicLink() || excluded.has(entry.name) || protectedName(entry.name)) continue;
      const file = path.join(directory, entry.name), relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(file, relative + '/', depth + 1);
      else if (entry.isFile()) {
        visited++;
        let handle;
        try {
          handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 100000 || stat.nlink !== 1) continue;
          bytes += stat.size;
          const content = await boundedRead(handle, 100000);
          if (content.includes(0)) continue;
          const lines = content.toString('utf8').split('\n');
          for (let i = 0; i < lines.length && matches.length < limit; i++) if (lines[i].toLowerCase().includes(query.toLowerCase())) matches.push({ path: relative, line: i + 1, text: lines[i].slice(0, 500) });
        } catch (e) { if (!['ENOENT', 'EACCES', 'ELOOP'].includes(e.code)) throw e; }
        finally { await handle?.close(); }
      }
    }
  }
  await walk(root);
  return { matches, visited, truncated };
}
