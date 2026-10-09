import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { runProcess } from '../src/process.js';
import { writeState } from '../src/state.js';

export async function verifyBundledDesktop(appPath = fileURLToPath(new URL('../dist/NexusIDE.app', import.meta.url))) {
  if (process.platform !== 'darwin') throw new Error('Bundled macOS verification requires macOS.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nexus-relocated-app-'));
  const receipt = { at: new Date().toISOString(), verified: false, syntheticWorkspace: true, visualVerification: false, checks: [] };
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', NODE_NO_WARNINGS: '1' };
  let child;
  try {
    const app = path.join(temporary, 'Moved App', 'NexusIDE.app');
    await cp(appPath, app, { recursive: true, verbatimSymlinks: true });
    const contents = path.join(app, 'Contents'), payload = path.join(contents, 'Resources/app');
    const node = path.join(contents, 'Resources/runtime/bin/node'), host = path.join(contents, 'MacOS/NexusIDE');
    const workspace = path.join(temporary, 'Synthetic Workspace'), dataRoot = path.join(temporary, 'Application Data');
    await mkdir(workspace); await writeFile(path.join(workspace, 'README.md'), 'Synthetic relocated application fixture.\n');
    const checked = async (command, args, options = {}) => {
      const result = await runProcess(command, args, { cwd: workspace, env, timeoutMs: 45000, ...options });
      assert.equal(result.code, 0, result.output); assert.equal(result.stopped, null);
      return result.output;
    };
    await checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    receipt.checks.push('relocated-signature-valid');
    const native = JSON.parse(await checked(host, ['--check-bootstrap', '--workspace', workspace, '--data-root', dataRoot]));
    assert.equal(native.origin.startsWith('http://127.0.0.1:'), true);
    await assert.rejects(fetch(native.origin, { signal: AbortSignal.timeout(1000) }));
    assert.throws(() => process.kill(native.pid, 0), { code: 'ESRCH' });
    receipt.checks.push('native-owned-bundled-bootstrap', 'native-shutdown-closes-service');
    assert.match(await checked(node, [path.join(payload, 'src/cli.js'), '--help']), /NexusIDE/);
    await checked(node, [path.join(payload, 'src/cli.js'), 'run', 'architect', 'Inspect the synthetic file.', '--demo']);
    const listing = await checked(node, [path.join(payload, 'src/cli.js'), 'status']);
    const savedId = /architect\s+completed\s+([a-f0-9-]{36})/.exec(listing)?.[1];
    assert.ok(savedId, 'The bundled CLI did not persist its completed run.');
    const run = JSON.parse(await checked(node, [path.join(payload, 'src/cli.js'), 'status', savedId]));
    assert.equal(run.status, 'completed'); assert.equal(run.agent, 'architect');
    receipt.checks.push('bundled-cli-demo', 'persisted-sqlite-history');
    child = spawn(node, [path.join(payload, 'src/desktop-bootstrap.js'), '--workspace', workspace, '--data-root', dataRoot], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit'); child.stderr.on('data', () => {});
    const lines = createInterface({ input: child.stdout });
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(15000) });
    const ready = JSON.parse(line), url = new URL(ready.url), token = url.hash.slice(1);
    assert.equal((await fetch(url.origin + '/api/state')).status, 401);
    const request = async (route, body) => {
      const response = await fetch(url.origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      assert.ok(response.ok, `API request failed: ${route} (${response.status})`);
      return response.json();
    };
    assert.equal((await request('/api/state')).agents.length, 7);
    await request('/api/terminal/start', {});
    await request('/api/terminal/input', { input: "printf 'NEXUS_BUNDLE_TERMINAL_OK\\n'\n" });
    let output = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      output = (await request('/api/terminal/output')).output;
      if (output.includes('NEXUS_BUNDLE_TERMINAL_OK\r\n')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(output, /NEXUS_BUNDLE_TERMINAL_OK\r?\n/);
    await request('/api/terminal/stop', {});
    receipt.checks.push('relocated-authenticated-dashboard', 'bundled-native-pty');
    child.stdin.end();
    const timeout = AbortSignal.timeout(12000);
    const ending = await Promise.race([exited, new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Bundled service failed to close.')), { once: true }))]);
    assert.equal(ending[0], 0);
    await assert.rejects(fetch(url.origin, { signal: AbortSignal.timeout(1000) }));
    const settings = await readFile(path.join(dataRoot, '.nexus/desktop/settings.json'), 'utf8');
    assert.equal(settings.includes(token), false);
    receipt.checks.push('parent-eof-shutdown', 'separate-private-app-data');
    receipt.manifest = JSON.parse(await readFile(path.join(contents, 'Resources/build-manifest.json'), 'utf8'));
    receipt.verified = true;
  } catch (error) { receipt.error = error.message; }
  finally { child?.kill('SIGKILL'); await rm(temporary, { recursive: true, force: true }); }
  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const receipt = await verifyBundledDesktop();
  await writeState(process.cwd(), 'verification', 'bundled-desktop.json', receipt);
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.verified) process.exitCode = 1;
}
