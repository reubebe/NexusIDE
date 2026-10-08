import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readState, writeState, listState } from './state.js';

export const defaults = [
  { name: 'architect', instructions: 'Inspect the project and propose a concrete implementation plan. Explain tradeoffs and cite files.', permissions: { read: true, write: false } },
  { name: 'coder', instructions: 'Inspect surrounding code before editing. Make focused changes that satisfy the task. Report changes and limitations accurately.', permissions: { read: true, write: true } },
  { name: 'reviewer', instructions: 'Review code for correctness and security. Report actionable findings with file references. Do not invent test results.', permissions: { read: true, write: false } },
].map(a => ({ version: 1, ...a }));

export function validateAgent(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('Agent must be an object.');
  const allowed = ['version', 'name', 'instructions', 'permissions', 'skills', 'provider', 'mcp', 'memory', 'applications'];
  for (const key of Object.keys(a)) if (!allowed.includes(key)) throw new Error(`Unsupported agent field: ${key}. Import requires NexusIDE v1 JSON.`);
  if (a.version !== 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(a.name ?? '')) throw new Error('Agent needs version: 1 and a lowercase name (letters, digits, hyphens).');
  if (typeof a.instructions !== 'string' || !a.instructions.trim()) throw new Error('Agent instructions must be nonempty text.');
  if (!a.permissions || typeof a.permissions.read !== 'boolean' || typeof a.permissions.write !== 'boolean') throw new Error('Explicit read/write boolean permissions are required.');
  if (a.permissions.execute !== undefined && typeof a.permissions.execute !== 'boolean') throw new Error('execute permission must be a boolean.');
  for (const key of Object.keys(a.permissions)) if (!['read', 'write', 'execute'].includes(key)) throw new Error(`Unsupported permission: ${key}`);
  for (const key of ['skills', 'mcp', 'applications']) if (a[key] !== undefined && (!Array.isArray(a[key]) || a[key].some(v => typeof v !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(v)))) throw new Error(`${key} must be a list of names.`);
  if (a.provider !== undefined && typeof a.provider !== 'string') throw new Error('provider must be a profile name.');
  if (a.memory !== undefined && typeof a.memory !== 'boolean') throw new Error('memory must be a boolean.');
  return a;
}

export async function installAgent(root, agent) {
  validateAgent(agent);
  await writeState(root, 'agents', `${agent.name}.json`, agent, { exclusive: true });
}

export async function loadAgent(root, name) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '')) throw new Error('Invalid agent name.');
  return validateAgent(await readState(root, 'agents', `${name}.json`));
}

export async function listAgents(root) {
  const files = await listState(root, 'agents');
  return Promise.all(files.filter(f => f.endsWith('.json')).sort().map(f => loadAgent(root, f.slice(0, -5))));
}
