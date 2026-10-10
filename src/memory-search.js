import { setImmediate } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { validateEmbedding } from './embedding-config.js';
import { embed } from './embeddings.js';
import { ensureSqliteFolder, safeName } from './state.js';
import { openDatabase } from './sqlite.js';
import { digest, configKey, indexSchema, decodeVector, keepBest } from './index-store.js';
import { normalizeMemory, normalizeLoadout, visibleMemory, boundMemoryResults } from './memory-policy.js';

// Query operators are never accepted from user text. A small OR expression
// preserves recall across natural-language queries and handles FTS punctuation.
export function ftsQuery(query) {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])]
    .slice(0, 64).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

export function searchBudget({ signal, timeoutMs = 5000, limit = 20, maxChars = 20000 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Search limit must be 1–20.');
  if (!Number.isInteger(maxChars) || maxChars < 256 || maxChars > 20000) throw new Error('Search character budget must be 256–20000.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Search timeout must be 1–120000 ms.');
  const deadline = Date.now() + timeoutMs;
  const timed = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timed]) : timed;
  return { signal: combined, limit, maxChars, check() {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new DOMException('Memory retrieval exceeded its time budget.', 'TimeoutError');
    combined.throwIfAborted();
  } };
}

export function reciprocalRankFusion(lexical, semantic, key = item => item.id, limit = 20) {
  const scores = new Map();
  for (const [kind, values] of [['lexical', lexical], ['semantic', semantic]]) {
    for (const [rank, item] of values.entries()) {
      const id = key(item), previous = scores.get(id) || { ...item, score: 0 };
      previous.score += 1 / (60 + rank + 1);
      previous[`${kind}Score`] = item[`${kind}Score`] ?? item.score;
      previous[`${kind}Rank`] = rank + 1;
      scores.set(id, previous);
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || String(key(a)).localeCompare(String(key(b)))).slice(0, limit);
}

export async function searchMemory(root, query = '', agent, options = {}) {
  const { mode = 'hybrid' } = options;
  if (!['lexical', 'semantic', 'hybrid'].includes(mode)) throw new Error('Search mode must be lexical, semantic, or hybrid.');
  if (typeof query !== 'string' || query.length > 16000 || (mode !== 'lexical' && !query.trim())) throw new Error('Memory query must contain 1–16000 characters.');
  if (agent !== undefined) safeName(agent);
  const loadout = normalizeLoadout(options.loadout), budget = searchBudget(options);
  const limit = options.loadout ? Math.min(budget.limit, loadout.maxItems) : budget.limit;
  const maxChars = options.loadout ? Math.min(budget.maxChars, loadout.maxChars) : budget.maxChars;
  budget.check();
  await ensureSqliteFolder(root, 'memory');
  const db = await openDatabase(root);
  let warning, config, usedMode = mode;
  try {
    if (mode !== 'lexical') {
      try { config = validateEmbedding((await loadConfig(root)).embeddings); }
      catch (error) { if (mode === 'semantic') throw error; warning = 'Embeddings are not configured; using keyword search.'; usedMode = 'lexical'; }
      indexSchema(db);
    }
    db.exec('BEGIN');
    const now = Date.now();
    db.function('memory_visible', { deterministic: true }, data => {
      budget.check();
      return Number(visibleMemory(JSON.parse(data), agent, loadout, now));
    });
    // Visibility precedes ranking/limiting, including private ownership,
    // expiration, archived state and selected project memory identifiers.
    const scope = "r.folder='memory' AND (r.scope='project' OR (r.scope='agent' AND r.agent=?)) AND memory_visible(r.data)=1";
    const lexicalCount = mode !== 'semantic' ? db.prepare(`SELECT count(*) AS count FROM state_records r WHERE ${scope}`).get(agent ?? null).count : 0;
    const terms = ftsQuery(query);
    const candidates = Math.min(200, Math.max(60, limit * 5));
    let lexical = [];
    const candidateDigests = new Map();
    if (mode !== 'semantic') {
      const rows = terms ? db.prepare(`SELECT r.name, r.data, -bm25(memory_fts) AS score FROM memory_fts
        JOIN state_records r ON r.name=memory_fts.name WHERE memory_fts MATCH ? AND ${scope}
        ORDER BY bm25(memory_fts),r.created DESC,r.name LIMIT ?`).all(terms, agent ?? null, candidates)
        : query.trim() ? [] : db.prepare(`SELECT r.name,r.data,0 AS score FROM state_records r WHERE ${scope}
          ORDER BY r.created DESC,r.name LIMIT ?`).all(agent ?? null, candidates);
      lexical = rows.map(row => {
        const note = JSON.parse(row.data);
        candidateDigests.set(note.id, { name: row.name, digest: digest(JSON.stringify(note)) });
        return { ...normalizeMemory(note), score: row.score, lexicalScore: row.score };
      });
    }
    budget.check();
    let stale = 0, indexed = 0, built, semantic = [];
    if (config) {
      const meta = db.prepare("SELECT * FROM index_meta WHERE kind='memory'").get();
      built = meta?.built;
      if (!meta || meta.config !== configKey(config)) {
        if (mode === 'semantic') throw new Error('Rebuild the memory index for the configured embedding model.');
        warning = 'The semantic index needs rebuilding; using keyword search.'; usedMode = 'lexical';
      } else {
        const scoped = db.prepare(`SELECT r.data,s.digest,c.vector FROM state_records r
          LEFT JOIN index_sources s ON s.kind='memory' AND s.key=substr(r.name,1,length(r.name)-5)
          LEFT JOIN index_chunks c ON c.kind=s.kind AND c.source_key=s.key WHERE ${scope}`);
        let visited = 0;
        for (const row of scoped.iterate(agent ?? null)) {
          if (++visited % 128 === 0) await setImmediate();
          budget.check();
          if (!row.vector || !row.vector.length || row.digest !== digest(JSON.stringify(JSON.parse(row.data)))) stale++;
          else indexed++;
        }
        if (indexed) {
          try {
            const [needle] = await embed(config, [query], budget.signal);
            if (needle.length !== meta.dimensions) throw new Error('Embedding dimensions changed; rebuild the memory index.');
            for (const row of scoped.iterate(agent ?? null)) {
              if (++visited % 128 === 0) await setImmediate();
              budget.check();
              const note = JSON.parse(row.data);
              if (!row.vector?.length || row.digest !== digest(JSON.stringify(note))) continue;
              const vector = decodeVector(row.vector, meta.dimensions);
              const score = vector.reduce((sum, value, i) => sum + value * needle[i], 0);
              keepBest(semantic, { ...normalizeMemory(note), score, semanticScore: score, sourceDigest: row.digest }, candidates);
            }
          } catch (error) {
            options.signal?.throwIfAborted();
            if (mode === 'semantic') throw error;
            semantic = []; usedMode = 'lexical';
            warning = error.name === 'TimeoutError' ? 'Semantic search timed out; using keyword search.' : 'Semantic search is unavailable; using keyword search.';
          }
        } else if (mode === 'hybrid') { usedMode = 'lexical'; warning = 'No current semantic vectors are available; using keyword search.'; }
      }
    }
    if (usedMode === 'lexical') indexed = lexicalCount;
    for (const candidate of semantic) {
      candidateDigests.set(candidate.id, { name: `${candidate.id}.json`, digest: candidate.sourceDigest });
      delete candidate.sourceDigest;
    }
    const ranked = usedMode === 'hybrid' ? reciprocalRankFusion(lexical, semantic, item => item.id, candidates) : usedMode === 'semantic' ? semantic : lexical;
    // Embeddings can await a service while another connection edits a note or
    // revokes its scope. Reopen the read snapshot before releasing any result.
    // Compare raw records as well as revisions: legacy writes need not bump a
    // revision. Keep this final authorization pass synchronous, and honor only
    // explicit cancellation so a semantic timeout can still return keywords.
    db.exec('ROLLBACK');
    options.signal?.throwIfAborted();
    db.exec('BEGIN');
    const currentNote = db.prepare("SELECT data FROM state_records WHERE folder='memory' AND name=?");
    const authorizedAt = Date.now();
    const current = ranked.filter(candidate => {
      const expected = candidateDigests.get(candidate.id);
      const row = expected && currentNote.get(expected.name);
      if (!row) return false;
      const note = JSON.parse(row.data);
      return expected.digest === digest(JSON.stringify(note)) && visibleMemory(note, agent, loadout, authorizedAt);
    });
    options.signal?.throwIfAborted();
    const bounded = boundMemoryResults(current, { limit, maxChars });
    return { ...bounded, mode: usedMode, ...(warning ? { warning } : {}), stale, indexed, ...(built ? { built } : {}) };
  } finally { db.close(); }
}
