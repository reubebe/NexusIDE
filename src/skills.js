import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { readState, writeState, listState, safeName } from './state.js';
import { scanSkillFiles } from './skill-scan.js';

export function parseSkill(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md requires YAML frontmatter.');
  let meta;
  try { meta = parse(match[1], { maxAliasCount: 20 }); }
  catch { throw new Error('Invalid SKILL.md YAML frontmatter.'); }
  if (!meta || typeof meta.name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64 || typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 1024) throw new Error('Invalid skill name or description.');
  return { meta, instructions: match[2] };
}
export async function readSkillBundle(directory) {
  if (typeof directory !== 'string' || !directory) throw new Error('Provide a skill directory.');
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Skill symlinks are forbidden.');
  const canonicalRoot = await realpath(directory);
  const files = Object.create(null);
  let size = 0, count = 0;
  async function walk(dir, prefix = '') {
    if ((await lstat(dir)).isSymbolicLink() || await realpath(dir) !== dir) throw new Error('Skill symlinks are forbidden.');
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      if (++count > 500) throw new Error('Skill exceeds 500 files/directories.');
      if (entry.isSymbolicLink()) throw new Error('Skill symlinks are forbidden.');
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative + '/');
      else if (entry.isFile()) {
        const handle = await open(path.join(dir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1) throw new Error('Skill resources must be regular files without hard links.');
          if (size + stat.size > 10_000_000) throw new Error('Skill exceeds 10 MB.');
          const chunks = [];
          let bytes = 0;
          while (true) {
            const chunk = Buffer.alloc(Math.min(65536, 10_000_000 - size - bytes + 1));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            bytes += bytesRead;
            if (size + bytes > 10_000_000) throw new Error('Skill exceeds 10 MB.');
            chunks.push(chunk.subarray(0, bytesRead));
          }
          const after = await handle.stat();
          if (after.nlink !== 1 || stat.size !== bytes || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('Skill resource changed during import; try again.');
          size += bytes;
          files[relative] = Buffer.concat(chunks, bytes).toString('base64');
        } finally { await handle.close(); }
      } else throw new Error('Unsupported skill file type.');
    }
  }
  await walk(canonicalRoot);
  if (!files['SKILL.md']) throw new Error('Directory needs SKILL.md.');
  const { meta, instructions } = parseSkill(Buffer.from(files['SKILL.md'], 'base64').toString('utf8'));
  return { files, meta, instructions };
}

export async function importSkill(root, directory, provenance = {}) {
  const { files, meta, instructions } = await readSkillBundle(directory);
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const scan = scanSkillFiles(files);
  const record = { name: meta.name, description: meta.description, meta, instructions, files, digest, scan, source: provenance.source || path.resolve(directory), revision: provenance.revision || null, license: provenance.license || null, imported: new Date().toISOString(), compatibility: 'instructions-and-resources', warnings: ['Scripts are stored as resources, never executed by import.', 'Skill allowed-tools and hooks do not grant permissions.', 'Static scan findings are indicators, not a safety guarantee.'] };
  await writeState(root, 'skills', `${meta.name}.json`, record, { exclusive: true });
  return { ...record, files: Object.keys(files) };
}
export async function loadSkill(root, name) {
  const skill = await readState(root, 'skills', `${safeName(name)}.json`);
  if (!skill.files || typeof skill.files !== 'object' || Array.isArray(skill.files) || Object.values(skill.files).some(v => typeof v !== 'string')) throw new Error('Invalid stored skill resources.');
  const digest = createHash('sha256').update(JSON.stringify(skill.files)).digest('hex');
  if (digest !== skill.digest) throw new Error('Skill resource digest mismatch. Re-import a reviewed source under a new name or restore the original record.');
  const source = Buffer.from(skill.files['SKILL.md'] || '', 'base64').toString('utf8');
  const parsed = parseSkill(source);
  if (parsed.meta.name !== name || skill.name !== name || parsed.meta.description !== skill.description || parsed.instructions !== skill.instructions) throw new Error('Stored skill instructions differ from SKILL.md.');
  return { ...skill, meta: parsed.meta };
}
export async function auditSkill(root, name) {
  safeName(name);
  try {
    const skill = await loadSkill(root, name);
    return { name, integrity: 'matches-record', source: skill.source, revision: skill.revision, license: skill.license, scan: scanSkillFiles(skill.files), note: 'Digest consistency is not publisher authentication. Someone able to edit local state can also change its digest.' };
  } catch (error) {
    return { name, integrity: 'unverified', error: error.message };
  }
}
export async function listSkills(root) {
  return Promise.all((await listState(root, 'skills')).map(async f => { const s = await readState(root, 'skills', f); return { name: s.name, description: s.description, digest: s.digest, compatibility: s.compatibility }; }));
}
export async function skillResource(root, agent, name, resource = 'SKILL.md') {
  if (!agent.skills?.includes(name)) throw new Error('Skill not granted to agent.');
  const s = await loadSkill(root, name);
  if (!Object.hasOwn(s.files, resource)) throw new Error('Unknown skill resource.');
  const content = Buffer.from(s.files[resource], 'base64');
  if (content.length > 100000 || content.includes(0)) throw new Error('Resource is binary or too large for text context.');
  return content.toString('utf8');
}
