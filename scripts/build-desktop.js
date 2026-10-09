import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/process.js';
import { MINIMUM_MACOS } from './desktop-package-utils.js';

export const desktopBinary = fileURLToPath(new URL('../dist/NexusIDE-host', import.meta.url));
export const desktopAppBinary = fileURLToPath(new URL('../dist/NexusIDE.app/Contents/MacOS/NexusIDE', import.meta.url));
export async function buildDesktop({ output = desktopBinary } = {}) {
  if (process.platform !== 'darwin') throw new Error('The native desktop host currently requires macOS. Use nexus serve on other platforms.');
  await mkdir(fileURLToPath(new URL('../dist/', import.meta.url)), { recursive: true });
  const source = fileURLToPath(new URL('../desktop/macos/NexusDesktop.swift', import.meta.url));
  const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : null;
  if (!architecture) throw new Error('Unsupported macOS build architecture.');
  const result = await runProcess('/usr/bin/xcrun', ['swiftc', '-target', `${architecture}-apple-macosx${MINIMUM_MACOS}`, source, '-o', output, '-framework', 'AppKit', '-framework', 'WebKit'], { timeoutMs: 120000, maxBytes: 30000 });
  if (result.code !== 0) throw new Error(`Desktop compilation failed. Install matching Xcode Command Line Tools.\n${result.output}`);
  return output;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await buildDesktop());
