import os from 'node:os';
import path from 'node:path';
import { access, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './config.js';
import { loadAgent } from './agents.js';
import { writeState } from './state.js';
import { runProcess } from './process.js';

const runner = fileURLToPath(new URL('./integration-runner.js', import.meta.url));
const catalog = {
  tradingagents: {
    source: 'https://github.com/TauricResearch/TradingAgents.git',
    agent: 'market-researcher',
    revision: null,
    executable: root => path.join(root, '.venv', 'bin', 'tradingagents'),
    envKeys: ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'ZHIPU_API_KEY', 'OPENROUTER_API_KEY', 'ALPHA_VANTAGE_API_KEY', 'OLLAMA_BASE_URL', 'TRADINGAGENTS_LLM_PROVIDER', 'TRADINGAGENTS_QUICK_THINK_LLM', 'TRADINGAGENTS_DEEP_THINK_LLM', 'TRADINGAGENTS_OUTPUT_LANGUAGE', 'TRADINGAGENTS_MAX_DEBATE_ROUNDS', 'TRADINGAGENTS_MAX_RISK_ROUNDS', 'TRADINGAGENTS_MAX_TOOL_ROUNDS'],
    timeoutMs: 1_800_000,
  },
  openmontage: {
    source: 'https://github.com/calesthio/OpenMontage.git',
    agent: 'production-planner',
    revision: null,
    executable: root => path.join(root, '.venv', 'bin', 'python'),
    envKeys: ['FAL_KEY', 'PEXELS_API_KEY', 'PIXABAY_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_API_KEY'],
    timeoutMs: 3_600_000,
  },
};

export function integrationRoot(name) {
  if (!Object.hasOwn(catalog, name)) throw new Error(`Unknown integration: ${name}`);
  const data = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32'
      ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(data, 'NexusIDE', 'runtimes', name);
}

async function exists(file, mode = constants.F_OK) { try { await access(file, mode); return true; } catch { return false; } }

export async function integrationStatus(name) {
  const definition = catalog[name];
  if (!definition) throw new Error(`Unknown integration: ${name}`);
  const root = integrationRoot(name);
  let revision = null;
  if (await exists(path.join(root, '.git'))) {
    const result = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 10_000 });
    if (result.code === 0) revision = result.output.trim();
  }
  return { name, root, source: definition.source, cloned: Boolean(revision), revision, ready: await exists(definition.executable(root), constants.X_OK), executable: definition.executable(root) };
}

export async function listIntegrationStatus() {
  return Promise.all(Object.keys(catalog).map(integrationStatus));
}

export async function installIntegration(name) {
  const definition = catalog[name];
  if (!definition) throw new Error(`Unknown integration: ${name}`);
  const root = integrationRoot(name);
  await mkdir(path.dirname(root), { recursive: true });
  if (!await exists(path.join(root, '.git'))) {
    const clone = await runProcess('git', ['clone', '--filter=blob:none', definition.source, root], { cwd: path.dirname(root), timeoutMs: 300_000, maxBytes: 1_000_000 });
    if (clone.code !== 0 || clone.stopped) throw new Error(`Clone failed: ${clone.output.trim() || clone.stopped}`);
  }
  const steps = name === 'tradingagents'
    ? [['uv', ['venv', '--python', '3.13', '.venv']], ['uv', ['pip', 'install', '--python', '.venv/bin/python', '.']]]
    : [['make', ['setup', 'PYTHON_VERSION=3.13']]];
  for (const [command, args] of steps) {
    const result = await runProcess(command, args, { cwd: root, timeoutMs: 3_600_000, maxBytes: 2_000_000 });
    if (result.code !== 0 || result.stopped) throw new Error(`Setup failed: ${result.output.trim() || result.stopped}`);
  }
  return integrationStatus(name);
}

export async function configureIntegration(projectRoot, name) {
  const definition = catalog[name];
  if (!definition) throw new Error(`Unknown integration: ${name}`);
  const status = await integrationStatus(name);
  if (!status.ready) throw new Error(`${name} is not installed. Run nexus integration install ${name}.`);
  const config = await loadConfig(projectRoot);
  config.applications ||= {};
  config.applications[name] = {
    command: process.execPath,
    args: [runner, name, await realpath(status.root)],
    cwd: await realpath(status.root),
    envKeys: definition.envKeys,
    timeoutMs: definition.timeoutMs,
  };
  await saveConfig(projectRoot, config);
  const agent = await loadAgent(projectRoot, definition.agent);
  agent.permissions.execute = true;
  agent.applications = [...new Set([...(agent.applications || []), name])];
  await writeState(projectRoot, 'agents', `${agent.name}.json`, agent);
  return { ...status, configured: true, agent: agent.name };
}
