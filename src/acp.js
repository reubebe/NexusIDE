import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listAgents, loadAgent } from './agents.js';
import { loadConfig, routeProvider } from './config.js';
import { runAgent } from './runtime.js';

export async function startAcp({ demo = false, allowCommands = false, input = process.stdin, output = process.stdout } = {}) {
  const sessions = new Map();
  let initialized = false;
  const connection = new AgentSideConnection(conn => ({
    async initialize() {
      initialized = true;
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } }, agentInfo: { name: 'nexuside', title: 'NexusIDE', version: '0.2.0' }, authMethods: [] };
    },
    async authenticate() { return {}; },
    async newSession(params) {
      if (!initialized) throw new Error('Initialize the connection first.');
      if (!path.isAbsolute(params.cwd)) throw new Error('Session cwd must be absolute.');
      if (params.mcpServers?.length || params.additionalDirectories?.length) throw new Error('Configure MCP grants in NexusIDE. Additional directory grants are not supported.');
      if (sessions.size >= 50) throw new Error('Session limit reached; restart the bridge.');
      const root = await realpath(params.cwd), agents = await listAgents(root);
      if (!agents.length) throw new Error('Run nexus init in this project first.');
      const id = randomUUID(), mode = agents.find(a => a.name === 'architect')?.name || agents[0].name;
      sessions.set(id, { root, mode, lastRuns: new Map(), controller: null });
      return { sessionId: id, modes: { currentModeId: mode, availableModes: agents.map(a => ({ id: a.name, name: a.name, description: a.instructions.slice(0, 150) })) } };
    },
    async setSessionMode({ sessionId, modeId }) {
      const session = sessions.get(sessionId);
      if (!session || session.controller) throw new Error('Session missing or busy.');
      await loadAgent(session.root, modeId); session.mode = modeId; return {};
    },
    async prompt({ sessionId, prompt }) {
      const session = sessions.get(sessionId);
      if (!session || session.controller) throw new Error('Session missing or busy.');
      if (!prompt.length || prompt.some(c => c.type !== 'text')) throw new Error('This bridge accepts text prompts only.');
      const controller = new AbortController(); session.controller = controller;
      let updates = Promise.resolve(), updateError;
      const update = content => { updates = updates.then(() => conn.sessionUpdate({ sessionId, update: content })).catch(e => { updateError = e; controller.abort(e); }); };
      const approve = async request => {
        controller.signal.throwIfAborted();
        const permission = conn.requestPermission({ sessionId, toolCall: { toolCallId: randomUUID(), title: request.type || 'Write project file', kind: request.type === 'command' || request.type === 'application' ? 'execute' : 'other', status: 'pending', rawInput: request, content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(request, null, 2) } }] }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Decline', kind: 'reject_once' }] });
        let timer, abort;
        const cancelled = new Promise(resolve => { abort = () => resolve({ outcome: { outcome: 'cancelled' } }); controller.signal.addEventListener('abort', abort, { once: true }); timer = setTimeout(abort, 300000); if (controller.signal.aborted) abort(); });
        try { const response = await Promise.race([permission, cancelled]); return response.outcome.outcome === 'selected' && response.outcome.optionId === 'allow'; }
        finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
      };
      try {
        const agent = await loadAgent(session.root, session.mode);
        agent.permissions.execute = agent.permissions.execute === true && allowCommands;
        const config = await loadConfig(session.root);
        const run = await runAgent({ root: session.root, agent, task: prompt.map(c => c.text).join('\n'), provider: await routeProvider(session.root, agent, { demo }), resume: session.lastRuns.get(agent.name), approve, signal: controller.signal, maxSteps: config.limits?.maxSteps || 20, maxContextChars: config.limits?.maxContextChars || 160000, onEvent: event => {
          if (event.type === 'text') update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } });
          else if (event.type === 'tool') update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\nUsing ${event.name}…\n` } });
        } });
        session.lastRuns.set(agent.name, run.id);
        await updates; if (updateError) throw updateError;
        return { stopReason: 'end_turn' };
      } catch (e) {
        await updates;
        if (controller.signal.aborted) return { stopReason: 'cancelled' };
        throw e;
      } finally { session.controller = null; }
    },
    async cancel({ sessionId }) { sessions.get(sessionId)?.controller?.abort(new Error('Editor cancelled the run.')); }
  }), ndJsonStream(Writable.toWeb(output), Readable.toWeb(input)));
  await connection.closed;
  for (const session of sessions.values()) session.controller?.abort(new Error('Editor disconnected.'));
}
