// Capture the real dashboard against a disposable, entirely synthetic project.
// No existing Nexus/Chrome process, project state, provider, or terminal is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, installAgent } from '../src/agents.js';
import { saveConfig } from '../src/config.js';
import { remember } from '../src/memory.js';
import { startServer } from '../src/server.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const images = path.join(repository, 'docs', 'assets', 'guide');
const chromePath = process.env.NEXUS_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const task = 'Review the project structure and propose a small, testable improvement.';
const receipt = { verified: false, syntheticWorkspace: true, realModelRequests: 0, screenshots: [], checks: [] };
let temporary, server, chrome, connection;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function devtoolsTargets(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (chrome.exitCode !== null) throw new Error('Isolated Chrome exited before DevTools became ready.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch {}
    await pause(100);
  }
  throw new Error('Isolated Chrome DevTools did not become ready.');
}

async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DevTools connection timed out.')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools connection failed.')); }, { once: true });
  });
  let id = 0;
  const pending = new Map(), listeners = new Set();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) { for (const listener of listeners) listener(message); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('DevTools connection closed.')); }
    pending.clear();
  });
  return {
    close: () => socket.close(),
    onEvent: listener => listeners.add(listener),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`DevTools timed out: ${method}`)); }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    }),
  };
}

async function evaluate(expression) {
  const response = await connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

async function until(expression, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(expression)) return;
    await pause(80);
  }
  throw new Error(`Dashboard did not become ready: ${description}`);
}

async function selectTab(tab) {
  await evaluate(`document.querySelector('[data-tab="${tab}"]').click(); window.scrollTo(0, 0)`);
  await until(`!document.getElementById(${JSON.stringify(tab)}).hidden`, `${tab} tab`);
  // Wait for layout, image decoding, and the app's asynchronous tab reads.
  await evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
}

async function viewport(width, height) {
  await connection.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await evaluate('window.scrollTo(0, 0)');
}

async function screenshot(name) {
  const shot = await connection.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(images, name), Buffer.from(shot.data, 'base64'));
  receipt.screenshots.push(`docs/assets/guide/${name}`);
}

try {
  await access(chromePath);
  temporary = await mkdtemp(path.join(os.tmpdir(), 'nexus-guide-'));
  const root = path.join(temporary, 'example-project');
  await mkdir(root);
  await writeFile(path.join(root, 'README.md'), '# Example project\n\nA synthetic project used only for NexusIDE guide screenshots.\n');
  await saveConfig(root, { version: 1, providers: { 'guide-demo': { kind: 'demo', model: 'offline-demo' } }, routes: { default: 'guide-demo' }, mcp: {} });
  for (const agent of defaults) await installAgent(root, { ...agent, memory: true });
  await remember(root, { text: 'Use SQLite for local-first project storage. Keep migrations reversible and test them against a temporary database.', layer: 'L1', category: 'decision' });
  await remember(root, { text: 'The project is a local agent workspace. Keep the runtime independent of the desktop and editor interfaces.', layer: 'L2', category: 'summary' });
  await remember(root, { text: 'Explain the outcome first, then give concise test results and any remaining limitations.', layer: 'L3', category: 'preference', scope: 'agent', agent: 'coder' });
  server = await startServer({ root, port: 0 });
  const origin = new URL(server.url).origin;
  const port = await freePort();
  chrome = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(temporary, 'chrome-profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-gpu', '--disable-features=MediaRouter', 'about:blank',
  ], { stdio: 'ignore' });
  let launchError;
  chrome.once('error', error => { launchError = error; });
  const targets = await devtoolsTargets(port);
  if (launchError) throw launchError;
  const page = targets.find(target => target.type === 'page' && target.url === 'about:blank');
  if (!page) throw new Error('Isolated Chrome did not expose its blank page.');
  connection = await connect(page.webSocketDebuggerUrl);
  const blocked = [], pageErrors = [];
  connection.onEvent(event => {
    if (event.method === 'Runtime.exceptionThrown') pageErrors.push(event.params.exceptionDetails.text);
    if (event.method !== 'Fetch.requestPaused') return;
    const { request, requestId } = event.params;
    // The guide has only a scripted offline profile, never a real model.
    // Also prevent accidental external assets from entering the browser capture.
    if (new URL(request.url).origin !== origin) {
      blocked.push(request.url);
      connection.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    } else connection.send('Fetch.continueRequest', { requestId }).catch(() => {});
  });
  await connection.send('Runtime.enable');
  await connection.send('Page.enable');
  await connection.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await viewport(1280, 960);
  await connection.send('Page.navigate', { url: server.url });
  await until('document.querySelectorAll("#agent-select option").length === 3', 'synthetic agents');
  await until('Boolean(document.querySelector("[data-tab=about]"))', 'About navigation');
  await evaluate(`document.getElementById('task').value = ${JSON.stringify(task)}; document.getElementById('task').dispatchEvent(new Event('input', { bubbles: true }))`);
  await mkdir(images, { recursive: true });
  await screenshot('workspace.png');

  await viewport(1280, 1080);
  await selectTab('agents');
  await evaluate('[...document.querySelectorAll("#agent-cards button")].find(button => button.querySelector("h3").textContent === "coder").click()');
  await until('!document.getElementById("memory-loadout").disabled && document.getElementById("agent-editor").value.includes("coder")', 'coder memory selection');
  await screenshot('agent-memory.png');

  await selectTab('memory');
  await until('document.querySelectorAll("#memories .memory-record").length === 2', 'project memories');
  await evaluate('document.getElementById("memory-query").value = "SQLite local storage"; document.getElementById("memory-search-agent").value = "coder"; document.getElementById("memory-search-form").requestSubmit()');
  await until('document.querySelectorAll("#memory-results .memory-record").length > 0', 'local keyword recall');
  await screenshot('memory.png');

  await selectTab('about');
  await until('[...document.querySelectorAll("#about img")].every(image => image.complete && image.naturalWidth > 0)', 'About illustrations');
  await screenshot('about.png');

  for (const size of [{ width: 1280, height: 960 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await viewport(size.width, size.height);
    for (const tab of ['workspace', 'agents', 'history', 'memory', 'settings', 'terminal', 'files', 'about']) {
      await selectTab(tab);
      if (tab === 'files') await until('document.querySelector("#file-list").textContent.includes("README.md")', 'synthetic file list');
      const metrics = await evaluate(`({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, visible: !document.getElementById(${JSON.stringify(tab)}).hidden, brokenImages: [...document.querySelectorAll('img')].filter(image => image.getClientRects().length && (!image.complete || !image.naturalWidth)).map(image => image.getAttribute('src')), notice: document.getElementById('notice').textContent })`);
      assert.equal(metrics.width, size.width);
      assert.ok(metrics.visible, `${tab} is hidden`);
      assert.ok(metrics.scrollWidth <= size.width, `${tab} at ${size.width}px overflows horizontally (${metrics.scrollWidth}px)`);
      assert.deepEqual(metrics.brokenImages, [], `${tab} has broken images`);
      assert.equal(metrics.notice, '', `${tab} displays an error`);
      receipt.checks.push({ tab, width: size.width, horizontalOverflow: false, brokenImages: false });
    }
  }
  await selectTab('workspace');
  await screenshot('mobile.png');

  // Exercise the normal visible plan controls after the clean guide captures.
  await viewport(1280, 960);
  await evaluate('[...document.querySelectorAll("#run-form button")].find(button => button.textContent.includes("Plan this task first")).click()');
  await until('document.getElementById("activity").textContent.includes("Plan saved.") && [...document.getElementById("agent-select").options].some(option => option.value.startsWith("team:plan-"))', 'offline plan proposal');
  const state = async () => {
    const response = await fetch(`${origin}/api/state`, { headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const planned = await state();
  assert.equal(planned.runs.length, 0, 'Planning must not start agent runs');
  assert.equal(planned.workflows.length, 0, 'Planning must not execute the workflow');
  const proposal = planned.jobs.find(job => job.plan);
  assert.equal(proposal?.status, 'planned');
  assert.deepEqual(proposal.plan.steps.map(step => step.agent), ['architect', 'coder', 'reviewer']);
  assert.equal(proposal.plan.steps.find(step => step.agent === 'coder').approval, true);
  await evaluate('document.getElementById("agent-select").value = [...document.getElementById("agent-select").options].find(option => option.value.startsWith("team:plan-")).value; document.getElementById("run-form").requestSubmit()');
  await until('document.querySelector("#approvals .approval")?.textContent.includes("step-2")', 'implementation-step approval');
  const waiting = await state();
  assert.equal(waiting.runs.length, 1, 'Only the read-only architect should run before approval');
  assert.equal(waiting.runs[0].agent, 'architect');
  assert.equal(waiting.approvals.length, 1);
  assert.equal(waiting.approvals[0].request.type, 'workflow');
  await evaluate('[...document.querySelectorAll("#approvals button")].find(button => button.textContent === "Approve").click()');
  await until('document.getElementById("activity").textContent.startsWith("Task status: completed") && !document.querySelector("#approvals .approval")', 'offline plan execution');
  const completed = await state();
  assert.equal(completed.runs.length, 3);
  assert.ok(completed.runs.every(run => run.status === 'completed'));
  assert.equal(completed.workflows.length, 1);
  assert.equal(completed.workflows[0].status, 'completed');
  receipt.checks.push({ flow: 'offline-task-planning', proposalDoesNotExecute: true, implementationRequiresApproval: true, completedAgentRuns: 3 });

  for (const size of [{ width: 1280, height: 960 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await viewport(size.width, size.height);
    await connection.send('Page.navigate', { url: `${origin}/guide` });
    await until('Boolean(document.querySelector(".guide-page"))', 'visual guide');
    const count = await evaluate('document.images.length');
    assert.ok(count >= 5, 'Visual guide should contain its diagrams and screenshots');
    // Scrolling genuinely loads lazy images without replacing or mocking the DOM.
    for (let index = 0; index < count; index++) {
      await evaluate(`document.images[${index}].scrollIntoView({ block: 'center' })`);
      await until(`document.images[${index}].complete && document.images[${index}].naturalWidth > 0`, `guide image ${index + 1}`);
    }
    await evaluate('window.scrollTo(0, 0)');
    const metrics = await evaluate('({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, brokenImages: [...document.images].filter(image => !image.complete || !image.naturalWidth).map(image => image.getAttribute("src")) })');
    assert.equal(metrics.width, size.width);
    assert.ok(metrics.scrollWidth <= size.width, `Guide at ${size.width}px overflows horizontally (${metrics.scrollWidth}px)`);
    assert.deepEqual(metrics.brokenImages, [], 'Guide has broken illustrations');
    receipt.checks.push({ page: 'guide', width: size.width, horizontalOverflow: false, decodedImages: count });
  }
  assert.deepEqual(blocked, [], 'Dashboard attempted to fetch an external asset');
  assert.deepEqual(pageErrors, [], 'Dashboard threw a browser exception');
  receipt.verified = true;
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  connection?.close();
  if (chrome && chrome.exitCode === null && chrome.pid) {
    const exited = once(chrome, 'exit').catch(() => {});
    chrome.kill('SIGTERM');
    await Promise.race([exited, pause(3000)]);
    if (chrome.exitCode === null) { chrome.kill('SIGKILL'); await exited; }
  }
  await server?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt, null, 2));
