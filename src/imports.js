import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { installAgent } from './agents.js';
import { writeState } from './state.js';

export async function importMarkdownAgent(root, file, { name, source, revision, licenseFile } = {}) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200000) throw new Error('Agent must be a regular Markdown file under 200 KB.');
  const original = await readFile(file, 'utf8');
  const match = original.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const meta = match ? parse(match[1], { maxAliasCount: 20 }) : {};
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Agent metadata must be an object.');
  const slug = name || String(meta.name || path.basename(file, '.md')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  const agent = { version: 1, name: slug, instructions: match ? match[2] : original, permissions: { read: true, write: false, execute: false } };
  const report = { name: slug, source: source || path.resolve(file), revision: revision || null, sha256: createHash('sha256').update(original).digest('hex'), imported: new Date().toISOString(), format: match ? 'markdown-frontmatter' : 'markdown', compatibility: 'instructions-only', original, metadata: meta, license: licenseFile ? await readFile(licenseFile, 'utf8') : null, warnings: ['Only instructions are imported. Tools, hooks, model preferences, memory claims and workflow semantics are not automatically implemented.', 'Read-only permissions are assigned by NexusIDE; source metadata grants no capabilities.'] };
  // Validate and create before recording provenance; duplicates never overwrite the agent.
  await installAgent(root, agent);
  await writeState(root, 'imports', `${slug}.json`, report, { exclusive: true });
  return { ...report, original: undefined, agent };
}
