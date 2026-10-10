import { ensureSqliteFolder, safeName, writeStateRecord } from './state.js';
import { openDatabase } from './sqlite.js';
import { createMemoryRecord, normalizeMemory, normalizeLoadout, boundMemoryResults, MEMORY_LAYERS, MEMORY_CATEGORIES } from './memory-policy.js';
import { searchMemory } from './memory-search.js';

export { createMemoryRecord, normalizeMemory } from './memory-policy.js';

export async function remember(root, input) {
  const memory = createMemoryRecord(input);
  await ensureSqliteFolder(root, 'memory');
  const db = await openDatabase(root);
  try {
    db.exec('BEGIN IMMEDIATE');
    writeStateRecord(db, 'memory', `${memory.id}.json`, memory, { exclusive: true });
    db.prepare('INSERT INTO memory_versions VALUES(?,?,?)').run(memory.id, memory.revision, JSON.stringify(memory));
    db.exec('COMMIT');
    return memory;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}
export async function recall(root, query = '', agent, options = {}) {
  return (await searchMemory(root, query, agent, { ...options, mode: 'lexical' })).matches;
}

// Bootstrap a few selected summaries/preferences even when task vocabulary
// differs. All startup retrieval is local; embeddings remain an explicit tool.
export async function memoryContext(root, query, agent, selection, { signal } = {}) {
  const loadout = normalizeLoadout(selection);
  const layers = loadout.layers.filter(layer => layer !== 'L1');
  const background = layers.length ? await recall(root, '', agent, { signal, loadout: { ...loadout, layers }, limit: 2 }) : [];
  const relevant = await recall(root, query.slice(0, 16000), agent, { signal, loadout });
  const unique = [...new Map([...background, ...relevant].map(note => [note.id, note])).values()];
  return { ...boundMemoryResults(unique, { limit: loadout.maxItems, maxChars: loadout.maxChars }), mode: 'lexical' };
}

export async function listMemories(root, { agent, allScopes = false, layer, status = 'all', offset = 0, limit = 50 } = {}) {
  if (agent !== undefined) safeName(agent);
  if (typeof allScopes !== 'boolean' || !['all', 'active', 'archived'].includes(status) || (layer !== undefined && !MEMORY_LAYERS.includes(layer))) throw new Error('Invalid memory list filter.');
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Memory page limit must be 1–200.');
  await ensureSqliteFolder(root, 'memory');
  const db = await openDatabase(root);
  try {
    const where = `r.folder='memory' AND (? OR r.scope='project' OR (r.scope='agent' AND r.agent=?))
      AND (? IS NULL OR coalesce(json_extract(r.data,'$.layer'),'L1')=?)
      AND (?='all' OR coalesce(json_extract(r.data,'$.status'),'active')=?)`;
    const args = [Number(allScopes), agent ?? null, layer ?? null, layer ?? null, status, status];
    db.exec('BEGIN');
    const total = db.prepare(`SELECT count(*) AS count FROM state_records r WHERE ${where}`).get(...args).count;
    const memories = db.prepare(`SELECT r.data,u.last_used,u.uses FROM state_records r LEFT JOIN memory_usage u ON u.id=substr(r.name,1,length(r.name)-5)
      WHERE ${where} ORDER BY r.created DESC,r.name LIMIT ? OFFSET ?`).all(...args, limit, offset).map(row => ({ ...normalizeMemory(JSON.parse(row.data)), lastUsed: row.last_used ?? null, useCount: row.uses ?? 0 }));
    return { memories, total, offset, limit };
  } finally { db.close(); }
}

export async function updateMemory(root, id, patch) {
  safeName(id);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 1) throw new Error('Memory edit requires its expected revision.');
  const allowed = ['expectedRevision', 'text', 'scope', 'agent', 'layer', 'category', 'status', 'expiresAt'];
  for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw new Error(`Unsupported memory edit field: ${key}.`);
  await ensureSqliteFolder(root, 'memory');
  const db = await openDatabase(root);
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare("SELECT data FROM state_records WHERE folder='memory' AND name=?").get(`${id}.json`);
    if (!row) throw new Error('Memory does not exist.');
    const previous = normalizeMemory(JSON.parse(row.data));
    if (previous.revision !== patch.expectedRevision) throw new Error('Memory changed; reload it before saving.');
    const { expectedRevision, ...changes } = patch;
    if (changes.layer && changes.layer !== previous.layer && changes.category === undefined) changes.category = MEMORY_CATEGORIES[changes.layer]?.[0];
    const current = normalizeMemory({ ...previous, ...changes, revision: previous.revision + 1, updated: new Date().toISOString() });
    if (current.scope === 'project') delete current.agent;
    db.prepare('INSERT OR IGNORE INTO memory_versions VALUES(?,?,?)').run(previous.id, previous.revision, JSON.stringify(previous));
    db.prepare('INSERT INTO memory_versions VALUES(?,?,?)').run(current.id, current.revision, JSON.stringify(current));
    writeStateRecord(db, 'memory', `${id}.json`, current);
    db.exec('COMMIT');
    return current;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

export async function memoryHistory(root, id, { offset = 0, limit = 50 } = {}) {
  safeName(id);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid memory revision page.');
  await ensureSqliteFolder(root, 'memory');
  const db = await openDatabase(root);
  try {
    db.exec('BEGIN');
    const current = db.prepare("SELECT data FROM state_records WHERE folder='memory' AND name=?").get(`${id}.json`);
    if (!current) throw new Error('Memory does not exist.');
    const versions = db.prepare('SELECT data FROM memory_versions WHERE id=? ORDER BY revision DESC LIMIT ? OFFSET ?').all(id, limit, offset).map(row => normalizeMemory(JSON.parse(row.data)));
    return { versions: versions.length || offset ? versions : [normalizeMemory(JSON.parse(current.data))] };
  } finally { db.close(); }
}

export async function recordMemoryUse(root, memories) {
  if (!memories.length) return;
  const db = await openDatabase(root);
  try {
    db.exec('BEGIN IMMEDIATE');
    const record = db.prepare(`INSERT INTO memory_usage(id,last_used,uses) SELECT ?,?,1 WHERE EXISTS
      (SELECT 1 FROM state_records WHERE folder='memory' AND name=? AND coalesce(json_extract(data,'$.revision'),1)=?)
      ON CONFLICT(id) DO UPDATE SET last_used=excluded.last_used,uses=memory_usage.uses+1`);
    const now = new Date().toISOString();
    for (const memory of memories) record.run(memory.id, now, `${memory.id}.json`, memory.revision ?? 1);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

export async function forget(root, id) {
  safeName(id);
  await ensureSqliteFolder(root, 'memory');
  const db = await openDatabase(root);
  try {
    db.exec('BEGIN IMMEDIATE');
    if (!db.prepare("DELETE FROM state_records WHERE folder='memory' AND name=?").run(`${id}.json`).changes) throw new Error('Memory does not exist.');
    db.prepare('DELETE FROM memory_fts WHERE name=?').run(`${id}.json`);
    db.prepare('DELETE FROM memory_versions WHERE id=?').run(id);
    db.prepare('DELETE FROM memory_usage WHERE id=?').run(id);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='index_sources'").get()) {
      db.prepare("DELETE FROM index_chunks WHERE kind='memory' AND source_key=?").run(id);
      db.prepare("DELETE FROM index_sources WHERE kind='memory' AND key=?").run(id);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}
