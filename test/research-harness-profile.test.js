import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAgent } from '../src/agents.js';
import { validateConfig } from '../src/config.js';

test('research context profile grants only inspected reads and requires version/hash-aware instructions', async () => {
  const read = async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
  const config = validateConfig(await read('../integrations/research-harness.example.json'));
  const agent = validateAgent(await read('../examples/harness-context-reader.json'));
  const server = config.mcp['research-harness-context'];
  assert.deepEqual(agent.mcp, ['research-harness-context']);
  assert.deepEqual(agent.permissions, { read: false, write: false, execute: false });
  assert.equal(agent.memory, false);
  assert.deepEqual(server.envKeys, []);
  assert.match(server.args[0], /research-harness-reader\.py$/);
  assert.deepEqual(server.tools, ['list_sources', 'read_source', 'search_sources', 'get_record', 'methods_reference', 'read_methods_content', 'read_task_output', 'recall_procedural_lessons', 'inspect_analysis_provenance', 'get_project_writing_profile', 'read_span', 'read_study_matrix', 'list_workbench_artifacts', 'read_workbench_artifact', 'inspect_source_document']);
  assert.match(agent.instructions, /expected_output_hash/);
  assert.match(agent.instructions, /expected_version/);
  assert.match(agent.instructions, /expected_content_hash/);
  assert.match(agent.instructions, /not reproduction/);
  assert.match(agent.instructions, /never scientific evidence/);
});
