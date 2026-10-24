import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/sqlite.js';
import { readState, writeState, listState, deleteState, ensureSqliteFolder, recentState, memoryRecords } from '../src/state.js';
import { remember, recall, forget } from '../src/memory.js';

const execute = promisify(execFile);
const stateModule = new URL('../src/state.js', import.meta.url).href;
const sqliteModule = new URL('../src/sqlite.js', import.meta.url).href;

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function legacy(root, folder, name, data) {
  const directory = path.join(root, '.nexus', folder);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name), content = JSON.stringify(data) + '\n';
  await writeFile(file, content);
  return { file, content };
}
async function migrationState(root, folder) {
  const db = await openDatabase(root);
  try {
    return {
      records: db.prepare('SELECT count(*) AS count FROM state_records WHERE folder=?').get(folder).count,
      migrated: Boolean(db.prepare('SELECT 1 FROM state_migrations WHERE folder=?').get(folder))
    };
  } finally { db.close(); }
}

test('legacy records migrate once and preserve original JSON and unrelated state', async t => {
  const root = await workspace(t);
  for (const folder of ['runs', 'workflows', 'memory']) {
    const original = { id: 'original', text: 'saved evidence', scope: 'project', started: '2026-10-01' };
    const backup = await legacy(root, folder, 'original.json', original);
    assert.deepEqual(await readState(root, folder, 'original.json'), original);
    assert.deepEqual(await migrationState(root, folder), { records: 1, migrated: true });
    await writeState(root, folder, 'original.json', { ...original, text: 'new evidence' });
    assert.equal((await readState(root, folder, 'original.json')).text, 'new evidence');
    assert.equal(await readFile(backup.file, 'utf8'), backup.content);
  }
  await writeState(root, 'config', 'models.json', { model: 'local' });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.nexus/config/models.json'), 'utf8')), { model: 'local' });
  assert.equal((await stat(path.join(root, '.nexus/storage.sqlite'))).mode & 0o777, 0o600);
});

test('invalid legacy JSON leaves no partial migration and can be repaired', async t => {
  const root = await workspace(t);
  const good = await legacy(root, 'runs', 'a-good.json', { id: 'good' });
  const bad = await legacy(root, 'runs', 'z-bad.json', { id: 'bad' });
  await writeFile(bad.file, '{corrupt');
  await assert.rejects(listState(root, 'runs'), SyntaxError);
  assert.deepEqual(await migrationState(root, 'runs'), { records: 0, migrated: false });
  assert.equal(await readFile(good.file, 'utf8'), good.content);
  assert.equal(await readFile(bad.file, 'utf8'), '{corrupt');
  await writeFile(bad.file, bad.content);
  assert.deepEqual(await listState(root, 'runs'), ['a-good.json', 'z-bad.json']);
  assert.deepEqual(await migrationState(root, 'runs'), { records: 2, migrated: true });
});

test('migration publication rolls back every record when a later insert fails', async t => {
  const root = await workspace(t);
  await legacy(root, 'runs', 'a-good.json', { id: 'good' });
  await legacy(root, 'runs', 'z-rejected.json', { id: 'rejected' });
  const db = await openDatabase(root);
  try {
    db.exec(`CREATE TRIGGER reject_fixture BEFORE INSERT ON state_records WHEN NEW.name='z-rejected.json'
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    await assert.rejects(ensureSqliteFolder(root, 'runs'), /fixture failure/);
    assert.equal(db.prepare('SELECT count(*) AS count FROM state_records').get().count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM state_migrations').get().count, 0);
    db.exec('DROP TRIGGER reject_fixture');
  } finally { db.close(); }
  assert.deepEqual(await listState(root, 'runs'), ['a-good.json', 'z-rejected.json']);
});

test('deleted migrated memories stay deleted after reopening even when legacy JSON remains', async t => {
  const root = await workspace(t);
  const original = await legacy(root, 'memory', 'saved.json', { id: 'saved', text: 'old note', scope: 'project' });
  assert.equal((await recall(root))[0].id, 'saved');
  await forget(root, 'saved');
  assert.deepEqual(await recall(root), []);
  assert.deepEqual(await listState(root, 'memory'), []);
  await assert.rejects(readState(root, 'memory', 'saved.json'), { code: 'ENOENT' });
  await assert.rejects(deleteState(root, 'memory', 'saved.json'), { code: 'ENOENT' });
  assert.equal(await readState(root, 'memory', 'saved.json', null), null);
  assert.equal(await readFile(original.file, 'utf8'), original.content);
  await legacy(root, 'memory', 'later.json', { id: 'later', text: 'not imported', scope: 'project' });
  assert.deepEqual(await listState(root, 'memory'), []);
});

test('concurrent exclusive writes create one record and return EEXIST to all other writers', async t => {
  const root = await workspace(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, writer) =>
    writeState(root, 'runs', 'exclusive.json', { writer }, { exclusive: true })));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of outcomes.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'EEXIST');
  const saved = await readState(root, 'runs', 'exclusive.json');
  assert.ok(Number.isInteger(saved.writer));
  assert.deepEqual(await listState(root, 'runs'), ['exclusive.json']);
});

test('separate processes can migrate, append, and update records in the same database', async t => {
  const root = await workspace(t);
  await legacy(root, 'runs', 'legacy.json', { id: 'legacy' });
  const program = `import { writeState } from ${JSON.stringify(stateModule)};
    const [root, worker] = process.argv.slice(1);
    for (let i = 0; i < 12; i++) {
      await writeState(root, 'runs', worker + '-' + i + '.json', { worker, i }, { exclusive: true });
      await writeState(root, 'runs', 'shared.json', { worker, i });
    }`;
  const outcomes = await Promise.allSettled(['one', 'two', 'three'].map(worker => execute(process.execPath,
    ['--input-type=module', '-e', program, root, worker], { timeout: 20_000 })));
  for (const result of outcomes) {
    assert.equal(result.status, 'fulfilled', result.status === 'rejected'
      ? `Worker failed (${result.reason.code || result.reason.signal}): ${result.reason.stderr}` : undefined);
  }
  assert.equal((await listState(root, 'runs')).length, 38);
  for (const worker of ['one', 'two', 'three']) {
    assert.deepEqual(await readState(root, 'runs', `${worker}-11.json`), { worker, i: 11 });
  }
  assert.equal((await readState(root, 'runs', 'shared.json')).i, 11);
  assert.deepEqual(await readState(root, 'runs', 'legacy.json'), { id: 'legacy' });
});

test('an interrupted SQLite transaction recovers without losing committed records', async t => {
  const root = await workspace(t);
  await writeState(root, 'runs', 'committed.json', { id: 'committed' });
  const program = `import { openDatabase } from ${JSON.stringify(sqliteModule)};
    const db = await openDatabase(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO state_records(folder,name,data) VALUES(?,?,?)').run('runs','interrupted.json','{}');
    process.kill(process.pid, 'SIGKILL');`;
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', program, root]), error => error.signal === 'SIGKILL');
  assert.deepEqual(await listState(root, 'runs'), ['committed.json']);
  assert.deepEqual(await readState(root, 'runs', 'committed.json'), { id: 'committed' });
  await writeState(root, 'runs', 'recovered.json', { id: 'recovered' });
  assert.deepEqual(await listState(root, 'runs'), ['committed.json', 'recovered.json']);
});

test('SQLite rejects symlinks and hard links for its database and every sidecar', async t => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    for (const createLink of [symlink, link]) {
      await t.test(`${createLink.name} ${suffix || 'database'}`, async subtest => {
        const root = await workspace(subtest);
        const outside = await workspace(subtest), target = path.join(outside, 'protected');
        await writeFile(target, 'must not change', { mode: 0o644 });
        await mkdir(path.join(root, '.nexus'));
        await createLink(target, path.join(root, '.nexus', `storage.sqlite${suffix}`));
        await assert.rejects(openDatabase(root), /singly linked|symbolic links/);
        assert.equal(await readFile(target, 'utf8'), 'must not change');
        assert.equal((await stat(target)).mode & 0o777, 0o644);
      });
    }
  }
});

test('SQLite rechecks transient unlinked sidecars without accepting unsafe replacements', async t => {
  // Reproduce the syscall snapshots observed during concurrent WAL cleanup,
  // without relying on the OS scheduler to hit the unlink/lstat race every run.
  // The child isolates the built-in fs mock from other tests and SQLite users.
  const program = `import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const [root, suffix, scenario] = process.argv.slice(1);
    const file = path.join(fs.realpathSync(root), '.nexus', 'storage.sqlite');
    const original = fs.lstatSync, baseline = original(file);
    const snapshot = patch => Object.assign(Object.create(Object.getPrototypeOf(baseline)), baseline, patch);
    let probes = 0;
    fs.lstatSync = (name, ...args) => {
      if (name !== file + suffix) return original(name, ...args);
      probes++;
      if (probes === 1 || scenario === 'persistent') return snapshot({ nlink: 0 });
      if (probes === 2) {
        if (scenario === 'missing') throw Object.assign(new Error('removed'), { code: 'ENOENT' });
        if (scenario === 'replacement') return snapshot({ nlink: 1 });
        if (scenario === 'hardlink') return snapshot({ nlink: 2 });
        if (scenario === 'symlink') return snapshot({ mode: 0o120600, nlink: 1 });
        if (scenario === 'public') return snapshot({ mode: 0o100644, nlink: 1 });
      }
      return original(name, ...args);
    };
    syncBuiltinESMExports();
    const { openDatabase } = await import(${JSON.stringify(sqliteModule)});
    if (scenario === 'missing' || scenario === 'replacement') {
      const db = await openDatabase(root);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      db.close();
      assert.ok(probes >= 2);
    } else {
      await assert.rejects(openDatabase(root), scenario === 'public' ? /private permissions/ : /singly linked|symbolic links/);
      assert.equal(probes, !suffix ? 1 : scenario === 'persistent' ? 3 : 2);
    }`;
  for (const suffix of ['-wal', '-shm', '-journal']) {
    for (const scenario of ['missing', 'replacement', 'hardlink', 'symlink', 'persistent', ...(process.platform === 'win32' ? [] : ['public'])]) {
      await t.test(`${suffix} ${scenario}`, async subtest => {
        const root = await workspace(subtest);
        (await openDatabase(root)).close();
        await execute(process.execPath, ['--input-type=module', '-e', program, root, suffix, scenario], { timeout: 10000 });
      });
    }
  }
  await t.test('main database remains strict', async subtest => {
    const root = await workspace(subtest);
    (await openDatabase(root)).close();
    await execute(process.execPath, ['--input-type=module', '-e', program, root, '', 'persistent'], { timeout: 10000 });
  });
});

test('SQLite refuses a newer schema without modifying its contents', async t => {
  const root = await workspace(t);
  const db = await openDatabase(root);
  db.exec('PRAGMA user_version=999');
  db.close();
  const original = await readFile(path.join(root, '.nexus/storage.sqlite'));
  await assert.rejects(openDatabase(root), /newer than this NexusIDE/);
  assert.deepEqual(await readFile(path.join(root, '.nexus/storage.sqlite')), original);
});

test('read-only storage opens never create or upgrade a database and reject writes', async t => {
  const root = await workspace(t), directory = path.join(root, '.nexus'), file = path.join(directory, 'storage.sqlite');
  await assert.rejects(openDatabase(root, { readOnly: true }), { code: 'ENOENT' });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  await mkdir(directory);
  await assert.rejects(openDatabase(root, { readOnly: true }), { code: 'ENOENT' });
  await assert.rejects(stat(file), { code: 'ENOENT' });
  await writeFile(file, '', { mode: 0o600 });
  const fixture = new DatabaseSync(file);
  fixture.exec('CREATE TABLE original (id TEXT); INSERT INTO original VALUES (\'preserved\')');
  fixture.close();
  const original = await readFile(file);
  const db = await openDatabase(root, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.deepEqual(db.prepare('SELECT name FROM sqlite_schema WHERE type=\'table\'').all().map(row => row.name), ['original']);
    assert.throws(() => db.exec('CREATE TABLE forbidden (id TEXT)'), /readonly/);
  } finally { db.close(); }
  assert.deepEqual(await readFile(file), original);
});

test('recent state is ordered and bounded while summaries omit large transcripts', async t => {
  const root = await workspace(t);
  for (let i = 0; i < 8; i++) {
    await writeState(root, 'runs', `run-${i}.json`, { id: i, started: `2026-10-0${i + 1}`, task: `task ${i}`, messages: [{ content: 'transcript' }], events: [{ type: 'log' }] });
  }
  const summaries = await recentState(root, 'runs', 3, { summary: true });
  assert.deepEqual(summaries.map(record => record.id), [7, 6, 5]);
  assert.ok(summaries.every(record => !('messages' in record) && !('events' in record)));
  assert.deepEqual((await recentState(root, 'runs', 1))[0].messages, [{ content: 'transcript' }]);
  await writeState(root, 'workflows', 'workflow.json', { id: 'workflow', started: '2026-10-01', events: ['event'] });
  assert.deepEqual(await recentState(root, 'workflows', 1, { summary: true }), [{ id: 'workflow', started: '2026-10-01' }]);
  for (const limit of [0, -1, 1.5, 1001]) await assert.rejects(recentState(root, 'runs', limit), /limit/);
});

test('memory recall and indexing pages respect agent scope, relevance, and result bounds', async t => {
  const root = await workspace(t);
  for (let i = 0; i < 25; i++) {
    await writeState(root, 'memory', `project-${String(i).padStart(2, '0')}.json`, { id: `project-${i}`, text: 'shared research note', scope: 'project', created: new Date(2026, 0, i + 1).toISOString() });
  }
  const alice = await remember(root, { text: 'Research private Málaga evidence', scope: 'agent', agent: 'alice' });
  const bob = await remember(root, { text: 'Research private evidence', scope: 'agent', agent: 'bob' });
  assert.equal((await recall(root)).length, 20);
  assert.equal((await recall(root))[0].id, 'project-24');
  assert.deepEqual((await recall(root, 'private', 'alice')).map(record => record.id), [alice.id]);
  assert.deepEqual((await recall(root, 'PRIVATE', 'bob')).map(record => record.id), [bob.id]);
  assert.deepEqual(await recall(root, 'private'), []);
  const ranked = await recall(root, 'MÁLAGA evidence', 'alice');
  assert.deepEqual(ranked.map(record => record.id), [alice.id]);
  assert.ok(ranked[0].score > 0, 'BM25 keyword score');
  const alicePages = [...await memoryRecords(root, { agent: 'alice', limit: 10 }), ...await memoryRecords(root, { agent: 'alice', offset: 10, limit: 100 })];
  assert.equal(alicePages.length, 26);
  assert.equal(new Set(alicePages.map(record => record.id)).size, 26);
  assert.ok(alicePages.every(record => record.scope === 'project' || record.agent === 'alice'));
  assert.equal((await memoryRecords(root)).length, 25);
  assert.equal((await memoryRecords(root, { allScopes: true })).length, 27);
  await assert.rejects(memoryRecords(root, { agent: '../other' }), /Invalid name/);
  await assert.rejects(memoryRecords(root, { limit: 1001 }), /Invalid memory page/);
  await assert.rejects(memoryRecords(root, { offset: -1 }), /Invalid memory page/);
});
