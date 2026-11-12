import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateSkillDraft, listSkillDrafts, publishSkillDraft, discoverSkills, planSkillSelection } from '../src/skill-foundry.js';
import { listState, readState } from '../src/state.js';
import { commandMatches } from '../ui/workbench.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-foundry-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'guide.md'), 'Check dimensions.\nPreserve the original.\nRecord the result.');
  return root;
}
const input = { approved: true, provider: 'fixture', source: 'guide.md', rights: 'Synthetic owned fixture', goal: 'Review an image' };
const candidate = { name: 'image-review', description: 'Review image inputs', steps: [{ text: 'Check dimensions.', startLine: 1, endLine: 1, quote: 'Check dimensions.' }] };
const provider = text => ({ name: 'fixture', profile: 'fixture', model: 'synthetic', complete: async (_messages, tools) => { assert.equal(tools.length, 0); return { text, calls: [], usage: { input: 10, output: 20 }, usageReported: true }; } });

test('generated draft uses a tool-free accounted run, validates exact grounding and remains unpublished', async t => {
  const root = await fixture(t);
  // Three deterministic fixture procedures compare to the same manually supplied
  // source evidence. This validates the pipeline, not a real model quality gain.
  for (const [index, text] of ['Check dimensions.', 'Preserve the original.', 'Record the result.'].entries()) {
    const reply = { ...candidate, name: 'fixture-' + index, steps: [{ text, quote: text, startLine: index + 1, endLine: index + 1 }] };
    const draft = await generateSkillDraft(root, input, { provider: provider(JSON.stringify(reply)) });
    assert.equal(draft.status, 'draft'); assert.equal(draft.generation.usage.input, 10);
    assert.match(draft.text, /Model-generated candidate/);
    assert.equal((await listState(root, 'skills')).length, 0);
    const run = await readState(root, 'runs', draft.generation.runId + '.json');
    assert.equal(run.profile, 'fixture'); assert.equal(run.status, 'completed');
    await assert.rejects(publishSkillDraft(root, { id: draft.id, digest: draft.digest, approved: false, rightsConfirmed: true }));
  }
});

test('generation refuses unapproved egress, malformed output, invented citations and tool execution', async t => {
  const root = await fixture(t);
  await assert.rejects(generateSkillDraft(root, { ...input, approved: false }, { provider: provider('{}') }), /Approve/);
  await assert.rejects(generateSkillDraft(root, input, { provider: provider('not json') }), /malformed/);
  await assert.rejects(generateSkillDraft(root, input, { provider: provider(JSON.stringify({ ...candidate, steps: [{ ...candidate.steps[0], quote: 'invented' }] })) }), /quotation/);
  const malicious = { ...provider(''), complete: async () => ({ text: '', usage: { input: 1, output: 1 }, calls: [{ id: 'attack', name: 'write_file', args: { path: 'escape', content: 'bad' } }] }) };
  await assert.rejects(generateSkillDraft(root, input, { provider: malicious }));
  assert.equal((await listSkillDrafts(root)).length, 0);
});

test('command search matches words irrespective of case and limits output', () => {
  assert.deepEqual(commandMatches([{ id: 'files', label: 'Project files' }, { id: 'agents', label: 'Your agents' }], 'FILES project').map(c => c.id), ['files']);
  assert.equal(commandMatches(Array.from({ length: 50 }, (_, i) => ({ id: String(i), label: 'item' })), '').length, 30);
});
test('published skill discovery is local and composition leaves permissions unchanged',async t=>{
 const root=await fixture(t),draft=await generateSkillDraft(root,input,{provider:provider(JSON.stringify(candidate))});
 assert.equal((await discoverSkills(root,'image review')).matches.length,0);
 await publishSkillDraft(root,{id:draft.id,digest:draft.digest,approved:true,rightsConfirmed:true});
 assert.equal((await discoverSkills(root,'image review')).matches[0].name,candidate.name);
 const plan=await planSkillSelection(root,{skills:[candidate.name]});assert.equal(plan.status,'plan-only');assert.ok(plan.selected[0].digest);assert.equal((await listState(root,'agents')).length,0);
 await assert.rejects(planSkillSelection(root,{skills:[candidate.name,candidate.name]}),/distinct/);
});
