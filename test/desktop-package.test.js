import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertContainedSymlinks, assertDeploymentTarget, assertRuntimeMetadata, assertSystemLibraries, copyPayload, publishArtifacts, safeVersion } from '../scripts/desktop-package-utils.js';
import { applicationPlist } from '../scripts/package-desktop.js';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('packaging validates the tested Node line, platform and architecture', () => {
  assertRuntimeMetadata({ version: 'v22.18.0', platform: 'darwin', arch: 'arm64' }, 'arm64');
  assertRuntimeMetadata({ version: 'v22.23.3', platform: 'darwin', arch: 'x64' }, 'x64');
  for (const bad of [{ version: 'v22.17.0' }, { version: 'v24.0.0' }, { platform: 'linux' }, { arch: 'x64' }]) assert.throws(() => assertRuntimeMetadata({ version: 'v22.18.0', platform: 'darwin', arch: 'arm64', ...bad }, 'arm64'));
});

test('packaging rejects Homebrew, relative and rpath dynamic library dependencies', () => {
  assert.deepEqual(assertSystemLibraries('node:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n'), ['/usr/lib/libSystem.B.dylib']);
  for (const name of ['/opt/homebrew/opt/lib/libtest.dylib', '@rpath/libtest.dylib', '@loader_path/libtest.dylib', 'libtest.dylib']) assert.throws(() => assertSystemLibraries(`node:\n\t${name} (compatibility version 1.0.0)\n`), /Non-system/);
  assert.throws(() => assertSystemLibraries('not a Mach-O binary'), /inspect/);
});

test('minimum deployment target ignores SDK and dependency version numbers', () => {
  assertDeploymentTarget('Load command 1\n cmd LC_BUILD_VERSION\n minos 11.0\n sdk 15.0\n ntools 1\n tool 3\n version 1115.7.3\nLoad command 2\n cmd LC_LOAD_DYLIB\n current version 1.0\n');
  assertDeploymentTarget('Load command 1\n cmd LC_BUILD_VERSION\n cmdsize 32\n platform 1\n minos 13.0\n sdk 27.0\nLoad command 2\n cmd LC_LOAD_DYLIB\n current version 3038.1.0\n');
  assertDeploymentTarget('Load command 1\n cmd LC_VERSION_MIN_MACOSX\n version 11.0\n sdk 15.0\n');
  assert.throws(() => assertDeploymentTarget('cmd LC_BUILD_VERSION\n minos 14.0\n'), /newer macOS/);
  assert.throws(() => assertDeploymentTarget('cmd LC_LOAD_DYLIB\n current version 1.0\n'), /newer macOS/);
});

test('application metadata is versioned, architecture-specific and free of source paths', () => {
  const plist = applicationPlist('0.2.0', 'arm64');
  assert.match(plist, /LSMinimumSystemVersion<\/key><string>13\.0/);
  assert.match(plist, /CFBundleShortVersionString<\/key><string>0\.2\.0/);
  assert.match(plist, /CFBundleIconFile<\/key><string>NexusIDE\.icns/);
  assert.doesNotMatch(plist, /Users\/|Downloads\//);
  assert.throws(() => safeVersion('../escape'));
  assert.throws(() => applicationPlist('0.2.0</string>', 'arm64'));
  assert.throws(() => applicationPlist('0.2.0', '<xml>'));
});

test('committed native icon assets are valid containers at the expected size', async () => {
  const icon = await readFile(new URL('../ui/brand/NexusIDE.icns', import.meta.url));
  assert.equal(icon.subarray(0, 4).toString(), 'icns');
  assert.equal(icon.readUInt32BE(4), icon.length);
  const raster = await readFile(new URL('../ui/brand/nexus-app-icon.png', import.meta.url));
  assert.equal(raster.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(raster.readUInt32BE(16), 1024);
  assert.equal(raster.readUInt32BE(20), 1024);
});

test('positive payload allowlist excludes private state and developer dependencies', async t => {
  const root = await temporary(t), source = path.join(root, 'source'), destination = path.join(root, 'bundle');
  await mkdir(path.join(source, 'src'), { recursive: true });
  await mkdir(path.join(source, '.nexus'), { recursive: true });
  await writeFile(path.join(source, 'src', 'main.js'), 'public');
  await writeFile(path.join(source, '.nexus', 'secret'), 'private');
  await writeFile(path.join(source, '.env'), 'private');
  await copyPayload(source, destination, { directories: ['src'], files: [] });
  assert.deepEqual(await readdir(destination), ['src']);
  assert.equal(await readFile(path.join(destination, 'src', 'main.js'), 'utf8'), 'public');
  await assert.rejects(copyPayload(source, destination, { directories: ['../'], files: [] }), /contained/);
  await writeFile(path.join(source, 'src', '.env'), 'nested-private-value');
  await assert.rejects(copyPayload(source, destination, { directories: ['src'], files: [] }), /Private or generated/);
});

test('source symlinks are never followed into a distributable', async t => {
  const root = await temporary(t);
  await symlink(os.tmpdir(), path.join(root, 'src'));
  await assert.rejects(copyPayload(root, path.join(root, 'out'), { directories: ['src'], files: [] }), /symlinks/);
});

test('dependency executable symlinks may only resolve inside the app', async t => {
  const root = await temporary(t), bundle = path.join(root, 'bundle');
  await mkdir(bundle); await writeFile(path.join(bundle, 'tool'), 'public');
  await symlink('tool', path.join(bundle, 'safe'));
  await assertContainedSymlinks(bundle);
  await symlink(os.tmpdir(), path.join(bundle, 'unsafe'));
  await assert.rejects(assertContainedSymlinks(bundle), /escapes/);
});

test('successful publication retains previous artifacts in a recoverable directory', async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'release.dmg'), 'old'); await writeFile(path.join(root, 'new.dmg'), 'new');
  const backup = await publishArtifacts([{ source: path.join(root, 'new.dmg'), name: 'release.dmg' }], root);
  assert.equal(await readFile(path.join(root, 'release.dmg'), 'utf8'), 'new');
  assert.equal(await readFile(path.join(backup, 'release.dmg'), 'utf8'), 'old');
});

test('failed multi-artifact publication restores every prior artifact', async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'release.app'), 'old app'); await writeFile(path.join(root, 'release.dmg'), 'old image'); await writeFile(path.join(root, 'new.app'), 'new app');
  await assert.rejects(publishArtifacts([{ source: path.join(root, 'new.app'), name: 'release.app' }, { source: path.join(root, 'missing.dmg'), name: 'release.dmg' }], root), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'release.app'), 'utf8'), 'old app');
  assert.equal(await readFile(path.join(root, 'release.dmg'), 'utf8'), 'old image');
});
