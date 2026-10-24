// Actual dashboard and reviewed backend, against disposable source only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { saveConfig, defaultConfig } from '../src/config.js';
import { connectMcp } from '../src/mcp.js';
import { startServer } from '../src/server.js';

const binary = process.env.NEXUS_CODEGRAPH_BINARY;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set NEXUS_CODEGRAPH_BINARY to the absolute reviewed codebase-memory-mcp binary.');
const chromeBinary = process.env.NEXUS_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const repository = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(repository, '.nexus/verification/code-map-ui');
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nexus-map-ui-')));
const root = path.join(base, 'project'), profile = path.join(base, 'browser');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, chrome, socket, connection;
const receipt = { verified: false, syntheticWorkspace: true, modelRequests: 0, checks: [], screenshots: [] };
let id = 0; const pending = new Map(), browserErrors = [];
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
  for (let attempt = 0; attempt < 200; attempt++) { if (await evaluate(expression)) return; await pause(200); }
  throw new Error('Dashboard timed out: ' + label + ' · ' + await evaluate('document.getElementById("code-map-status").textContent'));
}
async function capture(name) {
  const data = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, name), Buffer.from(data.data, 'base64')); receipt.screenshots.push(name);
}
try {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/math.js'), 'export function add(a, b) { return a + b; }\nexport function double(a) { return add(a, a); }\nexport function total(values) { return values.reduce(add, 0); }\n');
  await saveConfig(root, { ...structuredClone(defaultConfig), mcp: { codegraph: { command: '/usr/bin/env', args: [`CBM_ALLOWED_ROOT=${root}/src`, `CBM_CACHE_DIR=${base}/cache`, binary, '--ui=false'], tools: ['list_projects', 'search_graph', 'trace_path', 'check_index_coverage', 'index_repository'] } } });
  connection = await connectMcp(root, { mcp: ['codegraph'] }, async request => request.type === 'mcp-connect' || request.tool === 'index_repository');
  const indexTool = connection.tools.find(t => t.description.startsWith('[codegraph/index_repository]'));
  const indexed = JSON.parse(await connection.call(indexTool.name, { repo_path: root + '/src', name: 'example-source', mode: 'fast', persistence: false }));
  assert.ok(!indexed.isError, JSON.stringify(indexed)); await connection.close(); connection = undefined;
  server = await startServer({ root, port: 0 });
  chrome = spawn(chromeBinary, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
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
      const allowed = new URL(message.params.request.url).origin === new URL(server.url).origin;
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: message.params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) });
    }
    const waiter = pending.get(message.id); if (!waiter) return;
    clearTimeout(waiter.timer); pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: server.url });
  await until('Boolean(document.querySelector("#stats .stat"))', 'dashboard');
  await evaluate('document.querySelector("[data-tab=code-map]").click()');
  await until('!document.getElementById("code-map-approved").disabled', 'connection status');
  assert.equal(await evaluate('document.getElementById("code-map-connect").disabled'), true);
  await evaluate('document.getElementById("code-map-approved").click(); document.getElementById("code-map-connect").click()');
  await until('!document.getElementById("code-map-query").disabled', 'index list');
  await evaluate('document.getElementById("code-map-query").value="add"; document.getElementById("code-map-form").requestSubmit()');
  await until('Boolean(document.querySelector("#code-map-results .code-map-symbol-name"))', 'symbol search');
  await evaluate('document.querySelector("#code-map-results .code-map-symbol-name").click()');
  await until('!document.getElementById("code-map-neighbors").hidden && !document.getElementById("code-map-query").disabled', 'relationships');
  assert.ok(await evaluate('document.getElementById("code-map-neighbors").textContent.includes("double")'));
  await mkdir(output, { recursive: true });
  for (const width of [1280, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
    await evaluate('document.getElementById("code-map-neighbors").scrollIntoView({block:"start",behavior:"instant"})');
    await pause(200);
    const metrics = await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,notice:document.getElementById("notice").textContent})');
    assert.equal(metrics.notice, ''); assert.ok(metrics.scroll <= width, JSON.stringify(metrics));
    await capture(`code-map-${width}.png`); receipt.checks.push(`relationship-view-${width}-no-overflow`);
  }
  await evaluate('document.querySelector("#code-map-neighbors .selected .code-map-source").click()');
  await until('!document.getElementById("files").hidden && document.getElementById("file-title").textContent === "src/math.js"', 'current source');
  assert.ok(await evaluate('document.getElementById("file-content").value.includes("export function add")'));
  assert.deepEqual(browserErrors, []);
  receipt.checks.push('explicit-user-consent', 'real-symbol-search', 'direct-callers', 'safe-current-source-open', 'no-browser-errors'); receipt.verified = true;
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally {
  await connection?.close(); socket?.close();
  if (chrome && chrome.exitCode === null) { const exited = once(chrome, 'exit'); chrome.kill(); await exited; }
  await server?.close(); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await rm(base, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt, null, 2));
