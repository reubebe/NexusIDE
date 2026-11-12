import test from 'node:test';
import assert from 'node:assert/strict';
import { taskActivity } from '../ui/workbench.js';

test('activity keeps attempted, completed, failed and denied tools separate from validation', () => {
  const activity = taskActivity({ status: 'failed', events: [
    { type: 'tool-dispatch', name: 'write_file' },
    { type: 'approval', allowed: false, action: 'write' },
    { type: 'tool-finish', name: 'write_file', outcome: 'denied' },
    { type: 'tool-dispatch', name: 'run_command' },
    { type: 'tool-finish', name: 'run_command', outcome: 'failed' },
    { type: 'tool-dispatch', name: 'read_file' },
    { type: 'tool-finish', name: 'read_file', outcome: 'completed' },
    { type: 'text', text: 'Everything succeeded!' },
  ] });
  assert.deepEqual(activity.counts, { attempted: 3, completed: 1, failed: 1, denied: 1 });
  assert.match(activity.status, /^Failed/);
  assert.match(activity.evidence, /not independent validation/);
  assert.equal(activity.actions.some(a => a.label === 'Everything succeeded!'), false);
  assert.equal(activity.progress, 2);
});

test('activity shows pending approvals and never counts an unfinished call as completed', () => {
  const job = { status: 'running', events: [{ type: 'tool-dispatch', name: 'write_file' }] };
  assert.equal(taskActivity(job, 1).status, 'Waiting for your approval');
  assert.equal(taskActivity(job).counts.completed, 0);
  assert.equal(taskActivity(job).progress, 1);
  assert.match(taskActivity({ ...job, status: 'cancelled' }).status, /partial work/);
  assert.equal(taskActivity().progress, 0);
});

test('activity bounds visible history, preserves full counts and does not promote unknown outcomes', () => {
  const events = Array.from({ length: 40 }, () => ({ type: 'tool-dispatch', name: 'read_file' }));
  events.push({ type: 'tool-finish', name: 'read_file', outcome: 'new-unknown-status' });
  const activity = taskActivity({ status: 'completed', events });
  assert.equal(activity.actions.length, 12);
  assert.equal(activity.omitted, 29);
  assert.equal(activity.counts.attempted, 40);
  assert.equal(activity.counts.completed, 0);
  assert.equal(activity.actions.at(-1).outcome, 'unverified');
  assert.match(activity.status, /Review results/);
  assert.match(taskActivity({ status: 'completed', events: [], plan: { name: 'test' } }).status, /Review before running/);
});
