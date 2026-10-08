import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildDesktop, desktopBinary } from './build-desktop.js';
import { runProcess } from '../src/process.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = path.join(root, 'dist', 'NexusIDE.app');
const contents = path.join(app, 'Contents');
const executable = path.join(contents, 'MacOS', 'NexusIDE');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleExecutable</key><string>NexusIDE</string>
<key>CFBundleIdentifier</key><string>dev.nexuside.desktop</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>NexusIDE</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`;

export async function packageDesktop({ identity = process.env.NEXUS_CODESIGN_IDENTITY || '-' } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS packaging must run on macOS.');
  await buildDesktop();
  await rm(app, { recursive: true, force: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await copyFile(desktopBinary, executable); await chmod(executable, 0o755);
  await writeFile(path.join(contents, 'Info.plist'), plist);
  const signed = await runProcess('/usr/bin/codesign', ['--force', '--deep', '--sign', identity, app], { timeoutMs: 120000, maxBytes: 30000 });
  if (signed.code !== 0) throw new Error(`Code signing failed.\n${signed.output}`);
  const verified = await runProcess('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { timeoutMs: 120000, maxBytes: 30000 });
  if (verified.code !== 0) throw new Error(`Code signature verification failed.\n${verified.output}`);
  const dmg = path.join(root, 'dist', 'NexusIDE-0.2.0.dmg');
  await rm(dmg, { force: true });
  const image = await runProcess('/usr/bin/hdiutil', ['create', '-volname', 'NexusIDE', '-srcfolder', app, '-ov', '-format', 'UDZO', dmg], { timeoutMs: 120000, maxBytes: 30000 });
  if (image.code !== 0) throw new Error(`Disk image creation failed.\n${image.output}`);
  return { app, dmg, identity: identity === '-' ? 'ad-hoc' : identity };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await packageDesktop(), null, 2));
