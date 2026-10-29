import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boundedRead, utf8Text } from './bounded-read.js';
import { loadAgent, validateAgent } from './agents.js';
import { runAgent } from './runtime.js';
import { evaluateHarnessCandidate } from './harness-evaluation.js';
import { readState, writeState, listState } from './state.js';
import { acquireWorkspace } from './locks.js';
import { protectedName } from './file-policy.js';
import { redactor } from './redaction.js';
import { toolFailed } from './tool-failure-guard.js';

const folder = 'harness-experiments';
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value, limit = 2000) => typeof value === 'string' && value.trim() && value.length <= limit && !value.includes('\0') && Buffer.from(value).toString('utf8') === value;
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const now = () => new Date().toISOString();
const filename = id => {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Use the full harness experiment ID.');
  return `run-${id}.json`;
};

export async function readHarnessExperimentPlan(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return validateHarnessExperimentPlan(JSON.parse(utf8Text(await boundedRead(handle, 512_000)))); }
  finally { await handle.close(); }
}

export function validateHarnessExperimentPlan(value) {
  if (!keys(value, ['version', 'experiment', 'agent', 'hypothesis', 'candidateInstructions', 'edits', 'review', 'trialsPerCase', 'cases'], ['maxSteps', 'trialTimeoutMs']) || value.version !== 1 ||
    !string(value.experiment, 40) || !/^[a-z0-9][a-z0-9-]*$/.test(value.experiment) || !/^[a-z][a-z0-9-]{0,63}$/.test(value.agent) ||
    !string(value.hypothesis) || !string(value.candidateInstructions, 20_000)) throw new Error('Invalid version 1 harness experiment identity or instructions.');
  if (Buffer.byteLength(JSON.stringify(value)) > 512_000) throw new Error('Harness experiment plan exceeds 512 KB.');
  if (!Array.isArray(value.edits) || value.edits.length < 1 || value.edits.length > 3 || value.edits.some(edit => !keys(edit, ['component', 'description']) || edit.component !== 'instructions' || !string(edit.description, 1000))) throw new Error('Describe one to three instruction edits. Other agent settings cannot change in this experiment.');
  if (!keys(value.review, ['reviewer', 'leakageChecked', 'notes']) || !string(value.review.reviewer, 100) || typeof value.review.leakageChecked !== 'boolean' || !string(value.review.notes)) throw new Error('Supply a named leakage review and notes.');
  if (!Number.isInteger(value.trialsPerCase) || value.trialsPerCase < 3 || value.trialsPerCase > 5 || !Array.isArray(value.cases) || value.cases.length < 6 || value.cases.length > 20) throw new Error('Use 3–5 paired trials and 6–20 cases.');
  if (value.maxSteps !== undefined && (!Number.isInteger(value.maxSteps) || value.maxSteps < 1 || value.maxSteps > 10)) throw new Error('maxSteps must be 1–10.');
  if (value.trialTimeoutMs !== undefined && (!Number.isInteger(value.trialTimeoutMs) || value.trialTimeoutMs < 100 || value.trialTimeoutMs > 120_000)) throw new Error('trialTimeoutMs must be 100–120000.');
  const ids = new Set();
  for (const c of value.cases) {
    if (!keys(c, ['id', 'split', 'task', 'files', 'checks']) || !string(c.id, 80) || ids.has(c.id) || !['development', 'heldout'].includes(c.split) || !string(c.task, 10_000) || !object(c.files)) throw new Error('Cases need unique IDs, development/heldout splits, tasks and inline files.');
    ids.add(c.id);
    if (Object.keys(c.files).length > 20 || Buffer.byteLength(JSON.stringify(c.files)) > 100_000) throw new Error('A case allows at most 20 fixture files totaling 100 KB.');
    const paths = new Set();
    for (const [name, content] of Object.entries(c.files)) {
      const parts = name.split('/');
      if (!string(name, 200) || name.includes('\\') || name.includes(':') || parts.some(part => !part || part === '.' || part === '..' || protectedName(part)) || path.isAbsolute(name) || paths.has(name.toLowerCase()) || typeof content !== 'string' || content.includes('\0') || Buffer.from(content).toString('utf8') !== content) throw new Error('Fixture files need distinct, relative, unprotected UTF-8 paths and contents.');
      paths.add(name.toLowerCase());
    }
    for (const name of paths) if ([...paths].some(other => name !== other && other.startsWith(`${name}/`))) throw new Error('A fixture file cannot also be a directory.');
    if (!Array.isArray(c.checks) || c.checks.length < 1 || c.checks.length > 20 || c.checks.some(check => !keys(check, ['type', 'value', 'critical']) || !['includes', 'equals', 'excludes', 'tool'].includes(check.type) || !string(check.value, 2000) || typeof check.critical !== 'boolean')) throw new Error('Use 1–20 literal output/tool checks, each with a critical boolean.');
    if (!c.checks.some(check => ['includes', 'equals'].includes(check.type))) throw new Error('Each case needs a positive output check, not only exclusions or tool calls.');
    if (c.checks.some(check => check.type === 'tool' && !['read_file', 'list_files', 'search_code'].includes(check.value))) throw new Error('Tool checks may require read_file, list_files or search_code.');
  }
  for (const split of ['development', 'heldout']) if (value.cases.filter(c => c.split === split).length < 3) throw new Error('Provide at least three separate cases in each split.');
  return structuredClone(value);
}

function identity(provider) {
  if (!provider || typeof provider.complete !== 'function' || !string(provider.name, 100) || !string(provider.model, 200)) throw new Error('Select an explicit provider or the offline demo.');
  return { name: provider.name, model: provider.model, profile: provider.profile ?? null, endpoint: provider.endpoint ?? null, options: provider.options ?? null };
}

function boundedProvider(provider) {
  const readTools = new Set(['read_file', 'list_files', 'search_code']);
  return { ...provider, async complete(messages, tools, options = {}) {
    const { signal } = options;
    signal?.throwIfAborted();
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason || new Error('Trial cancelled.')); signal?.addEventListener('abort', abort, { once: true }); });
    try {
      const reply = await Promise.race([Promise.resolve().then(() => provider.complete(messages, tools.filter(tool => readTools.has(tool.name)), options)), cancelled]);
      if (reply?.calls?.some(call => !readTools.has(call.name))) throw new Error('Harness fixtures allow only read_file, list_files and search_code. No other tool request was executed.');
      return reply;
    }
    finally { signal?.removeEventListener('abort', abort); }
  } };
}

async function trial(root, agent, c, provider, plan, parentSignal) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nexus-harness-case-'));
  // Keep this deadline referenced: an unresolved provider promise alone does
  // not keep a CLI process alive, and AbortSignal.timeout uses an unref timer.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Harness trial timed out.')), plan.trialTimeoutMs ?? 60_000);
  const signal = AbortSignal.any([parentSignal, deadline.signal]);
  const started = Date.now();
  let runId, run, error;
  try {
    for (const [name, content] of Object.entries(c.files)) {
      const target = path.join(temporary, name);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: 0o600 });
    }
    run = await runAgent({ root: temporary, stateRoot: root,
      agent: { version: 1, name: agent.name, instructions: agent.instructions, permissions: { read: true, write: false, execute: false } },
      task: c.task, provider: boundedProvider(provider), maxSteps: plan.maxSteps ?? 5, maxContextChars: 32_000, signal,
      onEvent: event => { if (event.type === 'start') runId = event.id; } });
  } catch (e) {
    error = redactor(provider.sensitiveValues)(e.message);
    if (runId) run = await readState(root, 'runs', `${runId}.json`, null);
  } finally { clearTimeout(timer); await rm(temporary, { recursive: true, force: true }); }
  const output = run?.messages?.filter(message => message.role === 'assistant').at(-1)?.content ?? '';
  const events = run?.events ?? [];
  const successfulTools = new Set(events.filter(event => event.type === 'tool-result' && !String(event.content).startsWith('Tool error:') && !toolFailed(event.name, event.content)).map(event => event.name));
  const checks = c.checks.map(check => ({ type: check.type, passed: !error && (check.type === 'includes' ? output.includes(check.value) : check.type === 'equals' ? output.trim() === check.value.trim() : check.type === 'excludes' ? !output.includes(check.value) : successfulTools.has(check.value)), critical: check.critical }));
  const toolErrors = events.filter(event => event.type === 'tool-result' && (String(event.content).startsWith('Tool error:') || toolFailed(event.name, event.content))).length;
  return { runId: runId ?? null, status: error ? (signal.aborted ? 'cancelled' : 'failed') : 'completed', started: new Date(started).toISOString(), durationMs: Date.now() - started,
    score: error ? 0 : checks.filter(check => check.passed).length / checks.length,
    tokens: (run?.usage?.input ?? 0) + (run?.usage?.output ?? 0), usageReported: run?.usage?.reported === true,
    criticalFailure: !!error || toolErrors > 0 || checks.some(check => check.critical && !check.passed), checks, toolErrors, outputHash: hash(output), ...(error ? { error } : {}) };
}

export async function executeHarnessExperiment(root, value, { provider, approve = async () => false, signal } = {}) {
  const plan = validateHarnessExperimentPlan(value), descriptor = identity(provider);
  signal?.throwIfAborted();
  const baseline = await loadAgent(root, plan.agent);
  const candidate = validateAgent({ ...baseline, instructions: plan.candidateInstructions });
  if (candidate.instructions === baseline.instructions) throw new Error('Candidate instructions are unchanged.');
  const baselineRevision = hash(baseline), candidateRevision = hash(candidate);
  const suiteHash = hash({ cases: plan.cases, trialsPerCase: plan.trialsPerCase, maxSteps: plan.maxSteps ?? 5, trialTimeoutMs: plan.trialTimeoutMs ?? 60_000, provider: descriptor });
  const id = hash([plan.experiment, baselineRevision, plan.hypothesis.trim().replace(/\s+/g, ' ').toLowerCase()]);
  const existing = await readState(root, folder, filename(id), null);
  if (existing) return { ...existing, repeated: true };
  const approved = await approve({ type: 'harness-experiment', experiment: plan.experiment, agent: plan.agent, provider: descriptor, trials: plan.cases.length * plan.trialsPerCase * 2,
    suiteHash, baselineRevision, candidateRevision, notice: 'Runs only the supplied inline fixtures with read-only tools. Tasks, instructions and fixture contents reach the selected provider. Expected checks stay outside model context. Run transcripts and review records are saved locally. No original project files or external tools are exposed.' });
  if (!approved) throw new Error('Harness experiment declined.');
  signal?.throwIfAborted();
  const manifestFile = `suite-${hash(plan.experiment)}.json`;
  const manifest = { baselineRevision, suiteHash };
  try { await writeState(root, folder, manifestFile, manifest, { exclusive: true }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; if (hash(await readState(root, folder, manifestFile)) !== hash(manifest)) throw new Error('Experiment baseline, provider, fixtures or splits changed. Use a new experiment name.'); }
  const record = { version: 1, id, experiment: plan.experiment, agent: plan.agent, started: now(), status: 'running', decision: 'pending-review', baselineRevision, candidateRevision, baseline, candidate,
    suiteHash, plan, provider: descriptor, receipts: [], decisions: [], evidence: 'Executed paired runtime trials on inline read-only fixtures. Literal checks are not a general accuracy or security benchmark. Held-out independence relies on the named leakage review. No source edits, commands, model training or automatic adoption.', repeated: false };
  try { await writeState(root, folder, filename(id), record, { exclusive: true }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; return { ...await readState(root, folder, filename(id)), repeated: true }; }
  const experimentSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15 * 60_000)]);
  let consecutiveFailures = 0;
  try {
    for (const c of plan.cases) for (let index = 0; index < plan.trialsPerCase; index++) {
      // Alternate order to reduce a fixed ordering effect. Fresh workspace and
      // runtime messages for each side prevent candidate/baseline cross-talk.
      for (const side of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        experimentSignal.throwIfAborted();
        const result = await trial(root, side === 'baseline' ? baseline : candidate, c, provider, plan, experimentSignal);
        record.receipts.push({ case: c.id, split: c.split, trial: index, side, revision: side === 'baseline' ? baselineRevision : candidateRevision, ...result });
        await writeState(root, folder, filename(id), record);
        consecutiveFailures = result.status === 'completed' ? 0 : consecutiveFailures + 1;
        if (consecutiveFailures >= 2) throw new Error('Stopped after two consecutive failed or cancelled trials. Inspect the saved run errors and resolve the cause before starting a new experiment.');
      }
    }
    const measured = { version: 1, experiment: `executed-${id}`, baselineRevision, candidateRevision, hypothesis: plan.hypothesis, edits: plan.edits, review: plan.review, trialsPerCase: plan.trialsPerCase,
      cases: plan.cases.map(c => ({ id: c.id, split: c.split, ...Object.fromEntries(['baseline', 'candidate'].map(side => [side, record.receipts.filter(receipt => receipt.case === c.id && receipt.side === side).map(({ score, tokens, criticalFailure }) => ({ score, tokens, criticalFailure }))])) })) };
    record.evaluation = await evaluateHarnessCandidate(root, measured);
    record.blockers = [...record.evaluation.reasons];
    if (record.receipts.some(receipt => receipt.status !== 'completed')) record.blockers.push('At least one baseline or candidate trial did not complete; incomplete execution cannot establish improvement.');
    if (record.receipts.some(receipt => !receipt.usageReported)) record.blockers.push('Provider did not report token usage for every trial.');
    if (descriptor.name === 'demo') record.blockers.push('The offline scripted demo is not evidence of model improvement.');
    record.eligible = record.evaluation.status === 'eligible-for-human-review' && record.blockers.length === 0;
    record.status = 'completed';
  } catch (error) {
    record.status = experimentSignal.aborted ? 'cancelled' : 'failed';
    record.error = redactor(provider.sensitiveValues)(error.message); record.eligible = false;
  }
  record.finished = now();
  await writeState(root, folder, filename(id), record);
  return record;
}

export async function getHarnessExperiment(root, id) {
  return readState(root, folder, filename(id));
}
export async function listHarnessExperiments(root) {
  const names = (await listState(root, folder)).filter(name => /^run-[a-f0-9]{64}\.json$/.test(name));
  const records = [];
  for (const name of names) {
    const { id, experiment, agent, status, decision, eligible, started, finished, baselineRevision, candidateRevision, blockers } = await readState(root, folder, name);
    records.push({ id, experiment, agent, status, decision, eligible, started, finished, baselineRevision, candidateRevision, blockers });
  }
  return records.sort((a, b) => b.started.localeCompare(a.started));
}

export async function recordHarnessFeedback(root, id, input) {
  if (!keys(input, ['runId', 'revision', 'rating', 'notes']) || !string(input.runId, 100) || !/^[a-f0-9]{64}$/.test(input.revision) || !['positive', 'negative', 'neutral'].includes(input.rating) || !string(input.notes, 4000)) throw new Error('Feedback needs a runId, revision, positive/negative/neutral rating and notes.');
  const experiment = await getHarnessExperiment(root, id);
  if (!experiment.receipts.some(receipt => receipt.runId === input.runId && receipt.revision === input.revision)) throw new Error('Feedback must reference an executed run and its matching revision.');
  const record = redactor()({ id: randomUUID(), experimentId: id, at: now(), ...input });
  await writeState(root, 'harness-feedback', `${record.id}.json`, record, { exclusive: true });
  return record;
}

export async function listHarnessFeedback(root, id) {
  await getHarnessExperiment(root, id);
  const feedback = [];
  for (const name of await listState(root, 'harness-feedback')) {
    const record = await readState(root, 'harness-feedback', name);
    if (record.experimentId === id) feedback.push(record);
  }
  return feedback.sort((a, b) => a.at.localeCompare(b.at));
}

export async function reviewHarnessExperiment(root, id, input, { approve = async () => false } = {}) {
  if (!keys(input, ['action', 'reviewer', 'notes']) || !['adopt', 'reject', 'rollback'].includes(input.action) || !string(input.reviewer, 100) || !string(input.notes, 4000)) throw new Error('Review needs adopt/reject/rollback, a reviewer and notes.');
  const before = await getHarnessExperiment(root, id);
  if (!await approve({ type: `harness-${input.action}`, experimentId: id, agent: before.agent, baselineRevision: before.baselineRevision, candidateRevision: before.candidateRevision, ...input,
    notice: input.action === 'reject' ? 'Retains rejected evidence without changing the agent.' : 'Changes only this agent’s instructions after checking its exact saved revision. Existing permissions and provider settings remain unchanged.' })) throw new Error('Harness review declined.');
  const release = await acquireWorkspace(root, root, randomUUID());
  try {
    const record = await getHarnessExperiment(root, id), current = await loadAgent(root, record.agent);
    const revision = hash(current);
    if (hash(record.baseline) !== record.baselineRevision || hash(record.candidate) !== record.candidateRevision) throw new Error('Experiment snapshot integrity check failed.');
    // A durable prepared transition permits safe recovery after an interruption
    // between changing the agent and publishing the final review receipt.
    if (record.transition) {
      const pending = record.transition;
      if (!['adopt', 'rollback'].includes(pending.action) || pending.beforeRevision !== (pending.action === 'adopt' ? record.baselineRevision : record.candidateRevision) || pending.afterRevision !== (pending.action === 'adopt' ? record.candidateRevision : record.baselineRevision) || (pending.action === 'adopt' && !record.eligible)) throw new Error('Interrupted review integrity check failed.');
      if (pending.action !== input.action) throw new Error(`An interrupted ${pending.action} must be completed before another review.`);
      if (revision !== pending.beforeRevision && revision !== pending.afterRevision) throw new Error('Agent changed since the interrupted review; preserve current work and reconcile manually.');
      if (revision === pending.beforeRevision) await writeState(root, 'agents', `${record.agent}.json`, pending.action === 'adopt' ? record.candidate : record.baseline);
      record.decision = pending.action === 'adopt' ? 'adopted' : 'rolled-back';
      record.decisions.push({ ...pending.review, completed: now(), recovered: true });
      delete record.transition;
      await writeState(root, folder, filename(id), record);
      return record;
    }
    if (record.status !== 'completed') throw new Error('Only a completed experiment can be reviewed.');
    if (input.action === 'rollback' && record.decision !== 'adopted') throw new Error('Only an adopted experiment can be rolled back.');
    if (input.action !== 'rollback' && record.decision !== 'pending-review') throw new Error('This experiment already has a review decision. Evidence is retained; run a new hypothesis.');
    if (input.action === 'adopt' && !record.eligible) throw new Error('Candidate failed the experiment gate and cannot be adopted.');
    const decision = redactor()({ id: randomUUID(), at: now(), ...input });
    if (input.action === 'reject') record.decision = 'rejected';
    else {
      const expected = input.action === 'adopt' ? record.baselineRevision : record.candidateRevision;
      const target = input.action === 'adopt' ? record.candidate : record.baseline;
      if (revision !== expected) throw new Error('Agent changed since evaluation/adoption. Current instructions and settings are preserved.');
      record.transition = { action: input.action, beforeRevision: revision, afterRevision: hash(target), review: decision };
      await writeState(root, folder, filename(id), record);
      await writeState(root, 'agents', `${record.agent}.json`, target);
      record.decision = input.action === 'adopt' ? 'adopted' : 'rolled-back';
      delete record.transition;
    }
    record.decisions.push({ ...decision, completed: now() });
    await writeState(root, folder, filename(id), record);
    return record;
  } finally { await release(); }
}
