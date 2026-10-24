import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { providerEnvironment, verificationHistory } from '../src/doctor.js';
import { writeState } from '../src/state.js';

test('doctor reports bounded historical verification without echoing arbitrary receipt fields', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await verificationHistory(root), []);
  await writeState(root, 'verification', 'local-model.json', { verified: true, at: '2026-10-08T00:00:00Z', checks: ['synthetic-model-test'], error: 'private details', config: { key: 'private-key' } });
  await writeState(root, 'verification', 'research-harness-current.json', { verified: true, at: '2026-10-13T00:00:00Z', checks: ['workbench-read-bridge'], harness: { source: 'private local path' } });
  await writeState(root, 'verification', 'cortex.json', { verified: true, at: '2026-10-24T00:00:00Z', checks: ['read-only-bridge'], brain: 'private local path' });
  await writeState(root, 'verification', 'codegraph.json', { verified: 'true', checks: Array(100).fill('x'.repeat(1000)) });
  await writeFile(path.join(root, '.nexus/verification/docker.json'), 'invalid-json');
  const reports = await verificationHistory(root);
  assert.equal(reports.find(r => r.name === 'local-model').recordedSuccess, true);
  assert.equal(reports.find(r => r.name === 'research-harness-current').recordedSuccess, true);
  assert.equal(reports.find(r => r.name === 'cortex').recordedSuccess, true);
  assert.equal(reports.find(r => r.name === 'docker').unreadable, true);
  const graph = reports.find(r => r.name === 'codegraph');
  assert.equal(graph.recordedSuccess, false);
  assert.equal(graph.checks.length, 30);
  assert.equal(graph.checks[0].length, 160);
  assert.ok(!JSON.stringify(reports).includes('private'));
});

test('doctor distinguishes inherited account credentials without exposing or verifying them', () => {
  const environment = {
    OPENAI_API_KEY: 'synthetic-first-secret',
    OPENAI_API_KEY2: 'synthetic-second-secret',
    GEMINI_API_KEY: 'your-gemini-key',
    ANTHROPIC_API_KEY: ' ',
    UNRELATED_PASSWORD: 'synthetic-unrelated-secret',
  };
  const reports = providerEnvironment(environment);
  assert.equal(reports.find(r => r.id === 'openai').credential, 'available');
  assert.equal(reports.find(r => r.id === 'openai:2').credential, 'available');
  assert.equal(reports.find(r => r.id === 'openai:2').keyEnv, 'OPENAI_API_KEY2');
  assert.equal(reports.find(r => r.id === 'gemini').credential, 'placeholder');
  assert.equal(reports.find(r => r.id === 'anthropic').credential, 'missing');
  assert.equal(reports.find(r => r.id === 'deepseek').credential, 'missing');
  assert.ok(!reports.some(r => r.id === 'ollama' || r.id === 'openai:3'));
  assert.ok(reports.every(r => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['credential', 'id', 'keyEnv', 'label'])));
  const serialized = JSON.stringify(reports);
  for (const secret of Object.values(environment)) if (secret.trim()) assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('UNRELATED_PASSWORD'));
  assert.equal(providerEnvironment({}).find(r => r.id === 'gemini').credential, 'missing');
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
