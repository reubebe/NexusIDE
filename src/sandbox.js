import { runProcess } from './process.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function dockerArguments(root, cwd, command, args, image, name) {
  if (typeof image !== 'string' || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Docker mode requires an image pinned by sha256 digest.');
  const relative = path.relative(root, cwd);
  if (relative.startsWith('..') || path.isAbsolute(relative) || root.includes(',')) throw new Error('Invalid sandbox workspace.');
  return ['run', '--rm', '--pull=never', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=1g', '--cpus=2', '--user', `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m', '--mount', `type=bind,src=${root},dst=/workspace`, '--workdir', `/workspace/${relative.split(path.sep).join('/')}`, image, command, ...args];
}
export async function runSandbox(root, cwd, command, args, image, signal) {
  const name = `nexus-${randomUUID()}`;
  const dockerArgs = dockerArguments(root, cwd, command, args, image, name);
  try { return await runProcess('docker', dockerArgs, { cwd: root, signal }); }
  finally { await runProcess('docker', ['rm', '-f', name], { cwd: root, timeoutMs: 10000 }).catch(() => {}); }
}
