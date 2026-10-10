import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './config.js';
import { loadAgent } from './agents.js';
import { writeState, readState, deleteState } from './state.js';
import { acquireWorkspace } from './locks.js';
import { randomUUID } from 'node:crypto';
import { createIntegrationLifecycle } from './integration-lifecycle.js';

const runner = fileURLToPath(new URL('./integration-runner.js', import.meta.url));
const catalog = {
  tradingagents: {
    source: 'https://github.com/TauricResearch/TradingAgents.git',
    agent: 'market-researcher',
    revision: '1394a3f72aa4393e1a98f51b382434c4b4c2d972',
    executable: root => path.join(root, '.venv', 'bin', 'tradingagents'),
    envKeys: ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'ZHIPU_API_KEY', 'OPENROUTER_API_KEY', 'ALPHA_VANTAGE_API_KEY', 'OLLAMA_BASE_URL', 'TRADINGAGENTS_LLM_PROVIDER', 'TRADINGAGENTS_QUICK_THINK_LLM', 'TRADINGAGENTS_DEEP_THINK_LLM', 'TRADINGAGENTS_OUTPUT_LANGUAGE', 'TRADINGAGENTS_MAX_DEBATE_ROUNDS', 'TRADINGAGENTS_MAX_RISK_ROUNDS', 'TRADINGAGENTS_MAX_TOOL_ROUNDS'],
    timeoutMs: 1_800_000,
    steps: [['uv', ['venv', '--python', '3.13', '.venv']], ['uv', ['pip', 'install', '--python', '.venv/bin/python', '.']]],
  },
  openmontage: {
    source: 'https://github.com/calesthio/OpenMontage.git',
    agent: 'production-planner',
    revision: '9327439db69021ab4b0e2776729bf3b58fdb5a87',
    executable: root => path.join(root, '.venv', 'bin', 'python'),
    envKeys: ['FAL_KEY', 'PEXELS_API_KEY', 'PIXABAY_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_API_KEY'],
    timeoutMs: 3_600_000,
    steps: [['make', ['setup', 'PYTHON_VERSION=3.13']]],
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

const lifecycle = createIntegrationLifecycle({ definitions: catalog, rootFor: integrationRoot });
export async function integrationStatus(name, options) {
  const status = await lifecycle.status(name, options);
  const definition = catalog[name];
  return { ...status, requestedGrants: { agent: definition.agent, execute: true, environmentKeys: definition.envKeys } };
}
export const installIntegration = lifecycle.install;
export const upgradeIntegration = lifecycle.upgrade;
export const rollbackIntegration = lifecycle.rollback;
export const uninstallIntegration = lifecycle.uninstall;
export const recoverIntegration = lifecycle.recover;
export const withIntegrationRuntime = lifecycle.run;

export async function listIntegrationStatus() {
  return Promise.all(Object.keys(catalog).map(name => integrationStatus(name)));
}

function validateGrant(receipt, name, agent) {
  if (receipt === null) return;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.version !== 1 || receipt.name !== name || receipt.agent !== agent || !['preparing', 'configured', 'revoking'].includes(receipt.state) || typeof receipt.executionGranted !== 'boolean' || ![true, false, null].includes(receipt.previousExecute) ||
      (receipt.profile !== null && (!receipt.profile || typeof receipt.profile !== 'object' || Array.isArray(receipt.profile))) || (receipt.state === 'configured' && receipt.profile === null)) throw new Error('Invalid integration grant receipt; no configuration was changed.');
}

// Internal injectable boundary for isolated grant transaction tests; public
// commands always use the reviewed catalog and verified lifecycle above.
export function createIntegrationConfigurator({ definitions = catalog, statusFor = integrationStatus } = {}) {
async function configureIntegration(projectRoot, name, options = {}) {
  const definition = Object.hasOwn(definitions, name) && definitions[name];
  if (!definition) throw new Error(`Unknown integration: ${name}`);
  const status = await statusFor(name, options);
  if (!status.ready) throw new Error(`${name} is not installed or verified. ${status.diagnostic}`);
  if (options.confirm !== true) throw new Error('Configuration requires explicit confirmation: the agent receives execution access and the application may receive its listed environment credentials.');
  const release = await acquireWorkspace(projectRoot, projectRoot, randomUUID());
  try {
  const config = await loadConfig(projectRoot);
  const agent = await loadAgent(projectRoot, definition.agent);
  const before = structuredClone(config);
  const beforeAgent = structuredClone(agent);
  const receipt = await readState(projectRoot, 'integration-grants', `${name}.json`, null);
  validateGrant(receipt, name, definition.agent);
  if (receipt && receipt.state !== 'configured') throw new Error('An incomplete integration grant exists. Run nexus integration unconfigure to revoke it safely before configuring again.');
  config.applications ||= {};
  const profile = {
    command: process.execPath,
    args: [runner, name, status.managedRoot],
    // The launcher resolves the active immutable version. Its bootstrap cwd
    // must exist even when the legacy root was never installed or is disabled.
    cwd: path.dirname(status.managedRoot),
    envKeys: definition.envKeys,
    timeoutMs: definition.timeoutMs,
  };
  const old = config.applications[name];
  const same = value => JSON.stringify(value) === JSON.stringify(profile);
  const legacyManaged = old?.command === process.execPath && old.args?.length === 3 && old.args[0] === runner && old.args[1] === name && old.args[2] === status.managedRoot && old.cwd === status.managedRoot && JSON.stringify(old.envKeys) === JSON.stringify(definition.envKeys) && old.timeoutMs === definition.timeoutMs;
  if (old && !same(old) && !legacyManaged && JSON.stringify(old) !== JSON.stringify(receipt?.profile)) throw new Error('An application profile with this name already exists or was modified. Review it manually; it was not overwritten.');
  const grant = { version: 1, name, state: 'preparing', agent: agent.name, profile, previousExecute: receipt ? receipt.previousExecute : agent.permissions.execute ?? null, executionGranted: receipt ? receipt.executionGranted : agent.permissions.execute !== true };
  await writeState(projectRoot, 'integration-grants', `${name}.json`, grant);
  config.applications[name] = profile;
  agent.permissions.execute = true;
  agent.applications = [...new Set([...(agent.applications || []), name])];
  try {
    await saveConfig(projectRoot, config);
    await writeState(projectRoot, 'agents', `${agent.name}.json`, agent);
    await writeState(projectRoot, 'integration-grants', `${name}.json`, { ...grant, state: 'configured' });
  } catch (error) {
    await saveConfig(projectRoot, before);
    await writeState(projectRoot, 'agents', `${agent.name}.json`, beforeAgent);
    if (receipt) await writeState(projectRoot, 'integration-grants', `${name}.json`, receipt);
    else await deleteState(projectRoot, 'integration-grants', `${name}.json`);
    throw error;
  }
  return { ...status, configured: true, agent: agent.name, grants: { execute: true, application: name, environmentKeys: definition.envKeys }, note: 'Application invocations still require the existing execution approval. Credential values were not copied into configuration.' };
  } finally { await release(); }
}

async function unconfigureIntegration(projectRoot, name, options = {}) {
  const definition = Object.hasOwn(definitions, name) && definitions[name];
  if (!definition) throw new Error(`Unknown integration: ${name}`);
  if (options.confirm !== true) throw new Error('Unconfiguration requires explicit confirmation.');
  const release = await acquireWorkspace(projectRoot, projectRoot, randomUUID());
  try {
    const config = await loadConfig(projectRoot), agent = await loadAgent(projectRoot, definition.agent);
    const receipt = await readState(projectRoot, 'integration-grants', `${name}.json`, null);
    const existing = config.applications?.[name];
    validateGrant(receipt, name, definition.agent);
    const managed = existing?.args?.length === 3 && existing.args[0] === runner && existing.args[1] === name && path.isAbsolute(existing.args[2]) && existing.command === process.execPath;
    if (existing && !(receipt ? JSON.stringify(existing) === JSON.stringify(receipt.profile) : managed)) throw new Error('Application profile changed since configuration; no user configuration was removed.');
    const before = structuredClone(config), beforeAgent = structuredClone(agent);
    const journal = receipt || { version: 1, name, agent: agent.name, profile: existing ?? null, executionGranted: false, previousExecute: agent.permissions.execute ?? null };
    await writeState(projectRoot, 'integration-grants', `${name}.json`, { ...journal, state: 'revoking' });
    if (config.applications) delete config.applications[name];
    agent.applications = (agent.applications || []).filter(value => value !== name);
    let executionRestored = false;
    if (journal.executionGranted && agent.permissions.execute === true && agent.applications.length === 0) {
      if (journal.previousExecute === null) delete agent.permissions.execute;
      else agent.permissions.execute = journal.previousExecute;
      executionRestored = true;
    }
    try {
      await saveConfig(projectRoot, config);
      await writeState(projectRoot, 'agents', `${agent.name}.json`, agent);
      await deleteState(projectRoot, 'integration-grants', `${name}.json`);
    } catch (error) {
      await saveConfig(projectRoot, before); await writeState(projectRoot, 'agents', `${agent.name}.json`, beforeAgent);
      if (receipt) await writeState(projectRoot, 'integration-grants', `${name}.json`, receipt);
      else await deleteState(projectRoot, 'integration-grants', `${name}.json`).catch(() => {});
      throw error;
    }
    return { name, configured: false, agent: agent.name, executionRestored, note: 'Named application and agent membership removed. Other applications, credentials and runtime files were preserved.' };
  } finally { await release(); }
}
return { configureIntegration, unconfigureIntegration };
}
export const { configureIntegration, unconfigureIntegration } = createIntegrationConfigurator();
