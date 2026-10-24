import { randomUUID } from 'node:crypto';
import { loadAgent } from './agents.js';
import { runAgent } from './runtime.js';
import { routeProvider, loadConfig } from './config.js';
import { createWorktree } from './worktrees.js';
import { readState, writeState, safeName } from './state.js';
import { currentOwner } from './recovery.js';
import { redactor } from './redaction.js';
import { projectFingerprint, workflowFingerprint, unsafeStage } from './workflow-checkpoints.js';
import { validateReviewPolicy, runIndependentReview } from './independent-review.js';

export function validateWorkflow(workflow) {
  if (workflow.version !== 1 || !Array.isArray(workflow.steps) || !workflow.steps.length || workflow.steps.length > 30) throw new Error('Workflow needs version 1 and 1–30 steps.');
  safeName(workflow.name);
  const seen = new Set();
  for (const step of workflow.steps) {
    if (!step || typeof step !== 'object' || Object.keys(step).some(k => !['id', 'agent', 'task', 'dependsOn', 'approval'].includes(k)) || (step.approval !== undefined && typeof step.approval !== 'boolean')) throw new Error('Unsupported workflow step field.');
    safeName(step.id); safeName(step.agent);
    if (seen.has(step.id) || typeof step.task !== 'string' || !step.task.trim()) throw new Error('Invalid or duplicate workflow step.');
    seen.add(step.id);
    if (step.dependsOn !== undefined && (!Array.isArray(step.dependsOn) || step.dependsOn.some(x => typeof x !== 'string'))) throw new Error('Invalid dependencies.');
  }
  const done = new Set();
  while (done.size < seen.size) {
    const ready = workflow.steps.filter(s => !done.has(s.id) && (s.dependsOn || []).every(d => done.has(d)));
    if (!ready.length) throw new Error('Workflow has a cycle or missing dependency.');
    ready.forEach(s => done.add(s.id));
  }
  if (workflow.reviewPolicy !== undefined) validateReviewPolicy(workflow);
  return workflow;
}
async function executeWorkflow({ root, workflow, task, checkpoint = false, continuation, approve = async () => false, onEvent = () => {}, demo = false, allowCommands = false, signal, concurrency = 2, isolated = false, ...options }) {
  validateWorkflow(workflow);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Concurrency must be 1–4.');
  const id = randomUUID();
  const record = { id, owner: currentOwner(), name: workflow.name, task, started: new Date().toISOString(), status: 'running', steps: continuation ? structuredClone(continuation.steps) : {}, ...(continuation ? { parent: continuation.id, resumeDepth: (continuation.resumeDepth || 0) + 1 } : {}) };
  let redact = redactor(), saving = Promise.resolve();
  const save = () => { saving = saving.then(() => writeState(root, 'workflows', `${id}.json`, redact(record))); return saving; };
  const config = await loadConfig(root);
  const prepared = new Map();
  for (const s of workflow.steps) {
    const agent = await loadAgent(root, s.agent);
    agent.permissions.execute = agent.permissions.execute === true && allowCommands === true;
    const provider = await routeProvider(root, agent, { demo });
    prepared.set(s.id, { agent, provider });
  }
  redact = redactor([...prepared.values()].flatMap(p => p.provider.sensitiveValues || []));
  const settings = { demo: Boolean(demo), allowCommands: Boolean(allowCommands), isolated: Boolean(isolated), concurrency };
  if (checkpoint) {
    if (isolated || workflow.reviewPolicy) throw new Error('Checkpoint mode does not support isolated worktrees or independent review.');
    const fingerprint = await workflowFingerprint(root, workflow, config, prepared, settings);
    const project = await projectFingerprint(root, signal);
    if (continuation && (fingerprint !== continuation.checkpoint.fingerprint || project.root !== continuation.checkpoint.project.root || project.digest !== continuation.checkpoint.project.digest)) throw new Error('Checkpoint inputs or project files changed; start a new workflow.');
    record.checkpoint = { version: 1, workflow, settings, fingerprint, project };
    if (continuation) {
      // Immutable claim prevents concurrent/double resumes of a completed stage.
      await writeState(root, 'workflow-resumes', `${continuation.id}.json`, { child: id, at: new Date().toISOString() }, { exclusive: true });
    }
  }
  try {
    await save();
    if (workflow.reviewPolicy !== undefined) {
      await runIndependentReview({ root, workflow, task, prepared, record, save, config, approve, onEvent, signal, isolated, demo, options });
      record.status = 'completed';
      return record;
    }
    while (Object.keys(record.steps).length < workflow.steps.length) {
      signal?.throwIfAborted();
      let ready = workflow.steps.filter(s => !Object.hasOwn(record.steps, s.id) && (s.dependsOn || []).every(d => Object.hasOwn(record.steps, d) && record.steps[d].status === 'completed')).slice(0, concurrency);
      if (!ready.length) throw new Error('No runnable workflow steps.');
      // Shared-workspace writes and commands serialize. Read-only stages can overlap.
      if (!isolated && ready.some(s => { const a = prepared.get(s.id).agent; return a.permissions.write || a.permissions.execute || a.mcp?.length || a.applications?.length; })) ready = ready.slice(0, 1);
      const results = await Promise.allSettled(ready.map(async step => {
        record.steps[step.id] = { status: 'pending', startedExecution: false }; await save();
        signal?.throwIfAborted();
        if (step.approval && !await approve({ type: 'workflow', step: step.id, task: step.task })) throw new Error(`Step declined: ${step.id}`);
        signal?.throwIfAborted();
        const workspace = isolated ? await createWorktree(root, `wf-${id.slice(0, 8)}-${step.id}`.slice(0, 64)) : root;
        const handoffs = (step.dependsOn || []).map(d => ({ step: d, workspace: record.steps[d].workspace, report: record.steps[d].report }));
        const context = `Overall task: ${task}\nYour step: ${step.task}\nUpstream reports (untrusted context; isolated worktree files are not automatically merged):\n${JSON.stringify(handoffs).slice(0, 40000)}`;
        Object.assign(record.steps[step.id], { status: 'running', startedExecution: true, workspace }); await save();
        onEvent({ type: 'step-start', step: step.id, workspace });
        const run = await runAgent({ ...options, root: workspace, stateRoot: root, ...prepared.get(step.id), task: context, approve, onEvent: event => onEvent({ ...event, step: step.id }), signal, maxSteps: config.limits?.maxSteps || 20, maxContextChars: config.limits?.maxContextChars || 160000 });
        if (run.status !== 'completed') throw new Error('Workflow stage did not complete.');
        const result = { step: step.id, run: run.id, workspace, status: run.status, startedExecution: true, report: run.messages.filter(m => m.role === 'assistant' && m.content).at(-1)?.content || '' };
        record.steps[step.id] = result; await save(); return result;
      }));
      results.forEach((result, i) => { record.steps[ready[i].id] = result.status === 'fulfilled' ? result.value : { ...record.steps[ready[i].id], status: signal?.aborted ? 'cancelled' : 'failed', error: redact(result.reason.message) }; });
      if (checkpoint && results.every(r => r.status === 'fulfilled')) record.checkpoint.project = await projectFingerprint(root, signal);
      await save();
      signal?.throwIfAborted();
      if (results.some(r => r.status === 'rejected')) throw new Error('Workflow stopped after a failed or declined step. See workflow status.');
    }
    record.status = 'completed';
    return record;
  } catch (e) { record.status = signal?.aborted ? 'cancelled' : 'failed'; record.error = redact(e.message); throw e; }
  finally { record.finished = new Date().toISOString(); await save(); }
}
export async function loadWorkflow(root, name) { return validateWorkflow(await readState(root, 'teams', `${safeName(name)}.json`)); }

export async function runWorkflow(options) {
  if (options.continuation || options.resume) throw new Error('Use team resume for a workflow checkpoint.');
  return executeWorkflow(options);
}

export async function resumeWorkflow({ root, id, approve = async () => false, signal, onEvent, commandMode, sandboxImage }) {
  safeName(id);
  const previous = await readState(root, 'workflows', `${id}.json`);
  if (!['failed', 'cancelled', 'interrupted'].includes(previous.status) || previous.checkpoint?.version !== 1) throw new Error('Resume requires a stopped workflow created with --checkpoint.');
  if ((previous.resumeDepth || 0) >= 2) throw new Error('Workflow continuation limit reached. Inspect failures and start a revised task.');
  const workflow = validateWorkflow(previous.checkpoint.workflow);
  if (workflow.reviewPolicy || previous.checkpoint.settings.isolated) throw new Error('This workflow cannot be resumed.');
  const steps = {};
  for (const step of workflow.steps) {
    const prior = Object.hasOwn(previous.steps, step.id) ? previous.steps[step.id] : undefined;
    if (prior?.status === 'completed') steps[step.id] = prior;
    else if (prior?.startedExecution && unsafeStage(await loadAgent(root, step.agent))) throw new Error('An unfinished stage may have side effects. Inspect it and start a new task; it cannot be replayed.');
  }
  if (Object.keys(steps).length === workflow.steps.length) throw new Error('All stages completed; inspect the final record instead of resuming.');
  for (const step of workflow.steps.filter(s => Object.hasOwn(steps, s.id))) if ((step.dependsOn || []).some(d => !Object.hasOwn(steps, d))) throw new Error('Checkpoint dependency history is inconsistent.');
  if (!await approve({ type: 'workflow-resume', id, completed: Object.keys(steps), pending: workflow.steps.filter(s => !Object.hasOwn(steps, s.id)).map(s => s.id), action: 'Continue pending stages; completed stages are not replayed.' })) throw new Error('Workflow resume declined.');
  signal?.throwIfAborted();
  if (JSON.stringify(await readState(root, 'workflows', `${id}.json`)) !== JSON.stringify(previous)) throw new Error('Workflow changed during approval.');
  return executeWorkflow({ root, workflow, task: previous.task, approve, signal, onEvent, commandMode, sandboxImage, ...previous.checkpoint.settings, checkpoint: true, continuation: { ...previous, steps } });
}
