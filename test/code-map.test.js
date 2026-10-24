import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codeMapStatus, queryCodeMap, graphRows } from '../src/code-map.js';
import { saveConfig, defaultConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { connectMcp } from '../src/mcp.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-code-map-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/math.js'), 'export function add(a, b) { return a + b; }');
  const config = { ...structuredClone(defaultConfig), mcp: { codegraph: { command: '/usr/bin/env', args: [`CBM_ALLOWED_ROOT=${root}/src`, `CBM_CACHE_DIR=${root}/.nexus/graph`, `${root}/codebase-memory-mcp`, '--ui=false'], tools: ['list_projects', 'search_graph', 'trace_path', 'check_index_coverage'] } } };
  await saveConfig(root, config);
  const status = await codeMapStatus(root), calls = []; let connections = 0, closed = 0;
  const table = { cols: ['name', 'lines'], groups: [{ qn_prefix: 'demo.math', file: 'math.js', rows: [['add', '1-1']] }] };
  const neighbors = { cols: ['name', 'hop', 'strategy', 'confidence'], groups: [{ qn_prefix: 'demo.math', rows: [['double', 1, 'heuristic', 0.9]] }] };
  const responses = { list_projects: { projects: [{ name: 'demo', root_path: root + '/src' }, { name: 'outside', root_path: os.tmpdir() }] }, check_index_coverage: { indexed_at: '2026-10-24T00:00:00Z', scopes: [{ status: 'no_recorded_issue' }] }, search_graph: table, trace_path: { callers: neighbors, callees: neighbors, has_more: true } };
  const connect = async (_, agent, approve) => {
    connections++; assert.deepEqual(agent.mcp, ['codegraph']);
    assert.equal(await approve({ type: 'mcp-connect', name: 'codegraph' }), true);
    assert.equal(await approve({ type: 'mcp-call', tool: 'index_repository' }), false);
    return { tools: config.mcp.codegraph.tools.map(name => ({ name, description: `[codegraph/${name}] tool` })), call: async (name, args) => { calls.push({ name, args }); return JSON.stringify({ structuredContent: responses[name], isError: false }); }, close: async () => { closed++; } };
  };
  return { root, config, status, calls, responses, connect, counts: () => ({ connections, closed }), input: operation => ({ operation, approved: true, digest: status.digest, project: 'demo' }) };
}

test('code map requires explicit current connection approval before any process starts', async t => {
  const f = await fixture(t);
  await assert.rejects(queryCodeMap(f.root, { ...f.input('projects'), approved: false }, { connect: f.connect }), /approve/);
  await assert.rejects(queryCodeMap(f.root, { ...f.input('projects'), digest: '0'.repeat(64) }, { connect: f.connect }), /changed/);
  await assert.rejects(queryCodeMap(f.root, { ...f.input('search'), query: 'x', args: {} }, { connect: f.connect }), /approve/);
  assert.equal(f.counts().connections, 0);
  const result = await queryCodeMap(f.root, f.input('projects'), { connect: f.connect });
  assert.deepEqual(result.projects, [{ name: 'demo', scope: 'src' }]);
  assert.deepEqual(f.counts(), { connections: 1, closed: 1 });
});

test('code map normalizes source links and depth-one relationships without write tools', async t => {
  const f = await fixture(t);
  const found = await queryCodeMap(f.root, { ...f.input('search'), query: 'add' }, { connect: f.connect });
  assert.equal(found.symbols[0].path, 'src/math.js');
  assert.equal(found.freshness.indexedAt, '2026-10-24T00:00:00Z');
  const result = await queryCodeMap(f.root, { ...f.input('neighbors'), symbol: 'demo.math.add' }, { connect: f.connect });
  assert.equal(result.callers[0].qualifiedName, 'demo.math.double');
  assert.equal(result.callees[0].confidence, 0.9); assert.equal(result.truncated, true);
  assert.ok(f.calls.filter(c => c.name === 'trace_path').every(c => c.args.depth === 1 && c.args.limit === 20 && c.args.include_tests));
  assert.equal(f.calls.findLast(c => c.name === 'search_graph').args.qn_pattern, '^demo\\.math\\.add$');
  assert.deepEqual(f.counts(), { connections: 2, closed: 2 });
});

test('code map refuses indexes outside scope and keeps protected source paths unavailable', async t => {
  const f = await fixture(t);
  await assert.rejects(queryCodeMap(f.root, { ...f.input('search'), project: 'outside', query: 'x' }, { connect: f.connect }), /scope/);
  f.responses.search_graph.groups[0].file = '../.nexus/config/project.json';
  const found = await queryCodeMap(f.root, { ...f.input('search'), query: 'add' }, { connect: f.connect });
  assert.equal(found.symbols[0].path, null);
  f.responses.search_graph = {};
  await assert.rejects(queryCodeMap(f.root, { ...f.input('search'), query: 'x' }, { connect: f.connect }), /format/);
  assert.equal(f.counts().connections, f.counts().closed);
});

test('code map reports missing or unsupported connection without executing it', async t => {
  const f = await fixture(t);
  await saveConfig(f.root, structuredClone(defaultConfig));
  assert.equal((await codeMapStatus(f.root)).available, false);
  f.config.mcp.codegraph.args.push('--unexpected'); await saveConfig(f.root, f.config);
  assert.equal((await codeMapStatus(f.root)).available, false);
  assert.throws(() => graphRows({ cols: [], groups: [{ rows: [null] }] }), /row/);
});

test('code map parses flat BM25 rows and releases its lease after close failure', async t => {
  const f = await fixture(t);
  f.responses.search_graph = { cols: ['qn', 'file', 'lines'], rows: [['demo.math.add', 'math.js', '1-1']] };
  const found = await queryCodeMap(f.root, { ...f.input('search'), query: 'add' }, { connect: f.connect });
  assert.equal(found.symbols[0].path, 'src/math.js');
  assert.equal(found.symbols[0].qualifiedName, 'demo.math.add');
  const brokenClose = async (...args) => { const c = await f.connect(...args); return { ...c, close: async () => { throw new Error('close failed'); } }; };
  await assert.rejects(queryCodeMap(f.root, f.input('projects'), { connect: brokenClose }), /close failed/);
  // A leaked workspace lease would make this subsequent query fail.
  assert.equal((await queryCodeMap(f.root, f.input('projects'), { connect: f.connect })).projects.length, 1);
});

test('code map API and JavaScript asset use existing authentication boundary', async t => {
  const f = await fixture(t), server = await startServer({ root: f.root, port: 0 });
  t.after(() => server.close());
  const origin = new URL(server.url).origin;
  assert.equal((await fetch(origin + '/api/code-map')).status, 401);
  const response = await fetch(origin + '/api/code-map', { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(response.status, 200); assert.equal((await response.json()).scope, 'src');
  assert.equal((await fetch(origin + '/code-map.js')).status, 200);
  assert.equal((await fetch(origin + '/api/code-map', { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: '{}' })).status, 400);
});

test('reviewed graph backend discovers and traces synthetic source', { skip: !process.env.NEXUS_CODEGRAPH_BINARY }, async t => {
  const f = await fixture(t);
  const binary = process.env.NEXUS_CODEGRAPH_BINARY;
  assert.ok(path.isAbsolute(binary));
  await writeFile(path.join(f.root, 'src/math.js'), 'export function nexusMapAdd(a, b) { return a + b; }\nexport function nexusMapDouble(a) { return nexusMapAdd(a, a); }\n');
  f.config.mcp.codegraph.args = [`CBM_ALLOWED_ROOT=${f.root}/src`, `CBM_CACHE_DIR=${f.root}/.nexus/graph`, binary, '--ui=false'];
  f.config.mcp.codegraph.tools.push('index_repository');
  await saveConfig(f.root, f.config);
  const c = await connectMcp(f.root, { mcp: ['codegraph'] }, async r => r.type === 'mcp-connect' || r.tool === 'index_repository');
  try {
    const tool = c.tools.find(t => t.description.startsWith('[codegraph/index_repository]'));
    const result = JSON.parse(await c.call(tool.name, { repo_path: f.root + '/src', name: 'nexus-map-fixture', mode: 'fast', persistence: false }));
    assert.ok(!result.isError, JSON.stringify(result));
  } finally { await c.close(); }
  const status = await codeMapStatus(f.root);
  const found = await queryCodeMap(f.root, { operation: 'search', query: 'nexusMapAdd', project: 'nexus-map-fixture', digest: status.digest, approved: true });
  assert.ok(found.symbols.some(s => s.name === 'nexusMapAdd'));
  const selected = found.symbols.find(s => s.name === 'nexusMapAdd');
  const map = await queryCodeMap(f.root, { operation: 'neighbors', symbol: selected.qualifiedName, project: 'nexus-map-fixture', digest: status.digest, approved: true });
  assert.ok(map.callers.some(s => s.name === 'nexusMapDouble'));
  assert.equal(map.selected.path, 'src/math.js');
});
