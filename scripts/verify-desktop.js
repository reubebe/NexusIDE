import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { desktopBinary } from './build-desktop.js';
import { commandEnvironment } from '../src/process.js';
import { writeState } from '../src/state.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-desktop-'));
const receipt = { at: new Date().toISOString(), verified: false, syntheticWorkspace: true, visualVerification: false };
let launcher;
try {
  const token = 'a'.repeat(64);
  for (const [url, accepted] of [
    [`http://127.0.0.1:4317/#${token}`, true],
    [`https://example.com/#${token}`, false],
    [`http://127.0.0.1:4317/#bad`, false],
    [`http://user:pass@127.0.0.1:4317/#${token}`, false],
    [`http://127.0.0.1:4317/path#${token}`, false],
  ]) {
    const host = spawn(desktopBinary, ['--check-url'], { env: commandEnvironment(), stdio: ['pipe', 'ignore', 'ignore'] });
    const exit = once(host, 'exit'); host.stdin.end(url + '\n');
    assert.equal((await exit)[0] === 0, accepted);
  }
  const moduleUrl = new URL('../src/desktop.js', import.meta.url).href;
  const source = `import { launchDesktop } from ${JSON.stringify(moduleUrl)}; await launchDesktop(${JSON.stringify(root)}, { onReady: value => console.log(JSON.stringify(value)) });`;
  launcher = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env: commandEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(launcher, 'exit');
  launcher.stderr.on('data', () => {});
  const lines = createInterface({ input: launcher.stdout });
  const timeout = AbortSignal.timeout(15000);
  const [line] = await once(lines, 'line', { signal: timeout });
  const { origin, pid } = JSON.parse(line);
  assert.equal((await fetch(origin + '/api/state', { signal: timeout })).status, 401);
  assert.equal((await fetch(origin, { signal: timeout })).status, 200);
  process.kill(pid, 0);
  launcher.kill('SIGTERM');
  const ended = await Promise.race([exit, new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Desktop shutdown timed out')), { once: true }))]);
  assert.equal(ended[0], 0);
  await assert.rejects(fetch(origin + '/api/state', { signal: AbortSignal.timeout(2000) }));
  receipt.verified = true;
  receipt.checks = ['compiled-native-host', 'loopback-url-validation', 'dashboard-server-start', 'api-authentication', 'native-process-start', 'launcher-shutdown-closes-server'];
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally {
  launcher?.kill('SIGTERM');
  await writeState(process.cwd(), 'verification', 'desktop.json', receipt);
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt, null, 2));
