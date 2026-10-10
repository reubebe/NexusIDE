import { loadConfig } from './config.js';
import { validateEmbedding } from './embedding-config.js';
export { validateEmbedding } from './embedding-config.js';
export { embed } from './embeddings.js';
import { ensureSqliteFolder } from './state.js';
import { openDatabase } from './sqlite.js';
import { digest, updateIndex } from './index-store.js';
import { searchMemory } from './memory-search.js';

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

export async function semanticRecall(root, query, agent, options = {}) {
  return searchMemory(root, query, agent, { ...options, mode: 'semantic' });
}
