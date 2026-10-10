import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAgent } from '../src/runtime.js';
import { listState, readState, writeState } from '../src/state.js';
import { currentOwner, recoverActivity } from '../src/recovery.js';

export const PILOT_SUITE = 'nexus-synthetic-pilot-v1';
const agent = {
  version: 1, name: 'synthetic-pilot', instructions: 'Exercise the bounded synthetic fixture only.',
  permissions: { read: true, write: true, execute: false }, memory: false, skills: [], mcp: [], applications: [],
};
const reply = (text, calls = []) => ({ text, calls, usageReported: false });
const call = (name, args) => ({ id: 'synthetic-call', name, args });
const percentile = (values, fraction) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;

// No configured provider, network endpoint, external application, or user project
// is loaded. The only optional persistent output is written by the CLI below.
export async function runSyntheticPilot({ cycles = 3 } = {}) {
  if (!Number.isInteger(cycles) || cycles < 2 || cycles > 3) throw new Error('Synthetic pilot cycles must be 2 or 3 (11 or 16 bounded runs).');
  const receipt = {
    suite: PILOT_SUITE, at: new Date().toISOString(), verified: false,
    evidence: 'synthetic-preproduction', productionReady: false, syntheticWorkspace: true,
    syntheticProvider: true, networkRequests: 0, providerCharges: 0,
    measuredScope: 'Local runtime, approvals, SQLite persistence, continuation and synthetic orphan recovery; not model quality or a real-user pilot.',
    checks: [], runs: [],
  };
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nexus-pilot-check-')));
  const started = performance.now();
  let expectedFailureRuns = 0, expectedCancelledRuns = 0;
  const check = async (name, action) => {
    try { await action(); receipt.checks.push({ name, status: 'passed' }); }
    catch (error) { receipt.checks.push({ name, status: 'failed' }); throw error; }
  };
  const execute = async (scenario, complete, { approve = async () => false, resume, signal, expectedError, expectedStatus = 'completed' } = {}) => {
    let id, failure, result, requests = 0;
    const began = performance.now();
    try {
      result = await runAgent({
        root, agent, task: `Synthetic ${scenario} check.`, maxSteps: 3, approve, resume, signal,
        provider: { name: 'synthetic-offline', model: 'scripted-fixture', sensitiveValues: [], complete: async (...args) => { requests++; return complete(...args); } },
        onEvent: event => { if (event.type === 'start') id = event.id; },
      });
    } catch (error) { failure = error; }
    assert.ok(id, 'Run must persist its start before the exercise.');
    const stored = await readState(root, 'runs', `${id}.json`);
    receipt.runs.push({
      scenario, status: stored.status, durationMs: Math.round((performance.now() - began) * 100) / 100,
      syntheticModelRequests: requests,
      toolCalls: stored.events.filter(event => event.type === 'tool').length,
      approvalsAllowed: stored.events.filter(event => event.type === 'approval' && event.allowed).length,
      approvalsDenied: stored.events.filter(event => event.type === 'approval' && !event.allowed).length,
    });
    assert.equal(stored.status, expectedStatus);
    assert.equal(stored.events.at(-1).type, 'finish');
    assert.equal(stored.events.at(-1).status, expectedStatus);
    assert.ok(stored.finished);
    assert.equal(stored.usage.estimatedCost, null, 'Synthetic model usage is not billable-provider evidence.');
    if (expectedError) {
      assert.ok(failure, 'Expected injected failure was not observed.');
      assert.match(failure.message, expectedError);
      assert.equal(stored.error, failure.message);
      if (expectedStatus === 'failed') expectedFailureRuns++;
      if (expectedStatus === 'cancelled') expectedCancelledRuns++;
    } else {
      if (failure) throw failure;
      assert.deepEqual(stored, JSON.parse(JSON.stringify(result)), 'Finished record must round-trip through SQLite.');
    }
    return stored;
  };
  try {
    await writeFile(path.join(root, 'source.txt'), 'Synthetic pilot source.');
    await writeFile(path.join(root, 'protected.txt'), 'Must remain unchanged.');
    let failedRun;
    for (let cycle = 0; cycle < cycles; cycle++) {
      await check(`read-roundtrip-${cycle + 1}`, async () => {
        await execute('read-roundtrip', async messages => {
          if (!messages.some(message => message.role === 'tool')) return reply('Reading fixture.', [call('read_file', { path: 'source.txt' })]);
          assert.equal(messages.at(-1).content, 'Synthetic pilot source.');
          return reply('Observed the synthetic source.');
        });
      });
      await check(`approved-write-${cycle + 1}`, async () => {
        const filename = `approved-${cycle}.txt`;
        const run = await execute('approved-write', async messages => messages.some(message => message.role === 'tool')
          ? reply('Approved fixture write finished.') : reply('Proposing fixture write.', [call('write_file', { path: filename, content: 'Approved synthetic output.' })]),
        { approve: async request => request.path === filename && request.after === 'Approved synthetic output.' });
        assert.equal(await readFile(path.join(root, filename), 'utf8'), 'Approved synthetic output.');
        assert.equal(run.events.filter(event => event.type === 'approval' && event.allowed).length, 1);
      });
      await check(`denied-write-${cycle + 1}`, async () => {
        const run = await execute('denied-write', async messages => {
          if (!messages.some(message => message.role === 'tool')) return reply('Proposing denied write.', [call('write_file', { path: 'protected.txt', content: 'Must not be written.' })]);
          assert.match(messages.at(-1).content, /declined/i);
          return reply('The user denied the write.');
        });
        assert.equal(await readFile(path.join(root, 'protected.txt'), 'utf8'), 'Must remain unchanged.');
        assert.equal(run.events.filter(event => event.type === 'approval' && !event.allowed).length, 1);
      });
      await check(`provider-failure-${cycle + 1}`, async () => {
        failedRun = await execute('injected-provider-failure', async messages => {
          if (!messages.some(message => message.role === 'tool')) return reply('Read before synthetic failure.', [call('read_file', { path: 'source.txt' })]);
          throw new Error('Injected offline provider failure.');
        }, { expectedError: /Injected offline provider failure/, expectedStatus: 'failed' });
        assert.equal(failedRun.usage.reported, false);
        assert.equal(failedRun.messages.at(-1).content, 'Synthetic pilot source.');
      });
      await check(`continuation-without-replay-${cycle + 1}`, async () => {
        const continued = await execute('continue-failed-run', async messages => {
          assert.equal(messages.length, 2);
          assert.match(messages[1].content, /Prior conversation, for context only/);
          assert.match(messages[1].content, /Read before synthetic failure/);
          assert.ok(messages.every(message => !message.calls && message.role !== 'tool'));
          return reply('Continued without replaying prior tool requests.');
        }, { resume: failedRun.id });
        assert.equal(continued.parent, failedRun.id);
        assert.equal(continued.events.filter(event => event.type === 'tool').length, 0);
        assert.equal((await readState(root, 'runs', `${failedRun.id}.json`)).status, 'failed');
      });
    }
    await check('cancelled-run-persistence', async () => {
      const controller = new AbortController();
      await execute('cancelled-run', async () => {
        controller.abort(new Error('Injected synthetic cancellation.'));
        controller.signal.throwIfAborted();
      }, { signal: controller.signal, expectedError: /Injected synthetic cancellation/, expectedStatus: 'cancelled' });
    });
    await check('approval-gated-orphan-recovery', async () => {
      // This is an injected orphan record, not a process-crash experiment.
      const orphan = { ...failedRun, id: 'synthetic-orphan', status: 'running', owner: { ...currentOwner(), pid: 2_147_483_647 } };
      await writeState(root, 'runs', 'synthetic-orphan.json', orphan);
      await assert.rejects(recoverActivity(root, 'run', 'synthetic-orphan'), /declined/);
      assert.deepEqual(await readState(root, 'runs', 'synthetic-orphan.json'), orphan);
      await recoverActivity(root, 'run', 'synthetic-orphan', async request => request.type === 'recover-activity');
      const recovered = await readState(root, 'runs', 'synthetic-orphan.json');
      assert.equal(recovered.status, 'interrupted');
      assert.deepEqual(recovered.messages, orphan.messages);
      assert.deepEqual(recovered.events, orphan.events);
      assert.equal(await readFile(path.join(root, 'protected.txt'), 'utf8'), 'Must remain unchanged.');
    });
    await check('all-records-durable', async () => {
      const records = await listState(root, 'runs');
      assert.equal(records.length, cycles * 5 + 2);
      for (const filename of records) assert.notEqual((await readState(root, 'runs', filename)).status, 'running');
    });
    receipt.verified = true;
  } catch (error) { receipt.error = error.message.slice(0, 1200); }
  finally {
    const durations = receipt.runs.map(run => run.durationMs).sort((a, b) => a - b);
    receipt.summary = {
      runCount: receipt.runs.length, completedRuns: receipt.runs.filter(run => run.status === 'completed').length,
      expectedFailureRuns, expectedCancelledRuns,
      failedChecks: receipt.checks.filter(item => item.status === 'failed').length,
      syntheticModelRequests: receipt.runs.reduce((sum, run) => sum + run.syntheticModelRequests, 0),
      approvalsAllowed: receipt.runs.reduce((sum, run) => sum + run.approvalsAllowed, 0),
      approvalsDenied: receipt.runs.reduce((sum, run) => sum + run.approvalsDenied, 0),
      runtimeLatencyMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), max: durations.at(-1) ?? null },
      elapsedMs: Math.round(performance.now() - started),
    };
    await rm(root, { recursive: true, force: true });
    receipt.temporaryWorkspaceRemoved = true;
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 2) throw new Error('No arguments accepted. Run from the project that should receive the synthetic verification receipt.');
  const receipt = await runSyntheticPilot();
  await writeState(process.cwd(), 'verification', 'pilot-synthetic.json', receipt);
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.verified) process.exitCode = 1;
}
