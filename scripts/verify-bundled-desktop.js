import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { runProcess } from '../src/process.js';
import { writeState } from '../src/state.js';

const providerCredentialNames = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'ZHIPUAI_API_KEY', 'DASHSCOPE_API_KEY'];
const numberedCredentialNames = [...providerCredentialNames.map(key => `${key}2`), 'OPENAI_API_KEY10', 'ANTHROPIC_API_KEY3', 'GEMINI_API_KEY99'];
const fixtureProviderEnvironment = () => Object.fromEntries([...providerCredentialNames, ...numberedCredentialNames].map((key, index) => [key, `nexus-synthetic-credential-${index}`]));
const fixtureExcludedEnvironment = () => Object.fromEntries([
  ...providerCredentialNames.flatMap(key => ['0', '1', '02', '100', '_WORK', '2_EXTRA', '2.0', '-2', '+2'].map(suffix => `${key}${suffix}`)),
  'UNKNOWN_API_KEY2',
].map(key => [key, 'nexus-excluded-fixture']));

// Exercise the compiled native host with a synthetic child. This checks the
// actual process boundary without contacting a provider or using real keys.
export async function verifyNativeProviderEnvironment({ host, node, plist, temporary }) {
  const contents = path.join(temporary, 'Credential Fixture.app', 'Contents');
  const resources = path.join(contents, 'Resources');
  const binary = path.join(contents, 'MacOS', 'NexusIDE');
  const workspace = path.join(temporary, 'Credential Fixture Workspace');
  await mkdir(path.dirname(binary), { recursive: true });
  await mkdir(path.join(resources, 'runtime', 'bin'), { recursive: true });
  await mkdir(path.join(resources, 'app', 'src'), { recursive: true });
  await mkdir(workspace);
  await cp(host, binary); await writeFile(path.join(contents, 'Info.plist'), plist);
  await symlink(node, path.join(resources, 'runtime', 'bin', 'node'));
  const fixture = fixtureProviderEnvironment();
  const excluded = fixtureExcludedEnvironment();
  const childSource = `const assert = require('node:assert/strict');
const expected = ${JSON.stringify(fixture)};
for (const [key, value] of Object.entries(expected)) assert.equal(process.env[key], value);
for (const key of ${JSON.stringify(Object.keys(excluded))}) assert.equal(process.env[key], undefined);
assert.equal(process.env.UNRELATED_SECRET, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.NEXUS_API_KEY, undefined);
assert.equal(process.env.NEXUS_BASE_URL, undefined);
assert.equal(process.env.PATH.startsWith(${JSON.stringify(path.join(resources, 'runtime', 'bin') + ':')}), true);
process.stdin.resume();
process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:4317/#' + 'a'.repeat(64), root: process.cwd() }) + '\\n');
`;
  await writeFile(path.join(resources, 'app', 'src', 'desktop-bootstrap.js'), childSource);
  const result = await runProcess(binary, ['--check-bootstrap', '--workspace', workspace], {
    cwd: workspace, timeoutMs: 45000,
    env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), ...fixture, ...excluded, UNRELATED_SECRET: 'nexus-unrelated-fixture', NODE_OPTIONS: '--require=/nonexistent/nexus-injection.js', NEXUS_API_KEY: 'nexus-generic-fixture', NEXUS_BASE_URL: 'https://example.invalid' },
  });
  assert.equal(result.code, 0, 'Native host did not forward the supported credentials with other environment variables excluded.');
  assert.equal(result.stopped, null);
  assert.equal(JSON.parse(result.output).origin, 'http://127.0.0.1:4317');
  for (const value of Object.values(fixture)) assert.equal(result.output.includes(value), false, 'Native check exposed a fixture credential.');
}

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
    await verifyNativeProviderEnvironment({ host, node, plist: await readFile(path.join(contents, 'Info.plist'), 'utf8'), temporary });
    receipt.checks.push('native-provider-credential-allowlist', 'native-numbered-provider-credential-allowlist');
    assert.match(await readFile(path.join(contents, 'Info.plist'), 'utf8'), /CFBundleIconFile<\/key><string>NexusIDE\.icns/);
    const icon = await readFile(path.join(contents, 'Resources/NexusIDE.icns'));
    assert.equal(icon.subarray(0, 4).toString(), 'icns');
    assert.equal(icon.readUInt32BE(4), icon.length);
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
    const providerEnvironment = fixtureProviderEnvironment();
    child = spawn(node, [path.join(payload, 'src/desktop-bootstrap.js'), '--workspace', workspace, '--data-root', dataRoot], { cwd: workspace, env: { ...env, ...providerEnvironment, ...fixtureExcludedEnvironment() }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit'); child.stderr.on('data', () => {});
    const lines = createInterface({ input: child.stdout });
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(15000) });
    const ready = JSON.parse(line), url = new URL(ready.url), token = url.hash.slice(1);
    assert.equal((await fetch(url.origin + '/api/state')).status, 401);
    for (const asset of ['/guide', '/user-guide.md', '/brand/nexus-symbol.svg', '/illustrations/architecture.svg', '/guide-assets/workspace.png', '/guide-assets/task-flow.svg']) {
      const response = await fetch(url.origin + asset, { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, `Missing bundled guide asset: ${asset}`);
      assert.ok((await response.arrayBuffer()).byteLength > 100);
    }
    receipt.checks.push('bundled-visual-guide-and-brand');
    const request = async (route, body) => {
      const response = await fetch(url.origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      assert.ok(response.ok, `API request failed: ${route} (${response.status})`);
      return response.json();
    };
    assert.equal((await request('/api/state')).agents.length, 28);
    const providers = (await request('/api/providers')).providers;
    const cloudProviders = providers.filter(provider => !provider.local);
    assert.deepEqual([...new Set(cloudProviders.map(provider => provider.keyEnv))].sort(), Object.keys(providerEnvironment).sort());
    assert.ok(cloudProviders.every(provider => provider.credential === 'available'));
    assert.ok(providers.some(provider => provider.id === 'ollama' && provider.local && provider.credential === 'not-required' && !provider.keyEnv));
    for (const id of ['openai', 'anthropic', 'gemini', 'xai', 'deepseek', 'moonshot', 'moonshot-cn', 'zhipu', 'zai', 'qwen', 'qwen-cn']) {
      assert.ok(providers.some(provider => provider.id === id), `Missing default account: ${id}`);
      assert.ok(providers.some(provider => provider.id === `${id}:2`), `Missing second account: ${id}`);
    }
    for (const id of ['openai:10', 'anthropic:3', 'gemini:99']) assert.ok(providers.some(provider => provider.id === id), `Missing numbered account: ${id}`);
    const selection = await request('/api/providers/select', { provider: 'deepseek:2', model: 'deepseek-chat', route: 'default' });
    const configText = await readFile(path.join(workspace, '.nexus', 'config', 'project.json'), 'utf8');
    const config = JSON.parse(configText);
    assert.equal(config.providers[config.routes.default].keyEnv, 'DEEPSEEK_API_KEY2');
    assert.equal(config.providers[config.routes.default].model, 'deepseek-chat');
    for (const value of Object.values(providerEnvironment)) {
      assert.equal(JSON.stringify({ providers, selection }).includes(value), false);
      assert.equal(configText.includes(value), false);
    }
    receipt.checks.push('bundled-provider-picker-all-eight-keys', 'bundled-provider-picker-numbered-accounts', 'bundled-provider-selection-without-secret-persistence');
    const memory = await request('/api/memory', { text: 'Bundled memory lifecycle fixture.', layer: 'L2' });
    assert.equal(memory.revision, 1);
    assert.equal((await request('/api/memory/search', { query: 'lifecycle', mode: 'lexical' })).matches[0].id, memory.id);
    assert.equal((await request(`/api/memory/${memory.id}/history`)).versions.length, 1);
    const extraction = await request('/api/memory/distill', { runId: savedId, demo: true });
    let extracted;
    for (let attempt = 0; attempt < 50; attempt++) {
      extracted = (await request('/api/state')).jobs.find(job => job.id === extraction.id);
      if (extracted?.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(extracted.status, 'completed');
    const draft = (await request('/api/memory/drafts')).drafts.find(draft => draft.id === extracted.result);
    assert.equal(draft.candidates[0].status, 'pending');
    const reviewed = await request(`/api/memory/drafts/${draft.id}/review`, { candidateId: draft.candidates[0].id, decision: 'approve', expectedRevision: draft.revision });
    assert.equal(reviewed.memory.agent, 'architect');
    receipt.checks.push('bundled-versioned-memory-and-fts', 'bundled-reviewable-offline-distillation');
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
