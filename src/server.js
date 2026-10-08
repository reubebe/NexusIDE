import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { listAgents, loadAgent, validateAgent } from './agents.js';
import { listState, readState, writeState, safeName } from './state.js';
import { loadConfig, saveConfig, routeProvider } from './config.js';
import { listSkills, auditSkill } from './skills.js';
import { recall, remember } from './memory.js';
import { runAgent } from './runtime.js';
import { loadWorkflow, runWorkflow } from './workflows.js';
import { resolveWorktree } from './worktrees.js';
import { executeTool } from './tools.js';
import { createHash } from 'node:crypto';
import { acquireWorkspace } from './locks.js';
import { planTask } from './planner.js';
import { rebuildMemoryIndex, semanticRecall } from './semantic-memory.js';

export async function startServer({ root, port = 4317 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  const token = randomBytes(32).toString('hex');
  const jobs = new Map(), approvals = new Map();
  let origin, launching = false;
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON.');
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 200000) throw new Error('Request too large.'); }
    return JSON.parse(text || '{}');
  }
  const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  async function summary(folder) {
    const records = await Promise.all((await listState(root, folder)).map(f => readState(root, folder, f)));
    return records.sort((a, b) => (b.started || '').localeCompare(a.started || '')).slice(0, 100).map(({ messages, events, ...r }) => r);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host) return send(res, 403, { error: 'Invalid host.' });
      if (req.headers.origin && req.headers.origin !== origin) return send(res, 403, { error: 'Invalid origin.' });
      const url = new URL(req.url, origin);
      const pathname = url.pathname;
      if (!pathname.startsWith('/api/')) {
        const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/file-editor.js': ['file-editor.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
        const asset = assets[pathname];
        if (req.method !== 'GET' || !asset) return send(res, 404, { error: 'Not found.' });
        const data = await readFile(fileURLToPath(new URL(`../ui/${asset[0]}`, import.meta.url)));
        res.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8` }); return res.end(data);
      }
      const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(res, 401, { error: 'Open the dashboard using the URL printed by nexus serve.' });
      if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, { root, agents: await listAgents(root), skills: await listSkills(root), runs: await summary('runs'), workflows: await summary('workflows'), teams: await listState(root, 'teams'), memories: await recall(root), jobs: [...jobs.values()].map(({ controller, ...j }) => j), approvals: [...approvals.values()].map(({ resolve, timer, ...a }) => a) });
      if (req.method === 'GET' && pathname === '/api/config') return send(res, 200, await loadConfig(root));
      if (req.method === 'GET' && pathname === '/api/skills/audit') return send(res, 200, await auditSkill(root, url.searchParams.get('name')));
      const reader = { permissions: { read: true, write: false } };
      if (req.method === 'GET' && pathname === '/api/files') return send(res, 200, { path: url.searchParams.get('path') || '.', entries: (await executeTool(root, reader, 'list_files', { path: url.searchParams.get('path') || '.' }, async () => false)).split('\n').filter(Boolean) });
      if (req.method === 'GET' && pathname === '/api/file') {
        const content = await executeTool(root, reader, 'read_file', { path: url.searchParams.get('path') }, async () => false);
        return send(res, 200, { content, hash: createHash('sha256').update(content).digest('hex') });
      }
      if (req.method === 'PUT' && pathname === '/api/file') {
        const data = await body(req);
        const release = await acquireWorkspace(root, root, randomUUID());
        try {
        const result = await executeTool(root, { permissions: { read: true, write: true } }, 'write_file', { path: data.path, content: data.content }, async request => {
          const current = request.before === null ? null : createHash('sha256').update(request.before).digest('hex');
          if (current !== data.hash) throw new Error('File changed since opening; reload it before saving.');
          return true;
        });
        return send(res, 200, { result, hash: createHash('sha256').update(data.content).digest('hex') });
        } finally { await release(); }
      }
      if (req.method === 'PUT' && pathname === '/api/config') { await saveConfig(root, await body(req)); return send(res, 200, { saved: true }); }
      if (req.method === 'GET' && pathname.startsWith('/api/runs/')) return send(res, 200, await readState(root, 'runs', `${safeName(pathname.split('/').at(-1))}.json`));
      if (req.method === 'PUT' && pathname === '/api/agent') { const agent = validateAgent(await body(req)); await writeState(root, 'agents', `${agent.name}.json`, agent); return send(res, 200, agent); }
      if (req.method === 'POST' && pathname === '/api/memory') return send(res, 201, await remember(root, await body(req)));
      if (req.method === 'POST' && pathname === '/api/memory/index') return send(res, 200, await rebuildMemoryIndex(root));
      if (req.method === 'POST' && pathname === '/api/memory/search') { const data = await body(req); return send(res, 200, await semanticRecall(root, data.query)); }
      if (req.method === 'POST' && pathname === '/api/approval') {
        const data = await body(req), approval = approvals.get(data.id);
        if (!approval || typeof data.allow !== 'boolean') return send(res, 404, { error: 'Approval expired or invalid.' });
        approval.resolve(data.allow); return send(res, 200, { resolved: true });
      }
      if (req.method === 'POST' && pathname === '/api/cancel') {
        const data = await body(req); jobs.get(data.id)?.controller.abort(new Error('Cancelled from dashboard.')); return send(res, 200, { cancelled: true });
      }
      if (req.method === 'POST' && pathname === '/api/run') {
        const data = await body(req);
        if (typeof data.task !== 'string' || !data.task.trim() || data.task.length > 30000) throw new Error('Provide a task under 30000 characters.');
        if (launching || [...jobs.values()].some(j => j.status === 'running')) return send(res, 409, { error: 'Wait for or cancel the active dashboard task.' });
        launching = true;
        try {
        if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
        const id = randomUUID(), controller = new AbortController();
        const job = { id, status: 'running', events: [], controller };
        const approve = request => new Promise(resolve => {
          const approvalId = randomUUID();
          const finish = allow => { const a = approvals.get(approvalId); if (!a) return; clearTimeout(a.timer); approvals.delete(approvalId); controller.signal.removeEventListener('abort', abort); resolve(allow); };
          const abort = () => finish(false);
          approvals.set(approvalId, { id: approvalId, job: id, request, resolve: finish, timer: setTimeout(() => finish(false), 300000) });
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        });
        const options = { root, task: data.task, signal: controller.signal, approve, commandMode: data.sandboxImage ? 'docker' : 'host', sandboxImage: data.sandboxImage, onEvent: event => { job.events.push(event); if (job.events.length > 300) job.events.shift(); } };
        let execute;
        if (data.mode === 'plan') {
          execute = () => planTask({ ...options, demo: data.demo === true });
        } else if (data.team) {
          const workflow = await loadWorkflow(root, data.team);
          execute = () => runWorkflow({ ...options, workflow, demo: data.demo === true, allowCommands: data.allowCommands === true });
        } else {
          const agent = await loadAgent(root, data.agent);
          agent.permissions.execute = agent.permissions.execute === true && data.allowCommands === true;
          const provider = await routeProvider(root, agent, { demo: data.demo === true });
          const config = await loadConfig(root);
          const workspace = data.worktree ? await resolveWorktree(root, data.worktree) : root;
          execute = () => runAgent({ ...options, root: workspace, stateRoot: root, agent, provider, resume: data.resume, maxSteps: config.limits?.maxSteps || 20, maxContextChars: config.limits?.maxContextChars || 160000 });
        }
        jobs.set(id, job);
        void execute().then(result => { job.status = result.status; job.result = result.id; if (result.workflow) job.plan = result.workflow; }).catch(error => { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; });
        return send(res, 202, { id });
        } finally { launching = false; }
      }
      return send(res, 404, { error: 'Unknown endpoint.' });
    } catch (e) { if (!res.headersSent) send(res, 400, { error: e.message }); else res.destroy(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, token, url: `${origin}/#${token}`, async close() { for (const job of jobs.values()) job.controller.abort(); for (const approval of approvals.values()) approval.resolve(false); await new Promise(resolve => server.close(resolve)); } };
}
