// Regenerate the native icon from the canonical SVG without a raster dependency.
// Uses an isolated headless Chrome profile; never touches an existing browser.
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { commandEnvironment, runProcess } from '../src/process.js';

if (process.platform !== 'darwin') throw new Error('Native icon generation requires macOS sips and iconutil. The generated icon is committed for other platforms.');
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'nexus-brand-'));
const chrome = process.env.NEXUS_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function checked(command, args) {
  const result = await runProcess(command, args, { timeoutMs: 30000, maxBytes: 20000 });
  if (result.code !== 0) throw new Error(`${path.basename(command)}: ${result.output}`);
}
async function renderIcon(args, png) {
  const browser = spawn(chrome, args, { env: commandEnvironment(), detached: true, stdio: 'ignore' });
  let launchError;
  browser.once('error', error => { launchError = error; });
  const exited = once(browser, 'exit').catch(() => {});
  try {
    // Some macOS Chrome versions stay alive after --screenshot. Wait for a
    // complete PNG, then stop only this newly spawned process group.
    for (let attempt = 0; attempt < 150; attempt++) {
      if (launchError) throw launchError;
      try {
        const bytes = await readFile(png);
        if (bytes.length > 24 && bytes.subarray(-8).toString('hex') === '49454e44ae426082') return;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (browser.exitCode !== null) throw new Error('Chrome exited without producing an icon.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Chrome icon capture timed out.');
  } finally {
    if (browser.pid) {
      try { process.kill(-browser.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
      try { process.kill(-browser.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}
try {
  const symbol = await readFile(path.join(root, 'ui/brand/nexus-symbol.svg'), 'utf8');
  const html = path.join(temporary, 'icon.html');
  const png = path.join(temporary, 'icon.png');
  await writeFile(html, `<!doctype html><html><head><style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden;background:transparent}.tile{position:absolute;inset:72px;border-radius:198px;display:grid;place-items:center;background:linear-gradient(145deg,#293755,#171d30 52%,#10131d);box-shadow:inset 0 2px 3px #a3b9ef45,inset 0 0 0 2px #667dab66,0 17px 24px #00000038}.tile svg{width:650px;height:650px;filter:drop-shadow(0 12px 20px #080f2160)}</style></head><body><div class="tile">${symbol}</div></body></html>`);
  await renderIcon(['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--default-background-color=00000000', '--window-size=1024,1024', `--user-data-dir=${path.join(temporary, 'profile')}`, `--screenshot=${png}`, pathToFileURL(html).href], png);
  const dimensions = await readFile(png);
  if (dimensions.readUInt32BE(16) !== 1024 || dimensions.readUInt32BE(20) !== 1024) throw new Error('Icon raster dimensions must be 1024 × 1024.');
  const iconset = path.join(temporary, 'NexusIDE.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      await checked('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), png, '--out', path.join(iconset, name)]);
    }
  }
  const icns = path.join(temporary, 'NexusIDE.icns');
  await checked('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icns]);
  await copyFile(png, path.join(root, 'ui/brand/nexus-app-icon.png'));
  await copyFile(icns, path.join(root, 'ui/brand/NexusIDE.icns'));
  console.log('Generated ui/brand/nexus-app-icon.png and NexusIDE.icns from nexus-symbol.svg.');
} finally { await rm(temporary, { recursive: true, force: true }); }
