#!/usr/bin/env node
import path from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { withIntegrationRuntime } from './integrations.js';

const [name, root, ...args] = process.argv.slice(2);
if (!['tradingagents', 'openmontage'].includes(name) || typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw new Error('Invalid integration invocation.');

let command, argv;
if (name === 'tradingagents') {
  const allowed = new Set(['--ticker', '--date', '--analysts', '--save', '--no-save', '--show', '--no-show', '--html', '--no-html', '--help']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Unsupported TradingAgents argument: ${args[i]}`);
    if (['--ticker', '--date', '--analysts'].includes(args[i]) && (args[++i] === undefined || args[i].startsWith('--'))) throw new Error('TradingAgents option needs a value.');
  }
  command = path.join(root, '.venv', 'bin', 'tradingagents'); argv = args;
} else {
  const [action = 'preflight', value] = args;
  command = path.join(root, '.venv', 'bin', 'python');
  if (action === 'preflight' && (args.length === 0 || args.length === 1)) argv = ['-c', "from tools.tool_registry import registry; import json; registry.discover(); print(json.dumps(registry.provider_menu(), indent=2))"];
  else if (action === 'demo-list' && args.length === 1) argv = ['render_demo.py', '--list'];
  else if (action === 'demo' && args.length === 2 && ['code-to-screen', 'focusflow-pitch', 'world-in-numbers'].includes(value)) argv = ['render_demo.py', value];
  else if (action === 'backlot' && args.length <= 2 && (!value || /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))) argv = ['-m', 'backlot', 'open', ...(value ? [value] : [])];
  else if (action === 'simulate' && args.length === 1) argv = ['scripts/backlot_simulate_run.py'];
  else throw new Error('OpenMontage actions: preflight, demo-list, demo <name>, backlot [project-id], simulate.');
}

// Argument validation above is deliberately before runtime discovery. The lease
// prevents upgrades/uninstall while an approved invocation uses the active version.
const result = await withIntegrationRuntime(name, { runtimeRoot: root }, async (status, trackChild) => {
  command = path.join(status.root, '.venv', 'bin', name === 'tradingagents' ? 'tradingagents' : 'python');
  await access(command, constants.X_OK);
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: status.root, env: process.env, shell: false, stdio: 'inherit' });
    let registration = Promise.resolve(), failure;
    const stop = () => child.kill('SIGTERM');
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    child.once('spawn', () => { registration = trackChild(child.pid).catch(error => { failure = error; stop(); }); });
    child.once('error', error => { failure = error; });
    child.once('close', async (code, signal) => {
      process.off('SIGTERM', stop); process.off('SIGINT', stop);
      await registration;
      if (failure) reject(failure); else resolve(signal ? 1 : (code ?? 1));
    });
  });
});
process.exitCode = result;
