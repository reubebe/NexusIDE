import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// Do not forward provider credentials or arbitrary parent environment settings.
export function commandEnvironment() {
  return Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
}

export function runProcess(command, args, { cwd, signal, timeoutMs = 60_000, maxBytes = 100_000, env = commandEnvironment(), onSpawn } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, stopped = null, registration = Promise.resolve(), registrationError;
    const stop = reason => {
      if (stopped) return;
      stopped = reason;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (e) { if (e.code !== 'ESRCH') child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const stream of [child.stdout, child.stderr]) {
      // Pipe chunks need not end on a UTF-8 boundary. Each stream has its own
      // decoder so interleaved stderr cannot complete a pending stdout character.
      const decoder = new StringDecoder('utf8');
      stream.on('data', chunk => {
        const remaining = Math.max(0, maxBytes - bytes);
        output += decoder.write(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > maxBytes) stop('output-limit');
      });
      stream.on('end', () => {
        // A byte limit may split the final character; omit that incomplete
        // suffix instead of manufacturing a replacement beyond the byte cap.
        if (stopped !== 'output-limit') output += decoder.end();
      });
    }
    child.once('spawn', () => {
      registration = Promise.resolve().then(() => onSpawn?.(child.pid)).catch(error => { registrationError = error; stop('registration-failed'); });
    });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', e => { cleanup(); reject(e); });
    child.on('close', async (code, exitSignal) => { cleanup(); await registration; if (registrationError) reject(registrationError); else resolve({ code, signal: exitSignal, stopped, output }); });
  });
}
