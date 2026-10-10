import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runSyntheticPilot, PILOT_SUITE } from '../scripts/verify-pilot.js';

test('bounded synthetic pilot exercises durable runs, denied approvals, continuation, cancellation and orphan recovery', async () => {
  const receipt = await runSyntheticPilot({ cycles: 2 });
  assert.equal(receipt.verified, true, receipt.error);
  assert.equal(receipt.suite, PILOT_SUITE);
  assert.equal(receipt.evidence, 'synthetic-preproduction');
  assert.equal(receipt.productionReady, false);
  assert.equal(receipt.networkRequests, 0);
  assert.equal(receipt.providerCharges, 0);
  assert.equal(receipt.temporaryWorkspaceRemoved, true);
  assert.equal(receipt.summary.runCount, 11);
  assert.equal(receipt.summary.completedRuns, 8);
  assert.equal(receipt.summary.expectedFailureRuns, 2);
  assert.equal(receipt.summary.expectedCancelledRuns, 1);
  assert.equal(receipt.summary.failedChecks, 0);
  assert.equal(receipt.summary.syntheticModelRequests, 19);
  assert.equal(receipt.summary.approvalsAllowed, 2);
  assert.equal(receipt.summary.approvalsDenied, 2);
  assert.ok(receipt.checks.every(check => check.status === 'passed'));
  assert.equal(receipt.runs.filter(run => run.scenario === 'continue-failed-run').every(run => run.toolCalls === 0), true);
  assert.ok(receipt.summary.runtimeLatencyMs.p95 >= receipt.summary.runtimeLatencyMs.p50);
  assert.match(receipt.measuredScope, /not model quality or a real-user pilot/);
});

test('imported pilot does not mutate caller files or save a project receipt', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-pilot-caller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protectedFile = path.join(root, 'secret.txt');
  await writeFile(protectedFile, 'Private user project sentinel.');
  // Caller-supplied workspace/provider options are deliberately not part of the
  // API. Even accidental options cannot redirect the fixture into user data.
  const receipt = await runSyntheticPilot({ cycles: 2, root, provider: { complete() { throw new Error('Must not use caller provider.'); } } });
  assert.equal(receipt.verified, true, receipt.error);
  assert.equal(await readFile(protectedFile, 'utf8'), 'Private user project sentinel.');
  await assert.rejects(readFile(path.join(root, '.nexus/verification/pilot-synthetic.json')), { code: 'ENOENT' });
  assert.equal(JSON.stringify(receipt).includes('Private user project sentinel.'), false);
  assert.equal(JSON.stringify(receipt).includes(root), false);
});

test('synthetic pilot rejects unbounded or too-small run counts before creating a fixture', async () => {
  for (const cycles of [0, 1, 4, 1000, -1, 2.5, '3', null, NaN, Infinity]) {
    await assert.rejects(runSyntheticPilot({ cycles }), /cycles must be 2 or 3/);
  }
});

test('explicit CLI saves a truthful bounded rehearsal receipt in the selected project only', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-pilot-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/verify-pilot.js', import.meta.url))], { cwd: root, timeout: 15000 });
  const receipt = JSON.parse(await readFile(path.join(root, '.nexus/verification/pilot-synthetic.json'), 'utf8'));
  assert.deepEqual(JSON.parse(stdout), receipt);
  assert.equal(receipt.verified, true, receipt.error);
  assert.equal(receipt.productionReady, false);
  assert.equal(receipt.summary.runCount, 16);
  assert.equal(receipt.summary.expectedFailureRuns, 3);
  assert.equal(receipt.summary.expectedCancelledRuns, 1);
  assert.equal(receipt.summary.syntheticModelRequests, 28);
  await assert.rejects(readFile(path.join(root, '.nexus/storage.sqlite')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'source.txt')), { code: 'ENOENT' });
});
