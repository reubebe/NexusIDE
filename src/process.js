import { spawn } from 'node:child_process';

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
    const collect = chunk => {
      const remaining = Math.max(0, maxBytes - bytes);
      output += chunk.subarray(0, remaining).toString('utf8');
      bytes += chunk.length;
      if (bytes > maxBytes) stop('output-limit');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('spawn', () => {
      registration = Promise.resolve().then(() => onSpawn?.(child.pid)).catch(error => { registrationError = error; stop('registration-failed'); });
    });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', e => { cleanup(); reject(e); });
    child.on('close', async (code, exitSignal) => { cleanup(); await registration; if (registrationError) reject(registrationError); else resolve({ code, signal: exitSignal, stopped, output }); });
  });
}
