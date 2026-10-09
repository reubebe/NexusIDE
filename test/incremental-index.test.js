import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../src/config.js';
import { rebuildProjectIndex, semanticProjectSearch } from '../src/project-index.js';
import { rebuildMemoryIndex, semanticRecall } from '../src/semantic-memory.js';
import { forget, remember } from '../src/memory.js';
import { writeState } from '../src/state.js';
import { openIndex, updateIndex } from '../src/index-store.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const noteDigest = value => digest(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-incremental-'));
  const state = { requests: [], behavior: null };
  const server = http.createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      state.requests.push(request);
      if (await state.behavior?.(request, res)) return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ embeddings: request.input.map(() => [1, 0]) }));
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const config = {
    ...structuredClone(defaultConfig),
    embeddings: { model: 'incremental-fixture', url: `http://127.0.0.1:${server.address().port}/api/embed` }
  };
  await saveConfig(root, config);
  return {
    root, config, state,
    inputs: () => state.requests.flatMap(request => request.input),
    clear: () => { state.requests.length = 0; },
    file: (name, text) => writeFile(path.join(root, name), text)
  };
}

test('project indexing reuses unchanged chunks across edits and renames and removes deleted files', async t => {
  const f = await fixture(t);
  const original = 'a'.repeat(2000) + 'b'.repeat(1600);
  await f.file('long.md', original);
  await f.file('stable.md', 'unchanged reference');
  await f.file('obsolete.md', 'obsolete reference');
  const first = await rebuildProjectIndex(f.root);
  assert.equal(first.storage, 'sqlite');
  assert.equal(first.indexed, 4);
  assert.equal(first.embedded, 4);
  assert.equal(f.inputs().length, 4);
  assert.ok(f.state.requests.every(request => request.truncate === false));

  f.clear();
  const unchanged = await rebuildProjectIndex(f.root);
  assert.equal(unchanged.embedded, 0);
  assert.equal(unchanged.reused, 4);
  assert.equal(unchanged.deleted, 0);
  assert.deepEqual(f.inputs(), []);

  await f.file('long.md', 'c' + original.slice(1));
  await rename(path.join(f.root, 'stable.md'), path.join(f.root, 'renamed.md'));
  await unlink(path.join(f.root, 'obsolete.md'));
  await f.file('added.md', 'brand new reference');
  const changed = await rebuildProjectIndex(f.root);
  assert.equal(changed.indexed, 4);
  assert.equal(changed.files, 3);
  assert.equal(changed.embedded, 2);
  assert.equal(changed.reused, 2);
  assert.equal(changed.deleted, 2);
  assert.deepEqual(new Set(f.inputs()), new Set(['brand new reference', 'c' + original.slice(1, 2000)]));
  const result = await semanticProjectSearch(f.root, 'reference', { limit: 20 });
  assert.equal(result.stale, 0);
  assert.equal(result.matches.length, 4);
  assert.ok(result.matches.every(match => !['stable.md', 'obsolete.md'].includes(match.path)));
  assert.ok(result.matches.some(match => match.path === 'renamed.md'));
});

test('a model change and an explicit full rebuild invalidate cached vectors', async t => {
  const f = await fixture(t);
  await f.file('one.md', 'first distinct document');
  await f.file('two.md', 'second distinct document');
  await rebuildProjectIndex(f.root);
  f.clear();
  f.config.embeddings.model = 'replacement-fixture';
  await saveConfig(f.root, f.config);
  await assert.rejects(semanticProjectSearch(f.root, 'document'), /rebuild/i);
  const changed = await rebuildProjectIndex(f.root);
  assert.equal(changed.embedded, 2);
  assert.equal(changed.reused, 0);
  assert.equal(f.inputs().length, 2);
  assert.ok(f.state.requests.every(request => request.model === 'replacement-fixture'));
  f.clear();
  const forced = await rebuildProjectIndex(f.root, { force: true });
  assert.equal(forced.embedded, 2);
  assert.equal(forced.reused, 0);
  assert.equal(f.inputs().length, 2);
});

test('failed embeddings preserve the published index and permit a later successful rebuild', async t => {
  const f = await fixture(t);
  await f.file('stable.md', 'stable searchable baseline');
  const initial = await rebuildProjectIndex(f.root);
  await f.file('new.md', 'new document after failed attempt');
  f.state.behavior = (_request, res) => { res.statusCode = 503; res.end('temporarily unavailable'); return true; };
  await assert.rejects(rebuildProjectIndex(f.root), /503/);
  f.state.behavior = null;
  const preserved = await semanticProjectSearch(f.root, 'baseline');
  assert.equal(preserved.built, initial.built);
  assert.deepEqual(preserved.matches.map(match => match.path), ['stable.md']);
  f.clear();
  const recovered = await rebuildProjectIndex(f.root);
  assert.equal(recovered.embedded, 1);
  assert.equal(recovered.reused, 1);
  assert.deepEqual(f.inputs(), ['new document after failed attempt']);
  assert.equal((await semanticProjectSearch(f.root, 'document')).matches.length, 2);
});

test('embedding dimension drift preserves the previous generation until a full rebuild', async t => {
  const f = await fixture(t);
  await f.file('stable.md', 'stable dimension baseline');
  await f.file('edited.md', 'original dimension baseline');
  const initial = await rebuildProjectIndex(f.root);
  assert.equal(initial.dimensions, 2);
  await f.file('edited.md', 'edited dimension content');
  const replacementModel = (request, res) => {
    res.end(JSON.stringify({ embeddings: request.input.map(() => [1, 0, 0]) }));
    return true;
  };
  f.state.behavior = replacementModel;
  await assert.rejects(rebuildProjectIndex(f.root), /dimensions changed.*--force/i);
  await assert.rejects(semanticProjectSearch(f.root, 'baseline'), /dimensions changed/i);

  f.state.behavior = null;
  const preserved = await semanticProjectSearch(f.root, 'baseline');
  assert.equal(preserved.built, initial.built);
  assert.equal(preserved.indexed, 2);
  assert.deepEqual(preserved.matches.map(match => match.path), ['stable.md']);
  assert.equal(preserved.stale, 1);

  f.state.behavior = replacementModel;
  f.clear();
  const recovered = await rebuildProjectIndex(f.root, { force: true });
  assert.equal(recovered.dimensions, 3);
  assert.equal(recovered.embedded, 2);
  assert.equal(recovered.reused, 0);
  assert.deepEqual(new Set(f.inputs()), new Set(['stable dimension baseline', 'edited dimension content']));
  const result = await semanticProjectSearch(f.root, 'dimension');
  assert.equal(result.stale, 0);
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.some(match => match.text === 'edited dimension content'));
});

test('cancelling an in-flight rebuild preserves the published index and does not poison later indexing', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.file('stable.md', 'stable cancellation baseline');
  const initial = await rebuildProjectIndex(f.root);
  await f.file('new.md', 'document in cancelled generation');
  const entered = deferred(), release = deferred();
  f.state.behavior = async request => {
    if (request.input.includes('document in cancelled generation')) {
      entered.resolve();
      await release.promise;
    }
    return false;
  };
  t.after(() => release.resolve());
  const controller = new AbortController();
  const pending = rebuildProjectIndex(f.root, { signal: controller.signal });
  const rejected = assert.rejects(pending, /abort|cancel/i);
  await entered.promise;
  controller.abort();
  release.resolve();
  await rejected;
  f.state.behavior = null;
  const preserved = await semanticProjectSearch(f.root, 'baseline');
  assert.equal(preserved.built, initial.built);
  assert.deepEqual(preserved.matches.map(match => match.path), ['stable.md']);
  f.clear();
  const recovered = await rebuildProjectIndex(f.root);
  assert.equal(recovered.embedded, 1);
  assert.equal(recovered.reused, 1);
  assert.deepEqual(f.inputs(), ['document in cancelled generation']);
});

test('a cache-only rebuild yields to cancellation before publishing staged notes', async t => {
  const f = await fixture(t);
  const text = 'cached note content';
  const source = key => ({
    key, digest: digest(text), bytes: Buffer.byteLength(text),
    chunks: [{ start: 0, end: text.length, content: text }]
  });
  await updateIndex(f.root, 'memory', f.config.embeddings, [source('baseline')]);
  const original = await openIndex(f.root, 'memory', f.config.embeddings);
  const generation = original.meta.generation;
  original.close();
  f.clear();
  const controller = new AbortController();
  let consumed = 0, scheduled;
  t.after(() => clearImmediate(scheduled));
  async function* cachedNotes() {
    // Schedule only after initialization has completed: the cached row loop
    // itself must allow this callback to run without network or filesystem I/O.
    scheduled = setImmediate(() => controller.abort());
    for (let index = 0; index < 1000; index++) {
      consumed++;
      yield source(`pending-${index}`);
    }
  }
  await assert.rejects(updateIndex(f.root, 'memory', f.config.embeddings, cachedNotes(), { signal: controller.signal }), /abort/i);
  assert.ok(consumed > 0 && consumed < 1000);
  assert.deepEqual(f.inputs(), []);
  const preserved = await openIndex(f.root, 'memory', f.config.embeddings);
  try {
    assert.equal(preserved.meta.generation, generation);
    assert.equal(preserved.meta.chunks, 1);
    assert.deepEqual(preserved.db.prepare("SELECT key FROM index_sources WHERE kind='memory'").all().map(row => row.key), ['baseline']);
  } finally { preserved.close(); }
  const recovered = await updateIndex(f.root, 'memory', f.config.embeddings, [source('recovered')]);
  assert.equal(recovered.reused, 1);
  assert.equal(recovered.embedded, 0);
  assert.equal(recovered.deleted, 1);
});

test('an older concurrent rebuild cannot replace a newer published generation', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.file('version.md', 'original version');
  await rebuildProjectIndex(f.root);
  const entered = deferred(), release = deferred();
  f.state.behavior = async request => {
    if (request.input.includes('older pending version')) {
      entered.resolve();
      await release.promise;
    }
    return false;
  };
  t.after(() => release.resolve());
  await f.file('version.md', 'older pending version');
  const older = rebuildProjectIndex(f.root).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  await f.file('version.md', 'newer published version');
  const newer = await rebuildProjectIndex(f.root);
  release.resolve();
  const olderResult = await older;
  assert.ok(olderResult.error);
  assert.match(olderResult.error.message, /Index changed during this build/);
  f.state.behavior = null;
  const result = await semanticProjectSearch(f.root, 'published version');
  assert.equal(result.built, newer.built);
  assert.equal(result.stale, 0);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].text, 'newer published version');
  f.clear();
  assert.equal((await rebuildProjectIndex(f.root)).embedded, 0);
  assert.deepEqual(f.inputs(), []);
});

test('legacy project and memory indexes migrate without embedding unchanged valid entries', async t => {
  const f = await fixture(t);
  const text = 'legacy document evidence';
  await f.file('legacy.md', text);
  const note = await remember(f.root, { text: 'legacy memory evidence' });
  const built = '2026-01-01T00:00:00.000Z';
  await writeState(f.root, 'indexes', 'project.json', {
    version: 1, config: f.config.embeddings, built, dimensions: 2,
    files: 1, bytes: Buffer.byteLength(text), truncated: false,
    entries: [{ path: 'legacy.md', start: 0, end: text.length, digest: digest(text), content: text, vector: [1, 0] }]
  });
  await writeState(f.root, 'indexes', 'memory.json', {
    version: 1, config: f.config.embeddings, built, dimensions: 2,
    entries: [{ id: note.id, digest: noteDigest(note), vector: [1, 0] }]
  });
  const legacyPaths = ['project.json', 'memory.json'].map(name => path.join(f.root, '.nexus', 'indexes', name));
  const originals = await Promise.all(legacyPaths.map(file => readFile(file, 'utf8')));
  const project = await rebuildProjectIndex(f.root);
  const memory = await rebuildMemoryIndex(f.root);
  for (const result of [project, memory]) {
    assert.equal(result.storage, 'sqlite');
    assert.equal(result.indexed, 1);
    assert.equal(result.embedded, 0);
    assert.equal(result.reused, 1);
  }
  assert.deepEqual(f.inputs(), []);
  assert.deepEqual(await Promise.all(legacyPaths.map(file => readFile(file, 'utf8'))), originals);
  assert.equal((await semanticProjectSearch(f.root, 'evidence')).matches[0].path, 'legacy.md');
  assert.equal((await semanticRecall(f.root, 'evidence', 'coder')).matches[0].id, note.id);
});

test('incremental memory indexing honors note edits, deletion, and agent scope', async t => {
  const f = await fixture(t);
  const shared = await remember(f.root, { text: 'shared note' });
  const own = await remember(f.root, { text: 'private coder note', scope: 'agent', agent: 'coder' });
  const other = await remember(f.root, { text: 'private reviewer note', scope: 'agent', agent: 'reviewer' });
  const first = await rebuildMemoryIndex(f.root);
  assert.equal(first.storage, 'sqlite');
  assert.equal(first.embedded, 3);
  f.clear();
  const unchanged = await rebuildMemoryIndex(f.root);
  assert.equal(unchanged.embedded, 0);
  assert.equal(unchanged.reused, 3);
  assert.deepEqual(f.inputs(), []);
  await forget(f.root, shared.id);
  await writeState(f.root, 'memory', own.id + '.json', { ...own, text: 'updated private coder note' });
  const added = await remember(f.root, { text: 'new shared note' });
  const changed = await rebuildMemoryIndex(f.root);
  assert.equal(changed.indexed, 3);
  assert.equal(changed.embedded, 2);
  assert.equal(changed.reused, 1);
  assert.equal(changed.deleted, 1);
  assert.deepEqual(new Set(f.inputs()), new Set(['updated private coder note', 'new shared note']));
  const coder = await semanticRecall(f.root, 'note', 'coder');
  assert.deepEqual(new Set(coder.matches.map(note => note.id)), new Set([own.id, added.id]));
  assert.ok(coder.matches.some(note => note.text === 'updated private coder note'));
  const anonymous = await semanticRecall(f.root, 'note');
  assert.deepEqual(anonymous.matches.map(note => note.id), [added.id]);
  const reviewer = await semanticRecall(f.root, 'note', 'reviewer');
  assert.deepEqual(new Set(reviewer.matches.map(note => note.id)), new Set([other.id, added.id]));
  f.config.embeddings.model = 'new-memory-model';
  await saveConfig(f.root, f.config);
  await assert.rejects(semanticRecall(f.root, 'note', 'coder'), /rebuild/i);
  f.clear();
  assert.equal((await rebuildMemoryIndex(f.root)).embedded, 3);
  assert.equal(f.inputs().length, 3);
});

test('project indexes support more than the old 500-file limit and reuse the larger index', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 510 }, (_, index) => f.file(`document-${String(index).padStart(3, '0')}.md`, `unique document ${index}`)));
  const built = await rebuildProjectIndex(f.root);
  assert.equal(built.files, 510);
  assert.equal(built.indexed, 510);
  assert.equal(built.embedded, 510);
  assert.equal(built.truncated, false);
  assert.equal(f.inputs().length, 510);
  const last = await semanticProjectSearch(f.root, 'document-509');
  assert.equal(last.matches[0].path, 'document-509.md');
  f.clear();
  const unchanged = await rebuildProjectIndex(f.root);
  assert.equal(unchanged.reused, 510);
  assert.equal(unchanged.embedded, 0);
  assert.deepEqual(f.inputs(), []);
});
