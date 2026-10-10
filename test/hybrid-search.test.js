import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../src/config.js';
import { remember, updateMemory, forget } from '../src/memory.js';
import { createMemoryRecord } from '../src/memory-policy.js';
import { searchMemory } from '../src/memory-search.js';
import { rebuildMemoryIndex } from '../src/semantic-memory.js';
import { rebuildProjectIndex, searchProject } from '../src/project-index.js';
import { ensureSqliteFolder, writeStateRecord, writeState } from '../src/state.js';
import { openDatabase } from '../src/sqlite.js';

async function fixture(t, { embeddings = false, vector = () => [1, 0] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-hybrid-'));
  const state = { requests: [], status: 200, onRequest: null };
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  const config = structuredClone(defaultConfig);
  delete config.embeddings;
  if (embeddings) {
    server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      state.requests.push(request);
      if (state.onRequest?.(request, res)) return;
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embeddings: request.input.map(vector) }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    config.embeddings = { model: 'hybrid-fixture', url: `http://127.0.0.1:${server.address().port}/api/embed` };
  }
  await saveConfig(root, config);
  return { root, config, state, file: (name, text) => writeFile(path.join(root, name), text) };
}

async function seedMemories(root, inputs) {
  await ensureSqliteFolder(root, 'memory');
  const db = await openDatabase(root);
  try {
    db.exec('BEGIN IMMEDIATE');
    const notes = inputs.map(({ id, status = 'active', ...input }) => ({
      ...createMemoryRecord(input, { id, created: '2026-01-01T00:00:00.000Z' }), status
    }));
    for (const note of notes) writeStateRecord(db, 'memory', `${note.id}.json`, note);
    db.exec('COMMIT');
    return notes;
  } finally { db.close(); }
}

test('memory and project keyword retrieval work offline with BM25 and escaped query text', async t => {
  const f = await fixture(t);
  const concise = await remember(f.root, { text: 'café priority priority priority' });
  const broad = await remember(f.root, { text: `café priority ${'background '.repeat(50)}` });
  await f.file('concise.md', concise.text);
  await f.file('broad.md', broad.text);
  const built = await rebuildProjectIndex(f.root);
  assert.equal(built.mode, 'lexical');
  assert.equal(built.embedded, 0);
  assert.equal(built.dimensions, 0);
  for (const [search, expected, identity] of [
    [options => searchMemory(f.root, 'CAFÉ: "priority" (*)', undefined, options), concise.id, item => item.id],
    [options => searchProject(f.root, 'CAFÉ: "priority" (*)', options), 'concise.md', item => item.path]
  ]) {
    const lexical = await search({ mode: 'lexical' });
    assert.equal(identity(lexical.matches[0]), expected);
    assert.ok(lexical.matches[0].lexicalScore > lexical.matches[1].lexicalScore);
    assert.equal(lexical.mode, 'lexical');
    const fallback = await search({ mode: 'hybrid' });
    assert.equal(fallback.mode, 'lexical');
    assert.match(fallback.warning, /not configured/);
    assert.deepEqual(fallback.matches, lexical.matches);
  }
  assert.deepEqual((await searchMemory(f.root, '"()*:')).matches, []);
  assert.deepEqual((await searchProject(f.root, '"()*:')).matches, []);
});

test('hybrid retrieval fuses lexical and semantic ranks for memories and project chunks', async t => {
  const exact = 'authentication authentication authentication';
  const overlap = 'authentication governs credential rotation using scoped refresh tokens';
  const related = 'credentials expire regularly';
  const f = await fixture(t, { embeddings: true, vector: text => text === exact ? [0, 1] : text === related ? [0.8, 0.6] : [1, 0] });
  const notes = await seedMemories(f.root, [
    { id: 'exact', text: exact }, { id: 'overlap', text: overlap }, { id: 'related', text: related }
  ]);
  for (const note of notes) await f.file(`${note.id}.md`, note.text);
  await rebuildMemoryIndex(f.root);
  await rebuildProjectIndex(f.root);
  for (const [search, identity] of [
    [mode => searchMemory(f.root, 'authentication', undefined, { mode }), item => item.id],
    [mode => searchProject(f.root, 'authentication', { mode }), item => item.path.replace('.md', '')]
  ]) {
    assert.equal(identity((await search('lexical')).matches[0]), 'exact');
    const semantic = await search('semantic');
    assert.equal(identity(semantic.matches[0]), 'overlap');
    assert.equal(semantic.matches.length, 3);
    const hybrid = await search('hybrid');
    assert.equal(hybrid.mode, 'hybrid');
    assert.equal(identity(hybrid.matches[0]), 'overlap');
    assert.equal(hybrid.matches[0].lexicalRank, 2);
    assert.equal(hybrid.matches[0].semanticRank, 1);
    assert.equal(hybrid.matches[0].score, 1 / 62 + 1 / 61);
    assert.ok(hybrid.matches.every(item => !('vector' in item)));
  }
});

test('memory visibility and loadouts filter before lexical and semantic candidate limits', async t => {
  const f = await fixture(t, { embeddings: true, vector: text => text.startsWith('needle') ? [1, 0] : [0, 1] });
  const hidden = Array.from({ length: 100 }, (_, i) => ({
    id: `hidden-${String(i).padStart(3, '0')}`, text: 'needle',
    ...[
      { scope: 'agent', agent: 'reviewer' },
      { status: 'archived' },
      { expiresAt: '2020-01-01T00:00:00.000Z' },
      { layer: 'L3', category: 'preference' },
      {}
    ][i % 5]
  }));
  await seedMemories(f.root, [...hidden,
    { id: 'selected', text: `shared needle ${'context '.repeat(30)}` },
    { id: 'own', text: `private needle ${'context '.repeat(30)}`, scope: 'agent', agent: 'coder' }
  ]);
  await rebuildMemoryIndex(f.root);
  const loadout = { project: 'selected', ids: ['selected', ...hidden.filter((_, i) => i % 5 !== 4).map(note => note.id)], layers: ['L1'] };
  for (const mode of ['lexical', 'semantic', 'hybrid']) {
    const result = await searchMemory(f.root, 'needle', 'coder', { mode, loadout, limit: 2 });
    assert.deepEqual(new Set(result.matches.map(note => note.id)), new Set(['selected', 'own']));
    assert.equal(result.indexed, 2);
    assert.equal(result.stale, 0);
    assert.deepEqual((await searchMemory(f.root, 'needle', undefined, { mode, loadout })).matches.map(note => note.id), ['selected']);
    assert.deepEqual((await searchMemory(f.root, 'needle', 'coder', { mode, loadout: { project: 'none', layers: ['L1'] } })).matches.map(note => note.id), ['own']);
  }
});

test('hybrid memory retrieval uses current keywords but excludes changed and missing vectors', async t => {
  const f = await fixture(t, { embeddings: true });
  const stable = await remember(f.root, { text: 'quasar stable' });
  const edited = await remember(f.root, { text: 'old content' });
  const removed = await remember(f.root, { text: 'quasar deleted' });
  await rebuildMemoryIndex(f.root);
  await updateMemory(f.root, edited.id, { expectedRevision: 1, text: 'quasar edited' });
  await forget(f.root, removed.id);
  const fresh = await remember(f.root, { text: 'quasar new' });
  const result = await searchMemory(f.root, 'quasar');
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.stale, 2);
  assert.equal(result.indexed, 1);
  assert.deepEqual(new Set(result.matches.map(note => note.id)), new Set([stable.id, edited.id, fresh.id]));
  assert.ok(result.matches.filter(note => note.id !== stable.id).every(note => !('semanticScore' in note)));
  assert.deepEqual((await searchMemory(f.root, 'quasar', undefined, { mode: 'semantic' })).matches.map(note => note.id), [stable.id]);
});

test('stale project hits cannot crowd current results out of keyword candidates and FTS rebuilds stay current', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 65; i++) await f.file(`stale-${i}.md`, 'target target target');
  await f.file('current.md', `target ${'context '.repeat(60)}`);
  await rebuildProjectIndex(f.root);
  for (let i = 0; i < 65; i++) await f.file(`stale-${i}.md`, 'changed source');
  const result = await searchProject(f.root, 'target', { mode: 'lexical', limit: 1 });
  assert.deepEqual(result.matches.map(item => item.path), ['current.md']);
  assert.equal(result.stale, 65);
  await unlink(path.join(f.root, 'stale-0.md'));
  await f.file('current.md', 'replacement evidence');
  const rebuilt = await rebuildProjectIndex(f.root);
  assert.equal(rebuilt.deleted, 1);
  assert.equal((await searchProject(f.root, 'target')).matches.length, 0);
  assert.deepEqual((await searchProject(f.root, 'replacement')).matches.map(item => item.path), ['current.md']);
});

test('hybrid search falls back on unavailable embeddings while semantic mode preserves errors', async t => {
  const f = await fixture(t, { embeddings: true });
  const note = await remember(f.root, { text: 'fallback evidence' });
  await f.file('fallback.md', note.text);
  await rebuildProjectIndex(f.root, { mode: 'lexical' });
  for (const search of [
    mode => searchMemory(f.root, 'fallback', undefined, { mode }),
    mode => searchProject(f.root, 'fallback', { mode })
  ]) {
    const missing = await search('hybrid');
    assert.equal(missing.mode, 'lexical');
    assert.match(missing.warning, /rebuilding/);
    assert.equal(missing.matches.length, 1);
    await assert.rejects(search('semantic'), /Rebuild/);
  }
  await rebuildMemoryIndex(f.root);
  await rebuildProjectIndex(f.root);
  f.state.status = 503;
  for (const search of [
    mode => searchMemory(f.root, 'fallback', undefined, { mode }),
    mode => searchProject(f.root, 'fallback', { mode })
  ]) {
    const fallback = await search('hybrid');
    assert.equal(fallback.mode, 'lexical');
    assert.match(fallback.warning, /unavailable/);
    assert.equal(fallback.matches.length, 1);
    await assert.rejects(search('semantic'), /HTTP 503/);
  }
});

test('result budgets include serialized metadata and keep complete records', async t => {
  const f = await fixture(t);
  await remember(f.root, { text: `budget ${'"\\😀'.repeat(1500)}` });
  await f.file('budget.md', `budget ${'"\\😀'.repeat(1500)}`);
  await rebuildProjectIndex(f.root);
  for (const search of [
    options => searchMemory(f.root, 'budget', undefined, { mode: 'lexical', ...options }),
    options => searchProject(f.root, 'budget', { mode: 'lexical', ...options })
  ]) {
    const bounded = await search({ maxChars: 800, limit: 1 });
    assert.equal(bounded.matches.length, 1);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.matches[0].textTruncated, true);
    assert.equal(bounded.characters, JSON.stringify(bounded.matches).length);
    assert.ok(bounded.characters <= 800);
    assert.deepEqual(JSON.parse(JSON.stringify(bounded.matches)), bounded.matches);
    for (const options of [{ limit: 0 }, { limit: 21 }, { maxChars: 255 }, { timeoutMs: 0 }]) {
      await assert.rejects(search(options), /limit|budget|timeout/i);
    }
  }
  const loadout = await searchMemory(f.root, 'budget', undefined, { mode: 'lexical', maxChars: 2000, loadout: { maxChars: 600, maxItems: 1 } });
  assert.ok(loadout.characters <= 600);
});

test('semantic timeouts fall back to keywords but caller cancellation rejects retrieval', { timeout: 10000 }, async t => {
  const f = await fixture(t, { embeddings: true });
  const note = await remember(f.root, { text: 'cancellation evidence' });
  await f.file('cancellation.md', note.text);
  await rebuildMemoryIndex(f.root);
  await rebuildProjectIndex(f.root);
  for (const search of [
    options => searchMemory(f.root, 'cancellation', undefined, options),
    options => searchProject(f.root, 'cancellation', options)
  ]) {
    f.state.onRequest = () => true;
    const timed = await search({ timeoutMs: 150 });
    assert.equal(timed.mode, 'lexical');
    assert.match(timed.warning, /timed out/);
    assert.equal(timed.matches.length, 1);
    const controller = new AbortController();
    f.state.onRequest = () => { controller.abort(new DOMException('Cancelled by caller', 'AbortError')); return true; };
    await assert.rejects(search({ signal: controller.signal }), { name: 'AbortError' });
    const requests = f.state.requests.length;
    await assert.rejects(search({ signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(f.state.requests.length, requests);
    f.state.onRequest = null;
    assert.equal((await search()).mode, 'hybrid');
  }
});

test('retrieval rechecks live scope and raw content after the embedding service returns', async t => {
  const f = await fixture(t, { embeddings: true });
  for (const change of ['scope', 'archive', 'delete', 'legacy-edit']) {
    f.state.onRequest = null;
    const note = await remember(f.root, { text: `sensitive ${change} evidence` });
    await rebuildMemoryIndex(f.root);
    let mutation;
    f.state.onRequest = (request, res) => {
      mutation = (async () => {
        if (change === 'delete') await forget(f.root, note.id);
        else if (change === 'legacy-edit') await writeState(f.root, 'memory', `${note.id}.json`, { ...note, text: 'Content changed without a revision bump.' });
        else await updateMemory(f.root, note.id, { expectedRevision: 1, ...(change === 'scope' ? { scope: 'agent', agent: 'reviewer' } : { status: 'archived' }) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ embeddings: request.input.map(() => [1, 0]) }));
      })();
      return true;
    };
    const result = await searchMemory(f.root, 'sensitive', 'coder');
    await mutation;
    assert.ok(!result.matches.some(match => match.id === note.id), `${change} cannot leak a stale snapshot`);
  }
});
