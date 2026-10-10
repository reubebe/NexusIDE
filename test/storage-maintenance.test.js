import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, chmod, writeFile, readFile, realpath, readdir, stat, lstat, symlink, link, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/sqlite.js';
import { writeState, readState } from '../src/state.js';
import { storageStatus, migrateStorage, backupStorage } from '../src/storage-maintenance.js';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function legacy(root, folder, name, text) {
  const directory = path.join(root, '.nexus', folder);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await writeFile(file, text);
  return file;
}

test('storage status and failed backup do not create storage in a fresh workspace', async t => {
  const root = await workspace(t);
  const status = await storageStatus(root);
  assert.equal(status.exists, false);
  assert.equal(status.schemaVersion, null);
  assert.deepEqual(status.records, { runs: 0, workflows: 0, memory: 0, 'memory-drafts': 0 });
  await assert.rejects(backupStorage(root, path.join(root, 'backup.sqlite')), /No SQLite storage/);
  assert.deepEqual(await readdir(root), []);
});

test('status inspects an existing version-zero database without installing a schema', async t => {
  const root = await workspace(t);
  const directory = path.join(root, '.nexus');
  await mkdir(directory);
  const file = path.join(directory, 'storage.sqlite');
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE existing (value TEXT); INSERT INTO existing VALUES (\'retained\')');
  database.close();
  await chmod(file, 0o400);
  const original = await readFile(file);
  const before = await stat(file);
  const status = await storageStatus(root);
  assert.equal(status.exists, true);
  assert.equal(status.schemaVersion, 0);
  assert.equal(status.integrity, 'ok');
  assert.deepEqual(status.tables, {});
  assert.deepEqual(await readFile(file), original);
  const after = await stat(file);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(directory), ['storage.sqlite']);
});

test('migration retains JSON, reports counts, and is idempotent', async t => {
  const root = await workspace(t);
  const original = '{"id":"prior-run","started":"2026-10-09","status":"completed"}\n';
  const file = await legacy(root, 'runs', 'prior-run.json', original);
  await legacy(root, 'memory', 'note.json', '{"id":"note","text":"private note","scope":"project"}');
  assert.equal((await storageStatus(root)).exists, false);
  const migrated = await migrateStorage(root);
  assert.equal(migrated.integrity, 'ok');
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.records, { runs: 1, workflows: 0, memory: 1, 'memory-drafts': 0 });
  assert.ok(Object.values(migrated.migrations).every(value => typeof value === 'string'));
  assert.equal(migrated.tables.state_records, 2);
  assert.ok(migrated.bytes.database > 0);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.ok(!JSON.stringify(migrated).includes('private note'));
  assert.deepEqual((await migrateStorage(root)).migrations, migrated.migrations);
});

test('a failed legacy migration remains pending and status never retries it', async t => {
  const root = await workspace(t);
  const original = '{"private":"secret marker"';
  const broken = await legacy(root, 'runs', 'broken.json', original);
  await assert.rejects(migrateStorage(root), error => {
    assert.match(error.message, /migration failed for runs/);
    assert.ok(!error.message.includes('secret marker'));
    return true;
  });
  const status = await storageStatus(root);
  assert.equal(status.exists, true);
  assert.equal(status.integrity, 'ok');
  assert.equal(status.migrations.runs, null);
  assert.deepEqual(status.records, { runs: 0, workflows: 0, memory: 0, 'memory-drafts': 0 });
  assert.equal(await readFile(broken, 'utf8'), original);
  await writeFile(broken, '{"id":"repaired","status":"completed"}');
  assert.equal((await migrateStorage(root)).records.runs, 1);
});

test('online backup contains committed WAL data and restores independently', async t => {
  const root = await workspace(t);
  await writeState(root, 'memory', 'note.json', { id: 'note', scope: 'project', text: 'saved evidence' });
  const connection = await openDatabase(root);
  t.after(() => connection.close());
  connection.exec('PRAGMA wal_autocheckpoint = 0');
  connection.prepare("UPDATE state_records SET data=? WHERE folder='memory' AND name='note.json'").run(JSON.stringify({ id: 'note', scope: 'project', text: 'committed WAL evidence' }));
  assert.ok((await stat(path.join(root, '.nexus', 'storage.sqlite-wal'))).size > 0);
  const target = path.join(root, 'snapshot.sqlite');
  const result = await backupStorage(root, target);
  assert.equal(result.path, await realpath(target));
  assert.equal(result.integrity, 'ok');
  assert.equal(result.scope, 'sqlite-only');
  assert.ok(result.pages > 0);
  assert.ok(result.bytes > 0);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal((await stat(target)).nlink, 1);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.nexus-backup-')), []);
  assert.equal(await readState(root, 'memory', 'note.json').then(note => note.text), 'committed WAL evidence');
  await writeState(root, 'memory', 'note.json', { id: 'note', scope: 'project', text: 'changed after snapshot' });
  const restored = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(restored.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    const note = restored.prepare("SELECT data FROM state_records WHERE folder='memory' AND name='note.json'").get();
    assert.equal(JSON.parse(note.data).text, 'committed WAL evidence');
  } finally { restored.close(); }
  await assert.rejects(lstat(target + '-wal'), { code: 'ENOENT' });
});

test('backup refuses existing targets, links, and pre-existing sidecars without changing them', async t => {
  const root = await workspace(t);
  await migrateStorage(root);
  const existing = path.join(root, 'existing.sqlite');
  await writeFile(existing, 'do not overwrite');
  const symbolic = path.join(root, 'symbolic.sqlite');
  const hard = path.join(root, 'hard.sqlite');
  const dangling = path.join(root, 'dangling.sqlite');
  await symlink(existing, symbolic);
  await link(existing, hard);
  await symlink(path.join(root, 'missing.sqlite'), dangling);
  for (const destination of [existing, symbolic, hard, dangling]) {
    await assert.rejects(backupStorage(root, destination), { code: 'EEXIST' });
  }
  const target = path.join(root, 'with-sidecar.sqlite');
  await writeFile(target + '-wal', 'unrelated sidecar');
  await assert.rejects(backupStorage(root, target), { code: 'EEXIST' });
  assert.equal(await readFile(existing, 'utf8'), 'do not overwrite');
  assert.equal(await readFile(target + '-wal', 'utf8'), 'unrelated sidecar');
  assert.ok((await lstat(symbolic)).isSymbolicLink());
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.nexus-backup-')), []);
});

test('backup requires an explicit file path and refuses a missing parent', async t => {
  const root = await workspace(t);
  await migrateStorage(root);
  for (const destination of [undefined, '', ' ', null]) await assert.rejects(backupStorage(root, destination), /explicit backup file path/);
  await assert.rejects(backupStorage(root, path.join(root, 'missing-parent', 'snapshot.sqlite')), { code: 'ENOENT' });
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.nexus-backup-')), []);
});

test('competing backups publish exclusively and clean up the losing snapshot', async t => {
  const root = await workspace(t);
  await writeState(root, 'memory', 'note.json', { id: 'note', text: 'backup race evidence', scope: 'project' });
  const destination = path.join(root, 'exclusive.sqlite');
  const attempts = await Promise.allSettled([backupStorage(root, destination), backupStorage(root, destination)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const failure = attempts.find(result => result.status === 'rejected');
  assert.equal(failure.reason.code, 'EEXIST');
  assert.equal((await stat(destination)).nlink, 1);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  const snapshot = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshot.prepare('SELECT count(*) AS count FROM state_records').get().count, 1);
  } finally { snapshot.close(); }
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.nexus-backup-')), []);
});
