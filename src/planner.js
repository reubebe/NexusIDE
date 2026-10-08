import { randomUUID } from 'node:crypto';
import { listAgents, loadAgent } from './agents.js';
import { routeProvider } from './config.js';
import { runAgent } from './runtime.js';
import { validateWorkflow } from './workflows.js';
import { writeState } from './state.js';

export async function planTask({ root, task, demo = false, provider, approve, onEvent, signal }) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('Provide a planning task.');
  const agents = await listAgents(root);
  const id = randomUUID(), name = `plan-${id.slice(0, 8)}`;
  let workflow, run;
  if (demo) {
    const chosen = ['architect', 'coder', 'reviewer'].filter(n => agents.some(a => a.name === n));
    if (!chosen.length) throw new Error('Initialize project agents first.');
    workflow = { version: 1, name, steps: chosen.map((agent, i) => ({ id: `step-${i + 1}`, agent, task: i === 0 ? `Plan: ${task}` : i === chosen.length - 1 ? `Review results for: ${task}` : `Implement: ${task}`, ...(i ? { dependsOn: [`step-${i}`] } : {}) })) };
  } else {
    const base = await loadAgent(root, 'architect');
    const planner = { ...base, permissions: { read: true, write: false, execute: false }, mcp: [], applications: [], skills: [], memory: false, instructions: `You are a workflow planner. Inspect the project if useful. Return ONLY a JSON object with version:1, name:"${name}", and steps. Each step has id, agent, task, dependsOn (array of earlier step ids), and optional approval boolean. Use 1–12 steps and only these available agents: ${JSON.stringify(agents.map(a => ({ name: a.name, instructions: a.instructions.slice(0, 180), permissions: a.permissions })))}. Give each step a concrete task. Do not claim that execution has occurred. Require approval before implementation or external actions. Do not include shell commands as workflow metadata.` };
    run = await runAgent({ root, agent: planner, task, provider: provider || await routeProvider(root, base), approve, onEvent, signal, maxSteps: 10 });
    const response = run.messages.filter(m => m.role === 'assistant' && m.content).at(-1)?.content || '';
    const json = response.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    workflow = JSON.parse(json); workflow.name = name;
  }
  validateWorkflow(workflow);
  for (const step of workflow.steps) {
    const agent = agents.find(a => a.name === step.agent);
    if (!agent) throw new Error(`Planner selected unknown agent: ${step.agent}`);
    if (agent.permissions.write || agent.permissions.execute || agent.mcp?.length || agent.applications?.length) step.approval = true;
  }
  const record = { id, name, status: 'planned', task, workflow, run: run?.id, demo, created: new Date().toISOString() };
  await writeState(root, 'plans', `${id}.json`, record, { exclusive: true });
  await writeState(root, 'teams', `${name}.json`, workflow, { exclusive: true });
  return record;
}
