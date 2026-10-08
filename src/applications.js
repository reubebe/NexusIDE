import { loadConfig } from './config.js';
import { commandEnvironment, runProcess } from './process.js';
import { realpath } from 'node:fs/promises';

export async function runApplication(root, agent, name, args, approve, signal) {
  if (!agent.permissions?.execute || !agent.applications?.includes(name)) throw new Error('Application execution not granted to this agent.');
  if (!Array.isArray(args) || args.length > 100 || args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 10000)) throw new Error('Application arguments must be a bounded string array.');
  const config = await loadConfig(root);
  const app = config.applications?.[name];
  if (!app) throw new Error(`Application is not configured: ${name}`);
  const cwd = await realpath(app.cwd || root);
  const argv = [...app.args, ...args];
  if (!await approve({ type: 'application', name, command: app.command, args: argv, cwd, envKeys: app.envKeys || [], timeoutMs: app.timeoutMs || 60000 })) return 'Application declined.';
  signal?.throwIfAborted();
  const env = commandEnvironment();
  for (const key of app.envKeys || []) { if (process.env[key]) env[key] = process.env[key]; }
  const result = await runProcess(app.command, argv, { cwd, env, signal, timeoutMs: app.timeoutMs || 60000, maxBytes: 100000 });
  return JSON.stringify(result);
}
