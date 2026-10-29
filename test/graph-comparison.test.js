import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectGraphifyFixture } from '../scripts/compare-graph-backends.js';

test('Graphify experiment preserves provenance and does not claim direction from adjacency', () => {
  const graph = { schema_version: 1, graphify_version: 'fixture', directed: false, nodes: [{ id: 'sum', label: 'fixtureSum', source_file: 'math.js' }, { id: 'double', label: 'fixtureDouble', source_file: 'math.js' }], edges: [{ source: 'double', target: 'sum', relationship: 'calls', confidence: 1, source_file: 'math.js' }] };
  const evidence = inspectGraphifyFixture(graph, 'fixtureSum');
  assert.equal(evidence.foundSourceLinkedSymbol, true); assert.equal(evidence.foundCallerRelationship, true); assert.equal(evidence.oldSymbolRemains, false);
  assert.match(evidence.directionNote, /does not prove/);
  graph.nodes.push({ id: 'old', label: 'fixtureAdd', source_file: 'math.js' });
  assert.equal(inspectGraphifyFixture(graph, 'fixtureSum').oldSymbolRemains, true);
  graph.nodes[0].source_file = '';
  assert.equal(inspectGraphifyFixture(graph, 'fixtureSum').foundSourceLinkedSymbol, false);
  assert.throws(() => inspectGraphifyFixture({ nodes: [] }, 'fixtureSum'), /Unsupported/);
});

test('reviewed Graphify raw callable labels and typed call edges are recognized without false adjacency claims', () => {
  const graph = { nodes: [{ id: 'sum', label: 'fixtureSum()', source_file: 'math.js' }, { id: 'double', label: 'fixtureDouble()', source_file: 'math.js' }], edges: [{ source: 'double', target: 'sum', relation: 'calls', confidence: 'EXTRACTED', source_file: 'math.js', source_location: 'L2' }] };
  const evidence = inspectGraphifyFixture(graph, 'fixtureSum');
  assert.equal(evidence.foundSourceLinkedSymbol, true); assert.equal(evidence.foundCallerRelationship, true);
  assert.equal(evidence.schemaVersion, null); assert.equal(evidence.graphifyVersion, null);
  assert.equal(evidence.relationshipEvidence[0].confidence, 'EXTRACTED'); assert.equal(evidence.relationshipEvidence[0].source_location, 'L2');
  graph.edges[0].relation = 'contains';
  assert.equal(inspectGraphifyFixture(graph, 'fixtureSum').foundCallerRelationship, false);
  graph.nodes.push({ id: 'old', label: 'fixtureAdd()', source_file: 'math.js' });
  assert.equal(inspectGraphifyFixture(graph, 'fixtureSum').oldSymbolRemains, true);
  graph.nodes[0].source_file = 'aftermath.js';
  assert.equal(inspectGraphifyFixture(graph, 'fixtureSum').foundSourceLinkedSymbol, false);
});
