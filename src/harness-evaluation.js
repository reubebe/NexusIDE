import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { boundedRead, utf8Text } from './bounded-read.js';
import { readState, writeState } from './state.js';
import { redactor } from './redaction.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, length = 1000) => typeof value === 'string' && value.trim().length > 0 && value.length <= length;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fixedPolicy = { maxEdits: 3, minimumGain: 0.02, noiseMultiplier: 1.96, maxTokenIncrease: 0.1, minimumCasesPerSplit: 3, minimumTrials: 3 };

export async function readHarnessEvaluationInput(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return JSON.parse(utf8Text(await boundedRead(handle, 1_000_000))); }
  finally { await handle.close(); }
}

function validate(input) {
  if (!exact(input, ['version', 'experiment', 'baselineRevision', 'candidateRevision', 'hypothesis', 'edits', 'review', 'trialsPerCase', 'cases']) || input.version !== 1 ||
    !text(input.experiment, 80) || !/^[a-z0-9][a-z0-9-]*$/.test(input.experiment) || !/^[a-f0-9]{40,64}$/.test(input.baselineRevision) || !/^[a-f0-9]{40,64}$/.test(input.candidateRevision) ||
    input.baselineRevision === input.candidateRevision || !text(input.hypothesis, 2000)) throw new Error('Invalid harness evaluation identity. Use the documented version 1 evidence schema.');
  if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 20 || input.edits.some(e => !exact(e, ['component', 'description']) || !text(e.component, 100) || !text(e.description))) throw new Error('Supply bounded, described edits.');
  if (!exact(input.review, ['reviewer', 'leakageChecked', 'notes']) || !text(input.review.reviewer, 100) || typeof input.review.leakageChecked !== 'boolean' || !text(input.review.notes, 2000)) throw new Error('Supply a named leakage review and its notes.');
  if (!Number.isInteger(input.trialsPerCase) || input.trialsPerCase < 3 || input.trialsPerCase > 20 || !Array.isArray(input.cases) || input.cases.length < 6 || input.cases.length > 100) throw new Error('Use 3–20 trials per case and 6–100 cases.');
  const ids = new Set();
  for (const c of input.cases) {
    if (!exact(c, ['id', 'split', 'baseline', 'candidate']) || !text(c.id, 100) || ids.has(c.id) || !['development', 'heldout'].includes(c.split)) throw new Error('Case IDs must be unique across development and heldout splits.');
    ids.add(c.id);
    for (const side of ['baseline', 'candidate']) {
      if (!Array.isArray(c[side]) || c[side].length !== input.trialsPerCase) throw new Error('Each case must have the full trial array; use null for missing trials.');
      for (const trial of c[side]) if (trial !== null && (!exact(trial, ['score', 'tokens', 'criticalFailure']) || !Number.isFinite(trial.score) || trial.score < 0 || trial.score > 1 || !Number.isSafeInteger(trial.tokens) || trial.tokens < 0 || trial.tokens > 100_000_000 || typeof trial.criticalFailure !== 'boolean')) throw new Error('Trials need a score from 0–1, nonnegative token count and criticalFailure boolean.');
    }
  }
  for (const split of ['development', 'heldout']) if (input.cases.filter(c => c.split === split).length < fixedPolicy.minimumCasesPerSplit) throw new Error('Provide at least three separate cases in each split.');
  return input;
}

function metrics(cases, trials) {
  let baseline = 0, candidate = 0, baselineTokens = 0, candidateTokens = 0, missing = 0, criticalFailures = 0;
  const gains = []; let withinVariance = 0;
  for (const c of cases) {
    let b = 0, a = 0;
    for (const t of c.baseline) { b += t?.score || 0; baselineTokens += t?.tokens || 0; if (!t) missing++; }
    for (const t of c.candidate) { a += t?.score || 0; candidateTokens += t?.tokens || 0; if (!t) missing++; if (t?.criticalFailure) criticalFailures++; }
    const mean = (a - b) / trials;
    const paired = c.candidate.map((t, i) => (t?.score || 0) - (c.baseline[i]?.score || 0));
    withinVariance += paired.reduce((sum, difference) => sum + (difference - mean) ** 2, 0) / (trials - 1) / trials;
    baseline += b; candidate += a; gains.push(mean);
  }
  const denominator = cases.length * trials, gain = (candidate - baseline) / denominator;
  const variance = gains.reduce((sum, value) => sum + (value - gain) ** 2, 0) / (gains.length - 1);
  // A conservative heuristic band across case-level gains, not a calibrated
  // confidence interval or a substitute for an independently designed benchmark.
  const noiseFloor = Math.max(fixedPolicy.minimumGain, fixedPolicy.noiseMultiplier * Math.sqrt(variance / gains.length + withinVariance / gains.length ** 2));
  return { cases: cases.length, trials: denominator, baseline: baseline / denominator, candidate: candidate / denominator, gain, noiseFloor, baselineTokens, candidateTokens, missing, criticalFailures };
}

export async function evaluateHarnessCandidate(root, value) {
  const input = validate(value), redact = redactor();
  const sorted = [...input.cases].sort((a, b) => a.id.localeCompare(b.id));
  const scope = hash([input.experiment, input.baselineRevision]);
  const baselineHash = hash([input.trialsPerCase, sorted.map(c => ({ id: c.id, split: c.split, baseline: c.baseline }))]);
  const suiteName = `suite-${scope}.json`;
  // A fixed manifest/baseline prevents silently dropping a failed case or
  // changing split membership on the next candidate within this experiment.
  try { await writeState(root, 'harness-evaluations', suiteName, { baselineHash }, { exclusive: true }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if ((await readState(root, 'harness-evaluations', suiteName)).baselineHash !== baselineHash) throw new Error('The experiment baseline, case manifest or split changed. Use a new experiment with fresh independent evidence.');
  }
  const hypothesisHash = hash(input.hypothesis.trim().replace(/\s+/g, ' ').toLowerCase());
  const filename = `candidate-${hash([scope, hypothesisHash])}.json`;
  const previous = await readState(root, 'harness-evaluations', filename, null);
  if (previous) return { ...previous, repeated: true, note: 'This hypothesis was already assessed for this baseline. No new evaluation was performed; inspect the saved evidence before revising the approach.' };
  const development = metrics(sorted.filter(c => c.split === 'development'), input.trialsPerCase);
  const heldout = metrics(sorted.filter(c => c.split === 'heldout'), input.trialsPerCase);
  const reasons = [];
  if (input.edits.length > fixedPolicy.maxEdits) reasons.push('Candidate bundles more than three edits.');
  if (!input.review.leakageChecked) reasons.push('Leakage review is incomplete.');
  if (development.missing + heldout.missing) reasons.push('Missing trials count as zero reward; incomplete evidence cannot pass.');
  if (development.criticalFailures + heldout.criticalFailures) reasons.push('Candidate has a critical failure.');
  if (development.gain <= development.noiseFloor) reasons.push('Development gain does not exceed the noise floor.');
  if (heldout.gain <= heldout.noiseFloor) reasons.push('Held-out gain does not exceed the noise floor.');
  for (const [name, m] of [['Development', development], ['Held-out', heldout]]) {
    if (m.candidateTokens > m.baselineTokens * (1 + fixedPolicy.maxTokenIncrease)) reasons.push(`${name} token use grows by more than 10%.`);
    if (m.baselineTokens > 0 && m.candidateTokens > m.baselineTokens && m.gain <= (m.candidateTokens / m.baselineTokens - 1) * m.baseline) reasons.push(`${name} score gain does not pay for the proportional token increase.`);
  }
  const record = redact({ version: 1, at: new Date().toISOString(), experiment: input.experiment, baselineRevision: input.baselineRevision, candidateRevision: input.candidateRevision, hypothesis: input.hypothesis, edits: input.edits, review: input.review, evidenceHash: hash(input), baselineHash, policy: fixedPolicy,
    status: reasons.length ? 'rejected' : 'eligible-for-human-review', reasons, development, heldout,
    evidence: 'User-supplied measurements; not independently executed or certified. This command changes no source, prompts, model routes or runtime settings.', repeated: false });
  try { await writeState(root, 'harness-evaluations', filename, record, { exclusive: true }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; return { ...await readState(root, 'harness-evaluations', filename), repeated: true }; }
  return record;
}
