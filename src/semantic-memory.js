import { loadConfig } from './config.js';
import { setImmediate } from 'node:timers/promises';
import { validateEmbedding } from './embedding-config.js';
export { validateEmbedding } from './embedding-config.js';
export { embed } from './embeddings.js';
import { embed } from './embeddings.js';
import { ensureSqliteFolder } from './state.js';
import { openDatabase } from './sqlite.js';
import { digest, updateIndex, openIndex, decodeVector, keepBest } from './index-store.js';

const noteDigest = note => digest(JSON.stringify(note));

async function* noteSources(root, signal) {
  const db = await openDatabase(root);
  try {
    db.exec('BEGIN');
    for (const { data } of db.prepare("SELECT data FROM state_records WHERE folder='memory' ORDER BY name").iterate()) {
      signal?.throwIfAborted();
      const note = JSON.parse(data);
      if (typeof note.id !== 'string' || typeof note.text !== 'string' || !note.text.trim() || note.text.length > 16000) throw new Error('Invalid stored memory.');
      yield { key: note.id, digest: noteDigest(note), bytes: Buffer.byteLength(note.text),
        metadata: { scope: note.scope, agent: note.agent },
        chunks: [{ start: 0, end: note.text.length, content: note.text }] };
    }
  } finally { db.close(); }
}

export async function rebuildMemoryIndex(root, { signal, force = false } = {}) {
  const config = validateEmbedding((await loadConfig(root)).embeddings);
  await ensureSqliteFolder(root, 'memory');
  return updateIndex(root, 'memory', config, noteSources(root, signal), { signal, force });
}

export async function semanticRecall(root, query, agent, { signal } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 16000) throw new Error('Semantic query must contain 1–16000 characters.');
  const config = validateEmbedding((await loadConfig(root)).embeddings);
  await ensureSqliteFolder(root, 'memory');
  const index = await openIndex(root, 'memory', config);
  try {
    const { db, meta } = index;
    const scoped = db.prepare(`SELECT r.data, s.digest, c.vector FROM state_records r
      LEFT JOIN index_sources s ON s.kind='memory' AND s.key=substr(r.name,1,length(r.name)-5)
      LEFT JOIN index_chunks c ON c.kind=s.kind AND c.source_key=s.key
      WHERE r.folder='memory' AND (r.scope='project' OR (r.scope='agent' AND r.agent=?))`);
    let stale = 0, indexed = 0, visited = 0;
    for (const row of scoped.iterate(agent ?? null)) {
      if (++visited % 128 === 0) { await setImmediate(); signal?.throwIfAborted(); }
      if (!row.vector || row.digest !== noteDigest(JSON.parse(row.data))) stale++;
      else indexed++;
    }
    if (!indexed) return { matches: [], stale, indexed, built: meta.built };
    const [needle] = await embed(config, [query], signal);
    if (needle.length !== meta.dimensions) throw new Error('Embedding dimensions changed; rebuild the memory index.');
    const matches = [];
    for (const row of scoped.iterate(agent ?? null)) {
      if (++visited % 128 === 0) await setImmediate();
      signal?.throwIfAborted();
      const note = JSON.parse(row.data);
      if (!row.vector || row.digest !== noteDigest(note)) continue;
      const value = decodeVector(row.vector, meta.dimensions);
      keepBest(matches, { ...note, score: value.reduce((sum, x, i) => sum + x * needle[i], 0) }, 20);
    }
    return { matches, stale, indexed, built: meta.built };
  } finally { index.close(); }
}
