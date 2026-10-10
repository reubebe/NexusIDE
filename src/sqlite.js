import { DatabaseSync } from 'node:sqlite';
import { realpath } from 'node:fs/promises';
import { constants, mkdirSync, lstatSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SCHEMA_VERSION = 2;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function regularFile(file, { optional = false } = {}) {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('SQLite state requires singly linked regular files; symbolic links are refused.');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('SQLite state files require private permissions (chmod 600 with NexusIDE stopped).');
  return stat;
}

function checkDirectory(directory) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('SQLite state directory cannot be a symbolic link or non-directory.');
  return stat;
}

function secureSidecars(file) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    // Never open/close SQLite's files ourselves: closing any descriptor for an
    // inode releases this process's POSIX locks, including other connections'.
    // SQLite inherits the database's 0600 mode when creating its sidecars.
    regularFile(file + suffix, { optional: true });
  }
}

async function enableWal(db) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      // The initial rollback-to-WAL transition may return BUSY without invoking
      // SQLite's busy handler when another process is initializing this file.
      if ((error.errcode & 0xff) !== 5 || Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

/** Open the shared local database. Callers must close it, including on failure. */
export async function openDatabase(root, { readOnly = false } = {}) {
  const canonical = await realpath(root), directory = path.join(canonical, '.nexus');
  if (!readOnly) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const directoryStat = checkDirectory(directory), file = path.join(directory, 'storage.sqlite');
  let before = regularFile(file, { optional: !readOnly }), db;
  try {
    if (!before) {
      // Only create a missing database. Close this descriptor before SQLite can
      // acquire any locks; existing databases must be opened by SQLite alone.
      try { closeSync(openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      before = regularFile(file);
    }
    secureSidecars(file);
    db = new DatabaseSync(file, { readOnly, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    if (!sameFile(before, regularFile(file)) || !sameFile(directoryStat, checkDirectory(directory))) throw new Error('SQLite state path changed while opening.');
    secureSidecars(file);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > SCHEMA_VERSION) throw new Error(`SQLite schema ${version} is newer than this NexusIDE version supports.`);
    if (readOnly) return db;
    await enableWal(db);
    db.exec('PRAGMA synchronous = FULL;');
    if (version < 1) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS state_records (
          folder TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
          started TEXT, created TEXT, scope TEXT, agent TEXT,
          PRIMARY KEY(folder, name)
        );
        CREATE INDEX IF NOT EXISTS state_recent ON state_records(folder, started DESC, name);
        CREATE INDEX IF NOT EXISTS state_memory ON state_records(folder, scope, agent, created DESC, name);
        CREATE TABLE IF NOT EXISTS state_migrations (folder TEXT PRIMARY KEY, migrated TEXT NOT NULL);
        PRAGMA user_version = 1;
        COMMIT;`);
    }
    if (version < 2) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (db.prepare('PRAGMA user_version').get().user_version < 2) {
          db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(name UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
            CREATE TABLE IF NOT EXISTS memory_versions (id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(id,revision));
            CREATE TABLE IF NOT EXISTS memory_usage (id TEXT PRIMARY KEY, last_used TEXT NOT NULL, uses INTEGER NOT NULL);
            DELETE FROM memory_fts;
            INSERT INTO memory_fts(name,text) SELECT name,json_extract(data,'$.text') FROM state_records WHERE folder='memory';
            PRAGMA user_version=2;`);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    secureSidecars(file);
    return db;
  } catch (error) { db?.close(); throw error; }
}
