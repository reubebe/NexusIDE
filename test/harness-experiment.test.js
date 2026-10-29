import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installAgent, loadAgent } from '../src/agents.js';
import { readState, writeState, listState } from '../src/state.js';
import { createProvider } from '../src/providers.js';
import { executeHarnessExperiment, validateHarnessExperimentPlan, readHarnessExperimentPlan, getHarnessExperiment, listHarnessExperiments, recordHarnessFeedback, listHarnessFeedback, reviewHarnessExperiment } from '../src/harness-experiment.js';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-experiment-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await installAgent(root, { version: 1, name: 'reviewer', instructions: 'Legacy baseline instructions.', permissions: { read: true, write: false } });
  return root;
}
function plan() {
  return { version: 1, experiment: 'synthetic-fixtures', agent: 'reviewer', hypothesis: 'Ground the answer in the requested fixture.', candidateInstructions: 'Read and use the fixture before answering.',
    edits: [{ component: 'instructions', description: 'Request exact fixture grounding.' }], review: { reviewer: 'synthetic-test', leakageChecked: true, notes: 'Programmed test double; no model accuracy inference.' }, trialsPerCase: 3,
    cases: ['development', 'heldout'].flatMap(split => Array.from({ length: 3 }, (_, i) => ({ id: `${split}-${i}`, split, task: 'Read facts.txt and return its content exactly.', files: { 'facts.txt': `fixture-${split}-${i}` },
      checks: [{ type: 'equals', value: `fixture-${split}-${i}`, critical: false }, { type: 'tool', value: 'read_file', critical: true }] }))) };
}
function provider(extra = {}) {
  return { name: 'synthetic-test-double', model: 'deterministic-fixture', async complete(messages, tools) {
    assert.ok(tools.every(tool => !['write_file', 'run_command', 'run_application'].includes(tool.name)));
    const result = messages.find(message => message.role === 'tool');
    assert.ok(!JSON.stringify(messages.slice(0, 2)).includes('heldout'));
    if (!result) return { text: '', calls: [{ id: 'read', name: 'read_file', args: { path: 'facts.txt' } }], usage: { input: 4, output: 1 }, usageReported: true };
    return { text: messages[0].content.startsWith('Read and use') ? result.content : 'unreliable answer', calls: [], usage: { input: 4, output: 1 }, usageReported: true };
  }, ...extra };
}
const approve = async () => true;
const review = action => ({ action, reviewer: 'human-test', notes: 'Synthetic lifecycle verification.' });

test('executes paired fresh runtime runs, scores external checks, freezes splits and preserves rejected decisions', async t => {
  const root = await workspace(t), input = plan();
  let approvals = 0;
  const result = await executeHarnessExperiment(root, input, { provider: provider(), approve: async request => {
    assert.equal(request.trials, 36); assert.match(request.notice, /fixture contents/); approvals++; return true;
  } });
  assert.equal(result.status, 'completed'); assert.equal(result.eligible, true); assert.equal(result.receipts.length, 36); assert.equal(approvals, 1);
  assert.deepEqual(result.receipts.slice(0, 4).map(receipt => receipt.side), ['baseline', 'candidate', 'candidate', 'baseline']);
  assert.equal(new Set(result.receipts.map(receipt => receipt.runId)).size, 36);
  assert.equal(result.evaluation.heldout.baseline, 0.5); assert.equal(result.evaluation.heldout.candidate, 1);
  assert.match(result.evidence, /Executed paired/);
  assert.equal((await listHarnessExperiments(root))[0].id, result.id);
  assert.equal((await getHarnessExperiment(root, result.id)).candidate.instructions, input.candidateInstructions);
  assert.equal((await executeHarnessExperiment(root, input, { provider: provider() })).repeated, true);
  const changed = structuredClone(input); changed.hypothesis = 'New idea'; changed.cases[0].split = 'heldout'; changed.cases[3].split = 'development';
  await assert.rejects(executeHarnessExperiment(root, changed, { provider: provider(), approve }), /splits changed/);
  const rejected = await reviewHarnessExperiment(root, result.id, review('reject'), { approve });
  assert.equal(rejected.decision, 'rejected'); assert.equal(rejected.receipts.length, 36);
  assert.equal((await loadAgent(root, 'reviewer')).instructions, 'Legacy baseline instructions.');
  await assert.rejects(reviewHarnessExperiment(root, result.id, review('adopt'), { approve }), /already has a review/);
});

test('explicit adoption and rollback preserve permissions and retain revision-linked feedback', async t => {
  const root = await workspace(t), input = plan();
  const result = await executeHarnessExperiment(root, input, { provider: provider(), approve });
  const receipt = result.receipts[1];
  const feedback = await recordHarnessFeedback(root, result.id, { runId: receipt.runId, revision: receipt.revision, rating: 'positive', notes: 'This fixture answer is supported.' });
  assert.equal(feedback.experimentId, result.id);
  assert.equal((await listState(root, 'harness-feedback')).length, 1);
  assert.equal((await listHarnessFeedback(root, result.id))[0].id, feedback.id);
  await assert.rejects(recordHarnessFeedback(root, result.id, { runId: receipt.runId, revision: 'a'.repeat(64), rating: 'positive', notes: 'Wrong revision' }), /matching revision/);
  await assert.rejects(reviewHarnessExperiment(root, result.id, review('adopt')), /declined/);
  assert.equal((await reviewHarnessExperiment(root, result.id, review('adopt'), { approve })).decision, 'adopted');
  assert.equal((await loadAgent(root, 'reviewer')).instructions, input.candidateInstructions);
  assert.deepEqual((await loadAgent(root, 'reviewer')).permissions, { read: true, write: false });
  const rolledBack = await reviewHarnessExperiment(root, result.id, review('rollback'), { approve });
  assert.equal(rolledBack.decision, 'rolled-back'); assert.equal(rolledBack.decisions.length, 2);
  assert.equal((await loadAgent(root, 'reviewer')).instructions, 'Legacy baseline instructions.');
});

test('concurrent edits during approval cannot be overwritten by adoption', async t => {
  const root = await workspace(t);
  const result = await executeHarnessExperiment(root, plan(), { provider: provider(), approve });
  await assert.rejects(reviewHarnessExperiment(root, result.id, review('adopt'), { approve: async () => {
    const agent = await loadAgent(root, 'reviewer');
    await writeState(root, 'agents', 'reviewer.json', { ...agent, instructions: 'A newer user edit.' }); return true;
  } }), /Agent changed/);
  assert.equal((await loadAgent(root, 'reviewer')).instructions, 'A newer user edit.');
  assert.equal((await getHarnessExperiment(root, result.id)).decision, 'pending-review');
});

test('interrupted adoption can be completed only against the recorded snapshots', async t => {
  const root = await workspace(t);
  const result = await executeHarnessExperiment(root, plan(), { provider: provider(), approve });
  result.transition = { action: 'adopt', beforeRevision: result.baselineRevision, afterRevision: result.candidateRevision, review: { ...review('adopt'), at: new Date().toISOString() } };
  await writeState(root, 'harness-experiments', `run-${result.id}.json`, result);
  await writeState(root, 'agents', 'reviewer.json', result.candidate);
  const recovered = await reviewHarnessExperiment(root, result.id, review('adopt'), { approve });
  assert.equal(recovered.decision, 'adopted'); assert.equal(recovered.decisions[0].recovered, true);
  assert.equal(recovered.transition, undefined);
});

test('missing provider usage, script-only demo and critical tool failures block adoption', async t => {
  const root = await workspace(t), input = plan();
  const unknownUsage = provider({ async complete(messages, tools) { const result = await provider().complete(messages, tools); delete result.usage; result.usageReported = false; return result; } });
  const result = await executeHarnessExperiment(root, input, { provider: unknownUsage, approve });
  assert.equal(result.eligible, false); assert.match(result.blockers.join(' '), /report token usage/);
  await assert.rejects(reviewHarnessExperiment(root, result.id, review('adopt'), { approve }), /failed.*gate/);
  const demoInput = plan(); demoInput.experiment = 'demo-test';
  const demo = await executeHarnessExperiment(root, demoInput, { provider: createProvider({ NEXUS_PROVIDER: 'demo' }), approve });
  assert.equal(demo.eligible, false); assert.match(demo.blockers.join(' '), /scripted demo/);
  const failureInput = plan(); failureInput.experiment = 'failure-test';
  const failed = await executeHarnessExperiment(root, failureInput, { provider: provider({ async complete(messages) {
    if (messages.some(message => message.role === 'tool')) return { text: 'fixture-development-0', calls: [], usage: { input: 1, output: 1 } };
    return { text: '', calls: [{ id: 'bad-write', name: 'write_file', args: { path: 'facts.txt', content: 'modified' } }], usage: { input: 1, output: 1 } };
  } }), approve });
  assert.equal(failed.eligible, false); assert.ok(failed.receipts.every(receipt => receipt.status === 'failed' && receipt.criticalFailure && /only read_file/.test(receipt.error)));
});

test('abort leaves durable partial evidence and no eligible result', async t => {
  const root = await workspace(t), controller = new AbortController();
  const waiting = provider({ async complete() { controller.abort(new Error('Stopped by test.')); return new Promise(() => {}); } });
  const result = await executeHarnessExperiment(root, plan(), { provider: waiting, approve, signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.eligible, false); assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].status, 'cancelled'); assert.ok(result.receipts[0].runId);
  assert.equal((await getHarnessExperiment(root, result.id)).status, 'cancelled');
  assert.equal((await readState(root, 'runs', `${result.receipts[0].runId}.json`)).status, 'cancelled');
});

test('a timed-out baseline cannot manufacture an adoptable gain, even if later trials complete', async t => {
  const root = await workspace(t), input = plan(); input.trialTimeoutMs = 100;
  let requests = 0;
  const result = await executeHarnessExperiment(root, input, { provider: provider({ async complete(messages, tools) {
    if (++requests === 1) return new Promise(() => {});
    return provider().complete(messages, tools);
  } }), approve });
  assert.equal(result.status, 'completed'); assert.equal(result.receipts.length, 36);
  assert.equal(result.receipts[0].status, 'cancelled'); assert.equal(result.receipts[0].side, 'baseline');
  assert.equal(result.eligible, false); assert.match(result.blockers.join(' '), /baseline or candidate trial did not complete/);
});

test('persistent provider failure stops after two trials and preserves the underlying errors', async t => {
  const root = await workspace(t);
  let calls = 0;
  const result = await executeHarnessExperiment(root, plan(), { provider: provider({ async complete() { calls++; throw new Error('Provider unavailable.'); } }), approve });
  assert.equal(calls, 2); assert.equal(result.status, 'failed'); assert.equal(result.eligible, false);
  assert.equal(result.receipts.length, 2); assert.match(result.error, /two consecutive/);
  assert.ok(result.receipts.every(receipt => /Provider unavailable/.test(receipt.error)));
  assert.equal((await getHarnessExperiment(root, result.id)).receipts.length, 2);
});

test('input validation blocks traversal, protected fixtures, file collisions, weak checks and linked plans', async t => {
  const root = await workspace(t);
  for (const name of ['../outside', '/tmp/outside', 'x/../../outside', '.env', '.NEXUS/config.json', 'a\\b', 'a:b']) {
    const input = plan(); input.cases[0].files = { [name]: 'value' }; assert.throws(() => validateHarnessExperimentPlan(input), /Fixture files/);
  }
  const collision = plan(); collision.cases[0].files = { a: 'x', 'a/b': 'y' };
  assert.throws(() => validateHarnessExperimentPlan(collision), /also be a directory/);
  const weak = plan(); weak.cases[0].checks = [{ type: 'excludes', value: 'bad', critical: true }];
  assert.throws(() => validateHarnessExperimentPlan(weak), /positive output/);
  const arbitrary = plan(); arbitrary.command = 'echo'; assert.throws(() => validateHarnessExperimentPlan(arbitrary), /identity/);
  const p = path.join(root, 'plan.json'), link = path.join(root, 'linked.json');
  await writeFile(p, JSON.stringify(plan())); await symlink(p, link);
  assert.equal((await readHarnessExperimentPlan(p)).version, 1); await assert.rejects(readHarnessExperimentPlan(link));
  await assert.rejects(executeHarnessExperiment(root, plan(), { provider: provider() }), /declined/);
  assert.equal((await listHarnessExperiments(root)).length, 0);
});
