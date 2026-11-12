import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { saveConfig } from '../src/config.js';
import { remember } from '../src/memory.js';
import { createImageArtifact } from '../src/artifacts.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
for (const operation of ['memory/index', 'visual-review']) test(`dashboard shutdown cancels pending ${operation} requests`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-request-cancellation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await saveConfig(root, { version: 1, providers: { vision: { kind: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1', vision: true } }, routes: {}, mcp: {}, embeddings: { model: 'fixture', url: 'http://127.0.0.1:1234/api/embed' } });
  await remember(root, { text: 'Synthetic cancellation fixture.' });
  const artifact = await createImageArtifact(root, { title: 'Fixture', mimeType: 'image/png', data: png });
  const originalFetch = globalThis.fetch;
  let started, failPending, providerSignal;
  const called = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (new URL(url).port !== '1234') return originalFetch(url, options);
    providerSignal = options.signal;
    return new Promise((_, reject) => {
      failPending = () => reject(new Error('Synthetic request cancelled.'));
      options.signal.addEventListener('abort', failPending, { once: true });
      started();
    });
  });
  const app = await startServer({ root, port: 0 });
  t.after(async () => { failPending?.(); app.server.closeAllConnections(); await app.close(); });
  const pending = originalFetch(`${new URL(app.url).origin}/api/${operation}`, {
    method: 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(operation === 'visual-review' ? { id: artifact.id, provider: 'vision', question: 'Inspect pixel.', approved: true } : {}),
  });
  pending.catch(() => {});
  await called;
  const closing = app.close();
  // The cancellation must reach the actual provider request synchronously at
  // shutdown, rather than waiting for its two-minute provider timeout.
  assert.equal(providerSignal.aborted, true);
  const response = await pending;
  assert.equal(response.status, 400);
  await response.json();
  await closing;
});
