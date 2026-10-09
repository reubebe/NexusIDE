import { randomUUID } from 'node:crypto';
import { writeState, safeName, deleteState, searchMemories } from './state.js';

export async function remember(root, { text, scope = 'project', agent, source = 'user' }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Memory text must contain 1–16000 characters.');
  if (!['project', 'agent'].includes(scope)) throw new Error('Memory scope must be project or agent.');
  if (scope === 'agent') safeName(agent);
  const memory = { id: randomUUID(), text, scope, agent: scope === 'agent' ? agent : undefined, source, created: new Date().toISOString() };
  await writeState(root, 'memory', `${memory.id}.json`, memory, { exclusive: true });
  return memory;
}
export async function recall(root, query = '', agent) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return searchMemories(root, words, agent);
}
export async function forget(root, id) { await deleteState(root, 'memory', `${safeName(id)}.json`); }
