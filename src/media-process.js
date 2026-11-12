import { runProcess } from './process.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

// Fixed positional arguments prevent shell interpretation of media filenames.
// The tighter of a platform's 512/1024-byte blocks is acceptable: this is an
// upper bound, not a promise that every file below the bound can be encoded.
export function runMediaProcess(command, args, options = {}) {
  const { maxFileBytes = 50_000_000, cpuSeconds = 60, ...processOptions } = options;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1024 || maxFileBytes > 500_000_000 ||
      !Number.isSafeInteger(cpuSeconds) || cpuSeconds < 1 || cpuSeconds > 300) throw new Error('Invalid media resource limits.');
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Bounded media processing currently requires macOS or Linux.');
  const launch = () => runProcess('/bin/sh', ['-c', 'ulimit -f "$1" && ulimit -t "$2" && shift 2 && exec "$@"',
    'nexus-media-limits', String(Math.floor(maxFileBytes / 1024)), String(cpuSeconds), command, ...args], processOptions);
  return path.isAbsolute(command) ? access(command, constants.X_OK).then(launch) : launch();
}
