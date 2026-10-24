import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateHarnessCandidate, readHarnessEvaluationInput } from '../src/harness-evaluation.js';
import { runProcess } from '../src/process.js';
import { fileURLToPath } from 'node:url';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-eval-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const evidence = () => ({ version: 1, experiment: 'fixture', baselineRevision: 'a'.repeat(40), candidateRevision: 'b'.repeat(40), hypothesis: 'Bound redundant context', edits: [{ component: 'context', description: 'Reduce duplicate excerpts.' }], review: { reviewer: 'fixture-reviewer', leakageChecked: true, notes: 'Synthetic fixture only; no task-specific branches.' }, trialsPerCase: 3,
  cases: ['development', 'heldout'].flatMap(split => Array.from({ length: 3 }, (_, i) => ({ id: `${split}-${i}`, split, baseline: Array.from({ length: 3 }, () => ({ score: 0.5, tokens: 1000, criticalFailure: false })), candidate: Array.from({ length: 3 }, () => ({ score: 0.8, tokens: 900, criticalFailure: false })) }))) });

test('good evidence becomes eligible for review only, with durable duplicate prevention', async t => {
  const root = await workspace(t), input = evidence();
  const result = await evaluateHarnessCandidate(root, input);
  assert.equal(result.status, 'eligible-for-human-review'); assert.deepEqual(result.reasons, []);
  assert.match(result.evidence, /not independently executed/);
  input.hypothesis = '  BOUND   redundant context  ';
  const repeat = await evaluateHarnessCandidate(root, input);
  assert.equal(repeat.repeated, true); assert.equal(repeat.evidenceHash, result.evidenceHash);
});

test('missing trials use the full denominator and cannot pass', async t => {
  const root = await workspace(t), input = evidence(); input.cases[0].candidate[0] = null;
  const result = await evaluateHarnessCandidate(root, input);
  assert.equal(result.status, 'rejected'); assert.equal(result.development.missing, 1);
  assert.ok(Math.abs(result.development.candidate - 6.4 / 9) < 1e-10);
  assert.match(result.reasons.join(' '), /Missing trials/);
});

test('leakage, edit count, heldout regressions, critical failures and token increases are gated', async t => {
  const root = await workspace(t), input = evidence();
  input.review.leakageChecked = false;
  input.edits = Array.from({ length: 4 }, () => input.edits[0]);
  for (const c of input.cases) for (const trial of c.candidate) {
    trial.tokens = 1200;
    if (c.split === 'heldout') trial.score = 0.4;
  }
  input.cases[0].candidate[0].criticalFailure = true;
  const result = await evaluateHarnessCandidate(root, input), reasons = result.reasons.join(' ');
  assert.equal(result.status, 'rejected');
  for (const pattern of [/three edits/, /Leakage/, /Held-out gain/, /critical failure/, /10%/]) assert.match(reasons, pattern);
});

test('small and noisy gains are rejected, including variance within repeated trials', async t => {
  const root = await workspace(t), input = evidence();
  for (const c of input.cases) c.candidate.forEach((trial, i) => { trial.score = [0, 0.8, 1][i]; });
  const result = await evaluateHarnessCandidate(root, input);
  assert.ok(result.development.noiseFloor > result.development.gain);
  assert.equal(result.status, 'rejected');
});

test('experiment freezes baseline, case membership and splits', async t => {
  const root = await workspace(t), input = evidence();
  await evaluateHarnessCandidate(root, input);
  input.hypothesis = 'A different idea'; input.cases[0].baseline[0].score = 0.1;
  await assert.rejects(evaluateHarnessCandidate(root, input), /experiment baseline/);
});

test('reject malformed evidence, non-finite scores, unpaired trials, and linked input files', async t => {
  const root = await workspace(t), bad = evidence(); bad.cases[0].candidate[0].score = NaN;
  await assert.rejects(evaluateHarnessCandidate(root, bad), /Trials need/);
  const shorter = evidence(); shorter.cases[0].candidate.pop();
  await assert.rejects(evaluateHarnessCandidate(root, shorter), /full trial array/);
  const duplicated = evidence(); duplicated.cases[1].id = duplicated.cases[0].id;
  await assert.rejects(evaluateHarnessCandidate(root, duplicated), /unique/);
  const file = path.join(root, 'evidence.json'), link = path.join(root, 'link.json');
  await writeFile(file, JSON.stringify(evidence())); await symlink(file, link);
  assert.equal((await readHarnessEvaluationInput(file)).version, 1);
  await assert.rejects(readHarnessEvaluationInput(link));
});

test('documented CLI evaluates the synthetic example locally and rejects a duplicate', async t => {
  const root = await workspace(t);
  const args = [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'harness', 'evaluate', fileURLToPath(new URL('../examples/harness-evaluation.json', import.meta.url))];
  const settings = { cwd: root, env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' } };
  const first = await runProcess(process.execPath, args, settings);
  assert.equal(first.code, 0, first.output);
  assert.equal(JSON.parse(first.output).status, 'eligible-for-human-review');
  const second = await runProcess(process.execPath, args, settings);
  assert.equal(second.code, 1); assert.equal(JSON.parse(second.output).repeated, true);
});
