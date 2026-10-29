import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readState, writeState, stateDir } from './state.js';
import { commandEnvironment } from './process.js';
import { credentialStatus } from './provider-catalog.js';
import { acquireWorkspace } from './locks.js';

// Authentication is performed by the unmodified installed CLI. Nexus never
// reads, copies, refreshes or proxies its subscription credentials.
export const cliAccountCatalog = [
  { id: 'claude', label: 'Claude Code', command: 'claude', modes: ['subscription'], directoryEnv: 'CLAUDE_CONFIG_DIR', note: 'Sign in directly in Claude Code. Each profile has a separate configuration directory. Check /status for the active account and billing.' },
  { id: 'codex', label: 'Codex', command: 'codex', modes: ['subscription'], directoryEnv: 'CODEX_HOME', note: 'Sign in with ChatGPT in Codex. Each profile has separate CLI state and file-based credentials. Model access and limits follow the selected account.' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', modes: ['subscription'], directoryEnv: 'GEMINI_CLI_HOME', note: 'Choose Sign in with Google in Gemini CLI. Free and eligible paid plans use the signed-in account. Each profile has separate CLI state.' },
  { id: 'meta', label: 'Meta · Muse Code', command: 'muse', modes: ['subscription', 'api'], keyEnv: 'META_API_KEY', note: 'Subscription uses Muse Code’s existing machine sign-in. Saved subscription isolation is not documented, so only one subscription profile is allowed; switch users through Muse /login. A stored API key may override browser sign-in: verify billing inside Muse. API mode forwards only the chosen META_API_KEY variable. Contributor mode is disabled for these launches.' },
];
const profileId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
function validate(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).some(k => !['id', 'provider', 'label', 'mode', 'command', 'keyEnv'].includes(k))) throw new Error('Invalid CLI account profile.');
  const provider = cliAccountCatalog.find(p => p.id === profile.provider);
  if (!provider || !provider.modes.includes(profile.mode)) throw new Error('This provider does not support the selected CLI connection mode.');
  if (profile.id !== undefined && !profileId(profile.id)) throw new Error('Invalid CLI account ID.');
  if (typeof profile.label !== 'string' || !profile.label.trim() || profile.label.length > 64 || /[\x00-\x1f\x7f]/.test(profile.label)) throw new Error('Account label must be 1–64 printable characters.');
  if (typeof profile.command !== 'string' || !path.isAbsolute(profile.command) || /[\x00-\x1f]/.test(profile.command)) throw new Error('Choose the absolute path of the installed official CLI executable.');
  if (profile.mode === 'api') {
    if (!new RegExp(`^${provider.keyEnv}(?:[2-9]|[1-9][0-9])?$`).test(profile.keyEnv || '')) throw new Error('Choose META_API_KEY or a numbered META_API_KEY2–99.');
  } else if (profile.keyEnv !== undefined) throw new Error('Subscription profiles cannot contain an API key reference.');
  return provider;
}
async function profiles(home) {
  const data = await readState(home, 'connections', 'cli-accounts.json', { version: 1, profiles: [] });
  if (data.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 50) throw new Error('Invalid saved CLI profiles.');
  data.profiles.forEach(validate);
  if (new Set(data.profiles.map(p => p.id)).size !== data.profiles.length) throw new Error('Duplicate CLI account IDs.');
  return data.profiles;
}
async function executable(command) {
  // Symlinked package-manager executables are normal. Resolve once and spawn
  // the resolved file, without a shell or user-controlled extra arguments.
  const resolved = await realpath(command);
  if (!(await stat(resolved)).isFile()) throw new Error('CLI executable is not a regular file.');
  await access(resolved, constants.X_OK);
  return resolved;
}
export async function listCliAccounts({ home = os.homedir(), env = process.env } = {}) {
  const saved = await profiles(home);
  return { catalog: cliAccountCatalog, profiles: await Promise.all(saved.map(async p => ({ ...p,
    executableAvailable: await executable(p.command).then(() => true, () => false),
    credential: p.mode === 'api' ? credentialStatus(env[p.keyEnv]) : 'verify-in-cli',
  }))) };
}
export async function saveCliAccount(input, { home = os.homedir() } = {}) {
  validate(input);
  await executable(input.command);
  const release = await acquireWorkspace(home, home, randomUUID());
  try {
  const saved = await profiles(home);
  if (input.id && !saved.some(p => p.id === input.id)) throw new Error('CLI account no longer exists.');
  const previous = saved.find(p => p.id === input.id);
  if (previous && (previous.provider !== input.provider || previous.mode !== input.mode)) throw new Error('Create a new profile to change provider or connection mode.');
  if (input.provider === 'meta' && input.mode === 'subscription' && saved.some(p => p.id !== input.id && p.provider === 'meta' && p.mode === 'subscription')) throw new Error('Muse uses one shared machine sign-in. Switch that account in Muse instead of creating duplicate subscription profiles.');
  if (!input.id && saved.length >= 50) throw new Error('Maximum 50 CLI account profiles.');
  const profile = { ...input, id: input.id || randomUUID(), label: input.label.trim() };
  const next = saved.filter(p => p.id !== profile.id); next.push(profile);
  await writeState(home, 'connections', 'cli-accounts.json', { version: 1, profiles: next });
  return profile;
  } finally { await release(); }
}
export async function removeCliAccount(id, { home = os.homedir() } = {}) {
  if (!profileId(id)) throw new Error('Invalid CLI account ID.');
  const release = await acquireWorkspace(home, home, randomUUID());
  try {
  const saved = await profiles(home);
  if (!saved.some(p => p.id === id)) throw new Error('CLI account no longer exists.');
  await writeState(home, 'connections', 'cli-accounts.json', { version: 1, profiles: saved.filter(p => p.id !== id) });
  // Retain CLI state and tokens. Sign out in the official CLI before removal.
  return { removed: id, retainedCliState: true };
  } finally { await release(); }
}
export async function cliAccountLaunch(id, { home = os.homedir(), env = process.env, approved = false } = {}) {
  if (approved !== true) throw new Error('Confirm launching the official CLI in this project.');
  const profile = (await profiles(home)).find(p => p.id === id);
  if (!profile) throw new Error('CLI account no longer exists.');
  const provider = validate(profile), command = await executable(profile.command);
  const childEnv = commandEnvironment();
  const args = [];
  if (provider.directoryEnv) childEnv[provider.directoryEnv] = await stateDir(home, 'cli-accounts', profile.id);
  if (profile.provider === 'codex') args.push('-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"');
  if (profile.provider === 'meta') args.push('--contributor-mode', 'off');
  if (profile.mode === 'api') {
    if (credentialStatus(env[profile.keyEnv]) !== 'available') throw new Error(`Set a real ${profile.keyEnv} before launching.`);
    childEnv[provider.keyEnv] = env[profile.keyEnv];
  }
  return { command, args, env: childEnv, account: { id: profile.id, label: profile.label, provider: provider.label, mode: profile.mode } };
}
