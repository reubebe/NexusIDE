import { validateEmbedding } from './embedding-config.js';
import { readProviderJson } from './providers.js';

export function normalizeVector(value) {
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
  return body.embeddings.map(normalizeVector);
}
