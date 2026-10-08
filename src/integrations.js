import os from 'node:os';
import path from 'node:path';
import { access, mkdir, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './config.js';
import { loadAgent } from './agents.js';
import { writeState } from './state.js';
import { runProcess } from './process.js';
import { acquireWorkspace } from './locks.js';
import { randomUUID } from 'node:crypto';

const runner = fileURLToPath(new URL('./integration-runner.js', import.meta.url));
const catalog = {
  tradingagents: {
    source: 'https://github.com/TauricResearch/TradingAgents.git',
    agent: 'market-researcher',
    revision: '1394a3f72aa4393e1a98f51b382434c4b4c2d972',
    executable: root => path.join(root, '.venv', 'bin', 'tradingagents'),
    envKeys: ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'ZHIPU_API_KEY', 'OPENROUTER_API_KEY', 'ALPHA_VANTAGE_API_KEY', 'OLLAMA_BASE_URL', 'TRADINGAGENTS_LLM_PROVIDER', 'TRADINGAGENTS_QUICK_THINK_LLM', 'TRADINGAGENTS_DEEP_THINK_LLM', 'TRADINGAGENTS_OUTPUT_LANGUAGE', 'TRADINGAGENTS_MAX_DEBATE_ROUNDS', 'TRADINGAGENTS_MAX_RISK_ROUNDS', 'TRADINGAGENTS_MAX_TOOL_ROUNDS'],
    timeoutMs: 1_800_000,
  },
  openmontage: {
    source: 'https://github.com/calesthio/OpenMontage.git',
    agent: 'production-planner',
    revision: '9327439db69021ab4b0e2776729bf3b58fdb5a87',
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

export async function integrationStatus(name, { runtimeRoot } = {}) {
  const definition = Object.hasOwn(catalog, name) && catalog[name];
  if (!definition) throw new Error(`Unknown integration: ${name}`);
  const root = runtimeRoot || integrationRoot(name);
  let revision = null, origin = null;
  for (const entry of [root, path.join(root, '.git'), path.join(root, '.venv')]) {
    try { if ((await lstat(entry)).isSymbolicLink()) throw new Error('Managed runtime directories cannot be symbolic links.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (await exists(path.join(root, '.git'))) {
    const result = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 10_000 });
    if (result.code === 0) revision = result.output.trim();
    const remote = await runProcess('git', ['remote', 'get-url', 'origin'], { cwd: root, timeoutMs: 10_000 });
    if (remote.code === 0) origin = remote.output.trim();
  }
  const sourceVerified = origin === definition.source && revision === definition.revision;
  const executableAvailable = await exists(definition.executable(root), constants.X_OK);
  return { name, root, source: definition.source, cloned: Boolean(revision), revision, expectedRevision: definition.revision, origin, sourceVerified, executableAvailable, ready: process.platform !== 'win32' && sourceVerified && executableAvailable, executable: definition.executable(root), liveVerified: false };
}

export async function listIntegrationStatus() {
  return Promise.all(Object.keys(catalog).map(integrationStatus));
}

export async function installIntegration(name) {
  const definition = Object.hasOwn(catalog, name) && catalog[name];
  if (!definition) throw new Error(`Unknown integration: ${name}`);
  if (process.platform === 'win32') throw new Error('Managed runtime installation currently supports macOS/Linux only.');
  const root = integrationRoot(name);
  const existing = await integrationStatus(name);
  if (existing.cloned && !existing.sourceVerified) throw new Error('Existing runtime source/revision differs from the reviewed pin. It was left unchanged; inspect it manually.');
  if (existing.ready) return existing;
  await mkdir(path.dirname(root), { recursive: true });
  if (!await exists(path.join(root, '.git'))) {
    const clone = await runProcess('git', ['clone', '--no-checkout', '--filter=blob:none', definition.source, root], { cwd: path.dirname(root), timeoutMs: 300_000, maxBytes: 1_000_000 });
    if (clone.code !== 0 || clone.stopped) throw new Error(`Clone failed: ${clone.output.trim() || clone.stopped}`);
    const checkout = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', definition.revision], { cwd: root, timeoutMs: 300_000, maxBytes: 1_000_000 });
    if (checkout.code !== 0 || checkout.stopped) throw new Error('Could not check out the reviewed runtime revision. No installer was run.');
  }
  if (!(await integrationStatus(name)).sourceVerified) throw new Error('Runtime source verification failed. No installer was run.');
  if (await exists(path.join(root, '.venv'))) throw new Error('An incomplete environment already exists. It was left unchanged; inspect/repair it manually rather than reinstalling over it.');
  const steps = name === 'tradingagents'
    ? [['uv', ['venv', '--python', '3.13', '.venv']], ['uv', ['pip', 'install', '--python', '.venv/bin/python', '.']]]
    : [['make', ['setup', 'PYTHON_VERSION=3.13']]];
  for (const [command, args] of steps) {
    const result = await runProcess(command, args, { cwd: root, timeoutMs: 3_600_000, maxBytes: 2_000_000 });
    if (result.code !== 0 || result.stopped) throw new Error(`Setup failed: ${result.output.trim() || result.stopped}`);
  }
  return integrationStatus(name);
}

export async function configureIntegration(projectRoot, name, options = {}) {
  const definition = Object.hasOwn(catalog, name) && catalog[name];
  if (!definition) throw new Error(`Unknown integration: ${name}`);
  const status = await integrationStatus(name, options);
  if (!status.ready) throw new Error(`${name} is not installed. Run nexus integration install ${name}.`);
  const release = await acquireWorkspace(projectRoot, projectRoot, randomUUID());
  try {
  const config = await loadConfig(projectRoot);
  const agent = await loadAgent(projectRoot, definition.agent);
  const before = structuredClone(config);
  config.applications ||= {};
  const profile = {
    command: process.execPath,
    args: [runner, name, await realpath(status.root)],
    cwd: await realpath(status.root),
    envKeys: definition.envKeys,
    timeoutMs: definition.timeoutMs,
  };
  if (Object.hasOwn(config.applications, name) && JSON.stringify(config.applications[name]) !== JSON.stringify(profile)) throw new Error('An application profile with this name already exists. Review it manually; it was not overwritten.');
  config.applications[name] = profile;
  await saveConfig(projectRoot, config);
  agent.permissions.execute = true;
  agent.applications = [...new Set([...(agent.applications || []), name])];
  try { await writeState(projectRoot, 'agents', `${agent.name}.json`, agent); }
  catch (error) { await saveConfig(projectRoot, before); throw error; }
  return { ...status, configured: true, agent: agent.name };
  } finally { await release(); }
}
