import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrationRoot, integrationStatus } from '../src/integrations.js';
import { runProcess } from '../src/process.js';

test('managed integration roots are named external application-data directories', async () => {
  assert.match(integrationRoot('tradingagents'), /NexusIDE[/\\]runtimes[/\\]tradingagents$/);
  await assert.rejects(integrationStatus('unknown'), /Unknown integration/);
});

test('OpenMontage launcher rejects arbitrary Python arguments before execution', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = fileURLToPath(new URL('../src/integration-runner.js', import.meta.url));
  const result = await runProcess(process.execPath, [runner, 'openmontage', root, '-c', 'print("unsafe")'], { cwd: root });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /OpenMontage actions/);
  assert.doesNotMatch(result.output, /unsafe\n/);
});
