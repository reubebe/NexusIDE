import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileEditor, createFileBrowser } from '../ui/file-editor.js';

test('file browser ignores stale listings and retains the displayed directory after failure', async () => {
  const pending = [];
  const browser = createFileBrowser(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const first = browser.open('old'), next = browser.open('new');
  pending[1].resolve({ entries: ['correct.txt'] }); assert.equal(await next, true);
  pending[0].resolve({ entries: ['wrong.txt'] }); assert.equal(await first, false);
  assert.equal(browser.path, 'new'); assert.deepEqual(browser.entries, ['correct.txt']);
  const failed = browser.open('unavailable'); pending[2].reject(new Error('Unavailable'));
  await assert.rejects(failed, /Unavailable/);
  assert.equal(browser.path, 'new'); assert.deepEqual(browser.entries, ['correct.txt']);
  const stale = browser.open('slow'), latest = browser.open('.');
  pending[3].reject(new Error('Old error')); assert.equal(await stale, false);
  pending[4].resolve({ entries: ['root.txt'] }); await latest;
  assert.equal(browser.path, '.');
});

test('file editor preserves edits made during save and uses the acknowledged hash for the next save', async () => {
  let finish;
  const requests = [];
  const editor = createFileEditor(async (route, method, data) => {
    if (method !== 'PUT') return { content: 'original', hash: 'v1' };
    requests.push(data);
    return new Promise(resolve => { finish = resolve; });
  });
  await editor.open('one.txt');
  editor.draft = 'first edit';
  const saving = editor.save();
  editor.draft = 'typed while saving';
  await assert.rejects(editor.open('two.txt', true), /Wait/);
  await assert.rejects(editor.save(), /Wait/);
  finish({ hash: 'v2' }); await saving;
  assert.equal(editor.draft, 'typed while saving');
  assert.equal(editor.saved, 'first edit');
  assert.equal(editor.dirty, true);
  const next = editor.save();
  assert.deepEqual(requests[1], { path: 'one.txt', hash: 'v2', content: 'typed while saving' });
  finish({ hash: 'v3' }); await next;
  assert.equal(editor.dirty, false);
});

test('file editor retains draft and revision after conflicts and failed reloads', async () => {
  let failing = false;
  const editor = createFileEditor(async (_, method) => {
    if (method === 'PUT') throw new Error('File changed since opening');
    if (failing) throw new Error('File unavailable');
    return { content: 'original', hash: 'v1' };
  });
  await editor.open('one.txt'); editor.draft = 'valuable draft';
  await assert.rejects(editor.open('two.txt'), /Save or discard/);
  await assert.rejects(editor.save(), /File changed/);
  failing = true;
  await assert.rejects(editor.open('one.txt', true), /unavailable/);
  assert.equal(editor.path, 'one.txt');
  assert.equal(editor.hash, 'v1');
  assert.equal(editor.draft, 'valuable draft');
  assert.equal(editor.dirty, true);
  assert.equal(editor.busy, false);
  assert.equal(editor.loading, false);
  failing = false;
  await editor.open('one.txt', true);
  assert.equal(editor.draft, 'original');
  assert.equal(editor.dirty, false);
});
