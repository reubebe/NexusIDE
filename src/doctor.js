import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { listAgents } from './agents.js';
import { listSkills } from './skills.js';
import { runProcess } from './process.js';
import { readState } from './state.js';

const verificationNames = ['local-model', 'docker', 'vscode', 'desktop', 'dashboard-visual', 'semantic-memory', 'codegraph', 'codegraph-project', 'research-harness', 'research-evidence', 'tradingagents', 'openmontage'];
export async function verificationHistory(root) {
  return (await Promise.all(verificationNames.map(async name => {
    try {
      const receipt = await readState(root, 'verification', `${name}.json`, null);
      if (!receipt) return null;
      const legacyHarness = name === 'research-harness' && receipt.kind === 'live-local-mcp'
        && typeof receipt.verified === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(receipt.verified)
        && Number.isFinite(Date.parse(receipt.verified)) && receipt.result?.isError === false;
      return { name, recordedSuccess: receipt.verified === true || legacyHarness, at: typeof receipt.at === 'string' ? receipt.at.slice(0, 64) : legacyHarness ? receipt.verified.slice(0, 64) : null,
        checks: Array.isArray(receipt.checks) ? receipt.checks.filter(x => typeof x === 'string').slice(0, 30).map(x => x.slice(0, 160)) : [],
        receipt: `.nexus/verification/${name}.json` };
    } catch { return { name, recordedSuccess: false, unreadable: true }; }
  }))).filter(Boolean);
}
export async function executableAvailable(command) {
  if (typeof command !== 'string' || !command) return false;
  const candidates = command.includes(path.sep) ? [command] : (process.env.PATH || '').split(path.delimiter).map(p => path.join(p, command));
  for (const file of candidates) { try { await access(file, constants.X_OK); return true; } catch {} }
  return false;
}
export async function doctor(root) {
  const config = await loadConfig(root), agents = await listAgents(root), skills = await listSkills(root);
  const connections = [];
  for (const [name, profile] of Object.entries(config.providers)) connections.push({ name, kind: 'provider', configured: true, credentialAvailable: profile.keySecret ? Boolean(process.env.NEXUS_VAULT_PASSWORD) : profile.keyEnv ? Boolean(process.env[profile.keyEnv]) : null, liveVerified: false });
  for (const [name, profile] of Object.entries({ ...config.mcp, ...config.applications })) {
    const application = Object.hasOwn(config.applications || {}, name);
    const granted = [...(profile.envKeys || []), ...(profile.keyEnv ? [profile.keyEnv] : [])];
    connections.push({ name, kind: application ? 'application' : 'mcp', ...(profile.transport === 'http' ? { endpoint: profile.url } : { executableAvailable: await executableAvailable(profile.command) }),
      ...(application ? { availableEnvironment: granted.filter(k => process.env[k]) } : { missingEnvironment: granted.filter(k => !process.env[k]) }), liveVerified: false });
  }
  const missingSkills = agents.flatMap(a => (a.skills || []).filter(s => !skills.some(x => x.name === s)).map(skill => ({ agent: a.name, skill })));
  let docker = 'not-installed';
  if (await executableAvailable('docker')) { const result = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], { cwd: root, timeoutMs: 3000 }); docker = result.code === 0 && /^\d+\.\d+\.\d+[\w.+-]*$/.test(result.output.trim()) ? `running: ${result.output.trim()}` : 'daemon-unavailable'; }
  return { node: process.version, root, agents: agents.length, skills: skills.length, missingSkills, docker, connections,
    embeddings: config.embeddings ? { configured: true, model: config.embeddings.model, liveVerified: false } : { configured: false },
    verificationHistory: await verificationHistory(root),
    notes: ['Executable availability does not prove integration compatibility.', 'Doctor does not call model APIs or start external MCP/application servers.', 'Verification history is locally recorded evidence from earlier checks, not a fresh check or proof that current configuration is unchanged.'] };
}
