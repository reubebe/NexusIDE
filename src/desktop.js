import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { startServer } from './server.js';
import { commandEnvironment } from './process.js';
import { desktopBinary } from '../scripts/build-desktop.js';

export async function launchDesktop(root, { onReady = () => {} } = {}) {
  if (process.platform !== 'darwin') throw new Error('Native desktop currently supports macOS. Use nexus serve on other platforms.');
  try { await access(desktopBinary, constants.X_OK); }
  catch { throw new Error('Build the desktop host first: npm run desktop:build'); }
  const app = await startServer({ root, port: 0 });
  let child;
  const stop = () => child?.kill('SIGTERM');
  try {
    child = spawn(desktopBinary, [], { cwd: root, env: commandEnvironment(), stdio: ['pipe', 'ignore', 'inherit'] });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    // Keep the bearer token out of command arguments and inherited environment.
    child.stdin.on('error', () => {});
    child.stdin.write(app.url + '\n');
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => onReady({ origin: new URL(app.url).origin, pid: child.pid }));
      child.once('exit', (code, signal) => code === 0 || signal === 'SIGTERM' ? resolve() : reject(new Error(`Desktop host exited with code ${code}.`)));
    });
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    child?.stdin.destroy(); stop();
    await app.close();
  }
}
