import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createProvider } from '../src/providers.js';
import { runAgent } from '../src/runtime.js';
import { writeState } from '../src/state.js';

const model = process.argv[2];
if (!model) throw new Error('Usage: node scripts/verify-local-model.js INSTALLED_MODEL_NAME');
const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-live-model-'));
const receipt = { at: new Date().toISOString(), model, endpoint: 'http://127.0.0.1:11434/v1', verified: false, syntheticWorkspace: true };
try {
  await writeFile(path.join(root, 'fixture.txt'), 'NEXUS_LOCAL_MODEL_FIXTURE_37');
  const provider = createProvider({ NEXUS_PROVIDER: 'compatible', NEXUS_MODEL: model, NEXUS_BASE_URL: receipt.endpoint });
  const run = await runAgent({ root, provider, maxSteps: 6, maxContextChars: 32000,
    agent: { name: 'connection-check', instructions: 'Complete the requested synthetic file inspection using the granted tools.', permissions: { read: true, write: false } },
    task: 'Call list_files with path ".", then call read_file with path "fixture.txt". Return the exact content of fixture.txt. This is a tool compatibility check; do not guess its contents.',
    onEvent: event => { if (['start', 'tool', 'finish'].includes(event.type)) console.log(JSON.stringify({ type: event.type, tool: event.name, status: event.status })); },
  });
  assert.equal(run.status, 'completed');
  const tools = run.events.filter(e => e.type === 'tool').map(e => e.name);
  assert.ok(tools.includes('list_files') && tools.includes('read_file'), 'Model must actually call both tools.');
  assert.ok(run.messages.filter(m => m.role === 'assistant').at(-1)?.content.includes('NEXUS_LOCAL_MODEL_FIXTURE_37'), 'Model must return the observed fixture content.');
  Object.assign(receipt, { verified: true, tools, usage: run.usage });
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally {
  await writeState(process.cwd(), 'verification', 'local-model.json', receipt);
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt, null, 2));
