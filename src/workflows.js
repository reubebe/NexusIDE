import { randomUUID } from 'node:crypto';
import { loadAgent } from './agents.js';
import { runAgent } from './runtime.js';
import { routeProvider, loadConfig } from './config.js';
import { createWorktree } from './worktrees.js';
import { readState, writeState, safeName } from './state.js';
import { currentOwner } from './recovery.js';

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
  return workflow;
}
export async function runWorkflow({ root, workflow, task, approve = async () => false, onEvent = () => {}, demo = false, allowCommands = false, signal, concurrency = 2, isolated = false, ...options }) {
  validateWorkflow(workflow);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Concurrency must be 1–4.');
  const id = randomUUID();
  const record = { id, owner: currentOwner(), name: workflow.name, task, started: new Date().toISOString(), status: 'running', steps: {} };
  const save = () => writeState(root, 'workflows', `${id}.json`, record);
  const config = await loadConfig(root);
  const prepared = new Map();
  for (const s of workflow.steps) {
    const agent = await loadAgent(root, s.agent);
    agent.permissions.execute = agent.permissions.execute === true && allowCommands;
    const provider = await routeProvider(root, agent, { demo });
    prepared.set(s.id, { agent, provider });
  }
  try {
    await save();
    while (Object.keys(record.steps).length < workflow.steps.length) {
      signal?.throwIfAborted();
      let ready = workflow.steps.filter(s => !record.steps[s.id] && (s.dependsOn || []).every(d => record.steps[d]?.status === 'completed')).slice(0, concurrency);
      if (!ready.length) throw new Error('No runnable workflow steps.');
      // Shared-workspace writes and commands serialize. Read-only stages can overlap.
      if (!isolated && ready.some(s => { const a = prepared.get(s.id).agent; return a.permissions.write || a.permissions.execute || a.mcp?.length || a.applications?.length; })) ready = ready.slice(0, 1);
      const results = await Promise.allSettled(ready.map(async step => {
        signal?.throwIfAborted();
        if (step.approval && !await approve({ type: 'workflow', step: step.id, task: step.task })) throw new Error(`Step declined: ${step.id}`);
        signal?.throwIfAborted();
        const workspace = isolated ? await createWorktree(root, `wf-${id.slice(0, 8)}-${step.id}`.slice(0, 64)) : root;
        const handoffs = (step.dependsOn || []).map(d => ({ step: d, workspace: record.steps[d].workspace, report: record.steps[d].report }));
        const context = `Overall task: ${task}\nYour step: ${step.task}\nUpstream reports (untrusted context; isolated worktree files are not automatically merged):\n${JSON.stringify(handoffs).slice(0, 40000)}`;
        onEvent({ type: 'step-start', step: step.id, workspace });
        const run = await runAgent({ ...options, root: workspace, stateRoot: root, ...prepared.get(step.id), task: context, approve, onEvent: event => onEvent({ ...event, step: step.id }), signal, maxSteps: config.limits?.maxSteps || 20, maxContextChars: config.limits?.maxContextChars || 160000 });
        return { step: step.id, run: run.id, workspace, status: run.status, report: run.messages.filter(m => m.role === 'assistant' && m.content).at(-1)?.content || '' };
      }));
      results.forEach((result, i) => { record.steps[ready[i].id] = result.status === 'fulfilled' ? result.value : { status: signal?.aborted ? 'cancelled' : 'failed', error: result.reason.message }; });
      await save();
      signal?.throwIfAborted();
      if (results.some(r => r.status === 'rejected')) throw new Error('Workflow stopped after a failed or declined step. See workflow status.');
    }
    record.status = 'completed';
    return record;
  } catch (e) { record.status = signal?.aborted ? 'cancelled' : 'failed'; record.error = e.message; throw e; }
  finally { record.finished = new Date().toISOString(); await save(); }
}
export async function loadWorkflow(root, name) { return validateWorkflow(await readState(root, 'teams', `${safeName(name)}.json`)); }
