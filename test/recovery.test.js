import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readState, writeState } from '../src/state.js';
import { currentOwner, inspectActivity, recoverActivity } from '../src/recovery.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const orphan = () => ({ id: 'orphan', owner: { ...currentOwner(), pid: 2_147_483_647 }, started: '2026-10-07T00:00:00.000Z', status: 'running', messages: [{ role: 'user', content: 'Keep this history' }], events: [], steps: { plan: { status: 'completed' } } });

test('recovery preserves orphan history and requires explicit approval for runs and workflows', async t => {
  const root = await fixture(t);
  for (const [kind, folder] of [['run', 'runs'], ['workflow', 'workflows']]) {
    const record = orphan();
    await writeState(root, folder, 'orphan.json', record);
    assert.equal((await inspectActivity(root)).find(r => r.kind === kind).processStatus, 'absent');
    await assert.rejects(recoverActivity(root, kind, 'orphan'), /declined/);
    assert.deepEqual(await readState(root, folder, 'orphan.json'), record);
    const result = await recoverActivity(root, kind, 'orphan', async request => request.type === 'recover-activity');
    assert.equal(result.status, 'interrupted');
    const recovered = await readState(root, folder, 'orphan.json');
    assert.deepEqual(recovered.messages, record.messages);
    assert.deepEqual(recovered.steps, record.steps);
    assert.equal(recovered.recovery.previousStatus, 'running');
    await assert.rejects(recoverActivity(root, kind, 'orphan', async () => true), /Only records still marked running/);
  }
  assert.deepEqual(await inspectActivity(root), []);
});

test('recovery refuses active, legacy, other-host, and changed records', async t => {
  const root = await fixture(t);
  for (const owner of [currentOwner(), undefined, { ...currentOwner(), host: 'another-machine' }]) {
    await writeState(root, 'runs', 'orphan.json', { ...orphan(), owner });
    await assert.rejects(recoverActivity(root, 'run', 'orphan', async () => true), /confirmed absent process/);
  }
  await writeState(root, 'runs', 'orphan.json', orphan());
  await assert.rejects(recoverActivity(root, 'run', 'orphan', async () => {
    await writeState(root, 'runs', 'orphan.json', { ...orphan(), status: 'completed' });
    return true;
  }), /changed during approval/);
  assert.equal((await readState(root, 'runs', 'orphan.json')).status, 'completed');
  await assert.rejects(recoverActivity(root, 'config', 'orphan', async () => true), /kind must be/);
});
