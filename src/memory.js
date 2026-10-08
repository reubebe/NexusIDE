import { randomUUID } from 'node:crypto';
import { listState, readState, writeState, safeName, statePath } from './state.js';
import { unlink } from 'node:fs/promises';

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
  const memories = await Promise.all((await listState(root, 'memory')).map(f => readState(root, 'memory', f)));
  return memories.filter(m => m.scope === 'project' || m.agent === agent).map(m => ({ ...m, score: words.reduce((n, w) => n + Number(m.text.toLowerCase().includes(w)), 0) })).filter(m => !words.length || m.score).sort((a, b) => b.score - a.score || b.created.localeCompare(a.created)).slice(0, 20);
}
export async function forget(root, id) { await unlink(await statePath(root, 'memory', `${safeName(id)}.json`)); }
