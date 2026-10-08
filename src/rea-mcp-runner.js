#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const data = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : process.platform === 'win32'
    ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
const runtimes = path.join(data, 'NexusIDE', 'runtimes');
const root = path.join(runtimes, 'rea');
const node = path.join(runtimes, 'node24', 'node_modules', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
const child = spawn(node, [path.join(root, 'scripts', 'rea.mjs'), 'mcp'], { cwd: root, env: process.env, shell: false, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
