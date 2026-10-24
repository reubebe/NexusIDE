import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateWorkflow, runWorkflow } from '../src/workflows.js';
import { createIndependentReviewRunner, validateReviewReport } from '../src/independent-review.js';
import { installAgent } from '../src/agents.js';
import { saveConfig } from '../src/config.js';
import { recentState } from '../src/state.js';

const ids = ['plan', 'plan-review', 'build', 'inspect'];
const plan = 'Update main.js to return 2; check its exported answer.';
const source = 'export const answer = 2;\n';
const team = () => ({ version: 1, name: 'review-fixture', reviewPolicy: { maxPlanRounds: 2, maxModelRequests: 12 }, steps: ids.map((id, i) => ({ id, agent: id, task: id, ...(i ? { dependsOn: [ids[i - 1]] } : {}), ...(id === 'build' ? { approval: true } : {}) })) });
const report = (verdict = 'approved', inspection = false) => ({ verdict, summary: 'Observed the relevant evidence.', evidence: [{ source: inspection ? 'file' : 'plan', path: inspection ? 'main.js' : '', quote: inspection ? 'export const answer = 2;' : 'Update main.js to return 2' }], findings: verdict === 'approved' ? [] : [{ severity: 'blocking', message: 'Acceptance checks need more detail.', evidenceIndex: 0 }] });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-independent-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'main.js'), 'export const answer = 1;\n');
  return root;
}

test('independent workflow runs real tool calls and final reviewer sees builder edits', async t => {
  const root = await fixture(t), requests = [], approvals = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), model = body.model;
    requests.push(model);
    const tool = body.messages.find(message => message.role === 'tool');
    let content, calls;
    if (model === 'planner-model') content = plan;
    else if (model === 'critic-model') content = JSON.stringify(report());
    else if (model === 'builder-model' && !tool) calls = [{ id: 'write-fixture', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'main.js', content: source }) } }];
    else if (model === 'builder-model') content = 'Updated main.js. No tests were run.';
    else if (!tool) calls = [{ id: 'read-fixture', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'main.js' }) } }];
    else { assert.equal(tool.content, source); content = JSON.stringify(report('approved', true)); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: content || '', ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const models = ['planner-model', 'critic-model', 'builder-model', 'inspector-model'];
  await saveConfig(root, { version: 1, providers: Object.fromEntries(ids.map((id, i) => [id, { kind: 'compatible', model: models[i], baseUrl: `http://127.0.0.1:${server.address().port}/v1` }])), routes: Object.fromEntries(ids.map(id => [id, id])), mcp: {} });
  for (const id of ids) await installAgent(root, { version: 1, name: id, instructions: id, permissions: { read: true, write: id === 'build' } });
  const result = await runWorkflow({ root, workflow: team(), task: 'Change the answer.', approve: async request => { approvals.push(request); return true; } });
  assert.equal(result.status, 'completed');
  assert.equal(result.review.inspection.verdict, 'approved');
  assert.equal(result.review.modelRequests, 6);
  assert.deepEqual(requests, ['planner-model', 'critic-model', 'builder-model', 'builder-model', 'inspector-model', 'inspector-model']);
  assert.equal(approvals.filter(request => request.type === 'workflow').length, 1);
  assert.ok(approvals.some(request => request.path === 'main.js'));
  assert.equal(await readFile(path.join(root, 'main.js'), 'utf8'), source);
  const runs = await recentState(root, 'runs', 20);
  assert.equal(new Set(runs.map(run => run.id)).size, 4);
});

function harness({ verdict = 'approved', malformed = false, blockInspection = false } = {}) {
  const seen = [], record = { steps: {} };
  const prepared = new Map(ids.map(id => [id, { agent: { name: id, permissions: { read: true, write: id === 'build' } }, provider: { name: 'compatible', model: id, endpoint: 'http://127.0.0.1:1/v1', complete: async () => ({}) } }]));
  const run = async args => {
    const id = args.agent.name; seen.push(id); await args.provider.complete();
    const content = id === 'plan' ? plan : id === 'build' ? 'Built.' : malformed ? 'APPROVED' : JSON.stringify(report(id === 'inspect' && blockInspection ? 'blocked' : verdict, id === 'inspect'));
    const messages = id === 'inspect' ? [{ role: 'assistant', calls: [{ id: 'r', name: 'read_file', args: { path: 'main.js' } }] }, { role: 'tool', id: 'r', content: source }] : [];
    return { id: `${id}-${seen.length}`, status: 'completed', messages: [...messages, { role: 'assistant', content }] };
  };
  const options = { workflow: team(), task: 'task', prepared, record, save: async () => {}, config: {}, approve: async () => true, onEvent: () => {} };
  return { seen, record, prepared, run: createIndependentReviewRunner(run), options };
}

test('plan review blocking, malformed verdicts, and round exhaustion never start a builder', async t => {
  const root = await fixture(t);
  for (const scenario of [{ verdict: 'blocked' }, { malformed: true }, { verdict: 'revise' }]) {
    const h = harness(scenario);
    await assert.rejects(h.run({ ...h.options, root }));
    assert.ok(!h.seen.includes('build'));
    assert.equal(h.seen.length, scenario.verdict === 'revise' ? 4 : 2);
  }
});

test('model aliases, unsafe reviewers, isolated worktrees and demo fail preflight', async t => {
  const root = await fixture(t);
  const aliases = harness(); aliases.prepared.get('inspect').provider.model = 'build'; aliases.prepared.get('inspect').provider.profile = 'other-account';
  await assert.rejects(aliases.run({ ...aliases.options, root }), /different model/);
  assert.deepEqual(aliases.seen, []);
  for (const grants of [{ write: true }, { execute: true }]) {
    const h = harness(); Object.assign(h.prepared.get('plan-review').agent.permissions, grants);
    await assert.rejects(h.run({ ...h.options, root }), /read-only/);
    assert.deepEqual(h.seen, []);
  }
  for (const extra of [{ isolated: true }, { demo: true }, { options: { resume: 'prior' } }]) {
    const h = harness(); await assert.rejects(h.run({ ...h.options, root, ...extra })); assert.deepEqual(h.seen, []);
  }
});

test('request budget, cancelled approval, and failed inspection stop without automatic repair', async t => {
  const root = await fixture(t); await writeFile(path.join(root, 'main.js'), source);
  const budget = harness({ verdict: 'revise' });
  budget.options.workflow.reviewPolicy = { maxPlanRounds: 3, maxModelRequests: 4 };
  await assert.rejects(budget.run({ ...budget.options, root }), /budget exhausted/);
  assert.equal(budget.record.review.modelRequests, 4); assert.ok(!budget.seen.includes('build'));
  const cancel = harness(), controller = new AbortController();
  await assert.rejects(cancel.run({ ...cancel.options, root, signal: controller.signal, approve: async () => { controller.abort(); return true; } }));
  assert.ok(!cancel.seen.includes('build'));
  const inspect = harness({ blockInspection: true });
  await assert.rejects(inspect.run({ ...inspect.options, root }), /final inspection did not approve/);
  assert.deepEqual(inspect.seen, ids);
  assert.equal(inspect.record.review.inspection.verdict, 'blocked');
});

test('review evidence cannot be fabricated, stale, or approved with blocking findings', async t => {
  const root = await fixture(t), options = { root, target: plan, run: { messages: [] }, inspection: false };
  const fabricated = report(); fabricated.evidence[0].quote = 'not in the plan';
  await assert.rejects(validateReviewReport(JSON.stringify(fabricated), options), /does not occur/);
  const blocking = report('blocked'); blocking.verdict = 'approved';
  await assert.rejects(validateReviewReport(JSON.stringify(blocking), options), /blocking findings/);
  await assert.rejects(validateReviewReport(JSON.stringify(report('approved', true)), { ...options, inspection: true }), /file read/);
  const stale = { ...options, inspection: true, run: { messages: [{ role: 'assistant', calls: [{ id: 'r', name: 'read_file', args: { path: 'main.js' } }] }, { role: 'tool', id: 'r', content: source }] } };
  await assert.rejects(validateReviewReport(JSON.stringify(report('approved', true)), stale), /file changed/);
});

test('review policy rejects missing approval, reordered stages, and unbounded rounds', () => {
  const missing = team(); missing.steps[2].approval = false;
  assert.throws(() => validateWorkflow(missing), /approval gate/);
  const rounds = team(); rounds.reviewPolicy.maxPlanRounds = 99;
  assert.throws(() => validateWorkflow(rounds), /1–3/);
  const reordered = team(); reordered.steps.reverse();
  assert.throws(() => validateWorkflow(reordered), /in that order/);
});

test('review evidence uses a fresh reread and handles tool IDs reused across turns', async t => {
  const root = await fixture(t); await writeFile(path.join(root, 'main.js'), source);
  const messages = [
    { role: 'assistant', calls: [{ id: 'old-read', name: 'read_file', args: { path: 'main.js' } }] },
    { role: 'tool', id: 'old-read', content: source + '// removed later\n' },
    { role: 'assistant', calls: [{ id: 'fresh-read', name: 'read_file', args: { path: 'main.js' } }] },
    { role: 'tool', id: 'fresh-read', content: source },
    { role: 'assistant', calls: [{ id: 'fresh-read', name: 'git_status', args: {} }] },
    { role: 'tool', id: 'fresh-read', content: ' M main.js' },
  ];
  const review = await validateReviewReport(JSON.stringify(report('approved', true)), { root, target: plan, run: { messages }, inspection: true });
  assert.equal(review.verdict, 'approved');
});

test('cancellation during final review persistence cannot report completion', async t => {
  const root = await fixture(t); await writeFile(path.join(root, 'main.js'), source);
  const h = harness(), controller = new AbortController();
  await assert.rejects(h.run({ ...h.options, root, signal: controller.signal, save: async () => {
    if (h.record.review?.inspection) controller.abort();
  } }), { name: 'AbortError' });
});
