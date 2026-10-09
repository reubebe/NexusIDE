import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { prepareDesktopWorkspace } from './desktop-workspace.js';
import { startServer } from './server.js';

export function parseDesktopArguments(args) {
  const options = {};
  const keys = { '--workspace': 'workspace', '--data-root': 'dataRoot' };
  for (let i = 0; i < args.length; i += 2) {
    const key = Object.hasOwn(keys, args[i]) ? keys[args[i]] : undefined;
    if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --workspace PATH and optionally --data-root PATH.');
    options[key] = args[i + 1];
  }
  if (!options.workspace) throw new Error('Choose a workspace before starting NexusIDE.');
  return options;
}

export async function bootstrapDesktop(args = process.argv.slice(2)) {
  const { workspace, dataRoot } = parseDesktopArguments(args);
  let server, closing = false, forceExit;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    forceExit = setTimeout(() => process.exit(1), 8000);
    forceExit.unref();
    if (server) void server.close().finally(() => { clearTimeout(forceExit); process.stdin.pause(); });
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  process.stdin.once('end', shutdown); process.stdin.once('error', shutdown); process.stdin.resume();
  try {
    const prepared = await prepareDesktopWorkspace(workspace, { dataRoot });
    if (closing) return;
    server = await startServer({ root: prepared.root, port: 0 });
    if (closing) { await server.close(); clearTimeout(forceExit); return; }
    // Only the parent process pipe receives the bearer token. Never persist it.
    process.stdout.write(JSON.stringify({ url: server.url, root: prepared.root }) + '\n');
  } catch (error) {
    shutdown();
    throw error;
  }
}

// Finder/temporary locations may include system symlinks (e.g. /var on macOS).
const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entry === fileURLToPath(import.meta.url)) {
  try { await bootstrapDesktop(); }
  catch {
    // No provider credentials, paths or untrusted exception text reach native UI.
    process.stderr.write('NexusIDE could not prepare its workspace or start the local service. Check directory access and available storage.\n');
    process.exitCode = 1;
    process.stdin.pause();
  }
}
