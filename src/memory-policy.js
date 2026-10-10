import { randomUUID } from 'node:crypto';
import { safeName } from './state.js';

export const MEMORY_LAYERS = ['L1', 'L2', 'L3'];
export const MEMORY_CATEGORIES = { L1: ['fact', 'decision', 'constraint', 'procedure'], L2: ['summary'], L3: ['preference'] };
const agentName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function validateMemoryLoadout(value) {
  if (!object(value)) throw new Error('Memory selection must be an object.');
  for (const key of Object.keys(value)) if (!['project', 'ids', 'layers', 'maxItems', 'maxChars'].includes(key)) throw new Error(`Unsupported memory selection field: ${key}.`);
  if (value.project !== undefined && !['all', 'selected', 'none'].includes(value.project)) throw new Error('Project memory selection must be all, selected, or none.');
  if (value.ids !== undefined) {
    if (!Array.isArray(value.ids) || value.ids.length > 200) throw new Error('Select at most 200 memory IDs.');
    value.ids.forEach(safeName);
    if (new Set(value.ids).size !== value.ids.length) throw new Error('Memory IDs must be unique.');
  }
  if (value.layers !== undefined && (!Array.isArray(value.layers) || value.layers.length > 3 || value.layers.some(layer => !MEMORY_LAYERS.includes(layer)) || new Set(value.layers).size !== value.layers.length)) throw new Error('Memory layers must be a unique selection of L1, L2 and L3.');
  if (value.maxItems !== undefined && (!Number.isInteger(value.maxItems) || value.maxItems < 1 || value.maxItems > 20)) throw new Error('Memory result limit must be 1–20.');
  if (value.maxChars !== undefined && (!Number.isInteger(value.maxChars) || value.maxChars < 256 || value.maxChars > 20000)) throw new Error('Memory context budget must be 256–20000 characters.');
  return value;
}

export function normalizeLoadout(value) {
  if (value !== undefined) validateMemoryLoadout(value);
  return { project: 'all', ids: [], layers: [...MEMORY_LAYERS], maxItems: 8, maxChars: 12000, ...value };
}

export function normalizeMemory(note) {
  if (!object(note)) throw new Error('Invalid memory record.');
  safeName(note.id);
  if (typeof note.text !== 'string' || !note.text.trim() || note.text.length > 16000) throw new Error('Memory text must contain 1–16000 characters.');
  if (!['project', 'agent'].includes(note.scope) || (note.scope === 'agent' && !agentName(note.agent))) throw new Error('Memory must have a project scope or a valid owning agent.');
  const layer = note.layer ?? 'L1', category = note.category ?? MEMORY_CATEGORIES[layer]?.[0];
  if (!MEMORY_CATEGORIES[layer]?.includes(category)) throw new Error('Memory category does not match its layer.');
  const status = note.status ?? 'active', revision = note.revision ?? 1;
  if (!['active', 'archived'].includes(status) || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid memory status or revision.');
  const expiresAt = note.expiresAt ?? null;
  if (expiresAt !== null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) throw new Error('Memory expiry must be a date or null.');
  const source = note.source ?? (note.version !== 2 ? 'legacy' : undefined);
  if (typeof source !== 'string' || !source.trim() || source.length > 512) throw new Error('Memory source must contain 1–512 characters.');
  return { ...note, source, version: 2, layer, category, revision, status, expiresAt, updated: note.updated ?? note.created, provenance: note.provenance ?? null };
}

export function createMemoryRecord(input, { id = randomUUID(), created = new Date().toISOString(), source = input?.source ?? 'user', provenance = input?.provenance ?? null } = {}) {
  if (!object(input)) throw new Error('Provide a memory object.');
  const scope = input.scope ?? 'project';
  return normalizeMemory({ version: 2, id, text: input.text, scope, ...(scope === 'agent' ? { agent: input.agent } : {}), source, created, updated: created,
    layer: input.layer ?? 'L1', category: input.category, revision: 1, status: 'active', expiresAt: input.expiresAt ?? null, provenance });
}

// Selection only narrows scope; a selected ID cannot grant another agent's notes.
export function visibleMemory(raw, agent, loadout, now = Date.now()) {
  let note;
  try { note = normalizeMemory(raw); } catch { return false; }
  const selection = normalizeLoadout(loadout);
  if (note.status !== 'active' || (note.expiresAt && Date.parse(note.expiresAt) <= Number(now)) || !selection.layers.includes(note.layer)) return false;
  if (note.scope === 'agent') return Boolean(agent && note.agent === agent);
  return selection.project === 'all' || (selection.project === 'selected' && selection.ids.includes(note.id));
}

// Count serialized metadata as well as text, never slice serialized JSON mid-record.
export function boundMemoryResults(results, { limit = 20, maxChars = 20000 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(maxChars) || maxChars < 256 || maxChars > 20000) throw new Error('Invalid memory result budget.');
  const matches = []; let chars = 2, truncated = false;
  for (const record of results) {
    if (matches.length >= limit) { truncated = true; break; }
    let candidate = { ...record }, size = JSON.stringify(candidate).length;
    const remaining = maxChars - chars - Number(matches.length > 0);
    if (size > remaining) {
      truncated = true;
      candidate = { ...record, text: '', textTruncated: true };
      if (JSON.stringify(candidate).length + 1 > remaining) continue;
      let low = 0, high = record.text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (JSON.stringify({ ...candidate, text: record.text.slice(0, mid) }).length <= remaining) low = mid;
        else high = mid - 1;
      }
      candidate.text = record.text.slice(0, low);
      size = JSON.stringify(candidate).length;
    }
    chars += size + Number(matches.length > 0); matches.push(candidate);
  }
  return { matches, truncated, characters: chars };
}
