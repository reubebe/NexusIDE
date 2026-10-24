import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentEditor } from '../ui/agent-editor.js';

const agent = { version: 1, name: 'coder', instructions: 'Original', permissions: { read: true } };

test('agent selection protects unsaved JSON and loadout edits until explicitly discarded', () => {
  const editor = createAgentEditor();
  editor.select(agent);
  editor.draft = JSON.stringify({ ...agent, memoryLoadout: { project: 'none' } });
  assert.equal(editor.dirty, true);
  assert.throws(() => editor.select({ ...agent, name: 'reviewer' }), /Save your agent edits/);
  assert.equal(editor.name, 'coder');
  assert.match(editor.draft, /memoryLoadout/);
  editor.select(agent, true);
  assert.equal(editor.dirty, false);
});

test('agent save retains later edits and prevents selection and duplicate saves while pending', async () => {
  let finish;
  const editor = createAgentEditor(async (route, method, data) => {
    assert.equal(route, 'agent'); assert.equal(method, 'PUT');
    assert.equal(data.instructions, 'First edit');
    return new Promise(resolve => { finish = resolve; });
  });
  editor.select(agent);
  editor.draft = JSON.stringify({ ...agent, instructions: 'First edit' });
  const submitted = editor.draft, saving = editor.save();
  editor.draft = JSON.stringify({ ...agent, instructions: 'Newer edit' });
  assert.throws(() => editor.select(agent, true), /current agent save/);
  await assert.rejects(editor.save(), /current agent save/);
  finish(agent); await saving;
  assert.equal(editor.saved, submitted);
  assert.match(editor.draft, /Newer edit/);
  assert.equal(editor.dirty, true); assert.equal(editor.busy, false);
});

test('failed and invalid agent saves preserve the draft and saved snapshot', async () => {
  const editor = createAgentEditor(async () => { throw new Error('Save failed'); });
  editor.select(agent); const saved = editor.saved;
  editor.draft = '{invalid';
  await assert.rejects(editor.save(), SyntaxError);
  assert.equal(editor.busy, false);
  editor.draft = JSON.stringify({ ...agent, instructions: 'Keep this draft' });
  await assert.rejects(editor.save(), /Save failed/);
  assert.equal(editor.saved, saved); assert.match(editor.draft, /Keep this draft/);
  assert.equal(editor.dirty, true); assert.equal(editor.busy, false);
});

test('agent reload excludes competing saves and retains edits when the definition disappears', async () => {
  let finish;
  const editor = createAgentEditor(async () => new Promise(resolve => { finish = resolve; }));
  editor.select(agent); editor.draft = 'valuable draft';
  const loading = editor.reload();
  assert.equal(editor.loading, true);
  await assert.rejects(editor.save(), /current agent save/);
  assert.throws(() => editor.select(agent, true), /current agent save/);
  finish({ agents: [] }); await assert.rejects(loading, /draft has been retained/);
  assert.equal(editor.draft, 'valuable draft'); assert.equal(editor.loading, false);
  const reloading = editor.reload();
  finish({ agents: [{ ...agent, instructions: 'Latest saved definition' }] }); await reloading;
  assert.equal(editor.dirty, false); assert.match(editor.draft, /Latest saved/);
});
