import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { installAgent, defaults } from '../src/agents.js';
import { remember } from '../src/memory.js';
import { saveConfig } from '../src/config.js';
import { importSkill } from '../src/skills.js';

test('dashboard exposes the installed app version rather than the workspace package version', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-version-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: 'workspace-version' }));
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const response = await fetch(new URL(app.url).origin + '/api/state', { headers: { authorization: `Bearer ${app.token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, metadata.version);
});

test('dashboard skill audit requires authentication and reports coverage without returning source contents', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle'); await mkdir(bundle);
  await writeFile(path.join(bundle, 'SKILL.md'), '---\nname: audit-fixture\ndescription: Test audit\n---\nPrivate source prose.');
  await writeFile(path.join(bundle, 'image.bin'), Buffer.from([0, 1, 2]));
  await importSkill(root, bundle);
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const endpoint = new URL(app.url).origin + '/api/skills/audit?name=audit-fixture';
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = { authorization: `Bearer ${app.token}` };
  assert.equal((await fetch(endpoint, { headers: { ...headers, origin: 'https://example.invalid' } })).status, 403);
  const response = await fetch(endpoint, { headers });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.integrity, 'matches-record');
  assert.equal(report.scan.verdict, 'incomplete-review');
  assert.deepEqual(report.scan.coverage.skipped, [{ file: 'image.bin', reason: 'binary' }]);
  assert.equal(JSON.stringify(report).includes('Private source prose'), false);
});

test('dashboard runs a provider tool cycle, approves once, and rejects stale file saves', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-dashboard-')); t.after(() => rm(root, { recursive: true, force: true }));
  await installAgent(root, defaults[1]);
  const model = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    const done = request.messages.some(m => m.role === 'tool');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: done ? { content: 'Saved the requested file.' } : { tool_calls: [{ id: 'write-1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'new.txt', content: 'approved content' }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => model.close(resolve)));
  await saveConfig(root, { version: 1, providers: { fixture: { kind: 'compatible', model: 'test', baseUrl: `http://127.0.0.1:${model.address().port}/v1` } }, routes: { default: 'fixture' }, mcp: {} });
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const origin = new URL(app.url).origin;
  const api = async (endpoint, method = 'GET', data) => fetch(origin + '/api/' + endpoint, { method, headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.equal((await api('run', 'POST', { agent: 'coder', task: 'write file' })).status, 202);
  let approval;
  for (let i = 0; i < 100; i++) { const state = await (await api('state')).json(); if (state.approvals.length) { approval = state.approvals[0]; break; } await new Promise(r => setTimeout(r, 10)); }
  assert.ok(approval, 'write approval appeared');
  await assert.rejects(readFile(path.join(root, 'new.txt')), { code: 'ENOENT' });
  assert.equal((await api('approval', 'POST', { id: approval.id, allow: true })).status, 200);
  assert.equal((await api('approval', 'POST', { id: approval.id, allow: true })).status, 404);
  for (let i = 0; i < 100; i++) { const state = await (await api('state')).json(); if (state.jobs[0].status === 'completed') break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'approved content');
  const opened = await (await api('file?path=new.txt')).json();
  await writeFile(path.join(root, 'new.txt'), 'external edit');
  assert.equal((await api('file', 'PUT', { path: 'new.txt', hash: opened.hash, content: 'stale edit' })).status, 400);
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'external edit');
  const fresh = await (await api('file?path=new.txt')).json();
  const saved = await api('file', 'PUT', { path: 'new.txt', hash: fresh.hash, content: 'user edit' });
  assert.equal(saved.status, 200);
  const acknowledged = await saved.json();
  assert.equal(acknowledged.hash, (await (await api('file?path=new.txt')).json()).hash);
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'user edit');
  const html = await (await fetch(origin)).text();
  assert.match(html, /src="\/app.js" type="module"/);
  const module = await fetch(origin + '/file-editor.js');
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/);
  const renderCache = await fetch(origin + '/render-cache.js');
  assert.equal(renderCache.status, 200);
  assert.match(await renderCache.text(), /renderWhenChanged/);
});


test('semantic dashboard endpoints enforce authentication and explicit agent selection', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-semantic-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const embeddings = http.createServer(async (req, res) => {
    requests++;
    let data = ''; for await (const chunk of req) data += chunk;
    const { input } = JSON.parse(data);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embeddings: input.map(() => [1, 0]) }));
  });
  await new Promise(resolve => embeddings.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => embeddings.close(resolve)));
  await saveConfig(root, { version: 1, providers: {}, routes: {}, mcp: {}, embeddings: { model: 'fixture', url: `http://127.0.0.1:${embeddings.address().port}/api/embed` } });
  await remember(root, { text: 'Project note' });
  await remember(root, { text: 'Agent private note', scope: 'agent', agent: 'reviewer' });
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const origin = new URL(app.url).origin;
  const headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
  for (const route of ['index', 'search']) {
    assert.equal((await fetch(`${origin}/api/memory/${route}`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${origin}/api/memory/${route}`, { method: 'POST', headers: { ...headers, origin: 'https://example.invalid' }, body: '{}' })).status, 403);
  }
  assert.equal(requests, 0);
  assert.equal((await fetch(`${origin}/api/memory/index`, { method: 'POST', headers, body: '{}' })).status, 200);
  const response = await fetch(`${origin}/api/memory/search`, { method: 'POST', headers, body: JSON.stringify({ query: 'note' }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].text, 'Project note');
  assert.equal((await fetch(`${origin}/api/memory/search`, { method: 'POST', headers, body: JSON.stringify({ query: 'note', agent: 'reviewer' }) })).status, 400, 'unknown agent is refused');
  await installAgent(root, { ...defaults[2], memory: true });
  const selected = await (await fetch(`${origin}/api/memory/search`, { method: 'POST', headers, body: JSON.stringify({ query: 'note', agent: 'reviewer' }) })).json();
  assert.equal(selected.matches.length, 2);
});

test('dashboard terminal is authenticated, bounded, interactive and explicitly stopped', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-terminal-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const origin = new URL(app.url).origin, headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/terminal/start`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${origin}/api/terminal/start`, { method: 'POST', headers, body: '{}' })).status, 201);
  assert.equal((await fetch(`${origin}/api/terminal/start`, { method: 'POST', headers, body: '{}' })).status, 409);
  const input = await fetch(`${origin}/api/terminal/input`, { method: 'POST', headers, body: JSON.stringify({ input: 'printf NEXUS_EMBEDDED_TERMINAL_OK\\n\n' }) });
  assert.equal(input.status, 200);
  let output = '';
  for (let i = 0; i < 100 && !output.includes('NEXUS_EMBEDDED_TERMINAL_OK'); i++) { await new Promise(resolve => setTimeout(resolve, 10)); output += (await (await fetch(`${origin}/api/terminal/output?cursor=0`, { headers })).json()).output; }
  assert.match(output, /NEXUS_EMBEDDED_TERMINAL_OK/);
  assert.equal((await fetch(`${origin}/api/terminal/input`, { method: 'POST', headers, body: JSON.stringify({ input: 'x'.repeat(10001) }) })).status, 400);
  assert.equal((await fetch(`${origin}/api/terminal/stop`, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await (await fetch(`${origin}/api/terminal/output`, { headers })).json()).running, false);
});
