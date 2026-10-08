import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { writeState } from '../src/state.js';

const chromePath = process.env.NEXUS_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = process.cwd();
const profile = await mkdtemp(path.join(os.tmpdir(), 'nexus-responsive-'));
const images = path.join(root, '.nexus', 'verification', 'responsive');
const receipt = { at: new Date().toISOString(), verified: false, chromePath, checks: [] };
let server, chrome;

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});
const waitFor = async url => {
  for (let i = 0; i < 80; i++) {
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Chrome DevTools did not become ready.');
};
const connect = async endpoint => {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id; pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  return { socket, send };
};

try {
  server = await startServer({ root, port: 0 });
  const port = await freePort();
  chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  const targets = await waitFor(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find(item => item.type === 'page' && item.url === 'about:blank') || targets.find(item => item.type === 'page');
  if (!target) throw new Error('Chrome did not expose a page target.');
  const { socket, send } = await connect(target.webSocketDebuggerUrl);
  await mkdir(images, { recursive: true });
  for (const viewport of [{ name: 'mobile', width: 390, height: 844, mobile: false }, { name: 'tablet', width: 768, height: 1024, mobile: false }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
    await send('Page.navigate', { url: server.url });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const evaluated = await send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,title:document.title,innerWidth,scrollWidth:document.documentElement.scrollWidth,heading:document.querySelector("h1")?.textContent,runButton:document.querySelector("#run-form [type=submit]")?.getBoundingClientRect().toJSON()})', returnByValue: true });
    const metrics = JSON.parse(evaluated.result.value);
    assert.equal(metrics.innerWidth, viewport.width);
    assert.ok(metrics.scrollWidth <= viewport.width, `${viewport.name} has horizontal overflow: ${metrics.scrollWidth}px > ${viewport.width}px`);
    assert.equal(metrics.heading, 'Agent workspace');
    assert.ok(metrics.runButton.x >= 0 && metrics.runButton.x + metrics.runButton.width <= viewport.width, `${viewport.name} run button is clipped`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(images, `${viewport.name}.png`), Buffer.from(shot.data, 'base64'));
    receipt.checks.push({ ...viewport, metrics });
  }
  socket.close();
  receipt.verified = true;
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  if (chrome && chrome.exitCode === null) { chrome.kill('SIGTERM'); await once(chrome, 'exit').catch(() => {}); }
  await server?.close();
  await rm(profile, { recursive: true, force: true });
  await writeState(root, 'verification', 'responsive.json', receipt);
}
console.log(JSON.stringify(receipt, null, 2));
