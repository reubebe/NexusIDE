import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, realpath, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { initializeWorkspace } from './workspace-init.js';
import { readState, writeState } from './state.js';

export function desktopDataRoot() {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'NexusIDE');
}

function absoluteDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.length > 4096) throw new Error('Choose an absolute workspace directory.');
}

export async function prepareDesktopWorkspace(workspace, { dataRoot = desktopDataRoot(), installationRoot = fileURLToPath(new URL('../', import.meta.url)) } = {}) {
  absoluteDirectory(workspace); absoluteDirectory(dataRoot);
  const root = await realpath(workspace);
  if (!(await lstat(root)).isDirectory()) throw new Error('The selected workspace is not a directory.');
  const installation = await realpath(installationRoot);
  const relative = path.relative(installation, root);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Select a project outside the application bundle.');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const dataInfo = await lstat(dataRoot);
  if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink()) throw new Error('Desktop application data must be a real directory, not a symbolic link.');
  const data = await realpath(dataRoot);
  const previous = await readState(data, 'desktop', 'settings.json', {});
  const result = await initializeWorkspace(root);
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const recent = Array.isArray(previous.recentWorkspaces) ? previous.recentWorkspaces.filter(p => typeof p === 'string' && path.isAbsolute(p) && p.length <= 4096 && !p.includes('\0')) : [];
  await writeState(data, 'desktop', 'settings.json', {
    version: 1, appVersion: metadata.version, lastWorkspace: root,
    recentWorkspaces: [...new Set([root, ...recent])].slice(0, 10), lastOpened: new Date().toISOString(),
  });
  return { root, dataRoot: data, initialized: result };
}
