// Curated Hallmark-inspired checks, against a disposable Nexus workspace.
// This is a repeatable engineering audit, not a substitute for VoiceOver/manual review.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import { installAgent, defaults } from '../src/agents.js';
import { createVisualArtifact } from '../src/artifacts.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(repository, '.nexus/verification/ui-quality');
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nexus-ui-quality-')));
const root = path.join(base, 'project'), profile = path.join(base, 'browser');
const chromePath = process.env.NEXUS_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const receipt = { version: 1, at: new Date().toISOString(), verified: false, syntheticWorkspace: true, widths: [360, 390, 768, 1280], checks: [], failures: [], browserErrors: [], screenshots: [], limitations: ['Rendered checks cover the synthetic empty/default states and a synthetic chart.', 'Accessible names use labels/ARIA/text; this is not a full accessibility-tree or VoiceOver audit.', 'Contrast samples cover visible text controls on solid computed backgrounds; images and gradients need manual review.', 'Screenshots do not establish model accuracy or external service behavior.'] };
let server, chrome, socket, sequence = 0;
const pending = new Map();
async function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}
async function until(expression) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { if (await evaluate(expression)) return; await pause(100); }
  throw new Error('Dashboard did not reach the expected state.');
}

// Runs within the controlled synthetic browser page; never opens private user tabs.
const inspect = `(() => {
  const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const name = e => e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim() || [...(e.labels || [])].map(l => l.textContent).join(' ').trim() || ((e.matches('button,a') || ['submit','button','reset'].includes(e.type)) ? e.textContent.trim() || e.value : '') || e.getAttribute('title') || '';
  const controls = [...document.querySelectorAll('button,input:not([type=hidden]),textarea,select,a[href]')].filter(visible);
  const unnamed = controls.filter(e => !name(e)).map(e => e.id || e.outerHTML.slice(0,160));
  const rgba = text => { const m = text.match(/^rgba?\\(([^)]+)\\)$/); return m ? m[1].split(/[, ]+/).filter(Boolean).map(Number) : null; };
  const composite = (top, bottom) => { const a = top[3] ?? 1; return [0,1,2].map(i => top[i] * a + bottom[i] * (1-a)).concat(1); };
  const background = e => { const chain=[]; for(let n=e;n;n=n.parentElement) chain.unshift(n); let color=[255,255,255,1]; for(const n of chain) { const s=getComputedStyle(n); if(s.backgroundImage !== 'none') return null; const c=rgba(s.backgroundColor); if(c) color=composite(c,color); } return color; };
  const luminance = c => c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
  const contrast=[];
  for(const e of [...document.querySelectorAll('h1,h2,label,.primary,.secondary,p,small')].filter(visible).filter(e=>!e.disabled && e.textContent.trim()).slice(0,140)) {
    const style=getComputedStyle(e), bg=background(e), fg=rgba(style.color); if(!bg || !fg || +style.opacity<1) continue;
    const a=luminance(composite(fg,bg)), b=luminance(bg), ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05), large=parseFloat(style.fontSize)>=24 || (parseFloat(style.fontSize)>=18.66 && +style.fontWeight>=700), required=large?3:4.5;
    contrast.push({element:e.id || e.tagName.toLowerCase()+'.'+e.className,ratio:+ratio.toFixed(2),required,text:e.textContent.trim().slice(0,90)});
  }
  const moving=[...document.querySelectorAll('*')].filter(visible).filter(e=>{const s=getComputedStyle(e);return [...s.animationDuration.split(','),...s.transitionDuration.split(',')].some(v=>parseFloat(v)>.001)}).map(e=>e.id||e.tagName);
  return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,unnamed,contrastFailures:contrast.filter(c=>c.ratio+.01<c.required),contrastSamples:contrast.length,controls:controls.length,controlIds:controls.map(e=>e.id).filter(Boolean),moving,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches};
})()`;

try {
  await mkdir(root); await mkdir(output, { recursive: true });
  await writeFile(path.join(root, 'example.txt'), 'Synthetic UI audit file.\n');
  for (const agent of defaults) await installAgent(root, agent);
  await createVisualArtifact(root, { version: 1, kind: 'bar', title: 'Synthetic UI check', xLabel: 'Group', yLabel: 'Count', xUnit: 'category', yUnit: 'items', sources: [{ label: 'Synthetic test fixture' }], data: [{ label: 'A', y: 2 }, { label: 'B', y: 4 }] });
  server = await startServer({ root, port: 0 });
  chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  let startError; chrome.once('error', error => { startError = error; });
  let port;
  const started = Date.now();
  while (!port && Date.now() - started < 10000) { if (startError) throw startError; try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await pause(100); } }
  if (!port) throw new Error('Chrome did not start within ten seconds.');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') receipt.browserErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') receipt.browserErrors.push(message.params.args.map(a => a.value ?? a.description).join(' '));
    if (message.method === 'Fetch.requestPaused') {
      const allowed = new URL(message.params.request.url).origin === new URL(server.url).origin;
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: message.params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => {});
    }
    const waiter = pending.get(message.id); if (!waiter) return;
    clearTimeout(waiter.timer); pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: server.url });
  await until('Boolean(document.querySelector("#stats .stat"))');
  const tabs = await evaluate('[...document.querySelectorAll("[data-tab]")].map(e=>e.dataset.tab)');
  for (const width of receipt.widths) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (const tab of tabs) {
      await evaluate(`document.querySelector('[data-tab="${tab}"]').click()`);
      await until(`!document.getElementById(${JSON.stringify(tab)}).hidden`); await pause(75);
      const metrics = await evaluate(inspect);
      const issues = [];
      if (metrics.scrollWidth > width) issues.push(`horizontal overflow ${metrics.scrollWidth}px`);
      if (metrics.unnamed.length) issues.push(`${metrics.unnamed.length} unnamed visible controls`);
      if (!metrics.reducedMotion || metrics.moving.length) issues.push('reduced motion not respected');
      if (metrics.contrastFailures.length) issues.push(`${metrics.contrastFailures.length} sampled contrast failures`);
      const check = { width, tab, ...metrics, issues }; receipt.checks.push(check);
      if (issues.length) receipt.failures.push({ width, tab, issues });
    }
    await evaluate('document.querySelector("[data-tab=visualizations]").click()');
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const filename = `visualizations-${width}.png`; await writeFile(path.join(output, filename), Buffer.from(shot.data, 'base64')); receipt.screenshots.push(filename);
  }
  await evaluate('document.querySelector("[data-tab=workspace]").focus()');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  receipt.keyboardFocus = await evaluate('({tab:document.activeElement.dataset.tab,outline:getComputedStyle(document.activeElement).outlineStyle,width:parseFloat(getComputedStyle(document.activeElement).outlineWidth)})');
  if (receipt.keyboardFocus.tab !== tabs[1] || receipt.keyboardFocus.outline === 'none' || receipt.keyboardFocus.width < 1) receipt.failures.push({ issues: ['Keyboard tab movement or visible focus failed'] });
  const finalTabs = await evaluate('[...document.querySelectorAll("[data-tab]")].map(e=>e.dataset.tab)');
  if (JSON.stringify(finalTabs) !== JSON.stringify(tabs)) receipt.failures.push({ issues: ['Navigation controls changed during audit'] });
  receipt.verified = receipt.failures.length === 0 && receipt.browserErrors.length === 0;
  if (!receipt.verified) process.exitCode = 1;
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally {
  socket?.close(); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('UI audit closed.')); } pending.clear();
  if (chrome?.pid && chrome.exitCode === null) { const exit = once(chrome, 'exit'); chrome.kill('SIGTERM'); await Promise.race([exit, pause(3000)]); if (chrome.exitCode === null) chrome.kill('SIGKILL'); }
  await server?.close(); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); await rm(base, { recursive: true, force: true });
}
console.log(JSON.stringify({ verified: receipt.verified, checks: receipt.checks.length, failures: receipt.failures, browserErrors: receipt.browserErrors, error: receipt.error, receipt: path.join(output, 'receipt.json') }, null, 2));
