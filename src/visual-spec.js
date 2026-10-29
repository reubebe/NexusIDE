// Shared by the dashboard and runtime. Specifications are data, never executable code.
export const visualKinds = ['bar', 'line', 'scatter', 'timeline', 'graph', 'spatial'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`Invalid visualization: ${message}`); };
const text = (value, label, max = 240, empty = false) => {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(label);
  return value;
};
const number = (value, label) => { if (!Number.isFinite(value) || Math.abs(value) > 1e12) fail(label); return value; };
const array = (value, label, max, min = 1) => { if (!Array.isArray(value) || value.length < min || value.length > max) fail(label); return value; };
const keys = (value, allowed, label) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(label); };
export function validateVisualSpec(value) {
  if (JSON.stringify(value)?.length > 180_000) fail('specification exceeds 180 KB');
  keys(value, ['version', 'kind', 'title', 'description', 'sources', 'xLabel', 'yLabel', 'xUnit', 'yUnit', 'zUnit', 'data', 'nodes', 'edges', 'triangles'], 'unsupported fields');
  if (value.version !== 1 || !visualKinds.includes(value.kind)) fail('use version 1 and a supported kind');
  text(value.title, 'title');
  if (value.description !== undefined) text(value.description, 'description', 3000, true);
  array(value.sources, 'include at least one source or identify synthetic data', 30).forEach(source => {
    keys(source, ['label', 'path', 'url', 'at'], 'source fields'); text(source.label, 'source label', 500);
    if (source.path !== undefined && (typeof source.path !== 'string' || !source.path || source.path.length > 1000 || source.path.startsWith('/') || source.path.includes('\\') || source.path.split('/').some(p => p === '..' || !p || p.startsWith('.env') || ['.git', '.nexus', '.ssh', '.aws', '.netrc', 'node_modules'].includes(p.toLowerCase())))) fail('source path must be an accessible relative project path');
    if (source.url !== undefined) { let url; try { url = new URL(source.url); } catch { fail('source URL'); } if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || source.url.length > 2000) fail('source URL'); }
    if (source.at !== undefined && (typeof source.at !== 'string' || !Number.isFinite(Date.parse(source.at)))) fail('source timestamp');
  });
  if (value.kind === 'graph') {
    if (value.data !== undefined || value.triangles !== undefined) fail('graph uses nodes and edges');
    const ids = new Set();
    array(value.nodes, '1–300 graph nodes', 300).forEach(n => { keys(n, ['id', 'label', 'source'], 'node fields'); text(n.id, 'node id', 100); text(n.label, 'node label'); if (ids.has(n.id)) fail('duplicate node id'); ids.add(n.id); if (n.source !== undefined && (!Number.isInteger(n.source) || !value.sources[n.source])) fail('node source index'); });
    array(value.edges, 'at most 1000 edges', 1000, 0).forEach(e => { keys(e, ['source', 'target', 'label', 'relation', 'confidence'], 'edge fields'); if (!ids.has(e.source) || !ids.has(e.target)) fail('edge references a missing node'); text(e.label, 'edge label'); if (!['extracted', 'inferred', 'ambiguous'].includes(e.relation)) fail('edge relation'); if (e.confidence !== undefined && (!Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1)) fail('edge confidence'); });
  } else {
    if (value.nodes !== undefined || value.edges !== undefined) fail('only graphs use nodes and edges');
    for (const key of ['xLabel', 'xUnit']) text(value[key], key, 100);
    if (value.kind !== 'timeline') for (const key of ['yLabel', 'yUnit']) text(value[key], key, 100);
    if (value.kind === 'spatial') text(value.zUnit, 'zUnit', 100);
    if (value.kind === 'timeline' && value.xUnit !== 's') fail('timeline values must use seconds (xUnit: s)');
    array(value.data, '1–2000 data rows', 2000).forEach(row => {
      const allowed = value.kind === 'timeline' ? ['label', 'start', 'end', 'series'] : value.kind === 'spatial' ? ['label', 'x', 'y', 'z', 'series'] : ['label', 'x', 'y', 'series'];
      keys(row, allowed, 'data fields'); text(row.label, 'row label'); if (row.series !== undefined) text(row.series, 'series label', 100);
      if (value.kind === 'timeline') { number(row.start, 'start'); number(row.end, 'end'); if (row.start < 0 || row.end < row.start) fail('timeline interval'); }
      else { if (value.kind === 'bar') { if (row.x !== undefined) number(row.x, 'x'); } else number(row.x, 'x'); if (row.y !== null) number(row.y, 'y (use null for unavailable)'); if (value.kind === 'spatial') { if (row.y === null) fail('spatial y'); number(row.z, 'z'); } }
    });
    if (value.triangles !== undefined) {
      if (value.kind !== 'spatial') fail('only spatial views accept triangles');
      array(value.triangles, 'at most 4000 triangles', 4000, 0).forEach(t => { if (!Array.isArray(t) || t.length !== 3 || t.some(i => !Number.isInteger(i) || i < 0 || i >= value.data.length)) fail('triangle vertex index'); });
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export function visualRows(spec) {
  return spec.kind === 'graph' ? spec.edges.map(e => ({ from: e.source, to: e.target, label: e.label, relation: e.relation, confidence: e.confidence ?? null })) : spec.data;
}

export function visualCsv(spec) {
  const rows = visualRows(spec), columns = [...new Set(rows.flatMap(Object.keys))];
  const cell = value => { let text = value == null ? '' : String(value); if (/^[\s]*[=+@-]/.test(text) && typeof value !== 'number') text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
  return [columns.map(cell).join(','), ...rows.map(row => columns.map(c => cell(row[c])).join(','))].join('\r\n') + '\r\n';
}
