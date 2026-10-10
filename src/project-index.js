import { opendir, open, realpath } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { protectedName, resolveProjectPath } from './file-policy.js';
import { boundedRead } from './bounded-read.js';
import { loadConfig } from './config.js';
import { validateEmbedding } from './embedding-config.js';
import { embed } from './embeddings.js';
import { digest, configKey, updateIndex, openIndex, decodeVector } from './index-store.js';
import { ftsQuery, searchBudget, reciprocalRankFusion } from './memory-search.js';
import { boundMemoryResults } from './memory-policy.js';

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

export async function rebuildProjectIndex(root, { signal, force = false, mode = 'hybrid' } = {}) {
  if (!['lexical', 'hybrid', 'semantic'].includes(mode)) throw new Error('Search mode must be lexical, semantic, or hybrid.');
  const configured = mode === 'lexical' ? null : (await loadConfig(root)).embeddings;
  const config = configured || mode === 'semantic' ? validateEmbedding(configured) : null, stats = {};
  return updateIndex(root, 'project', config, projectSources(await realpath(root), stats, signal), { signal, force, stats });
}

export async function searchProject(root, query, options = {}) {
  const { mode = 'hybrid', strictEmbedding = false } = options;
  if (!['lexical', 'hybrid', 'semantic'].includes(mode)) throw new Error('Search mode must be lexical, semantic, or hybrid.');
  if (typeof query !== 'string' || !query.trim() || query.length > 4000) throw new Error('Project query must contain 1–4000 characters.');
  const budget = searchBudget({ ...options, limit: options.limit ?? 12 });
  const candidates = Math.max(60, budget.limit * 5), strict = strictEmbedding || mode === 'semantic';
  let config, warning, usedMode = mode;
  if (mode !== 'lexical') {
    try { config = validateEmbedding((await loadConfig(root)).embeddings); }
    catch (error) { if (strict) throw error; usedMode = 'lexical'; warning = 'Embeddings are not configured; using keyword search.'; }
  }
  budget.check();
  const index = await openIndex(root, 'project', config, { anyConfig: !strict });
  try {
    const { db, meta } = index;
    const validity = new Map(), staleKeys = new Set();
    let visited = 0, lexical = [], semantic = [];
    async function current(row) {
      budget.check();
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
      budget.check();
      if (!validity.get(row.source_key)) staleKeys.add(`${row.source_key}:${row.position}`);
      return validity.get(row.source_key);
    }
    const result = (row, score, type) => ({ path: row.source_key, start: row.start, end: row.end, digest: row.digest, score, [`${type}Score`]: score, text: row.content.slice(0, 700) });
    const key = item => `${item.path}:${item.start}`;
    const terms = ftsQuery(query);
    if (mode !== 'semantic' && terms) {
      // Validate source contents before accepting candidates, so stale high
      // ranking chunks cannot crowd current documents out of the result set.
      for (const row of db.prepare(`SELECT c.*,s.digest,-bm25(project_chunks_fts,1,2) AS score
        FROM project_chunks_fts JOIN index_chunks c ON c.rowid=project_chunks_fts.rowid
        JOIN index_sources s ON s.kind=c.kind AND s.key=c.source_key
        WHERE project_chunks_fts MATCH ? AND c.kind='project'
        ORDER BY bm25(project_chunks_fts,1,2),c.source_key,c.position`).iterate(terms)) {
        if (++visited % 128 === 0) await setImmediate();
        if (await current(row)) lexical.push(result(row, row.score, 'lexical'));
        if (lexical.length >= candidates) break;
      }
    }
    budget.check();
    if (config && meta.config !== configKey(config)) {
      if (strict) throw new Error('Rebuild the project index for the configured embedding model.');
      usedMode = 'lexical'; warning = 'The semantic index needs rebuilding; using keyword search.';
    } else if (config && meta.chunks) {
      try {
        const [needle] = await embed(config, [query], budget.signal);
        if (needle.length !== meta.dimensions) throw new Error('Embedding dimensions changed; rebuild the project index.');
        const lexicalRanks = new Map(lexical.map((item, rank) => [key(item), rank]));
        const compare = (a, b) => b.score - a.score || (lexicalRanks.get(key(a)) ?? Infinity) - (lexicalRanks.get(key(b)) ?? Infinity) || key(a).localeCompare(key(b));
        for (const row of db.prepare(`SELECT c.*,s.digest FROM index_chunks c JOIN index_sources s
          ON s.kind=c.kind AND s.key=c.source_key WHERE c.kind='project' ORDER BY c.source_key,c.position`).iterate()) {
          if (++visited % 128 === 0) await setImmediate();
          budget.check();
          const vector = decodeVector(row.vector, meta.dimensions);
          const score = vector.reduce((sum, value, i) => sum + value * needle[i], 0);
          const candidate = result(row, score, 'semantic');
          if (semantic.length >= candidates && compare(candidate, semantic.at(-1)) >= 0) continue;
          if (!await current(row)) continue;
          const at = semantic.findIndex(item => compare(candidate, item) < 0);
          semantic.splice(at < 0 ? semantic.length : at, 0, candidate);
          if (semantic.length > candidates) semantic.pop();
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        // Filesystem policy failures still fail closed, even when keywords are
        // available. Only embedding/search budget failures permit fallback.
        if (strict || /Symbolic links|protected|outside|Corrupt index/i.test(error.message)) throw error;
        usedMode = 'lexical'; semantic = [];
        warning = error.name === 'TimeoutError' ? 'Semantic search timed out; using keyword search.' : 'Semantic search is unavailable; using keyword search.';
      }
    }
    const ranked = usedMode === 'hybrid' ? reciprocalRankFusion(lexical, semantic, key, candidates) : usedMode === 'semantic' ? semantic : lexical;
    const bounded = boundMemoryResults(ranked, budget);
    return { ...bounded, mode: usedMode, ...(warning ? { warning } : {}), stale: staleKeys.size, indexed: meta.chunks, files: meta.files, truncated: bounded.truncated || Boolean(meta.truncated), built: meta.built };
  } finally { index.close(); }
}

// Existing callers retain strict embedding configuration/index errors, while
// the general search entry point offers an offline keyword fallback.
export async function semanticProjectSearch(root, query, options = {}) {
  return searchProject(root, query, { ...options, mode: 'hybrid', strictEmbedding: true });
}
