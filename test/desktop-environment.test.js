import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDesktop } from '../scripts/build-desktop.js';
import { applicationPlist } from '../scripts/package-desktop.js';
import { verifyNativeProviderEnvironment } from '../scripts/verify-bundled-desktop.js';

test('native desktop forwards default and numbered cloud accounts while excluding malformed keys and startup hooks', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nexus-native-environment-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const host = await buildDesktop({ output: path.join(temporary, 'NexusIDE-host') });
  await verifyNativeProviderEnvironment({ host, node: process.execPath, plist: applicationPlist('0.2.0', process.arch), temporary });
});
