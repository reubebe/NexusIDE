import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { saveConfig, defaultConfig } from '../src/config.js';
import { connectMcp } from '../src/mcp.js';
import { writeState } from '../src/state.js';

const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary)) throw new Error('Pass the absolute path of a reviewed codebase-memory-mcp binary.');
const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codegraph-'));
const source = path.join(root, 'source');
const receipt = { at: new Date().toISOString(), verified: false, syntheticWorkspace: true, binary, approvals: [] };
let connection;
try {
  await mkdir(source);
  await writeFile(path.join(source, 'math.js'), 'export function nexusFixtureAdd(a, b) { return a + b; }\nexport function nexusFixtureDouble(a) { return nexusFixtureAdd(a, a); }\n');
  await saveConfig(root, { ...structuredClone(defaultConfig), mcp: { codegraph: {
    command: '/usr/bin/env', args: [`CBM_CACHE_DIR=${path.join(root, 'cache')}`, `CBM_ALLOWED_ROOT=${source}`, binary, '--ui=false'],
    tools: ['index_repository', 'search_graph', 'trace_path'],
  } } });
  connection = await connectMcp(root, { mcp: ['codegraph'] }, async request => {
    // Approval applies only to this synthetic fixture and these fixed calls.
    receipt.approvals.push({ type: request.type, tool: request.tool });
    return request.type === 'mcp-connect' || ['index_repository', 'search_graph', 'trace_path'].includes(request.tool);
  });
  assert.equal(connection.tools.length, 3);
  const indexTool = connection.tools.find(t => t.description.startsWith('[codegraph/index_repository]'));
  const denied = JSON.parse(await connection.call(indexTool.name, { repo_path: root, mode: 'fast' }));
  assert.equal(denied.isError, true, 'Indexing outside the allowed source root must fail');
  const call = async (name, args) => {
    const tool = connection.tools.find(t => t.description.startsWith(`[codegraph/${name}]`));
    assert.ok(tool, `Granted tool ${name} discovered`);
    const result = JSON.parse(await connection.call(tool.name, args));
    assert.ok(!result.isError, JSON.stringify(result));
    return result;
  };
  await call('index_repository', { repo_path: source, name: 'nexus-codegraph-fixture', mode: 'fast', persistence: false });
  const found = await call('search_graph', { project: 'nexus-codegraph-fixture', name_pattern: 'nexusFixtureAdd', label: 'Function', format: 'json' });
  assert.match(JSON.stringify(found), /nexusFixtureAdd/);
  const traced = await call('trace_path', { project: 'nexus-codegraph-fixture', function_name: 'nexusFixtureAdd', direction: 'inbound' });
  assert.match(JSON.stringify(traced), /nexusFixtureDouble/);
  receipt.verified = true;
  receipt.checks = ['mcp-handshake', 'explicit-tool-allowlist', 'index-synthetic-source', 'find-function', 'trace-caller', 'index-root-containment'];
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally {
  await connection?.close();
  if (!receipt.verified) receipt.diagnostics = root;
  await writeState(process.cwd(), 'verification', 'codegraph.json', receipt);
  if (receipt.verified) await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt, null, 2));
