import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installAgent } from '../src/agents.js';
import { writeState } from '../src/state.js';
import { saveConfig } from '../src/config.js';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-memory-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = async (...args) => (await execute(process.execPath, [entry, ...args], { cwd: root, timeout: 10000 })).stdout;
  return { root, run, json: async (...args) => JSON.parse(await run(...args)) };
}

test('memory CLI applies loaded selections and protects revisioned edits', async t => {
  const { root, run, json } = await fixture(t);
  const project = await json('memory', 'add', 'SQLite project decision', '--layer', 'L1', '--category', 'decision');
  const own = await json('memory', 'add', 'SQLite private preference', '--agent', 'reviewer', '--layer', 'L3');
  await json('memory', 'add', 'SQLite other private note', '--agent', 'coder');
  await installAgent(root, { version: 1, name: 'reviewer', instructions: 'Review code.', permissions: { read: true, write: false }, memory: true, memoryLoadout: { project: 'none', layers: ['L3'] } });
  const selected = await json('memory', 'search', 'SQLite', '--agent', 'reviewer');
  assert.equal(selected.mode, 'lexical');
  assert.match(selected.warning, /Embeddings/);
  assert.deepEqual(selected.matches.map(note => note.id), [own.id]);
  assert.deepEqual((await json('memory', 'search', 'SQLite', '--mode', 'lexical')).matches.map(note => note.id), [project.id]);
  assert.equal((await json('memory', 'list', '--all-scopes', '--limit', '1')).total, 3);
  assert.equal((await json('memory', 'list', '--agent', 'reviewer', '--layer', 'L3')).memories[0].id, own.id);

  const patch = path.join(root, 'patch.json');
  await writeFile(patch, JSON.stringify({ expectedRevision: 1, status: 'archived' }));
  const edited = await json('memory', 'update', own.id, patch);
  assert.equal(edited.revision, 2);
  assert.equal(edited.status, 'archived');
  await assert.rejects(run('memory', 'update', own.id, patch), error => /Memory changed/.test(error.stderr));
  assert.deepEqual((await json('memory', 'history', own.id)).versions.map(note => note.revision), [2, 1]);
  assert.equal((await json('memory', 'search', 'SQLite', '--agent', 'reviewer', '--mode', 'lexical')).matches.length, 0);
  assert.match(await run('memory', 'forget', own.id), /revision history deleted/);
  await assert.rejects(run('memory', 'history', own.id), error => /does not exist/.test(error.stderr));
});

test('project CLI indexes and searches offline while semantic commands remain strict', async t => {
  const { root, run, json } = await fixture(t);
  await writeFile(path.join(root, 'accessibility.md'), 'Accessibility controls include keyboard focus and readable labels.');
  await json('project', 'index', '--mode', 'lexical');
  const results = await json('project', 'search', 'keyboard focus');
  assert.equal(results.mode, 'lexical');
  assert.equal(results.matches[0].path, 'accessibility.md');
  await assert.rejects(run('project', 'semantic', 'keyboard'), error => /embedding/i.test(error.stderr));
  await assert.rejects(run('memory', 'semantic', 'keyboard'), error => /embedding/i.test(error.stderr));
  await assert.rejects(run('memory', 'semantic', 'keyboard', '--mode', 'lexical'), error => /requires semantic retrieval/.test(error.stderr));
});

test('memory CLI distillation stays draft-only until explicit revisioned review', async t => {
  const { root, run, json } = await fixture(t);
  const source = { id: 'completed-fixture', agent: 'reviewer', status: 'completed', messages: [
    { role: 'user', content: 'Use SQLite for the local database.' },
    { role: 'assistant', content: 'SQLite stores the local project data.' }
  ] };
  await writeState(root, 'runs', `${source.id}.json`, source);
  await assert.rejects(run('memory', 'distill', source.id), error => /--demo or --provider/.test(error.stderr));
  await saveConfig(root, { version: 1, providers: { fixture: { kind: 'demo', model: 'offline' } }, routes: {}, mcp: {} });
  await assert.rejects(run('memory', 'distill', source.id, '--provider', 'fixture'), error => /distillation declined/.test(error.stderr));
  assert.equal((await json('memory', 'drafts')).total, 0);

  const draft = await json('memory', 'distill', source.id, '--demo');
  assert.equal(draft.candidates[0].status, 'pending');
  assert.equal((await json('memory', 'list', '--all-scopes')).total, 0);
  const listed = await json('memory', 'drafts', '--limit', '1');
  assert.equal(listed.total, 1);
  assert.equal(Object.hasOwn(listed.drafts[0], 'sourceExcerpt'), false);
  await assert.rejects(run('memory', 'review', draft.id, draft.candidates[0].id, 'approve'), error => /expected draft revision/.test(error.stderr));
  const reviewed = await json('memory', 'review', draft.id, draft.candidates[0].id, 'approve', '--revision', '1');
  assert.equal(reviewed.draft.revision, 2);
  assert.equal(reviewed.memory.agent, source.agent);
  assert.equal(reviewed.memory.provenance.runId, source.id);
  assert.equal((await json('memory', 'list', '--all-scopes')).total, 1);

  const rejected = await json('memory', 'distill', source.id, '--demo');
  await json('memory', 'review', rejected.id, rejected.candidates[0].id, 'reject', '--revision', '1');
  assert.equal((await json('memory', 'list', '--all-scopes')).total, 1);
});
