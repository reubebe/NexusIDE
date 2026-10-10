import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRehearsalReceipt, rehearseLifecycle, rehearsalEnvironment, validateReleaseArtifacts, validateReleaseReport, verifyRelease } from '../scripts/verify-release.js';
import { sha256 } from '../scripts/desktop-package-utils.js';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function metadata() {
  return {
    version: '0.2.0', arch: 'arm64', minimumMacOS: '13.0', builtAt: '2026-10-09T12:00:00.000Z', signing: 'ad-hoc', notarized: false,
    runtime: { version: 'v22.18.0', arch: 'arm64', platform: 'darwin', modules: '127' },
    sourceRevision: 'a'.repeat(40), sourceDirty: false, lockfileSha256: '0'.repeat(64),
  };
}

function reportFor(manifest = metadata()) {
  return { ...manifest, bundledNodeSha256: '1'.repeat(64), dmgSha256: '2'.repeat(64), checks: ['code-signature', 'disk-image-integrity'] };
}

async function fixture(root) {
  const appPath = path.join(root, 'NexusIDE.app'), reportPath = path.join(root, 'release.json'), dmgPath = path.join(root, 'release.dmg');
  const resources = path.join(appPath, 'Contents/Resources');
  await mkdir(path.join(resources, 'runtime/bin'), { recursive: true });
  await mkdir(path.join(resources, 'app'), { recursive: true });
  await writeFile(path.join(resources, 'runtime/bin/node'), 'fixture runtime, not executable');
  await writeFile(path.join(resources, 'app/package-lock.json'), '{"lockfileVersion":3}');
  await writeFile(dmgPath, 'fixture dmg');
  const manifest = metadata();
  manifest.lockfileSha256 = await sha256(path.join(resources, 'app/package-lock.json'));
  await writeFile(path.join(resources, 'build-manifest.json'), JSON.stringify(manifest));
  const report = { ...reportFor(manifest), bundledNodeSha256: await sha256(path.join(resources, 'runtime/bin/node')), dmgSha256: await sha256(dmgPath) };
  await writeFile(reportPath, JSON.stringify(report));
  return { appPath, reportPath, dmgPath, manifest, report };
}

test('release reports distinguish valid development and finalized signed artifact metadata', () => {
  const manifest = metadata();
  assert.equal(validateReleaseReport(reportFor(manifest), manifest).signing, 'ad-hoc');
  const signed = { ...manifest, signing: 'developer-id', signingMode: 'release', hardenedRuntime: true, signingIdentity: 'A'.repeat(40), teamId: 'AB12345678' };
  assert.equal(validateReleaseReport({ ...reportFor(signed), notarized: true }, signed).notarized, true);
  assert.throws(() => validateReleaseReport({ ...reportFor(manifest), notarized: true }, manifest), /Ad-hoc/);
  assert.throws(() => validateReleaseReport({ ...reportFor(signed), teamId: 'BA12345678' }, signed), /teamId/);
  assert.throws(() => validateReleaseReport({ ...reportFor(signed), hardenedRuntime: false }, { ...signed, hardenedRuntime: false }), /hardenedRuntime/);
  assert.throws(() => validateReleaseReport({ ...reportFor(manifest), signing: 'developer-id' }, { ...manifest, signing: 'developer-id' }), /signing/);
});

test('release report schema rejects missing fields, mismatched source and forged digest shapes', () => {
  const manifest = metadata(), report = reportFor(manifest);
  for (const change of [
    { version: '../escape' }, { arch: 'unknown' }, { signing: 'signed' }, { notarized: 'yes' },
    { lockfileSha256: 'invalid' }, { dmgSha256: 'bad' }, { builtAt: 'invalid' },
    { sourceRevision: 'main' }, { sourceDirty: 'false' }, { checks: 'passed' },
    { runtime: { ...manifest.runtime, version: 'v20.10.0' } },
  ]) assert.throws(() => validateReleaseReport({ ...report, ...change }, manifest));
  assert.throws(() => validateReleaseReport({ ...report, sourceRevision: 'b'.repeat(40) }, manifest), /sourceRevision/);
  assert.throws(() => validateReleaseReport(null, manifest), /object/);
});

test('artifact validation hashes actual report, DMG, bundled Node and lockfile without execution', async t => {
  const files = await fixture(await temporary(t));
  const result = await validateReleaseArtifacts(files);
  assert.equal(result.reportSha256, await sha256(files.reportPath));
  await writeFile(files.dmgPath, 'tampered');
  await assert.rejects(validateReleaseArtifacts(files), /dmgSha256/);
});

test('artifact validation rejects tampered runtime/lockfile and escaping symlinks', async t => {
  const files = await fixture(await temporary(t));
  const node = path.join(files.appPath, 'Contents/Resources/runtime/bin/node');
  await writeFile(node, 'tampered');
  await assert.rejects(validateReleaseArtifacts(files), /bundledNodeSha256/);
  await writeFile(node, 'fixture runtime, not executable');
  await writeFile(path.join(files.appPath, 'Contents/Resources/app/package-lock.json'), '{}');
  await assert.rejects(validateReleaseArtifacts(files), /lockfileSha256/);
  await symlink(os.tmpdir(), path.join(files.appPath, 'external'));
  await assert.rejects(validateReleaseArtifacts(files), /escapes/);
});

test('rehearsal evidence never promotes development-machine checks into clean-machine certification', () => {
  const receipt = createRehearsalReceipt();
  assert.equal(receipt.verified, false);
  assert.equal(receipt.cleanMachineVerified, false);
  assert.equal(receipt.releaseCertified, false);
  assert.equal(receipt.environment.kind, 'development-machine-rehearsal');
  assert.equal(receipt.unperformed.length, 8);
  assert.ok(receipt.unperformed.every(check => check.status === 'not-run' && check.reason));
});

test('rehearsal environment excludes provider keys, developer PATH, inherited node options and real HOME', () => {
  const env = rehearsalEnvironment('/synthetic-release');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'NODE_NO_WARNINGS', 'PATH', 'TMPDIR'].sort());
  assert.equal(env.HOME, '/synthetic-release/Home');
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.notEqual(env.HOME, os.homedir());
});

function fixtureDriver({ corruptUpgrade = false } = {}) {
  const launches = [], record = { id: 'fixture-run', status: 'completed', agent: 'architect', usage: { input: 0, output: 0 } };
  return {
    launches,
    async launch(app, workspace, dataRoot) {
      launches.push({ app, workspace, dataRoot, version: await readFile(path.join(app, 'version.txt'), 'utf8') });
      await mkdir(path.join(workspace, '.nexus/agents'), { recursive: true });
      await mkdir(path.join(dataRoot, '.nexus/desktop'), { recursive: true });
      try { await writeFile(path.join(workspace, '.nexus/agents/architect.json'), '{"name":"architect","instructions":"user customization"}', { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await writeFile(path.join(dataRoot, '.nexus/desktop/settings.json'), JSON.stringify({ lastWorkspace: workspace }));
      if (corruptUpgrade && launches.length === 3) await writeFile(path.join(workspace, 'README.md'), 'wrong');
    },
    async seed(app, workspace) { await writeFile(path.join(workspace, '.nexus/run.json'), JSON.stringify(record)); return record.id; },
    async readRun(app, workspace) { return JSON.parse(await readFile(path.join(workspace, '.nexus/run.json'), 'utf8')); },
  };
}

test('isolated install, relaunch, upgrade, app removal and backup restoration preserve user fixtures', async t => {
  const root = await temporary(t), appPath = path.join(root, 'Current.app'), previousAppPath = path.join(root, 'Previous.app');
  await mkdir(appPath); await mkdir(previousAppPath);
  await writeFile(path.join(appPath, 'version.txt'), '0.2.0'); await writeFile(path.join(previousAppPath, 'version.txt'), '0.1.0');
  const driver = fixtureDriver(), checks = [];
  const result = await rehearseLifecycle({ appPath, previousAppPath, driver, onCheck: name => checks.push(name) });
  assert.equal(result.temporaryDataRemoved, true);
  assert.deepEqual(driver.launches.map(value => value.version), ['0.1.0', '0.1.0', '0.2.0', '0.2.0', '0.2.0']);
  assert.equal(checks.length, 6);
  assert.ok(checks.includes('uninstall-app-retains-project-and-application-data'));
  assert.ok(checks.includes('closed-state-backup-and-separate-location-restore'));
  assert.notEqual(driver.launches[4].workspace, driver.launches[0].workspace);
  await assert.rejects(readFile(path.join(driver.launches[0].workspace, 'README.md')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(appPath, 'version.txt'), 'utf8'), '0.2.0');
  assert.equal(await readFile(path.join(previousAppPath, 'version.txt'), 'utf8'), '0.1.0');
});

test('lifecycle fails on lost user state and still cleans only its isolated temporary directory', async t => {
  const root = await temporary(t), appPath = path.join(root, 'Current.app');
  await mkdir(appPath); await writeFile(path.join(appPath, 'version.txt'), '0.2.0');
  const driver = fixtureDriver({ corruptUpgrade: true });
  await assert.rejects(rehearseLifecycle({ appPath, driver }), /wrong/);
  await assert.rejects(readFile(path.join(driver.launches[0].workspace, 'README.md')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(appPath, 'version.txt'), 'utf8'), '0.2.0');
});

test('invalid artifact evidence reports failure before native tools or lifecycle execution', async t => {
  const files = await fixture(await temporary(t));
  await writeFile(files.dmgPath, 'tampered');
  const receipt = await verifyRelease(files);
  assert.equal(receipt.verified, false);
  assert.equal(receipt.cleanMachineVerified, false);
  assert.equal(receipt.checks.length, 1);
  assert.equal(receipt.checks[0].name, 'artifact-metadata-and-digests');
  assert.match(receipt.checks[0].error, /dmgSha256/);
});
