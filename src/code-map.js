import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { connectMcp } from './mcp.js';
import { acquireWorkspace } from './locks.js';
import { resolveProjectPath } from './file-policy.js';

const required = ['list_projects', 'search_graph', 'trace_path', 'check_index_coverage'];
const fingerprint = profile => createHash('sha256').update(JSON.stringify(profile)).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const bounded = (v, max = 300) => typeof v === 'string' && v.length <= max && !/[\x00-\x1f]/.test(v);
const regex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function codeMapStatus(root) {
  const profile = (await loadConfig(root)).mcp.codegraph;
  const unavailable = reason => ({ available: false, reason });
  if (!profile) return unavailable('Configure the optional codebase-memory-mcp connection named codegraph in Connections.');
  if (profile.transport === 'http' || (profile.envKeys || []).length) return unavailable('Code map requires a local codebase-memory-mcp profile without forwarded credentials.');
  if (!required.every(tool => profile.tools.includes(tool))) return unavailable('The codegraph profile must grant list_projects, search_graph, trace_path, and check_index_coverage.');
  let executable = profile.command, scope, args = [...profile.args];
  if (profile.command === '/usr/bin/env') {
    while (args[0]?.startsWith('CBM_')) {
      const setting = args.shift();
      if (setting.startsWith('CBM_ALLOWED_ROOT=')) scope = setting.slice(17);
      else if (!setting.startsWith('CBM_CACHE_DIR=')) return unavailable('Unsupported codegraph launcher setting.');
    }
    executable = args.shift();
  }
  if (!executable || !path.isAbsolute(executable) || !['codebase-memory-mcp', 'codebase-memory-mcp.exe'].includes(path.basename(executable)) || !args.includes('--ui=false') || args.some(arg => !['--ui=false', '--tool-profile=analysis'].includes(arg))) return unavailable('Use the reviewed codebase-memory-mcp binary with --ui=false and optional --tool-profile=analysis.');
  const canonical = await realpath(root);
  if (!scope || !path.isAbsolute(scope) || !inside(canonical, await realpath(scope))) return unavailable('Set CBM_ALLOWED_ROOT to this workspace or a source folder inside it.');
  scope = await realpath(scope);
  await resolveProjectPath(canonical, path.relative(canonical, scope) || '.');
  return { available: true, digest: fingerprint(profile), command: executable, scope: path.relative(canonical, scope) || '.', tools: required, note: 'Queries start this local process and read its existing index. The backend may refresh its own cache. No model request is made.' };
}

function decode(raw) {
  if (typeof raw !== 'string' || raw.length > 100000) throw new Error('Code map result is too large.');
  const envelope = JSON.parse(raw);
  if (envelope.isError || envelope.truncated) throw new Error('Graph service could not complete this bounded query.');
  const value = envelope.structuredContent || JSON.parse(envelope.content?.filter(item => item.type === 'text').map(item => item.text).join(''));
  if (!value || typeof value !== 'object' || value.error) throw new Error('Invalid graph response.');
  return value;
}

export function graphRows(table, limit = 20) {
  if (Array.isArray(table?.cols) && Array.isArray(table.rows)) {
    // BM25 queries use a flat qn/file table; exact-symbol and traversal queries
    // use grouped tables. Normalize both documented backend response shapes.
    return table.rows.slice(0, limit).map(row => {
      if (!Array.isArray(row)) throw new Error('Invalid graph row.');
      const value = Object.fromEntries(table.cols.map((key, i) => [key, row[i]]));
      if (!bounded(value.qn, 1800) || !value.qn) throw new Error('Invalid qualified symbol.');
      return { name: value.qn.split('.').at(-1), qualifiedName: value.qn, file: bounded(value.file) ? value.file : null, lines: bounded(value.lines, 40) ? value.lines : '', confidence: null, strategy: '', test: false };
    });
  }
  if (!Array.isArray(table?.cols) || !Array.isArray(table?.groups)) throw new Error('Unsupported graph result format.');
  const rows = [];
  for (const group of table.groups.slice(0, 100)) {
    if (!Array.isArray(group.rows) || !bounded(group.qn_prefix ?? '', 1500)) throw new Error('Invalid graph group.');
    for (const row of group.rows) {
      if (rows.length >= limit) return rows;
      if (!Array.isArray(row)) throw new Error('Invalid graph row.');
      const value = Object.fromEntries(table.cols.map((key, i) => [key, row[i]]));
      if (!bounded(value.name, 300)) throw new Error('Invalid symbol name.');
      rows.push({ name: value.name, qualifiedName: group.qn_prefix ? `${group.qn_prefix}.${value.name}` : value.name, file: bounded(group.file) ? group.file : null, lines: bounded(value.lines, 40) ? value.lines : '', confidence: Number.isFinite(value.confidence) ? value.confidence : null, strategy: bounded(value.strategy, 80) ? value.strategy : '', test: value.test === true });
    }
  }
  return rows;
}

export async function queryCodeMap(root, input, { connect = connectMcp, signal } = {}) {
  if (!input || Object.keys(input).some(k => !['operation', 'digest', 'approved', 'project', 'query', 'symbol'].includes(k)) || !['projects', 'search', 'neighbors'].includes(input.operation) || input.approved !== true || !/^[a-f0-9]{64}$/.test(input.digest || '')) throw new Error('Review and approve the configured code map connection first.');
  if (input.operation !== 'projects' && (!bounded(input.project, 200) || !input.project)) throw new Error('Select an indexed project.');
  if (input.operation === 'search' && (!bounded(input.query, 120) || !input.query.trim())) throw new Error('Search needs 1–120 characters.');
  if (input.operation === 'neighbors' && (!bounded(input.symbol, 1800) || !input.symbol)) throw new Error('Select a symbol.');
  const release = await acquireWorkspace(root, root, randomUUID());
  let connection;
  try {
    const status = await codeMapStatus(root);
    if (!status.available) throw new Error(status.reason);
    if (status.digest !== input.digest) throw new Error('Graph configuration changed. Refresh and approve it again.');
    const timeout = AbortSignal.timeout(30000), cancelled = signal ? AbortSignal.any([signal, timeout]) : timeout;
    connection = await connect(root, { mcp: ['codegraph'] }, async request => request.type === 'mcp-connect' ? request.name === 'codegraph' : request.type === 'mcp-call' && required.includes(request.tool), cancelled);
    const call = async (name, args) => {
      const tool = connection.tools.find(t => t.description.startsWith(`[codegraph/${name}]`));
      if (!tool) throw new Error(`Graph service is missing ${name}.`);
      return decode(await connection.call(tool.name, args));
    };
    const listed = await call('list_projects', { format: 'json', limit: 50 });
    const canonical = await realpath(root), projects = [];
    for (const p of (listed.projects || []).slice(0, 50)) {
      if (!bounded(p.name, 200) || typeof p.root_path !== 'string' || !path.isAbsolute(p.root_path)) continue;
      try {
        const directory = await realpath(p.root_path);
        if (!inside(canonical, directory) || !inside(path.resolve(canonical, status.scope), directory)) continue;
        const scope = path.relative(canonical, directory) || '.';
        await resolveProjectPath(canonical, scope);
        projects.push({ name: p.name, scope });
      } catch { /* inaccessible or protected project roots are not presented */ }
    }
    if (input.operation === 'projects') return { projects, truncated: Boolean(listed.has_more), backend: 'codebase-memory-mcp' };
    const project = projects.find(p => p.name === input.project);
    if (!project) throw new Error('Index is not available inside the approved workspace scope.');
    const coverage = await call('check_index_coverage', { project: project.name, scopes: ['.'], scope_limit: 10, format: 'json' });
    const freshness = { indexedAt: bounded(coverage.indexed_at, 100) ? coverage.indexed_at : 'unknown', statuses: (coverage.scopes || []).slice(0, 10).map(s => bounded(s.status, 100) ? s.status : 'unknown'), warning: 'Best-effort index coverage only. Missing edges do not prove a function is unused; check current source.' };
    const search = await call('search_graph', { project: project.name, ...(input.operation === 'search' ? { query: input.query.trim() } : { qn_pattern: '^' + regex(input.symbol) + '$' }), format: 'json', limit: 20, max_output_tokens: 5000 });
    const symbols = graphRows(search);
    for (const symbol of symbols) {
      const candidate = symbol.file && !path.isAbsolute(symbol.file) && !symbol.file.split(/[\\/]/).includes('..') ? path.join(project.scope, symbol.file) : null;
      try { if (!candidate) throw new Error(); await resolveProjectPath(canonical, candidate); symbol.path = candidate; }
      catch { symbol.path = null; }
      delete symbol.file;
    }
    if (input.operation === 'search') return { project, freshness, symbols, truncated: Boolean(search.truncated || search.has_more) };
    const selected = symbols.find(s => s.qualifiedName === input.symbol);
    if (!selected) throw new Error('Symbol no longer exists in this index. Search again.');
    const incoming = await call('trace_path', { project: project.name, function_name: input.symbol, direction: 'inbound', depth: 1, limit: 20, max_output_tokens: 5000, include_tests: true, include_evidence: true, format: 'json' });
    const outgoing = await call('trace_path', { project: project.name, function_name: input.symbol, direction: 'outbound', depth: 1, limit: 20, max_output_tokens: 5000, include_tests: true, include_evidence: true, format: 'json' });
    return { project, freshness, selected, callers: graphRows(incoming.callers), callees: graphRows(outgoing.callees), truncated: Boolean(incoming.truncated || incoming.has_more || outgoing.truncated || outgoing.has_more), queriedAt: new Date().toISOString() };
  } finally { try { await connection?.close(); } finally { await release(); } }
}
