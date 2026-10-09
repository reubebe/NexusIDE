import { readState, writeState, safeName } from './state.js';
import { createProvider, validateProviderOptions } from './providers.js';
import { getSecret } from './vault.js';
import { validateEmbedding } from './embedding-config.js';

export const defaultConfig = { version: 1, providers: {}, routes: {}, limits: { maxSteps: 20, maxContextChars: 160000 }, mcp: {} };
export async function loadConfig(root) { return validateConfig(await readState(root, 'config', 'project.json', structuredClone(defaultConfig))); }
export function validateConfig(config) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(config) || config.version !== 1 || !object(config.providers) || !object(config.routes) || !object(config.mcp)) throw new Error('Invalid project configuration.');
  if (Object.keys(config).some(k => !['version', 'providers', 'routes', 'limits', 'mcp', 'applications', 'embeddings'].includes(k))) throw new Error('Unknown configuration field.');
  if (config.embeddings !== undefined) validateEmbedding(config.embeddings);
  for (const name of Object.keys(config.routes)) { safeName(name); if (typeof config.routes[name] !== 'string' || !Object.hasOwn(config.providers, config.routes[name])) throw new Error('Route must name a configured provider.'); }
  if (config.limits && (!Number.isInteger(config.limits.maxSteps) || config.limits.maxSteps < 1 || config.limits.maxSteps > 100 || !Number.isInteger(config.limits.maxContextChars) || config.limits.maxContextChars < 1000 || config.limits.maxContextChars > 2000000)) throw new Error('Invalid run limits.');
  for (const [name, p] of Object.entries(config.providers)) {
    safeName(name);
    if (!object(p) || !['anthropic', 'compatible', 'demo'].includes(p.kind) || typeof p.model !== 'string' || !p.model.trim()) throw new Error(`Invalid provider ${name}`);
    if (Object.keys(p).some(k => !['kind', 'model', 'baseUrl', 'keyEnv', 'keySecret', 'inputCostPerMillion', 'outputCostPerMillion', 'timeoutMs', 'maxOutputTokens', 'tokenLimitField'].includes(k))) throw new Error('Provider configuration contains unsupported fields. Store keys in environment variables or the vault.');
    validateProviderOptions(Object.fromEntries(['timeoutMs', 'maxOutputTokens', 'tokenLimitField'].filter(k => p[k] !== undefined).map(k => [k, p[k]])));
    if (p.baseUrl !== undefined) {
      if (typeof p.baseUrl !== 'string') throw new Error('Provider baseUrl must be a URL.');
      const url = new URL(p.baseUrl);
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Provider endpoint must use HTTPS or local HTTP without credentials, query or fragment.');
    }
    if (p.keySecret) { safeName(p.keySecret); if (p.keyEnv) throw new Error('Choose keyEnv or keySecret, not both.'); }
    if (p.keyEnv !== undefined && (typeof p.keyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(p.keyEnv))) throw new Error('Invalid key environment variable.');
    for (const key of ['inputCostPerMillion', 'outputCostPerMillion']) if (p[key] !== undefined && (!Number.isFinite(p[key]) || p[key] < 0)) throw new Error('Invalid token rate.');
  }
  for (const [name, m] of Object.entries(config.mcp)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !object(m) || !Array.isArray(m.tools) || m.tools.some(t => typeof t !== 'string')) throw new Error('Invalid MCP server definition.');
    if (m.transport === 'http') {
      if (typeof m.url !== 'string') throw new Error('HTTP MCP needs a URL.');
      const url = new URL(m.url);
      if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error('MCP URL must use HTTPS or local HTTP, without credentials, query or fragment.');
      if (m.keyEnv !== undefined && (typeof m.keyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(m.keyEnv))) throw new Error('Invalid MCP credential variable.');
      if (Object.keys(m).some(k => !['transport', 'url', 'keyEnv', 'tools'].includes(k))) throw new Error('Unknown HTTP MCP setting.');
    } else {
      if (m.transport !== undefined && m.transport !== 'stdio') throw new Error('Unsupported MCP transport.');
      if (typeof m.command !== 'string' || !m.command || !Array.isArray(m.args) || m.args.some(a => typeof a !== 'string')) throw new Error('Invalid MCP server definition.');
      if (Object.keys(m).some(k => !['transport', 'command', 'args', 'tools', 'envKeys'].includes(k))) throw new Error('Unknown MCP setting. Use envKeys to reference credentials.');
    }
    if (m.envKeys !== undefined && (!Array.isArray(m.envKeys) || m.envKeys.some(k => typeof k !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(k)))) throw new Error('Invalid MCP environment keys.');
  }
  if (config.applications !== undefined && !object(config.applications)) throw new Error('applications must be an object.');
  for (const [name, app] of Object.entries(config.applications || {})) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !object(app) || typeof app.command !== 'string' || !app.command || !Array.isArray(app.args) || app.args.some(a => typeof a !== 'string')) throw new Error('Invalid application definition.');
    if (Object.keys(app).some(k => !['command', 'args', 'cwd', 'envKeys', 'timeoutMs'].includes(k))) throw new Error('Unsupported application setting.');
    if (app.cwd !== undefined && typeof app.cwd !== 'string') throw new Error('Application cwd must be a path.');
    if (app.timeoutMs !== undefined && (!Number.isInteger(app.timeoutMs) || app.timeoutMs < 1000 || app.timeoutMs > 3600000)) throw new Error('Application timeout must be 1 second to 1 hour.');
    if (app.envKeys !== undefined && (!Array.isArray(app.envKeys) || app.envKeys.some(k => typeof k !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(k)))) throw new Error('Invalid application environment keys.');
  }
  return config;
}
export async function saveConfig(root, config) { await writeState(root, 'config', 'project.json', validateConfig(config)); }
export async function routeProvider(root, agent, { demo = false, providerName, env = process.env } = {}) {
  if (demo) return createProvider({ NEXUS_PROVIDER: 'demo' });
  const config = await loadConfig(root);
  const selected = providerName || agent.provider || config.routes[agent.name] || config.routes.default;
  if (!selected) return createProvider(env);
  const p = config.providers[selected];
  if (!p) throw new Error(`Unknown provider profile: ${selected}`);
  if (p.keyEnv && !env[p.keyEnv]) throw new Error(`Provider credential is unavailable: ${p.keyEnv}`);
  const provider = createProvider({ NEXUS_PROVIDER: p.kind, NEXUS_MODEL: p.model, NEXUS_BASE_URL: p.baseUrl, NEXUS_API_KEY: p.keySecret ? await getSecret(root, p.keySecret, env.NEXUS_VAULT_PASSWORD) : p.keyEnv ? env[p.keyEnv] : undefined }, Object.fromEntries(['timeoutMs', 'maxOutputTokens', 'tokenLimitField'].filter(k => p[k] !== undefined).map(k => [k, p[k]])));
  provider.profile = selected;
  provider.rates = { input: p.inputCostPerMillion, output: p.outputCostPerMillion };
  return provider;
}
