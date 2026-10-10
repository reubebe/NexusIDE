import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { listAgents, loadAgent, validateAgent } from './agents.js';
import { listState, readState, writeState, safeName, recentState } from './state.js';
import { loadConfig, saveConfig, routeProvider } from './config.js';
import { listSkills, auditSkill } from './skills.js';
import { recall, remember, listMemories, updateMemory, memoryHistory } from './memory.js';
import { searchMemory } from './memory-search.js';
import { draftMemory, listMemoryDrafts, reviewMemoryDraft } from './memory-distillation.js';
import { runAgent } from './runtime.js';
import { loadWorkflow, runWorkflow } from './workflows.js';
import { resolveWorktree } from './worktrees.js';
import { executeTool } from './tools.js';
import { createHash } from 'node:crypto';
import { acquireWorkspace } from './locks.js';
import { planTask } from './planner.js';
import { rebuildMemoryIndex } from './semantic-memory.js';
import { commandEnvironment } from './process.js';

export async function readJsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON.');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 200000) throw new Error('Request too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8') || '{}');
}

export async function startServer({ root, port = 4317 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  const token = randomBytes(32).toString('hex');
  const jobs = new Map(), approvals = new Map();
  let terminal;
  let origin, launching = false, terminalStarting = false, closing = false;
  const executions = new Set();
  let terminalStart;
  const body = readJsonBody;
  const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  async function summary(folder) {
    return recentState(root, folder, 100, { summary: true });
  }
  async function writeConfiguration(callback) {
    // Configuration and grant journals share the writer lease. Otherwise an
    // editor save can interleave with integration grant setup/revocation and
    // silently restore a permission or profile that was just removed.
    const release = await acquireWorkspace(root, root, randomUUID());
    try { return await callback(); } finally { await release(); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (closing) return send(res, 503, { error: 'Dashboard is shutting down.' });
      if (req.headers.host !== new URL(origin).host) return send(res, 403, { error: 'Invalid host.' });
      if (req.headers.origin && req.headers.origin !== origin) return send(res, 403, { error: 'Invalid origin.' });
      const url = new URL(req.url, origin);
      const pathname = url.pathname;
      if (!pathname.startsWith('/api/')) {
        const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/file-editor.js': ['file-editor.js', 'text/javascript'], '/render-cache.js': ['render-cache.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
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
      if (req.method === 'PUT' && pathname === '/api/config') { const config = await body(req); await writeConfiguration(() => saveConfig(root, config)); return send(res, 200, { saved: true }); }
      if (req.method === 'GET' && pathname.startsWith('/api/runs/')) return send(res, 200, await readState(root, 'runs', `${safeName(pathname.split('/').at(-1))}.json`));
      if (req.method === 'PUT' && pathname === '/api/agent') { const agent = validateAgent(await body(req)); await writeConfiguration(() => writeState(root, 'agents', `${agent.name}.json`, agent)); return send(res, 200, agent); }
      if (req.method === 'GET' && pathname === '/api/memory') return send(res, 200, await listMemories(root, {
        agent: url.searchParams.get('agent') || undefined, layer: url.searchParams.get('layer') || undefined,
        status: url.searchParams.get('status') || 'all', offset: Number(url.searchParams.get('offset') || 0), limit: Number(url.searchParams.get('limit') || 50)
      }));
      if (req.method === 'POST' && pathname === '/api/memory') {
        const data = await body(req);
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['text', 'layer', 'category', 'scope', 'agent', 'expiresAt'].includes(key))) throw new Error('Unsupported memory field.');
        return send(res, 201, await remember(root, data));
      }
      if (req.method === 'GET' && pathname === '/api/memory/drafts') return send(res, 200, await listMemoryDrafts(root, { offset: Number(url.searchParams.get('offset') || 0), limit: Number(url.searchParams.get('limit') || 50) }));
      const reviewRoute = pathname.match(/^\/api\/memory\/drafts\/([^/]+)\/review$/);
      if (req.method === 'POST' && reviewRoute) {
        const { candidateId, decision, expectedRevision } = await body(req);
        return send(res, 200, await reviewMemoryDraft({ root, draftId: reviewRoute[1], candidateId, decision, expectedRevision }));
      }
      const memoryRoute = pathname.match(/^\/api\/memory\/([^/]+)(\/history)?$/);
      if (req.method === 'GET' && memoryRoute?.[2]) return send(res, 200, await memoryHistory(root, memoryRoute[1], { offset: Number(url.searchParams.get('offset') || 0), limit: Number(url.searchParams.get('limit') || 50) }));
      if (req.method === 'PATCH' && memoryRoute && !memoryRoute[2]) return send(res, 200, await updateMemory(root, memoryRoute[1], await body(req)));
      if (req.method === 'POST' && pathname === '/api/memory/index') return send(res, 200, await rebuildMemoryIndex(root));
      if (req.method === 'POST' && pathname === '/api/memory/search') {
        const data = await body(req), agent = data.agent ? await loadAgent(root, data.agent) : undefined;
        if (agent && !agent.memory) throw new Error('Memory is disabled for this agent.');
        return send(res, 200, await searchMemory(root, data.query, agent?.name, { mode: data.mode || 'hybrid', loadout: agent ? agent.memoryLoadout || {} : undefined }));
      }
      if (req.method === 'POST' && pathname === '/api/terminal/start') {
        if (terminalStarting || terminal?.exitCode === null) return send(res, 409, { error: 'Terminal is already running.' });
        terminalStarting = true;
        let finishStart;
        terminalStart = new Promise(resolve => { finishStart = resolve; });
        try {
        const pty = await import('node-pty');
        if (closing) throw new Error('Dashboard is shutting down.');
        const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
        const processPty = pty.spawn(shell, [], { name: 'xterm-256color', cwd: root, cols: 100, rows: 30, env: { ...commandEnvironment(), TERM: 'xterm-256color', NEXUS_WORKSPACE: root } });
        const session = { process: processPty, output: '', cursor: 0, exitCode: null };
        terminal = session;
        processPty.onData(data => { if (terminal !== session) return; session.output += data; if (session.output.length > 200000) { const cut = session.output.length - 150000; session.output = session.output.slice(cut); session.cursor += cut; } });
        processPty.onExit(({ exitCode }) => { session.exitCode = exitCode; });
        return send(res, 201, { running: true });
        } finally { terminalStarting = false; finishStart(); }
      }
      if (req.method === 'POST' && pathname === '/api/terminal/input') {
        if (!terminal || terminal.exitCode !== null) return send(res, 409, { error: 'Terminal is not running.' });
        const data = await body(req);
        if (typeof data.input !== 'string' || data.input.length > 10000) throw new Error('Terminal input must be under 10000 characters.');
        terminal.process.write(data.input); return send(res, 200, { accepted: data.input.length });
      }
      if (req.method === 'GET' && pathname === '/api/terminal/output') {
        if (!terminal) return send(res, 200, { running: false, output: '', cursor: 0, exitCode: null });
        const requested = Number(url.searchParams.get('cursor') || 0), start = Math.max(terminal.cursor, Number.isSafeInteger(requested) ? requested : 0);
        return send(res, 200, { running: terminal.exitCode === null, output: terminal.output.slice(start - terminal.cursor), cursor: terminal.cursor + terminal.output.length, exitCode: terminal.exitCode });
      }
      if (req.method === 'POST' && pathname === '/api/terminal/stop') {
        await terminalStart;
        if (terminal?.exitCode === null) terminal.process.kill(); terminal = undefined; return send(res, 200, { stopped: true });
      }
      if (req.method === 'POST' && pathname === '/api/approval') {
        const data = await body(req), approval = approvals.get(data.id);
        if (!approval || typeof data.allow !== 'boolean') return send(res, 404, { error: 'Approval expired or invalid.' });
        approval.resolve(data.allow); return send(res, 200, { resolved: true });
      }
      if (req.method === 'POST' && pathname === '/api/cancel') {
        const data = await body(req); jobs.get(data.id)?.controller.abort(new Error('Cancelled from dashboard.')); return send(res, 200, { cancelled: true });
      }
      if (req.method === 'POST' && (pathname === '/api/run' || pathname === '/api/memory/distill')) {
        const data = await body(req);
        const distill = pathname === '/api/memory/distill';
        if (!distill && (typeof data.task !== 'string' || !data.task.trim() || data.task.length > 30000)) throw new Error('Provide a task under 30000 characters.');
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
        if (distill) {
          const run = await readState(root, 'runs', `${safeName(data.runId)}.json`);
          if (run.status !== 'completed') throw new Error('Memory distillation requires a completed run.');
          const agent = await loadAgent(root, run.agent);
          const provider = data.demo === true ? undefined : await routeProvider(root, agent, { providerName: data.provider });
          execute = async () => {
            const draft = await draftMemory({ root, runId: data.runId, provider, demo: data.demo === true, approve, signal: controller.signal });
            job.events.push({ type: 'text', text: `Created ${draft.candidates.length} memory candidates. Review them in Memory.`, at: new Date().toISOString() });
            return { id: draft.id, status: 'completed' };
          };
        } else if (data.mode === 'plan') {
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
        if (closing) throw new Error('Dashboard is shutting down.');
        jobs.set(id, job);
        const execution = execute().then(result => { job.status = result.status; job.result = result.id; if (result.workflow) job.plan = result.workflow; }).catch(error => { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; });
        executions.add(execution);
        void execution.finally(() => executions.delete(execution));
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
  let closePromise;
  return { server, token, url: `${origin}/#${token}`, close() {
    return closePromise ||= (async () => {
      closing = true;
      for (const job of jobs.values()) job.controller.abort();
      for (const approval of approvals.values()) approval.resolve(false);
      await terminalStart;
      if (terminal?.exitCode === null) terminal.process.kill();
      terminal = undefined;
      await new Promise(resolve => server.close(resolve));
      // Drain requests that were preparing an execution when shutdown began.
      for (const job of jobs.values()) job.controller.abort();
      await Promise.allSettled([...executions]);
    })();
  } };
}
