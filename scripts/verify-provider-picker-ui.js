// Real dashboard + installed Ollama model listing. No inference or cloud requests.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { saveConfig, loadConfig, defaultConfig } from '../src/config.js';
import { installAgent, defaults } from '../src/agents.js';
import { startServer } from '../src/server.js';

const keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'ZHIPUAI_API_KEY', 'DASHSCOPE_API_KEY'];
for (const key of Object.keys(process.env)) if (keys.some(base => key === base || key.startsWith(base)) || key.startsWith('NEXUS_')) delete process.env[key];
const credential = 'nexus-synthetic-ui-credential';
process.env.GEMINI_API_KEY = credential;
// Defense in depth: even an unexpected backend request may reach only loopback,
// and Ollama only through its read-only installed-model endpoint.
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const parsed = new URL(typeof url === 'string' ? url : url.url || String(url));
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || (parsed.port === '11434' && parsed.pathname !== '/api/tags')) throw new Error('Visual verification refused a non-fixture or inference request.');
  return originalFetch(url, init);
};
const repository = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(repository, '.nexus/verification/provider-picker-ui');
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nexus-provider-ui-')));
const root = path.join(base, 'project'), profile = path.join(base, 'browser');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, chrome, socket;
const receipt = { verified: false, syntheticWorkspace: true, syntheticCredentials: true, realLocalModelListing: true, modelRequests: 0, cloudRequests: 0, checks: [], screenshots: [] };
let id = 0; const pending = new Map(), browserErrors = [], blocked = [];
async function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const request = ++id, timer = setTimeout(() => { pending.delete(request); reject(new Error('Browser command timed out: ' + method)); }, 20000);
    pending.set(request, { resolve, reject, timer }); socket.send(JSON.stringify({ id: request, method, params }));
  });
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function until(expression, label) {
  for (let attempt = 0; attempt < 150; attempt++) { if (await evaluate(expression)) return; await pause(100); }
  throw new Error('Dashboard timed out: ' + label + ' · ' + await evaluate('document.getElementById("notice").textContent'));
}
async function capture(name) {
  const data = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, name), Buffer.from(data.data, 'base64')); receipt.screenshots.push(name);
}
try {
  await mkdir(root); await installAgent(root, defaults.find(a => a.name === 'coder'));
  await saveConfig(root, structuredClone(defaultConfig));
  const local = await (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5000) })).json();
  assert.ok(local.models.some(model => model.name === 'gpt-oss:20b'), 'Expected installed model gpt-oss:20b');
  server = await startServer({ root, port: 0 });
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) { try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await pause(100); } }
  assert.ok(port, 'Chrome failed to start');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Fetch.requestPaused') {
      const parsed = new URL(message.params.request.url);
      const allowed = parsed.origin === new URL(server.url).origin && (parsed.pathname !== '/api/providers/models' || parsed.searchParams.get('provider') === 'ollama');
      if (!allowed) blocked.push(parsed.pathname);
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: message.params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) });
    }
    const waiter = pending.get(message.id); if (!waiter) return;
    clearTimeout(waiter.timer); pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: server.url });
  await until('document.getElementById("provider-credential-summary").textContent.includes("GEMINI_API_KEY")', 'synthetic credential detection');
  await evaluate('document.querySelector("[data-tab=settings]").click()');
  const providers = await evaluate('[...document.getElementById("provider-picker").options].map(o => ({value:o.value, text:o.textContent}))');
  assert.ok(providers.find(p => p.value === 'gemini').text.includes('key detected'));
  assert.ok(providers.find(p => p.value === 'openai').text.includes('key needed'));
  assert.ok(providers.find(p => p.value === 'ollama').text.includes('no API key'));
  assert.equal(await evaluate('document.body.textContent.includes(' + JSON.stringify(credential) + ')'), false);
  await evaluate('document.getElementById("provider-picker").value="ollama"; document.getElementById("provider-picker").dispatchEvent(new Event("change", {bubbles:true}))');
  await until('!document.getElementById("model-picker").disabled && [...document.getElementById("model-picker").options].some(o=>o.value==="gpt-oss:20b")', 'real installed local model');
  await evaluate('document.getElementById("model-picker").value="gpt-oss:20b"; document.getElementById("model-picker").dispatchEvent(new Event("change", {bubbles:true})); document.getElementById("provider-route").value="coder"; document.getElementById("provider-route").dispatchEvent(new Event("change", {bubbles:true}))');
  await until('!document.getElementById("connect-provider").disabled', 'save enabled');
  await evaluate('document.getElementById("provider-form").requestSubmit()');
  await until('document.getElementById("provider-selection-status").textContent.includes("coder: gpt-oss:20b")', 'saved local route');
  const config = await loadConfig(root), saved = config.providers[config.routes.coder];
  assert.equal(saved.kind, 'compatible'); assert.equal(saved.baseUrl, 'http://127.0.0.1:11434/v1'); assert.equal(saved.model, 'gpt-oss:20b'); assert.equal(saved.keyEnv, undefined);
  assert.equal(config.routes.default, undefined); assert.equal(JSON.stringify(config).includes(credential), false);
  await mkdir(output, { recursive: true });
  for (const width of [1280, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1080, deviceScaleFactor: 1, mobile: false });
    await evaluate('window.scrollTo({top:0,behavior:"instant"})'); await pause(150);
    const metrics = await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,notice:document.getElementById("notice").textContent})');
    assert.equal(metrics.notice, ''); assert.ok(metrics.scroll <= width, JSON.stringify(metrics));
    await capture(`connections-${width}.png`);
    if (width === 390) { await evaluate('document.getElementById("model-picker").scrollIntoView({block:"start",behavior:"instant"})'); await pause(150); await capture('local-model-selection-390.png'); }
    receipt.checks.push(`connections-${width}-no-overflow`);
  }
  assert.deepEqual(browserErrors, []); assert.deepEqual(blocked, []);
  receipt.checks.push('synthetic-gemini-key-detected', 'other-cloud-keys-cleared', 'real-ollama-model-list', 'fixture-coder-route-saved', 'local-profile-without-api-key', 'no-default-route-change', 'no-credential-value-exposure', 'no-browser-errors', 'no-model-inference'); receipt.verified = true;
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { const exited = once(chrome, 'exit'); chrome.kill(); await exited; }
  await server?.close(); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await rm(base, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt, null, 2));
