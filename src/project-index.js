import { opendir, open, realpath } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { protectedName, resolveProjectPath } from './file-policy.js';
import { boundedRead } from './bounded-read.js';
import { loadConfig } from './config.js';
import { validateEmbedding } from './embedding-config.js';
import { embed } from './embeddings.js';
import { digest, updateIndex, openIndex, decodeVector, keepBest } from './index-store.js';

const excluded = new Set(['dist', 'build', '.venv', '__pycache__']);
const extensions = new Set(['.c', '.cc', '.cpp', '.css', '.go', '.h', '.html', '.java', '.js', '.json', '.jsx', '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.ts', '.tsx', '.txt', '.yaml', '.yml']);
export const PROJECT_INDEX_LIMITS = { files: 10000, bytes: 50_000_000, chunks: 30000, visited: 100000, fileBytes: 100000, depth: 20 };

async function* projectSources(root, stats, signal) {
  let files = 0, bytes = 0, chunks = 0, visited = 0;
  async function* walk(prefix = '', depth = 0) {
    if (depth > PROJECT_INDEX_LIMITS.depth) { stats.truncated = true; return; }
    if (visited >= PROJECT_INDEX_LIMITS.visited) { stats.truncated = true; return; }
    signal?.throwIfAborted();
    const directory = prefix ? await resolveProjectPath(root, prefix) : root;
    const entries = [];
    for await (const entry of await opendir(directory)) {
      signal?.throwIfAborted();
      if (visited >= PROJECT_INDEX_LIMITS.visited) { stats.truncated = true; break; }
      visited++;
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (files >= PROJECT_INDEX_LIMITS.files || bytes >= PROJECT_INDEX_LIMITS.bytes || chunks >= PROJECT_INDEX_LIMITS.chunks) { stats.truncated = true; return; }
      if (entry.isSymbolicLink() || excluded.has(entry.name.toLowerCase()) || protectedName(entry.name)) continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) { yield* walk(relative + '/', depth + 1); continue; }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      let handle, source;
      try {
        const absolute = await resolveProjectPath(root, relative);
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > PROJECT_INDEX_LIMITS.fileBytes) continue;
        if (bytes + stat.size > PROJECT_INDEX_LIMITS.bytes) { stats.truncated = true; continue; }
        const buffer = await boundedRead(handle, PROJECT_INDEX_LIMITS.fileBytes);
        if (buffer.includes(0) || !Buffer.from(buffer.toString('utf8')).equals(buffer)) continue;
        const text = buffer.toString('utf8'), parts = [];
        for (let start = 0; start < text.length; start += 1800) {
          const content = text.slice(start, start + 2000);
          if (content.trim()) parts.push({ start, end: start + content.length, content });
        }
        // Never publish only part of a file when reaching the chunk budget.
        if (chunks + parts.length > PROJECT_INDEX_LIMITS.chunks) { stats.truncated = true; continue; }
        files++; bytes += buffer.length; chunks += parts.length;
        source = { key: relative, digest: digest(buffer), bytes: buffer.length, chunks: parts };
      } catch (error) { if (!['ENOENT', 'EACCES', 'ELOOP'].includes(error.code)) throw error; }
      finally { await handle?.close(); }
      if (source) yield source;
    }
  }
  yield* walk();
}

export async function rebuildProjectIndex(root, { signal, force = false } = {}) {
  const config = validateEmbedding((await loadConfig(root)).embeddings), stats = {};
  return updateIndex(root, 'project', config, projectSources(await realpath(root), stats, signal), { signal, force, stats });
}

export async function semanticProjectSearch(root, query, { signal, limit = 12 } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 4000) throw new Error('Project query must contain 1–4000 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Search limit must be 1–20.');
  const config = validateEmbedding((await loadConfig(root)).embeddings);
  const index = await openIndex(root, 'project', config);
  try {
    const { db, meta } = index;
    if (!meta.chunks) return { matches: [], stale: 0, indexed: 0, files: meta.files, truncated: Boolean(meta.truncated), built: meta.built };
    const [needle] = await embed(config, [query], signal);
    if (needle.length !== meta.dimensions) throw new Error('Embedding dimensions changed; rebuild the project index.');
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [])].filter(term => !['the', 'and', 'where', 'what', 'which', 'with', 'from', 'this', 'that', 'defined'].includes(term));
    const matches = [], validity = new Map(); let stale = 0, visited = 0;
    for (const row of db.prepare(`SELECT c.*, s.digest FROM index_chunks c JOIN index_sources s
      ON s.kind = c.kind AND s.key = c.source_key WHERE c.kind = 'project'`).iterate()) {
      if (++visited % 128 === 0) await setImmediate();
      signal?.throwIfAborted();
      const vector = decodeVector(row.vector, meta.dimensions);
      const semanticScore = vector.reduce((sum, value, i) => sum + value * needle[i], 0);
      const haystack = `${row.source_key}\n${row.content}`.toLowerCase();
      const lexicalScore = terms.reduce((count, term) => count + Number(haystack.includes(term)), 0) / Math.max(1, terms.length);
      const score = semanticScore + lexicalScore * 0.35;
      if (matches.length >= limit && score <= matches.at(-1).score) continue;
      if (!validity.has(row.source_key)) {
        let handle;
        try {
          const absolute = await resolveProjectPath(root, row.source_key);
          handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = await handle.stat();
          const current = stat.isFile() && stat.nlink === 1 && stat.size <= PROJECT_INDEX_LIMITS.fileBytes ? await boundedRead(handle, PROJECT_INDEX_LIMITS.fileBytes) : null;
          validity.set(row.source_key, Boolean(current && digest(current) === row.digest));
        } catch (error) { if (['ENOENT', 'EACCES', 'ELOOP'].includes(error.code)) validity.set(row.source_key, false); else throw error; }
        finally { await handle?.close(); }
      }
      if (!validity.get(row.source_key)) { stale++; continue; }
      keepBest(matches, { path: row.source_key, start: row.start, end: row.end, digest: row.digest, score, semanticScore, lexicalScore, text: row.content.slice(0, 700) }, limit);
    }
    return { matches, stale, indexed: meta.chunks, files: meta.files, truncated: Boolean(meta.truncated), built: meta.built };
  } finally { index.close(); }
}
