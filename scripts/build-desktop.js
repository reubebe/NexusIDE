import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/process.js';

export const desktopBinary = fileURLToPath(new URL('../dist/NexusIDE-host', import.meta.url));
export async function buildDesktop() {
  if (process.platform !== 'darwin') throw new Error('The native desktop host currently requires macOS. Use nexus serve on other platforms.');
  await mkdir(fileURLToPath(new URL('../dist/', import.meta.url)), { recursive: true });
  const source = fileURLToPath(new URL('../desktop/macos/NexusDesktop.swift', import.meta.url));
  const result = await runProcess('/usr/bin/xcrun', ['swiftc', source, '-o', desktopBinary, '-framework', 'AppKit', '-framework', 'WebKit'], { timeoutMs: 120000, maxBytes: 30000 });
  if (result.code !== 0) throw new Error(`Desktop compilation failed. Install matching Xcode Command Line Tools.\n${result.output}`);
  return desktopBinary;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await buildDesktop());
