import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { remember, recall, listMemories, updateMemory, memoryHistory, recordMemoryUse, forget, memoryContext } from '../src/memory.js';
import { validateMemoryLoadout, normalizeLoadout, boundMemoryResults } from '../src/memory-policy.js';
import { openDatabase } from '../src/sqlite.js';
import { writeState, readState } from '../src/state.js';
import { runAgent } from '../src/runtime.js';
import { defaults, installAgent } from '../src/agents.js';
import { startServer } from '../src/server.js';
import { backupStorage } from '../src/storage-maintenance.js';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-memory-governance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('memory edits are revision-checked, versioned, indexed and reversible by an explicit new revision', async t => {
  const root = await workspace(t);
  const original = await remember(root, { text: 'Original SQLite constraint', category: 'constraint' });
  assert.equal(original.revision, 1);
  await assert.rejects(updateMemory(root, original.id, { text: 'No revision' }), /expected revision/);
  const updated = await updateMemory(root, original.id, { expectedRevision: 1, text: 'Replacement Postgres summary', layer: 'L2' });
  assert.equal(updated.category, 'summary');
  assert.equal(updated.revision, 2);
  await assert.rejects(updateMemory(root, original.id, { expectedRevision: 1, text: 'Lost update' }), /changed/);
  await assert.rejects(updateMemory(root, original.id, { expectedRevision: 2, provenance: { kind: 'forged' } }), /Unsupported/);
  assert.equal((await recall(root, 'SQLite')).length, 0);
  assert.equal((await recall(root, 'Postgres')).length, 1);
  const archived = await updateMemory(root, original.id, { expectedRevision: 2, status: 'archived' });
  assert.deepEqual(await recall(root, 'Postgres'), []);
  assert.equal((await listMemories(root, { status: 'archived' })).total, 1);
  const restored = await updateMemory(root, original.id, { expectedRevision: archived.revision, status: 'active' });
  assert.equal(restored.revision, 4);
  const history = await memoryHistory(root, original.id);
  assert.deepEqual(history.versions.map(note => note.revision), [4, 3, 2, 1]);
  assert.equal(history.versions.at(-1).text, original.text);
  assert.equal((await memoryHistory(root, original.id, { offset: 2, limit: 1 })).versions[0].revision, 2);
});

test('expiry, selected IDs and layer filtering narrow recall without granting other agent notes', async t => {
  const root = await workspace(t);
  const selected = await remember(root, { text: 'Shared database decision' });
  const hidden = await remember(root, { text: 'Unselected database decision' });
  const privateNote = await remember(root, { text: 'Other database decision', scope: 'agent', agent: 'reviewer' });
  const own = await remember(root, { text: 'Own database decision', scope: 'agent', agent: 'coder' });
  const expired = await remember(root, { text: 'Expired database decision', expiresAt: '2000-01-01T00:00:00Z' });
  const preference = await remember(root, { text: 'Database concise reports', layer: 'L3' });
  const loadout = { project: 'selected', ids: [selected.id, privateNote.id, expired.id, preference.id], layers: ['L1'] };
  const notes = await recall(root, 'database', 'coder', { loadout });
  assert.deepEqual(new Set(notes.map(note => note.id)), new Set([selected.id, own.id]));
  assert.ok(!notes.some(note => [hidden.id, privateNote.id, expired.id].includes(note.id)));
  assert.deepEqual(await recall(root, 'database', 'coder', { loadout: { layers: [] } }), []);
  assert.deepEqual((await recall(root, 'database', 'coder', { loadout: { project: 'none' } })).map(note => note.id), [own.id]);
  const page = await listMemories(root, { agent: 'coder', limit: 2, offset: 1 });
  assert.equal(page.total, 5);
  assert.equal(page.memories.length, 2);
});

test('loadout validation and serialized result budgets do not produce broken JSON', () => {
  for (const invalid of [{ project: 'everyone' }, { ids: ['../private'] }, { ids: ['same', 'same'] }, { layers: ['L0'] }, { maxChars: 255 }, { maxItems: 21 }, { permission: true }]) assert.throws(() => validateMemoryLoadout(invalid));
  assert.equal(normalizeLoadout().maxItems, 8);
  const result = boundMemoryResults([{ id: 'one', text: 'escaped "quotes"\n'.repeat(1000) }, { id: 'two', text: 'more' }], { limit: 2, maxChars: 512 });
  assert.ok(JSON.stringify(result.matches).length <= 512);
  assert.equal(result.characters, JSON.stringify(result.matches).length);
  assert.ok(result.truncated);
  assert.equal(result.matches[0].textTruncated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.matches)), result.matches);
});

test('startup context includes selected summaries and preferences, runtime tools obey grant and budgets', async t => {
  const root = await workspace(t);
  const preference = await remember(root, { text: 'Keep responses concise.', layer: 'L3' });
  await remember(root, { text: 'Private marker never allowed', scope: 'agent', agent: 'reviewer' });
  const fact = await remember(root, { text: 'SQLite database detail' });
  const agent = { ...defaults[0], memory: true, memoryLoadout: { maxItems: 2, maxChars: 1800 } };
  const context = await memoryContext(root, 'SQLite', agent.name, agent.memoryLoadout);
  assert.deepEqual(new Set(context.matches.map(note => note.id)), new Set([preference.id, fact.id]));
  let step = 0;
  const provider = { name: 'fixture', model: 'offline', async complete(messages, tools) {
    assert.ok(!JSON.stringify(messages).includes('Private marker'));
    assert.ok(messages[0].content.includes('Keep responses concise.'));
    assert.ok(tools.some(tool => tool.name === 'search_memory'));
    assert.ok(!tools.some(tool => tool.name === 'search_memory_semantic'));
    if (!step++) return { text: '', calls: [{ id: 'lookup', name: 'search_memory', args: { query: 'SQLite' } }], usage: {} };
    const result = JSON.parse(messages.at(-1).content);
    assert.equal(result.mode, 'lexical');
    assert.deepEqual(result.matches.map(note => note.id), [fact.id]);
    return { text: 'Verified fixture response.', calls: [], usage: {} };
  } };
  const run = await runAgent({ root, agent, task: 'SQLite', provider, approve: async () => { throw new Error('Local recall needs no approval.'); } });
  assert.equal(run.status, 'completed');
  assert.equal(run.memoryContext.records.length, 2);
  assert.ok(run.memoryContext.characters <= 1800);
  const listed = (await listMemories(root)).memories;
  assert.equal(listed.find(note => note.id === fact.id).useCount, 2);
  assert.equal(listed.find(note => note.id === preference.id).useCount, 1);
  const saved = await readState(root, 'runs', `${run.id}.json`);
  assert.deepEqual(saved.memoryContext, run.memoryContext);
  const longTask = 'SQLite '.repeat(3000);
  const longRun = await runAgent({ root, agent, task: longTask, provider: { name: 'fixture', model: 'offline', complete: async messages => {
    assert.equal(messages.at(-1).content, longTask, 'retrieval bound does not truncate the actual task');
    return { text: 'Done', calls: [], usage: {} };
  } } });
  assert.equal(longRun.status, 'completed');
});

test('usage does not invalidate content revisions and forget removes all derived memory records', async t => {
  const root = await workspace(t);
  const note = await remember(root, { text: 'Remembered statement' });
  await recordMemoryUse(root, [note]);
  assert.equal((await readState(root, 'memory', `${note.id}.json`)).revision, 1);
  const changed = await updateMemory(root, note.id, { expectedRevision: 1, text: 'Changed statement' });
  await recordMemoryUse(root, [note]);
  assert.equal((await listMemories(root)).memories[0].useCount, 1, 'stale retrieval does not increment use');
  await recordMemoryUse(root, [changed]);
  assert.equal((await listMemories(root)).memories[0].useCount, 2);
  await forget(root, note.id);
  assert.equal((await listMemories(root)).total, 0);
  const db = await openDatabase(root);
  try { for (const table of ['memory_versions', 'memory_usage', 'memory_fts']) assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0); }
  finally { db.close(); }
  await assert.rejects(memoryHistory(root, note.id), /does not exist/);
});

test('v1 migration backfills keyword search without rewriting legacy records and backup retains revisions', async t => {
  const root = await workspace(t);
  await mkdir(path.join(root, '.nexus'), { mode: 0o700 });
  const file = path.join(root, '.nexus', 'storage.sqlite');
  const legacy = { id: 'legacy', text: 'Málaga legacy searchable', scope: 'project', created: '2026-01-01' };
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE state_records(folder TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),started TEXT,created TEXT,scope TEXT,agent TEXT,PRIMARY KEY(folder,name));
    CREATE TABLE state_migrations(folder TEXT PRIMARY KEY,migrated TEXT NOT NULL); PRAGMA user_version=1;`);
  old.prepare('INSERT INTO state_records VALUES(?,?,?,?,?,?,?)').run('memory', 'legacy.json', JSON.stringify(legacy), null, legacy.created, legacy.scope, null);
  old.close(); await chmod(file, 0o600);
  assert.equal((await recall(root, 'malaga'))[0].source, 'legacy');
  assert.deepEqual(await readState(root, 'memory', 'legacy.json'), legacy);
  await updateMemory(root, 'legacy', { expectedRevision: 1, text: 'Updated Málaga record' });
  const destination = path.join(root, 'snapshot.sqlite');
  await backupStorage(root, destination);
  const snapshot = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(snapshot.prepare('SELECT count(*) AS count FROM memory_versions').get().count, 2);
    assert.equal(snapshot.prepare("SELECT count(*) AS count FROM memory_fts WHERE memory_fts MATCH 'malaga'").get().count, 1);
  } finally { snapshot.close(); }
});

test('dashboard memory workflow protects provenance, detects conflicts and reviews pending drafts', async t => {
  const root = await workspace(t);
  await installAgent(root, { ...defaults[0], memory: true });
  const runId = 'fixture-completed';
  await writeState(root, 'runs', `${runId}.json`, { id: runId, agent: 'architect', status: 'completed', messages: [{ role: 'user', content: 'Use SQLite.' }, { role: 'assistant', content: 'SQLite is selected.' }] });
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const origin = new URL(app.url).origin;
  const api = (route, method = 'GET', body) => fetch(`${origin}/api/memory${route}`, { method, headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await api('', 'POST', { text: 'Forged', source: 'run:fake' })).status, 400);
  const note = await (await api('', 'POST', { text: 'Manual decision', layer: 'L1', category: 'decision' })).json();
  assert.equal(note.revision, 1);
  assert.equal((await api(`/${note.id}`, 'PATCH', { expectedRevision: 1, text: 'Edited decision' })).status, 200);
  assert.equal((await api(`/${note.id}`, 'PATCH', { expectedRevision: 1, text: 'Lost update' })).status, 400);
  assert.equal((await (await api(`/${note.id}/history`)).json()).versions.length, 2);
  const job = await (await api('/distill', 'POST', { runId, demo: true })).json();
  assert.ok(job.id);
  let listed;
  for (let i = 0; i < 100; i++) {
    listed = await (await api('/drafts')).json();
    if (listed.drafts.length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(listed.total, 1);
  const draft = listed.drafts[0];
  assert.equal(draft.sourceExcerpt, undefined, 'list does not expose the full excerpt');
  assert.deepEqual((await (await api('/search', 'POST', { query: 'SQLite', agent: 'architect', mode: 'lexical' })).json()).matches, []);
  const approved = await (await api(`/drafts/${draft.id}/review`, 'POST', { candidateId: draft.candidates[0].id, decision: 'approve', expectedRevision: 1 })).json();
  assert.equal(approved.memory.scope, 'agent');
  const search = await (await api('/search', 'POST', { query: 'SQLite', agent: 'architect', mode: 'lexical' })).json();
  assert.equal(search.matches[0].id, approved.memory.id);
  assert.equal((await (await api('/search', 'POST', { query: 'SQLite', mode: 'lexical' })).json()).matches.length, 0);
  assert.equal((await api('?limit=201')).status, 400);
  assert.equal((await api('/drafts?limit=101')).status, 400);
});
