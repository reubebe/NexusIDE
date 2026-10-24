import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, link, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateConfig } from '../src/config.js';
import { validateAgent } from '../src/agents.js';

const adapter = fileURLToPath(new URL('../integrations/cortex-reader.py', import.meta.url));
const engine = process.env.NEXUS_CORTEX_ENGINE || fileURLToPath(new URL('../fixtures/cortex-engine.py', import.meta.url));
const python = process.env.NEXUS_TEST_PYTHON || 'python3';
const available = process.platform !== 'win32' && spawnSync(python, ['--version']).status === 0;
const note = (status, body) => `---\ntype: concept\ntitle: SQLite knowledge\nstatus: ${status}\nauthor: agent\ntags: [storage]\n---\n${body}\n`;

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'nexus-cortex-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const brain = path.join(temp, 'brain'); await mkdir(path.join(brain, 'notes'), { recursive: true });
  const hash = createHash('sha256').update(await readFile(engine)).digest('hex');
  const transport = new StdioClientTransport({ command: python, args: ['-I', '-B', adapter, '--engine', engine, '--engine-sha256', hash, '--brain', brain], env: { PATH: process.env.PATH || '/usr/bin:/bin' }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'cortex-test', version: '1' });
  await client.connect(transport); t.after(() => client.close());
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return response.isError ? { error: response.content[0].text } : JSON.parse(response.content[0].text);
  };
  return { temp, brain, client, call };
}

test('Cortex public profile grants only approved knowledge reads without shell or file access', async () => {
  const config = validateConfig(JSON.parse(await readFile(new URL('../integrations/cortex.example.json', import.meta.url), 'utf8')));
  const agent = validateAgent(JSON.parse(await readFile(new URL('../examples/cortex-reader.json', import.meta.url), 'utf8')));
  assert.deepEqual(config.mcp.cortex.tools, ['cortex_find', 'cortex_read', 'cortex_context']);
  assert.deepEqual(config.mcp.cortex.envKeys, []);
  assert.deepEqual(agent.permissions, { read: false, write: false, execute: false });
  assert.match(agent.instructions, /expected_hash/);
});

test('Cortex MCP handshake, status-filtered discovery, source hashes and bounded context', { skip: !available }, async t => {
  const { brain, client, call } = await fixture(t);
  await writeFile(path.join(brain, 'notes/draft.md'), note('draft', 'SQLite stores local notes.'));
  await writeFile(path.join(brain, 'notes/verified.md'), note('verified', 'SQLite has reviewed findings.'));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['cortex_find', 'cortex_read', 'cortex_context']);
  const found = await call('cortex_find', { query: 'SQLite', status: 'verified', tag: 'storage' });
  assert.equal(found.items.length, 1); assert.equal(found.items[0].path, '/notes/verified.md');
  assert.match(found.items[0].content_hash, /^[a-f0-9]{64}$/);
  const context = await call('cortex_context', { query: 'SQLite', budget: 700 });
  assert.ok(context.items.length > 0);
  assert.ok(JSON.stringify(context.items).length <= 700);
  assert.match(context.scope, /Untrusted/);
  assert.deepEqual((await readdir(brain)).sort(), ['notes']);
});

test('Cortex redacts full text before pagination and refuses stale hashes', { skip: !available }, async t => {
  const { brain, call } = await fixture(t);
  const file = path.join(brain, 'notes/secret.md');
  const secret = 'sk-proj-' + 'z'.repeat(32);
  await writeFile(file, note('draft', `SQLite ${secret}\npassword=example-sensitive-value\n-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----`));
  const page = (await call('cortex_find', { query: 'SQLite' })).items[0];
  let text = '', start = 0;
  do {
    const read = await call('cortex_read', { path: page.path, expected_hash: page.content_hash, start, length: 17 });
    assert.equal(read.error, undefined); text += read.text; start = read.next_start;
  } while (start !== null);
  assert.equal(text.includes(secret), false); assert.equal(text.includes('private material'), false);
  assert.equal(text.includes('example-sensitive-value'), false);
  assert.match(text, /REDACTED/);
  await writeFile(file, note('verified', 'Changed'));
  assert.match((await call('cortex_read', { path: page.path, expected_hash: page.content_hash })).error, /Page changed/);
});

test('Cortex rejects path escape, symlinks, hard links, unknown writes and invalid limits', { skip: !available }, async t => {
  const { brain, temp, call } = await fixture(t);
  const outside = path.join(temp, 'outside.md'); await writeFile(outside, note('verified', 'OUTSIDE MUST NOT LEAK'));
  const hash = createHash('sha256').update(await readFile(outside)).digest('hex');
  await symlink(outside, path.join(brain, 'notes/symlink.md'));
  await link(outside, path.join(brain, 'notes/hard.md'));
  for (const name of ['../outside.md', '/notes/../../outside.md', 'notes/symlink.md', 'notes/hard.md']) {
    assert.ok((await call('cortex_read', { path: name, expected_hash: hash })).error);
  }
  assert.ok((await call('cortex_verify', { path: 'notes/hard.md' })).error);
  assert.ok((await call('cortex_context', { query: 'SQLite', budget: 200000 })).error);
  const result = await call('cortex_find', { query: 'OUTSIDE' });
  assert.ok(result.error); assert.equal(JSON.stringify(result).includes('OUTSIDE MUST NOT LEAK'), false);
});

test('Cortex adapter refuses an unreviewed engine before accepting requests', { skip: !available }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'nexus-cortex-pin-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const result = spawnSync(python, ['-I', '-B', adapter, '--engine', engine, '--engine-sha256', '0'.repeat(64), '--brain', temp], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /reviewed engine hash/);
});

test('Cortex reports omitted context and refuses oversized files and invalid query budgets', { skip: !available }, async t => {
  const { brain, call } = await fixture(t);
  await writeFile(path.join(brain, 'notes/large.md'), note('draft', 'SQLite ' + 'knowledge '.repeat(2000)));
  const context = await call('cortex_context', { query: 'SQLite', budget: 256 });
  assert.deepEqual(context.items, []); assert.equal(context.omitted_pages, 1);
  assert.match((await call('cortex_context', { query: 'SQLite', budget: 200000 })).error, /budget must/);
  assert.match((await call('cortex_find', { query: 'SQLite', limit: true })).error, /limit must/);
  assert.match((await call('cortex_find', { query: 'SQLite', root: '/tmp' })).error, /unsupported/);
  await writeFile(path.join(brain, 'notes/too-big.md'), note('draft', 'x'.repeat(256001)));
  assert.match((await call('cortex_find', { query: 'SQLite' })).error, /bounded regular/);
});

test('Cortex survives malformed protocol parameters and parse errors', { skip: !available }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'nexus-cortex-protocol-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const hash = createHash('sha256').update(await readFile(engine)).digest('hex');
  const input = [
    '{invalid json}',
    ...[null, [], 'bad'].map((params, id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params })),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
  ].join('\n') + '\n';
  const result = spawnSync(python, ['-I', '-B', adapter, '--engine', engine, '--engine-sha256', hash, '--brain', temp], { input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].error.code, -32700);
  assert.ok(replies.slice(1, 4).every(reply => reply.error.code === -32602));
  assert.deepEqual(replies[4], { jsonrpc: '2.0', id: 4, result: {} });
});
