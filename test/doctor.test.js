import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verificationHistory } from '../src/doctor.js';
import { writeState } from '../src/state.js';

test('doctor reports bounded historical verification without echoing arbitrary receipt fields', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await verificationHistory(root), []);
  await writeState(root, 'verification', 'local-model.json', { verified: true, at: '2026-10-08T00:00:00Z', checks: ['synthetic-model-test'], error: 'private details', config: { key: 'private-key' } });
  await writeState(root, 'verification', 'research-harness-current.json', { verified: true, at: '2026-10-13T00:00:00Z', checks: ['workbench-read-bridge'], harness: { source: 'private local path' } });
  await writeState(root, 'verification', 'codegraph.json', { verified: 'true', checks: Array(100).fill('x'.repeat(1000)) });
  await writeFile(path.join(root, '.nexus/verification/docker.json'), 'invalid-json');
  const reports = await verificationHistory(root);
  assert.equal(reports.find(r => r.name === 'local-model').recordedSuccess, true);
  assert.equal(reports.find(r => r.name === 'research-harness-current').recordedSuccess, true);
  assert.equal(reports.find(r => r.name === 'docker').unreadable, true);
  const graph = reports.find(r => r.name === 'codegraph');
  assert.equal(graph.recordedSuccess, false);
  assert.equal(graph.checks.length, 30);
  assert.equal(graph.checks[0].length, 160);
  assert.ok(!JSON.stringify(reports).includes('private'));
});

test('doctor recognizes the historical Research Harness receipt without accepting arbitrary truthy values', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = { verified: '2026-10-05T04:50:34.137Z', kind: 'live-local-mcp', result: { isError: false } };
  await writeState(root, 'verification', 'research-harness.json', legacy);
  const [report] = await verificationHistory(root);
  assert.equal(report.recordedSuccess, true);
  assert.equal(report.at, legacy.verified);
  for (const invalid of [{ ...legacy, verified: 'true' }, { ...legacy, result: { isError: true } }, { ...legacy, kind: 'unknown' }]) {
    await writeState(root, 'verification', 'research-harness.json', invalid);
    assert.equal((await verificationHistory(root))[0].recordedSuccess, false);
  }
});
