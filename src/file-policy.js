import { realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

export const protectedNames = new Set(['.git', '.nexus', '.research', '.ssh', '.aws', '.gnupg', '.netrc', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519', 'node_modules']);
export function protectedName(name) {
  // Protect aliases on case-insensitive filesystems (the default on macOS).
  const normalized = name.toLowerCase();
  return protectedNames.has(normalized) || normalized.startsWith('.env');
}

export async function resolveProjectPath(root, input) {
  if (typeof input !== 'string' || !input || path.isAbsolute(input)) throw new Error('Use a relative project path.');
  const base = await realpath(root), target = path.resolve(base, input), relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path leaves project.');
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.some(protectedName)) throw new Error('Protected path.');
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not accessible to agents.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
