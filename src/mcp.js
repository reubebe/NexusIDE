import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { commandEnvironment } from './process.js';
import { loadConfig } from './config.js';
import { extractMcpArtifacts } from './artifacts.js';
import { version } from './version.js';

export async function connectMcp(root, agent, approve, signal, workspaceRoot = root, runId) {
  const config = await loadConfig(root);
  const clients = [], tools = [], routes = new Map();
  const close = async () => { await Promise.allSettled(clients.map(c => c.close())); };
  try {
    for (const name of agent.mcp || []) {
      signal?.throwIfAborted();
      const server = Object.hasOwn(config.mcp, name) ? config.mcp[name] : undefined;
      if (!server) throw new Error(`Missing MCP configuration: ${name}`);
      if (!await approve({ type: 'mcp-connect', name, transport: server.transport || 'stdio', url: server.url, keyEnv: server.keyEnv, command: server.command, args: server.args, cwd: workspaceRoot, envKeys: server.envKeys || [] })) throw new Error(`MCP connection declined: ${name}`);
      signal?.throwIfAborted();
      const env = commandEnvironment();
      for (const key of server.envKeys || []) { if (typeof key !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error('Invalid MCP environment key.'); if (process.env[key]) env[key] = process.env[key]; }
      const transport = server.transport === 'http'
        ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.keyEnv && process.env[server.keyEnv] ? { Authorization: `Bearer ${process.env[server.keyEnv]}` } : {}, redirect: 'error' }, fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }) })
        : new StdioClientTransport({ command: server.command, args: server.args, cwd: workspaceRoot, env, stderr: 'pipe', maxBufferSize: 10_000_000 });
      transport.stderr?.on('data', () => {});
      const client = new Client({ name: 'nexuside', version });
      clients.push(client);
      await client.connect(transport, { timeout: 15000, signal });
      let cursor;
      for (let page = 0; page < 10; page++) {
        const list = await client.listTools(cursor ? { cursor } : {}, { timeout: 15000, signal });
        for (const tool of list.tools) {
          if (!server.tools.includes(tool.name)) continue;
          if (tools.length >= 64) throw new Error('Too many granted MCP tools; limit each run to 64.');
          const alias = `mcp_${name.replaceAll('-', '_').slice(0, 48)}_${tools.length}`;
          tools.push({ name: alias, description: `[${name}/${tool.name}] ${tool.description || ''}`.slice(0, 2000), parameters: tool.inputSchema });
          routes.set(alias, { client, server: name, name: tool.name });
        }
        cursor = list.nextCursor;
        if (!cursor) break;
      }
    }
    return { tools, close, async call(alias, args) {
      const route = routes.get(alias);
      if (!route) throw new Error('MCP tool not granted.');
      if (!await approve({ type: 'mcp-call', server: route.server, tool: route.name, args })) return 'MCP call declined.';
      signal?.throwIfAborted();
      const raw = await route.client.callTool({ name: route.name, arguments: args }, undefined, { timeout: 60000, signal });
      const result = await extractMcpArtifacts(root, raw, { source: `${route.server}/${route.name}`, runId });
      const serialized = JSON.stringify(result);
      if (serialized.length <= 100000) return serialized;
      // Keep the failure flag outside the preview so truncation cannot hide an
      // error from the model or the runtime's repeated-tool-failure guard.
      const truncated = { isError: result.isError === true, truncated: true, warning: 'MCP result exceeded 100000 characters; request a narrower result.', preview: serialized.slice(0, 90000) };
      const bounded = JSON.stringify(truncated);
      if (bounded.length <= 100000) return bounded;
      // Serializing a JSON preview escapes it again. Removing at least the
      // overflow in characters also removes at least that many encoded chars.
      truncated.preview = truncated.preview.slice(0, Math.max(0, truncated.preview.length - (bounded.length - 100000)));
      return JSON.stringify(truncated);
    } };
  } catch (e) { await close(); throw e; }
}
