import { mkdir, lstat, realpath, open, rename, unlink, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { boundedRead } from './bounded-read.js';
import { openDatabase } from './sqlite.js';

export const MAX_STATE_BYTES = 20_000_000;
const databaseFolders = new Set(['runs', 'workflows', 'memory']);
const absent = (folder, name) => Object.assign(new Error(`State record does not exist: ${folder}/${name}`), { code: 'ENOENT' });
const collision = (folder, name) => Object.assign(new Error(`State record already exists: ${folder}/${name}`), { code: 'EEXIST' });

function serialize(data) {
  const serialized = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error('State file exceeds the 20 MB storage limit.');
  // Match the JSON reader's behavior and reject undefined before changing state.
  JSON.parse(serialized);
  return serialized;
}
const metadata = data => ['started', 'created', 'scope', 'agent'].map(key => typeof data?.[key] === 'string' ? data[key] : null);
function putRecord(db, folder, name, data, serialized, exclusive = false) {
  const conflict = exclusive ? '' : ' ON CONFLICT(folder,name) DO UPDATE SET data=excluded.data, started=excluded.started, created=excluded.created, scope=excluded.scope, agent=excluded.agent';
  try { db.prepare(`INSERT INTO state_records(folder,name,data,started,created,scope,agent) VALUES(?,?,?,?,?,?,?)${conflict}`).run(folder, name, serialized, ...metadata(data)); }
  catch (error) { if (exclusive && error.errcode === 1555) throw collision(folder, name); throw error; }
}

async function stateDatabase(root, folder) {
  safeName(folder);
  const db = await openDatabase(root);
  try {
    if (!db.prepare('SELECT 1 FROM state_migrations WHERE folder=?').get(folder)) {
      // Stage one legacy record at a time so large histories do not accumulate in
      // JavaScript memory. TEMP writes do not lock the shared database while we
      // await filesystem reads; the complete folder is published atomically below.
      db.exec(`CREATE TEMP TABLE migrated_records (
        folder TEXT, name TEXT PRIMARY KEY, data TEXT, started TEXT, created TEXT, scope TEXT, agent TEXT
      )`);
      const stage = db.prepare('INSERT INTO migrated_records VALUES (?,?,?,?,?,?,?)');
      for (const name of await listJsonState(root, folder)) {
        const data = await readJsonState(root, folder, name);
        stage.run(folder, name, serialize(data), ...metadata(data));
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!db.prepare('SELECT 1 FROM state_migrations WHERE folder=?').get(folder)) {
          db.exec('INSERT INTO state_records SELECT * FROM migrated_records');
          db.prepare('INSERT INTO state_migrations(folder,migrated) VALUES(?,?)').run(folder, new Date().toISOString());
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

export async function ensureSqliteFolder(root, folder) {
  if (!databaseFolders.has(folder)) throw new Error('Folder is not stored in SQLite.');
  const db = await stateDatabase(root, folder);
  db.close();
}

export function safeName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value) || value.includes('..')) throw new Error('Invalid name.');
  return value;
}
export async function statePath(root, ...parts) {
  parts.forEach(safeName);
  let current = await realpath(root);
  for (const part of ['.nexus', ...parts]) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('State paths cannot be symbolic links.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return current;
}
export async function stateDir(root, ...parts) {
  const target = await statePath(root, ...parts);
  await mkdir(target, { recursive: true, mode: 0o700 });
  return statePath(root, ...parts);
}
export async function readState(root, folder, name, fallback) {
  safeName(folder); safeName(name);
  if (!databaseFolders.has(folder)) return readJsonState(root, folder, name, fallback);
  const db = await stateDatabase(root, folder);
  try {
    const record = db.prepare('SELECT data FROM state_records WHERE folder=? AND name=?').get(folder, name);
    if (record) return JSON.parse(record.data);
    if (fallback !== undefined) return fallback;
    throw absent(folder, name);
  } finally { db.close(); }
}
async function readJsonState(root, folder, name, fallback) {
  try {
    const file = await open(await statePath(root, folder, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      return JSON.parse((await boundedRead(file, MAX_STATE_BYTES, { allowUnlinkedSnapshot: true })).toString('utf8'));
    } finally { await file.close(); }
  } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function writeState(root, folder, name, data, { exclusive = false } = {}) {
  safeName(folder); safeName(name);
  const serialized = serialize(data);
  if (databaseFolders.has(folder)) {
    const db = await stateDatabase(root, folder);
    try { putRecord(db, folder, name, data, serialized, exclusive); }
    finally { db.close(); }
    return;
  }
  await stateDir(root, folder);
  const target = await statePath(root, folder, name);
  const temporary = exclusive ? target : `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
    if (!exclusive) { await statePath(root, folder, name); await rename(temporary, target); }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export async function listState(root, folder) {
  safeName(folder);
  if (!databaseFolders.has(folder)) return listJsonState(root, folder);
  const db = await stateDatabase(root, folder);
  try { return db.prepare("SELECT name FROM state_records WHERE folder=? AND name LIKE '%.json' ORDER BY name").all(folder).map(row => row.name); }
  finally { db.close(); }
}
async function listJsonState(root, folder) {
  try { return (await readdir(await statePath(root, folder))).filter(f => f.endsWith('.json')).sort(); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

export async function deleteState(root, folder, name) {
  safeName(folder); safeName(name);
  if (!databaseFolders.has(folder)) return unlink(await statePath(root, folder, name));
  const db = await stateDatabase(root, folder);
  try { if (!db.prepare('DELETE FROM state_records WHERE folder=? AND name=?').run(folder, name).changes) throw absent(folder, name); }
  finally { db.close(); }
}

export async function recentState(root, folder, limit = 30, { summary = false } = {}) {
  if (!['runs', 'workflows'].includes(folder)) throw new Error('Recent state requires runs or workflows.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('State result limit must be 1–1000.');
  const db = await stateDatabase(root, folder);
  try {
    const value = summary ? "json_remove(data, '$.messages', '$.events')" : 'data';
    return db.prepare(`SELECT ${value} AS data FROM state_records WHERE folder=? ORDER BY started DESC, name LIMIT ?`).all(folder, limit).map(row => JSON.parse(row.data));
  } finally { db.close(); }
}

/** Bounded pages for indexing; agent-scoped unless allScopes is explicitly set. */
export async function memoryRecords(root, { agent, allScopes = false, offset = 0, limit = 200 } = {}) {
  if (agent !== undefined) safeName(agent);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid memory page.');
  const db = await stateDatabase(root, 'memory');
  try {
    const scope = allScopes ? '' : " AND (scope='project' OR (scope='agent' AND agent=?))";
    const args = allScopes ? [limit, offset] : [agent ?? null, limit, offset];
    return db.prepare(`SELECT data FROM state_records WHERE folder='memory'${scope} ORDER BY name LIMIT ? OFFSET ?`).all(...args).map(row => JSON.parse(row.data));
  } finally { db.close(); }
}

/** Score in SQLite so normal recall only materializes its small result set. */
export async function searchMemories(root, words, agent) {
  if (agent !== undefined) safeName(agent);
  const db = await stateDatabase(root, 'memory');
  try {
    db.function('memory_score', { deterministic: true }, text => words.reduce((score, word) => score + Number(String(text ?? '').toLowerCase().includes(word)), 0));
    return db.prepare(`SELECT data, memory_score(json_extract(data,'$.text')) AS score FROM state_records
      WHERE folder='memory' AND (scope='project' OR (scope='agent' AND agent=?)) AND (?=0 OR score>0)
      ORDER BY score DESC, created DESC, name LIMIT 20`).all(agent ?? null, words.length).map(row => ({ ...JSON.parse(row.data), score: row.score }));
  } finally { db.close(); }
}
