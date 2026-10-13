import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeWorkspace } from '../src/workspace-init.js';
import { listAgents } from '../src/agents.js';

test('fresh workspaces receive the bundled agent library and remain idempotent', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-agent-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await initializeWorkspace(root);
  const agents = await listAgents(root);
  assert.equal(agents.length, 28);
  assert.ok(agents.some(agent => agent.name === 'agency-software-architect'));
  assert.ok(agents.some(agent => agent.name === 'harness-context-reader'));
  assert.ok(result.bundled.created.includes('agency-software-architect'));
  const second = await initializeWorkspace(root);
  assert.equal((await listAgents(root)).length, 28);
  assert.deepEqual(second.bundled.created, []);
  assert.ok(second.bundled.kept.includes('harness-context-reader'));
});
