import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../src/config.js';
import { rebuildProjectIndex, semanticProjectSearch } from '../src/project-index.js';
import { writeState } from '../src/state.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-storage-scale-'));
const receipt = { at: new Date().toISOString(), verified: false, syntheticWorkspace: true, syntheticEmbeddings: true, files: 2048, dimensions: 1536 };
let inputCount = 0;
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const { input } = JSON.parse(body); inputCount += input.length;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ embeddings: input.map(() => Array.from({ length: receipt.dimensions }, (_, i) => i % 17 + 1)) }));
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await saveConfig(root, { ...structuredClone(defaultConfig), embeddings: { model: 'scale-fixture', url: `http://127.0.0.1:${server.address().port}/api/embed` } });
  for (let i = 0; i < receipt.files; i++) await writeFile(path.join(root, `module-${String(i).padStart(4, '0')}.js`), `export const module${i} = 'searchable fixture ${i}';\n`);
  let start = performance.now();
  receipt.first = await rebuildProjectIndex(root); receipt.firstMs = Math.round(performance.now() - start);
  assert.equal(receipt.first.indexed, receipt.files); assert.equal(receipt.first.truncated, false);
  receipt.databaseBytes = (await stat(path.join(root, '.nexus/storage.sqlite'))).size;
  assert.ok(receipt.databaseBytes > 20_000_000, 'Verify storage beyond the former JSON limit');
  inputCount = 0; start = performance.now();
  receipt.unchanged = await rebuildProjectIndex(root); receipt.unchangedMs = Math.round(performance.now() - start);
  assert.equal(inputCount, 0); assert.equal(receipt.unchanged.reused, receipt.files);
  await writeFile(path.join(root, 'module-0000.js'), 'export const updated = "new content";\n');
  await unlink(path.join(root, 'module-0001.js'));
  receipt.edited = await rebuildProjectIndex(root);
  assert.equal(receipt.edited.embedded, 1); assert.equal(receipt.edited.deleted, 1);
  const found = await semanticProjectSearch(root, 'updated new content');
  assert.equal(found.matches[0].path, 'module-0000.js');
  assert.ok(found.matches.every(match => match.path !== 'module-0001.js'));
  receipt.checks = ['2048-files', '1536-dimensional-vectors', 'database-over-20MB', 'unchanged-zero-embedding-calls', 'single-file-reembedding', 'deleted-source-removed', 'bounded-ranked-retrieval'];
  receipt.verified = true;
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
  await writeState(process.cwd(), 'verification', 'storage-scale.json', receipt);
}
console.log(JSON.stringify(receipt, null, 2));
