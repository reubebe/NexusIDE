import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig } from '../src/config.js';
import { connectMcp } from '../src/mcp.js';

test('MCP handshake exposes only granted tools and requires connection and call approval', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-mcp-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = { version: 1, providers: {}, routes: {}, mcp: { fixture: { command: process.execPath, args: [fileURLToPath(new URL('../fixtures/mcp-server.mjs', import.meta.url))], tools: ['echo'] } } };
  await saveConfig(root, config);
  const approvals = [];
  const client = await connectMcp(root, { mcp: ['fixture'] }, async r => { approvals.push(r.type); return true; });
  t.after(() => client.close());
  assert.equal(client.tools.length, 1);
  const result = await client.call(client.tools[0].name, { text: 'hello' });
  assert.match(result, /hello/);
  assert.deepEqual(approvals, ['mcp-connect', 'mcp-call']);
  await assert.rejects(client.call('not_granted', {}), /not granted/);
  await assert.rejects(connectMcp(root, { mcp: ['fixture'] }, async () => false), /declined/);
});

test('HTTP MCP supports explicit endpoints and tool grants', async t => {
  const http = await import('node:http');
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = ''; for await (const c of req) body += c;
    const request = JSON.parse(body);
    if (request.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] };
    else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'HTTP tool works' }] };
    else result = {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-http-mcp-')); t.after(() => rm(root, { recursive: true, force: true }));
  await saveConfig(root, { version: 1, providers: {}, routes: {}, mcp: { fixture: { transport: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, tools: ['echo'] } } });
  const client = await connectMcp(root, { mcp: ['fixture'] }, async () => true);
  try { assert.match(await client.call(client.tools[0].name, {}), /HTTP tool works/); }
  finally { await client.close(); }
});
