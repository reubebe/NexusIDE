import { DatabaseSync, backup } from 'node:sqlite';
import { constants } from 'node:fs';
import { lstat, realpath, mkdtemp, chmod, open, link, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from './sqlite.js';
import { ensureSqliteFolder, statePath } from './state.js';

const folders = ['runs', 'workflows', 'memory', 'memory-drafts'];
const tables = ['state_records', 'state_migrations', 'memory_versions', 'memory_usage', 'memory_fts', 'index_meta', 'index_sources', 'index_chunks', 'project_chunks_fts'];
const suffixes = ['', '-wal', '-shm', '-journal'];
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function optionalStat(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function requireRegular(stat) {
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('Storage requires a singly linked regular file; symbolic links are refused.');
  }
}

async function databaseFile(root) {
  const file = await statePath(root, 'storage.sqlite');
  const stat = await optionalStat(file);
  if (stat) requireRegular(stat);
  return { file, stat };
}

/** Inspect persisted state without triggering legacy folder migration. */
export async function storageStatus(root) {
  const { file, stat } = await databaseFile(root);
  const result = {
    exists: Boolean(stat), path: file, schemaVersion: null, integrity: null,
    bytes: { database: 0, wal: 0, shm: 0, total: 0 }, tables: {},
    records: Object.fromEntries(folders.map(folder => [folder, 0])),
    migrations: Object.fromEntries(folders.map(folder => [folder, null]))
  };
  if (!stat) return result;
  const db = await openDatabase(root, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; BEGIN');
    result.schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
    result.integrity = db.prepare('PRAGMA integrity_check').all().every(row => row.integrity_check === 'ok') ? 'ok' : 'failed';
    const present = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name);
    for (const table of tables) {
      if (present.includes(table)) result.tables[table] = db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
    }
    if (present.includes('state_records')) {
      for (const folder of folders) result.records[folder] = db.prepare('SELECT count(*) AS count FROM state_records WHERE folder=?').get(folder).count;
    }
    if (present.includes('state_migrations')) {
      for (const folder of folders) result.migrations[folder] = db.prepare('SELECT migrated FROM state_migrations WHERE folder=?').get(folder)?.migrated ?? null;
    }
    db.exec('ROLLBACK');
    for (const [key, suffix] of [['database', ''], ['wal', '-wal'], ['shm', '-shm']]) {
      const current = await optionalStat(file + suffix);
      if (current) requireRegular(current);
      result.bytes[key] = current?.size ?? 0;
    }
    result.bytes.total = result.bytes.database + result.bytes.wal + result.bytes.shm;
    return result;
  } finally { db.close(); }
}

/** Each legacy folder is published atomically; the original JSON is retained. */
export async function migrateStorage(root) {
  for (const folder of folders) {
    try { await ensureSqliteFolder(root, folder); }
    catch (cause) {
      throw new Error(`Storage migration failed for ${folder}; its legacy files were retained. Repair that folder and retry.`, { cause });
    }
  }
  return storageStatus(root);
}

async function requireUnused(destination) {
  for (const suffix of suffixes) {
    if (await optionalStat(destination + suffix)) {
      throw Object.assign(new Error('Backup destination or SQLite sidecar already exists; choose a new file.'), { code: 'EEXIST' });
    }
  }
}

/** Online snapshot of SQLite only. Configuration, vault and JSON are separate. */
export async function backupStorage(root, destination) {
  if (typeof destination !== 'string' || !destination.trim() || destination.includes('\0')) {
    throw new Error('An explicit backup file path is required.');
  }
  const requested = path.resolve(destination);
  const parent = await realpath(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  await requireUnused(target);
  const { file, stat } = await databaseFile(root);
  if (!stat) throw new Error('No SQLite storage exists yet. Run storage migrate first.');
  const db = await openDatabase(root, { readOnly: true });
  let temporaryDirectory, temporaryFile, temporaryStat, published = false;
  try {
    temporaryDirectory = await mkdtemp(path.join(parent, '.nexus-backup-'));
    await chmod(temporaryDirectory, 0o700);
    temporaryFile = path.join(temporaryDirectory, 'snapshot.sqlite');
    const handle = await open(temporaryFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { temporaryStat = await handle.stat(); }
    finally { await handle.close(); }
    const pages = await backup(db, temporaryFile);
    const current = await lstat(temporaryFile);
    requireRegular(current);
    if (!sameFile(current, temporaryStat)) throw new Error('Backup file changed during snapshot creation.');
    const snapshot = new DatabaseSync(temporaryFile, { enableDoubleQuotedStringLiterals: false });
    try {
      // Finish the backup as one standalone file, without WAL sidecar dependencies.
      snapshot.exec('PRAGMA trusted_schema = OFF; PRAGMA journal_mode = DELETE;');
      if (!snapshot.prepare('PRAGMA integrity_check').all().every(row => row.integrity_check === 'ok')) {
        throw new Error('SQLite backup integrity check failed.');
      }
    } finally { snapshot.close(); }
    const synced = await open(temporaryFile, constants.O_RDWR | constants.O_NOFOLLOW);
    try { await synced.chmod(0o600); await synced.sync(); }
    finally { await synced.close(); }
    await requireUnused(target);
    // link is atomic and exclusive, unlike rename, which can replace an existing
    // destination. The temporary directory is on the destination filesystem.
    await link(temporaryFile, target);
    published = true;
    await unlink(temporaryFile);
    const saved = await lstat(target);
    requireRegular(saved);
    if (!sameFile(saved, temporaryStat)) throw new Error('Backup destination changed while publishing.');
    return { path: target, source: file, bytes: saved.size, pages, integrity: 'ok', scope: 'sqlite-only' };
  } catch (error) {
    if (published && sameFile((await optionalStat(target)) ?? {}, temporaryStat)) await unlink(target);
    throw error;
  } finally {
    db.close();
    if (temporaryDirectory) {
      for (const suffix of suffixes) {
        await unlink(path.join(temporaryDirectory, 'snapshot.sqlite' + suffix)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      await rmdir(temporaryDirectory);
    }
  }
}
