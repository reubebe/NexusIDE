import { createHash } from 'node:crypto';
import { readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { protectedName } from './file-policy.js';
import { loadConfig } from './config.js';
import { validateEmbedding } from './embedding-config.js';
import { embed } from './semantic-memory.js';
import { readState, writeState } from './state.js';

const excluded = new Set(['dist', 'build', '.venv', '__pycache__']);
const extensions = new Set(['.c', '.cc', '.cpp', '.css', '.go', '.h', '.html', '.java', '.js', '.json', '.jsx', '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.ts', '.tsx', '.txt', '.yaml', '.yml']);
const digest = value => createHash('sha256').update(value).digest('hex');

async function projectChunks(root) {
  const chunks = []; let files = 0, bytes = 0, truncated = false;
  async function walk(directory, prefix = '', depth = 0) {
    if (depth > 20) { truncated = true; return; }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files >= 500 || bytes >= 5_000_000 || chunks.length >= 1000) { truncated = true; return; }
      if (entry.isSymbolicLink() || excluded.has(entry.name) || protectedName(entry.name)) continue;
      const absolute = path.join(directory, entry.name), relative = prefix + entry.name;
      if (entry.isDirectory()) { await walk(absolute, relative + '/', depth + 1); continue; }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      let handle;
      try {
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 100_000 || bytes + stat.size > 5_000_000) continue;
        const buffer = await handle.readFile();
        if (buffer.includes(0)) continue;
        const text = buffer.toString('utf8'); files++; bytes += buffer.length;
        const fileDigest = digest(buffer);
        for (let start = 0; start < text.length && chunks.length < 1000; start += 1800) {
          const content = text.slice(start, start + 2000);
          if (content.trim()) chunks.push({ path: relative, start, end: start + content.length, digest: fileDigest, content });
        }
      } finally { await handle?.close(); }
    }
  }
  await walk(root);
  return { chunks, files, bytes, truncated };
}

export async function rebuildProjectIndex(root, { signal } = {}) {
  const config = validateEmbedding((await loadConfig(root)).embeddings);
  const source = await projectChunks(root), entries = []; let dimensions = 0;
  for (let offset = 0; offset < source.chunks.length; offset += 8) {
    signal?.throwIfAborted();
    const batch = source.chunks.slice(offset, offset + 8);
    const vectors = await embed(config, batch.map(item => item.content), signal);
    vectors.forEach((vector, index) => { dimensions ||= vector.length; if (vector.length !== dimensions) throw new Error('Embedding dimensions changed during indexing.'); entries.push({ ...batch[index], vector }); });
  }
  const index = { version: 1, config, built: new Date().toISOString(), dimensions, files: source.files, bytes: source.bytes, truncated: source.truncated, entries };
  if (Buffer.byteLength(JSON.stringify(index)) > 24_000_000) throw new Error('Project index exceeds the 24 MB storage limit.');
  await writeState(root, 'indexes', 'project.json', index);
  return { indexed: entries.length, files: source.files, bytes: source.bytes, dimensions, truncated: source.truncated, model: config.model, built: index.built };
}

export async function semanticProjectSearch(root, query, { signal, limit = 12 } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 4000) throw new Error('Project query must contain 1–4000 characters.');
  const config = validateEmbedding((await loadConfig(root)).embeddings);
  const index = await readState(root, 'indexes', 'project.json', null);
  if (!index || index.version !== 1 || JSON.stringify(index.config) !== JSON.stringify(config)) throw new Error('Rebuild the project index for the configured embedding model.');
  const [needle] = await embed(config, [query], signal);
  if (needle.length !== index.dimensions) throw new Error('Embedding dimensions changed; rebuild the project index.');
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [])].filter(term => !['the', 'and', 'where', 'what', 'which', 'with', 'from', 'this', 'that', 'defined'].includes(term));
  const ranked = index.entries.map(entry => {
    const semantic = entry.vector.reduce((sum, value, i) => sum + value * needle[i], 0);
    const haystack = `${entry.path}\n${entry.content}`.toLowerCase();
    const lexical = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0) / Math.max(1, terms.length);
    return { ...entry, score: semantic + lexical * 0.35, semanticScore: semantic, lexicalScore: lexical };
  }).sort((a, b) => b.score - a.score);
  const wanted = Math.max(1, Math.min(20, limit)), matches = []; let stale = 0;
  for (const candidate of ranked) {
    if (matches.length >= wanted) break;
    let handle;
    try {
      const absolute = path.resolve(root, candidate.path);
      if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Corrupt project index path.');
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      const current = stat.isFile() && stat.nlink === 1 && stat.size <= 100_000 ? await handle.readFile() : null;
      if (!current || digest(current) !== candidate.digest) { stale++; continue; }
      const { vector, content, ...entry } = candidate; matches.push({ ...entry, text: content.slice(0, 700) });
    } catch (error) { if (['ENOENT', 'EACCES', 'ELOOP'].includes(error.code)) stale++; else throw error; }
    finally { await handle?.close(); }
  }
  return { matches, stale, indexed: index.entries.length, files: index.files, truncated: index.truncated, built: index.built };
}
