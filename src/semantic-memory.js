import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { validateEmbedding } from './embedding-config.js';
export { validateEmbedding } from './embedding-config.js';
import { listState, readState, writeState } from './state.js';
import { readProviderJson } from './providers.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function vector(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8192 || value.some(x => !Number.isFinite(x))) throw new Error('Invalid embedding vector.');
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || !norm) throw new Error('Invalid embedding vector norm.');
  return value.map(x => x / norm);
}
export async function embed(config, input, signal) {
  validateEmbedding(config);
  const response = await fetch(config.url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: config.model, input, truncate: false }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Embedding endpoint returned HTTP ${response.status}.`); }
  const body = await readProviderJson(response);
  if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) throw new Error('Embedding response count mismatch.');
  return body.embeddings.map(vector);
}
async function memories(root) {
  const files = await listState(root, 'memory');
  if (files.length > 1000) throw new Error('Semantic index is limited to 1000 notes.');
  return Promise.all(files.map(f => readState(root, 'memory', f)));
}
export async function rebuildMemoryIndex(root, { signal } = {}) {
  const config = validateEmbedding((await loadConfig(root)).embeddings);
  const notes = await memories(root), entries = [];
  let dimensions;
  for (let offset = 0; offset < notes.length; offset += 8) {
    signal?.throwIfAborted();
    const batch = notes.slice(offset, offset + 8);
    const vectors = await embed(config, batch.map(n => n.text), signal);
    vectors.forEach((v, i) => {
      dimensions ??= v.length;
      if (v.length !== dimensions) throw new Error('Embedding dimensions changed during indexing.');
      entries.push({ id: batch[i].id, digest: hash(batch[i]), vector: v });
    });
  }
  const index = { version: 1, config, built: new Date().toISOString(), dimensions: dimensions || 0, entries };
  if (Buffer.byteLength(JSON.stringify(index, null, 2)) > 18_000_000) throw new Error('Semantic index exceeds storage limit; reduce note count or embedding dimensions.');
  await writeState(root, 'indexes', 'memory.json', index);
  return { indexed: entries.length, dimensions: index.dimensions, model: config.model, built: index.built };
}
export async function semanticRecall(root, query, agent, { signal } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 16000) throw new Error('Semantic query must contain 1–16000 characters.');
  const config = validateEmbedding((await loadConfig(root)).embeddings);
  const index = await readState(root, 'indexes', 'memory.json', null);
  if (!index || index.version !== 1 || hash(index.config) !== hash(config)) throw new Error('Rebuild the memory index for the configured embedding model.');
  const notes = (await memories(root)).filter(n => n.scope === 'project' || (n.scope === 'agent' && agent && n.agent === agent));
  const entries = new Map(index.entries.map(e => [e.id, e]));
  const current = notes.filter(n => entries.get(n.id)?.digest === hash(n));
  const stale = notes.length - current.length;
  if (!current.length) return { matches: [], stale, indexed: 0, built: index.built };
  const [needle] = await embed(config, [query], signal);
  if (needle.length !== index.dimensions) throw new Error('Embedding dimensions changed; rebuild the memory index.');
  const matches = current.map(note => {
    const value = vector(entries.get(note.id).vector);
    if (value.length !== needle.length) throw new Error('Corrupt memory vector dimensions.');
    return { ...note, score: value.reduce((sum, x, i) => sum + x * needle[i], 0) };
  }).sort((a, b) => b.score - a.score).slice(0, 20);
  return { matches, stale, indexed: current.length, built: index.built };
}
