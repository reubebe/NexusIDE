import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable, Writable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { startAcp } from '../src/acp.js';
import { defaults, installAgent } from '../src/agents.js';
import { saveConfig } from '../src/config.js';

test('ACP initializes, selects an agent, and runs a text prompt through the shared runtime', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-acp-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const a of defaults) await installAgent(root, a);
  const toAgent = new PassThrough(), fromAgent = new PassThrough();
  const running = startAcp({ demo: true, input: toAgent, output: fromAgent });
  const updates = [];
  const client = new ClientSideConnection(() => ({ sessionUpdate: update => { updates.push(update); }, requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }) }), ndJsonStream(Writable.toWeb(toAgent), Readable.toWeb(fromAgent)));
  try {
    const initialized = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    assert.equal(initialized.agentInfo.name, 'nexuside');
    const session = await client.newSession({ cwd: root, mcpServers: [] });
    assert.equal(session.modes.currentModeId, 'architect');
    await client.setSessionMode({ sessionId: session.sessionId, modeId: 'reviewer' });
    const result = await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Inspect project' }] });
    assert.equal(result.stopReason, 'end_turn');
    assert.ok(updates.some(u => u.update.content?.text.includes('Offline demo completed')));
  } finally { toAgent.end(); fromAgent.end(); await running; }
});

test('ACP cancellation releases a pending write approval without modifying files', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-acp-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await installAgent(root, defaults.find(a => a.name === 'coder'));
  const model = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* drain request */ }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'write', function: { name: 'write_file', arguments: JSON.stringify({ path: 'cancelled.txt', content: 'must not be written' }) } }] } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => model.close(resolve)));
  await saveConfig(root, { version: 1, providers: { fixture: { kind: 'compatible', model: 'fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1` } }, routes: { default: 'fixture' }, mcp: {} });
  const toAgent = new PassThrough(), fromAgent = new PassThrough();
  const running = startAcp({ input: toAgent, output: fromAgent });
  let sawApproval, answerApproval;
  const pending = new Promise(resolve => { sawApproval = resolve; });
  const client = new ClientSideConnection(() => ({ sessionUpdate: async () => {}, requestPermission: async () => {
    sawApproval();
    return new Promise(resolve => { answerApproval = resolve; });
  } }), ndJsonStream(Writable.toWeb(toAgent), Readable.toWeb(fromAgent)));
  try {
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await client.newSession({ cwd: root, mcpServers: [] });
    const prompt = client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Write a file' }] });
    await pending;
    await client.cancel({ sessionId });
    assert.equal((await prompt).stopReason, 'cancelled');
    answerApproval({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await assert.rejects(readFile(path.join(root, 'cancelled.txt')), { code: 'ENOENT' });
    await client.setSessionMode({ sessionId, modeId: 'coder' });
  } finally {
    answerApproval?.({ outcome: { outcome: 'cancelled' } });
    toAgent.end(); fromAgent.end(); await running;
  }
});
