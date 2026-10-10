import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { openDatabase } from './sqlite.js';
import { readState } from './state.js';
import { embed, normalizeVector } from './embeddings.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const configKey = config => JSON.stringify({ model: config?.model ?? null, url: config?.url ?? null, chunker: 1 });
const MAX_VECTOR_BYTES = 512 * 1024 * 1024;

export function indexSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      kind TEXT PRIMARY KEY, generation TEXT NOT NULL, config TEXT NOT NULL,
      built TEXT NOT NULL, dimensions INTEGER NOT NULL, files INTEGER NOT NULL,
      bytes INTEGER NOT NULL, truncated INTEGER NOT NULL, chunks INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS index_sources (
      kind TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL,
      metadata TEXT NOT NULL, PRIMARY KEY(kind, key)
    );
    CREATE TABLE IF NOT EXISTS index_chunks (
      kind TEXT NOT NULL, source_key TEXT NOT NULL, position INTEGER NOT NULL,
      start INTEGER NOT NULL, end INTEGER NOT NULL, hash TEXT NOT NULL,
      content TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(kind, source_key, position)
    );
    CREATE INDEX IF NOT EXISTS index_chunks_hash ON index_chunks(kind, hash);
    CREATE VIRTUAL TABLE IF NOT EXISTS project_chunks_fts USING fts5(content, path, tokenize='unicode61 remove_diacritics 2');
    CREATE TABLE IF NOT EXISTS index_fts_versions (kind TEXT PRIMARY KEY, version INTEGER NOT NULL);
  `);
  if (!db.prepare("SELECT 1 FROM index_fts_versions WHERE kind='project' AND version=1").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare("SELECT 1 FROM index_fts_versions WHERE kind='project' AND version=1").get()) {
        db.exec(`DELETE FROM project_chunks_fts;
          INSERT INTO project_chunks_fts(rowid,content,path) SELECT rowid,content,source_key FROM index_chunks WHERE kind='project';
          INSERT OR REPLACE INTO index_fts_versions VALUES ('project',1);`);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}

export function encodeVector(vector) {
  const buffer = Buffer.alloc(vector.length * 8);
  vector.forEach((value, i) => buffer.writeDoubleLE(value, i * 8));
  return buffer;
}
export function decodeVector(buffer, dimensions) {
  if (buffer.length !== dimensions * 8 || dimensions < 1 || dimensions > 8192) throw new Error('Corrupt index vector dimensions.');
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const vector = Array.from({ length: dimensions }, (_, i) => bytes.readDoubleLE(i * 8));
  if (vector.some(value => !Number.isFinite(value))) throw new Error('Corrupt index vector.');
  return vector;
}

// Only the optional legacy cache is read here. Original JSON remains untouched.
async function legacyIndex(root, kind, config) {
  const old = await readState(root, 'indexes', `${kind}.json`, null);
  if (!old || old.version !== 1 || !old.config || configKey(old.config) !== configKey(config) || !Array.isArray(old.entries)) return null;
  if (!Number.isInteger(old.dimensions) || old.dimensions < 0 || old.dimensions > 8192) throw new Error('Corrupt legacy index dimensions.');
  return old;
}

export async function updateIndex(root, kind, config, sources, { signal, force = false, stats = {} } = {}) {
  signal?.throwIfAborted();
  const db = await openDatabase(root);
  try {
    indexSchema(db);
    const base = db.prepare('SELECT * FROM index_meta WHERE kind = ?').get(kind);
    const compatible = !force && base?.config === configKey(config);
    const legacy = config && !base && !force ? await legacyIndex(root, kind, config) : null;
    // TEMP tables are private to this connection and disappear on close/crash.
    // No write transaction is held while waiting for the embedding service.
    db.exec(`CREATE TEMP TABLE staged_sources (key TEXT PRIMARY KEY, digest TEXT, bytes INTEGER, metadata TEXT);
      CREATE TEMP TABLE staged_chunks (source_key TEXT, position INTEGER, start INTEGER, end INTEGER, hash TEXT, content TEXT, vector BLOB, PRIMARY KEY(source_key, position));
      CREATE INDEX temp.staged_hash ON staged_chunks(hash);`);
    const saveSource = db.prepare('INSERT INTO staged_sources VALUES (?, ?, ?, ?)');
    const saveChunk = db.prepare('INSERT INTO staged_chunks VALUES (?, ?, ?, ?, ?, ?, ?)');
    const oldVector = db.prepare(`SELECT c.vector FROM index_chunks c JOIN index_meta m ON m.kind = c.kind
      WHERE c.kind = ? AND m.generation = ? AND c.hash = ? AND c.content = ? LIMIT 1`);
    const stagedVector = db.prepare('SELECT vector FROM staged_chunks WHERE hash = ? AND content = ? LIMIT 1');
    const legacyVectors = new Map();
    for (const entry of legacy?.entries || []) {
      const key = kind === 'project' ? digest(entry.content || '') : `${entry.id}:${entry.digest}`;
      legacyVectors.set(key, entry);
    }
    let indexed = 0, embedded = 0, reused = 0, files = 0, bytes = 0;
    let dimensions = compatible ? base.dimensions : legacy?.dimensions || 0;
    let pending = [];
    async function flush() {
      if (!pending.length) return;
      signal?.throwIfAborted();
      const vectors = await embed(config, pending.map(item => item.chunk.content), signal);
      signal?.throwIfAborted();
      vectors.forEach((vector, i) => {
        dimensions ||= vector.length;
        if (vector.length !== dimensions) throw new Error('Embedding dimensions changed during indexing; retry with --force.');
        const { source, chunk, position, hash } = pending[i];
        saveChunk.run(source.key, position, chunk.start, chunk.end, hash, chunk.content, encodeVector(vector));
      });
      embedded += pending.length;
      pending = [];
    }
    for await (const source of sources) {
      signal?.throwIfAborted();
      saveSource.run(source.key, source.digest, source.bytes, JSON.stringify(source.metadata || {}));
      files++; bytes += source.bytes;
      for (const [position, chunk] of source.chunks.entries()) {
        const hash = digest(chunk.content);
        let stored = !force ? stagedVector.get(hash, chunk.content)?.vector : null;
        if (!stored && compatible) stored = oldVector.get(kind, base.generation, hash, chunk.content)?.vector;
        const old = legacyVectors.get(kind === 'project' ? hash : `${source.key}:${source.digest}`);
        if (!stored && old && (kind !== 'project' || old.content === chunk.content)) {
          const vector = normalizeVector(old.vector);
          if (vector.length !== dimensions) throw new Error('Corrupt legacy index vector dimensions.');
          stored = encodeVector(vector);
        }
        if (!config) {
          saveChunk.run(source.key, position, chunk.start, chunk.end, hash, chunk.content, Buffer.alloc(0));
          if (compatible && oldVector.get(kind, base.generation, hash, chunk.content)) reused++;
        } else if (stored) {
          decodeVector(stored, dimensions);
          saveChunk.run(source.key, position, chunk.start, chunk.end, hash, chunk.content, stored);
          reused++;
        } else {
          pending.push({ source, chunk, position, hash });
          if (pending.length >= 8) await flush();
        }
        indexed++;
        if (indexed % 128 === 0) { await setImmediate(); signal?.throwIfAborted(); }
        if (indexed * dimensions * 8 > MAX_VECTOR_BYTES) throw new Error('Index vector storage exceeds 512 MiB; reduce the project scope.');
      }
    }
    await flush();
    if (indexed * dimensions * 8 > MAX_VECTOR_BYTES) throw new Error('Index vector storage exceeds 512 MiB; reduce the project scope.');
    signal?.throwIfAborted();
    const built = new Date().toISOString();
    let deleted = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT generation FROM index_meta WHERE kind = ?').get(kind);
      if (current?.generation !== base?.generation) throw new Error('Index changed during this build; retry to use the newer generation.');
      deleted = db.prepare('SELECT count(*) AS count FROM index_sources WHERE kind = ? AND key NOT IN (SELECT key FROM staged_sources)').get(kind).count;
      db.prepare('DELETE FROM index_sources WHERE kind = ? AND key NOT IN (SELECT key FROM staged_sources)').run(kind);
      db.prepare(`DELETE FROM index_chunks WHERE kind = ? AND NOT EXISTS
        (SELECT 1 FROM staged_chunks s WHERE s.source_key=index_chunks.source_key AND s.position=index_chunks.position)`).run(kind);
      db.prepare(`INSERT INTO index_sources SELECT ?, key, digest, bytes, metadata FROM staged_sources WHERE true
        ON CONFLICT(kind,key) DO UPDATE SET digest=excluded.digest, bytes=excluded.bytes, metadata=excluded.metadata
        WHERE digest!=excluded.digest OR bytes!=excluded.bytes OR metadata!=excluded.metadata`).run(kind);
      db.prepare(`INSERT INTO index_chunks SELECT ?, source_key, position, start, end, hash, content, vector FROM staged_chunks WHERE true
        ON CONFLICT(kind,source_key,position) DO UPDATE SET start=excluded.start, end=excluded.end,
        hash=excluded.hash, content=excluded.content, vector=excluded.vector
        WHERE start!=excluded.start OR end!=excluded.end OR hash!=excluded.hash OR vector!=excluded.vector`).run(kind);
      if (kind === 'project') {
        // Synchronize FTS in the same publication transaction as source digests
        // and vectors. No triggers are required with trusted_schema disabled.
        db.exec(`DELETE FROM project_chunks_fts WHERE rowid IN (
          SELECT f.rowid FROM project_chunks_fts f LEFT JOIN index_chunks c ON c.rowid=f.rowid
          WHERE c.rowid IS NULL OR c.kind!='project' OR f.content!=c.content OR f.path!=c.source_key);
          INSERT INTO project_chunks_fts(rowid,content,path)
          SELECT c.rowid,c.content,c.source_key FROM index_chunks c LEFT JOIN project_chunks_fts f ON f.rowid=c.rowid
          WHERE c.kind='project' AND f.rowid IS NULL;`);
      }
      db.prepare('INSERT OR REPLACE INTO index_meta VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(kind, randomUUID(), configKey(config), built, indexed ? dimensions : 0, files, bytes, Number(Boolean(stats.truncated)), indexed);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { indexed, embedded, reused, deleted, files, bytes, dimensions: indexed ? dimensions : 0, truncated: Boolean(stats.truncated), model: config?.model ?? null, mode: config ? 'hybrid' : 'lexical', built, storage: 'sqlite', migrated: Boolean(legacy) };
  } finally { db.close(); }
}

export async function openIndex(root, kind, config, { anyConfig = false } = {}) {
  const db = await openDatabase(root);
  try {
    indexSchema(db);
    // A read snapshot keeps metadata/chunks consistent across concurrent publishes.
    db.exec('BEGIN');
    const meta = db.prepare('SELECT * FROM index_meta WHERE kind = ?').get(kind);
    if (!meta || (!anyConfig && meta.config !== configKey(config))) throw new Error(`Rebuild the ${kind} index for the configured embedding model.`);
    return { db, meta, close() { db.exec('ROLLBACK'); db.close(); } };
  } catch (error) { db.close(); throw error; }
}

// A bounded sorted result set: vector rows stream from SQLite, never a giant JSON array.
export function keepBest(matches, candidate, limit) {
  if (matches.length >= limit && candidate.score <= matches.at(-1).score) return;
  const at = matches.findIndex(value => value.score < candidate.score);
  matches.splice(at < 0 ? matches.length : at, 0, candidate);
  if (matches.length > limit) matches.pop();
}
