import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { defaultConfig, saveConfig } from '../src/config.js';
import { remember } from '../src/memory.js';
import { rebuildMemoryIndex, semanticRecall } from '../src/semantic-memory.js';
import { writeState } from '../src/state.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-semantic-live-'));
const receipt = { at: new Date().toISOString(), model: process.argv[2] || 'nomic-embed-text', verified: false, syntheticWorkspace: true };
try {
  await saveConfig(root, { ...structuredClone(defaultConfig), embeddings: { model: receipt.model, url: 'http://127.0.0.1:11434/api/embed' } });
  const relevant = await remember(root, { text: 'The interface should support keyboard navigation and screen readers.' });
  await remember(root, { text: 'The film script features a spaceship landing on Mars.' });
  await remember(root, { text: 'Private accessibility notes.', scope: 'agent', agent: 'other-agent' });
  receipt.index = await rebuildMemoryIndex(root);
  receipt.incremental = await rebuildMemoryIndex(root);
  assert.equal(receipt.incremental.embedded, 0);
  assert.equal(receipt.incremental.reused, 3);
  const result = await semanticRecall(root, 'How should we make the UI accessible?', 'reviewer');
  assert.equal(result.matches[0].id, relevant.id);
  assert.equal(result.matches.length, 2);
  receipt.verified = true;
  receipt.checks = ['real-embedding-vectors', 'incremental-vector-reuse', 'semantic-ranking', 'agent-scope-filter'];
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally { await writeState(process.cwd(), 'verification', 'semantic-memory.json', receipt); await rm(root, { recursive: true, force: true }); }
console.log(JSON.stringify(receipt, null, 2));
