import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { runProcess, commandEnvironment } from '../src/process.js';
import { connectMcp } from '../src/mcp.js';
import { saveConfig, defaultConfig } from '../src/config.js';

const firstSource = 'export function fixtureAdd(a, b) { return a + b; }\nexport function fixtureDouble(a) { return fixtureAdd(a, a); }\n';
const changedSource = 'export function fixtureSum(a, b) { return a + b; }\nexport function fixtureDouble(a) { return fixtureSum(a, a); }\n';
const sha = value => createHash('sha256').update(value).digest('hex');

export function inspectGraphifyFixture(graph, currentName) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges ?? graph.links) || graph.nodes.length > 10000 || (graph.edges ?? graph.links).length > 20000) throw new Error('Unsupported or oversized Graphify graph.');
  const nodes = graph.nodes, edges = graph.edges ?? graph.links;
  const labelMatches = (node, name) => node && [name, `${name}()`].includes(node.label);
  const sourceMatches = node => typeof node?.source_file === 'string' && node.source_file.replaceAll('\\', '/').split('/').at(-1) === 'math.js';
  const target = nodes.find(n => labelMatches(n, currentName) && sourceMatches(n));
  const caller = nodes.find(n => labelMatches(n, 'fixtureDouble') && sourceMatches(n));
  const relationships = target && caller ? edges.filter(e => e && (e.relationship ?? e.relation ?? e.label) === 'calls' && ((e.source === caller.id && e.target === target.id) || (e.source === target.id && e.target === caller.id))) : [];
  return { schemaVersion: graph.schema_version ?? graph.graph?.schema_version ?? null, graphifyVersion: graph.graphify_version ?? graph.graph?.graphify_version ?? null, nodes: nodes.length, edges: edges.length, foundSourceLinkedSymbol: Boolean(target), foundCallerRelationship: relationships.length > 0, relationshipEvidence: relationships.map(e => ({ source: e.source, target: e.target, relationship: e.relationship ?? e.relation ?? e.label ?? null, confidence: e.confidence ?? null, source_file: e.source_file ?? null, source_location: e.source_location ?? null })).slice(0, 10), directionNote: 'Raw serialized endpoint order is preserved. Undirected graph adjacency alone does not prove call direction.', oldSymbolRemains: currentName === 'fixtureSum' && nodes.some(n => labelMatches(n, 'fixtureAdd') && sourceMatches(n)) };
}

export async function compareGraphBackends({ graphify, codegraph, timeoutMs = 120000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Benchmark timeout must be 1 second to 5 minutes.');
  for (const command of [graphify, codegraph].filter(Boolean)) {
    if (typeof command !== 'string' || !path.isAbsolute(command) || /[\0\r\n]/.test(command)) throw new Error('Use reviewed absolute executable paths.');
    await access(command, constants.X_OK);
  }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nexus-graph-comparison-'))), source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'math.js'), firstSource);
  const report = { version: 1, at: new Date().toISOString(), fixture: { path: source, initialSha256: sha(firstSource), changedSha256: sha(changedSource), synthetic: true }, network: 'No provider credentials are forwarded. Graphify uses code-only extraction; no semantic model is selected.', graphify: { status: 'unavailable', reason: 'No reviewed Graphify executable supplied. No installation was attempted.' }, codegraph: { status: 'unavailable', reason: 'No reviewed codebase-memory-mcp executable supplied.' }, adoption: 'Not adopted. This small fixture is an engineering comparison, not evidence of general accuracy or token savings.' };
  let connection;
  try {
    if (codegraph) {
      await saveConfig(root, { ...structuredClone(defaultConfig), mcp: { codegraph: { command: '/usr/bin/env', args: [`CBM_ALLOWED_ROOT=${source}`, `CBM_CACHE_DIR=${path.join(root, 'cache')}`, codegraph, '--ui=false'], tools: ['index_repository', 'search_graph', 'trace_path'] } } });
      try {
        connection = await connectMcp(root, { mcp: ['codegraph'] }, async () => true, AbortSignal.timeout(timeoutMs));
        report.codegraph = { status: 'completed', executable: codegraph, passes: [] };
      } catch (error) { report.codegraph = { status: 'failed', reason: error.message }; }
    }
    const graphifyPasses = [];
    for (const [pass, text, name] of [['initial', firstSource, 'fixtureAdd'], ['changed', changedSource, 'fixtureSum']]) {
      await writeFile(path.join(source, 'math.js'), text);
      if (graphify) {
        const started = performance.now();
        try {
          const output = path.join(root, 'graphify-output');
          const result = await runProcess(graphify, ['extract', source, '--code-only', '--no-cluster', '--no-dedup', '--out', output], { cwd: root, timeoutMs, maxBytes: 500000, env: commandEnvironment() });
          if (result.code !== 0 || result.stopped) throw new Error(`Graphify ${result.stopped || `exit ${result.code}`}: ${result.output.slice(-1000)}`);
          // The reviewed CLI treats --out as the parent of graphify-out.
          const file = path.join(output, 'graphify-out', 'graph.json'), stat = await lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2000000) throw new Error('Graphify graph exceeds the 2 MB fixture bound.');
          const bytes = await readFile(file), evidence = inspectGraphifyFixture(JSON.parse(bytes), name);
          graphifyPasses.push({ pass, elapsedMs: Math.round(performance.now() - started), bytes: bytes.length, sha256: sha(bytes), ...evidence });
          report.graphify = { status: 'completed', executable: graphify, passes: graphifyPasses };
        } catch (error) { report.graphify = { status: 'failed', reason: error.message, passes: graphifyPasses }; graphify = undefined; }
      }
      if (connection && report.codegraph.status === 'completed') {
        const started = performance.now();
        try {
          const call = async (tool, args) => {
            const selected = connection.tools.find(t => t.description.startsWith(`[codegraph/${tool}]`));
            if (!selected) throw new Error(`Missing ${tool}`);
            const raw = await connection.call(selected.name, args), result = JSON.parse(raw);
            if (result.isError || result.truncated) throw new Error('Code graph returned an error or incomplete result.');
            return { result, raw };
          };
          await call('index_repository', { repo_path: source, name: 'nexus-graph-comparison', mode: 'fast', persistence: false });
          const found = await call('search_graph', { project: 'nexus-graph-comparison', name_pattern: name, label: 'Function', format: 'json', limit: 20, max_output_tokens: 3000 });
          const traced = await call('trace_path', { project: 'nexus-graph-comparison', function_name: name, direction: 'inbound', max_output_tokens: 3000 });
          const old = pass === 'changed' ? await call('search_graph', { project: 'nexus-graph-comparison', name_pattern: 'fixtureAdd', label: 'Function', format: 'json', limit: 20, max_output_tokens: 3000 }) : null;
          report.codegraph.passes.push({ pass, elapsedMs: Math.round(performance.now() - started), foundSourceLinkedSymbol: found.raw.includes(name) && found.raw.includes('math.js'), foundCallerRelationship: traced.raw.includes('fixtureDouble'), search: found.result, callers: traced.result, oldSymbolQuery: old?.result ?? null, evidenceNote: 'Inspect oldSymbolQuery rows to distinguish an echoed query from a stale symbol.' });
        } catch (error) { report.codegraph.status = 'failed'; report.codegraph.reason = error.message; }
      }
    }
  } finally {
    await connection?.close();
    report.completeComparison = report.graphify.status === 'completed' && report.codegraph.status === 'completed';
    report.receipt = path.join(root, 'comparison.json');
    await writeFile(report.receipt, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [graphify, codegraph] = process.argv.slice(2);
  console.log(JSON.stringify(await compareGraphBackends({ graphify: graphify === '-' ? undefined : graphify, codegraph: codegraph === '-' ? undefined : codegraph }), null, 2));
}
