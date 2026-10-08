import { commandEnvironment } from './process.js';

export async function launchTerminal(root) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('An interactive terminal is required.');
  const pty = await import('node-pty');
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  const terminal = pty.spawn(shell, [], { name: 'xterm-256color', cwd: root, cols: process.stdout.columns || 100, rows: process.stdout.rows || 30, env: { ...commandEnvironment(), TERM: 'xterm-256color', NEXUS_WORKSPACE: root } });
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true); process.stdin.resume();
  const input = data => terminal.write(data.toString());
  const resize = () => terminal.resize(process.stdout.columns || 100, process.stdout.rows || 30);
  const output = terminal.onData(data => process.stdout.write(data));
  process.stdin.on('data', input); process.stdout.on('resize', resize);
  await new Promise(resolve => terminal.onExit(({ exitCode }) => { process.exitCode = exitCode; resolve(); }));
  output.dispose(); process.stdin.off('data', input); process.stdout.off('resize', resize); process.stdin.setRawMode(wasRaw); process.stdin.pause();
}
