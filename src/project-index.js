import { createHash } from 'node:crypto';
import { readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { protectedName, resolveProjectPath } from './file-policy.js';
import { boundedRead } from './bounded-read.js';
import { loadConfig } from './config.js';
import { validateEmbedding } from './embedding-config.js';
import { embed } from './semantic-memory.js';
import { readState, writeState } from './state.js';

const excluded = new Set(['dist', 'build', '.venv', '__pycache__']);
const extensions = new Set(['.c', '.cc', '.cpp', '.css', '.go', '.h', '.html', '.java', '.js', '.json', '.jsx', '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.ts', '.tsx', '.txt', '.yaml', '.yml']);
const digest = value => createHash('sha256').update(value).digest('hex');

async function projectChunks(root, signal) {
  const chunks = []; let files = 0, bytes = 0, visited = 0, truncated = false;
  async function walk(directory, prefix = '', depth = 0) {
    if (depth > 20) { truncated = true; return; }
    signal?.throwIfAborted();
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (files >= 500 || bytes >= 5_000_000 || chunks.length >= 1000 || visited++ >= 10000) { truncated = true; return; }
      if (entry.isSymbolicLink() || excluded.has(entry.name) || protectedName(entry.name)) continue;
      const absolute = path.join(directory, entry.name), relative = prefix + entry.name;
      if (entry.isDirectory()) { await walk(absolute, relative + '/', depth + 1); continue; }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      let handle;
      try {
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 100_000) continue;
        if (bytes + stat.size > 5_000_000) { truncated = true; continue; }
        const buffer = await boundedRead(handle, 100_000);
        if (buffer.includes(0) || !Buffer.from(buffer.toString('utf8')).equals(buffer)) continue;
        const text = buffer.toString('utf8'); files++; bytes += buffer.length;
        const fileDigest = digest(buffer);
        for (let start = 0; start < text.length && chunks.length < 1000; start += 1800) {
          const content = text.slice(start, start + 2000);
          if (content.trim()) chunks.push({ path: relative, start, end: start + content.length, digest: fileDigest, content });
        }
        if (chunks.length >= 1000 && chunks.at(-1)?.end < text.length) truncated = true;
      } catch (error) { if (!['ENOENT', 'EACCES', 'ELOOP'].includes(error.code)) throw error; }
      finally { await handle?.close(); }
    }
  }
  await walk(root);
  return { chunks, files, bytes, truncated };
}

export async function rebuildProjectIndex(root, { signal } = {}) {
  const config = validateEmbedding((await loadConfig(root)).embeddings);
  const source = await projectChunks(root, signal), entries = []; let dimensions = 0;
  for (let offset = 0; offset < source.chunks.length; offset += 8) {
    signal?.throwIfAborted();
    const batch = source.chunks.slice(offset, offset + 8);
    const vectors = await embed(config, batch.map(item => item.content), signal);
    vectors.forEach((vector, index) => { dimensions ||= vector.length; if (vector.length !== dimensions) throw new Error('Embedding dimensions changed during indexing.'); entries.push({ ...batch[index], vector }); });
  }
  const index = { version: 1, config, built: new Date().toISOString(), dimensions, files: source.files, bytes: source.bytes, truncated: source.truncated, entries };
  signal?.throwIfAborted();
  await writeState(root, 'indexes', 'project.json', index);
  return { indexed: entries.length, files: source.files, bytes: source.bytes, dimensions, truncated: source.truncated, model: config.model, built: index.built };
}

export async function semanticProjectSearch(root, query, { signal, limit = 12 } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 4000) throw new Error('Project query must contain 1–4000 characters.');
  const config = validateEmbedding((await loadConfig(root)).embeddings);
  const index = await readState(root, 'indexes', 'project.json', null);
  if (!index || index.version !== 1 || JSON.stringify(index.config) !== JSON.stringify(config)) throw new Error('Rebuild the project index for the configured embedding model.');
  if (!Array.isArray(index.entries) || index.entries.length > 1000) throw new Error('Corrupt project index.');
  if (!index.entries.length) return { matches: [], stale: 0, indexed: 0, files: index.files, truncated: index.truncated, built: index.built };
  const [needle] = await embed(config, [query], signal);
  if (needle.length !== index.dimensions) throw new Error('Embedding dimensions changed; rebuild the project index.');
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [])].filter(term => !['the', 'and', 'where', 'what', 'which', 'with', 'from', 'this', 'that', 'defined'].includes(term));
  const ranked = index.entries.map(entry => {
    if (!Array.isArray(entry.vector) || entry.vector.length !== needle.length || entry.vector.some(value => !Number.isFinite(value))) throw new Error('Corrupt project vector dimensions.');
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
      const absolute = await resolveProjectPath(root, candidate.path);
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      const current = stat.isFile() && stat.nlink === 1 && stat.size <= 100_000 ? await boundedRead(handle, 100_000) : null;
      if (!current || digest(current) !== candidate.digest) { stale++; continue; }
      const { vector, content, ...entry } = candidate; matches.push({ ...entry, text: content.slice(0, 700) });
    } catch (error) { if (['ENOENT', 'EACCES', 'ELOOP'].includes(error.code)) stale++; else throw error; }
    finally { await handle?.close(); }
  }
  return { matches, stale, indexed: index.entries.length, files: index.files, truncated: index.truncated, built: index.built };
}
