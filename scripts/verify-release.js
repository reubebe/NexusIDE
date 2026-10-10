import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/process.js';
import { writeState } from '../src/state.js';
import { assertContainedSymlinks, assertRuntimeMetadata, safeVersion, sha256 } from './desktop-package-utils.js';
import { assertSignatureDetails, signingPolicy } from './macos-signing.js';

export const RELEASE_REHEARSAL_SUITE = 'nexus-release-rehearsal-v1';
const manifestPath = app => path.join(app, 'Contents/Resources/build-manifest.json');
const nodePath = app => path.join(app, 'Contents/Resources/runtime/bin/node');
const cliPath = app => path.join(app, 'Contents/Resources/app/src/cli.js');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// A report is a consistency record, not proof of publisher identity or a clean device.
export function validateReleaseReport(report, manifest) {
  for (const value of [report, manifest]) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Release metadata must be an object.');
    safeVersion(value.version);
    assert.ok(['ad-hoc', 'developer-id'].includes(value.signing), 'Unknown release signing mode.');
    assert.equal(typeof value.notarized, 'boolean', 'Notarization status must be explicit.');
    assert.ok(!(value.signing === 'ad-hoc' && value.notarized), 'Ad-hoc artifacts cannot claim notarization.');
    assertRuntimeMetadata(value.runtime, value.arch);
    assert.ok(/^\d+\.\d+(?:\.\d+)?$/.test(value.minimumMacOS || ''), 'Missing minimum macOS version.');
    assert.ok(Number.isFinite(Date.parse(value.builtAt)), 'Missing build timestamp.');
    assert.ok(hex(value.lockfileSha256), 'Invalid lockfile digest.');
    assert.ok(value.sourceRevision === null || /^[a-f0-9]{40,64}$/.test(value.sourceRevision || ''), 'Invalid source revision.');
    assert.ok(value.sourceDirty === null || typeof value.sourceDirty === 'boolean', 'Invalid source dirty status.');
    if (value.signing === 'developer-id' || ['signingMode', 'hardenedRuntime', 'signingIdentity', 'teamId'].some(field => field in value)) {
      const policy = signingPolicy({ mode: value.signingMode, identity: value.signingIdentity || '-', teamId: value.teamId || undefined });
      for (const field of Object.keys(policy)) assert.equal(value[field], policy[field], `Invalid signing policy field: ${field}.`);
    }
  }
  for (const field of ['version', 'arch', 'minimumMacOS', 'builtAt', 'signing', 'sourceRevision', 'sourceDirty', 'lockfileSha256', 'runtime']) {
    assert.deepEqual(report[field], manifest[field], `Report does not match the app: ${field}.`);
  }
  for (const field of ['signingMode', 'hardenedRuntime', 'signingIdentity', 'teamId']) {
    if (field in report || field in manifest) assert.deepEqual(report[field], manifest[field], `Report does not match the app: ${field}.`);
  }
  // The immutable, signed manifest can precede notarization; the external report is final.
  assert.ok(!manifest.notarized || report.notarized, 'Final report contradicts manifest notarization.');
  assert.ok(hex(report.bundledNodeSha256) && hex(report.dmgSha256), 'Invalid artifact digest.');
  assert.ok(Array.isArray(report.checks) && report.checks.every(value => typeof value === 'string'), 'Invalid build checks.');
  return { version: report.version, arch: report.arch, signing: report.signing, notarized: report.notarized };
}

export async function validateReleaseArtifacts({ appPath, reportPath, dmgPath }) {
  assert.ok((await lstat(appPath)).isDirectory(), 'Application must be a real directory.');
  assert.ok((await lstat(reportPath)).isFile() && (await lstat(dmgPath)).isFile(), 'Report and disk image must be regular files.');
  await assertContainedSymlinks(appPath);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const manifest = JSON.parse(await readFile(manifestPath(appPath), 'utf8'));
  const identity = validateReleaseReport(report, manifest);
  for (const [field, file] of [
    ['bundledNodeSha256', nodePath(appPath)], ['dmgSha256', dmgPath],
    ['lockfileSha256', path.join(appPath, 'Contents/Resources/app/package-lock.json')],
  ]) assert.equal(await sha256(file), report[field], `Artifact digest mismatch: ${field}.`);
  return { report, manifest, identity, reportSha256: await sha256(reportPath) };
}

export function createRehearsalReceipt() {
  return {
    schemaVersion: 1, suite: RELEASE_REHEARSAL_SUITE, at: new Date().toISOString(), verified: false,
    syntheticWorkspace: true, cleanMachineVerified: false, releaseCertified: false,
    environment: { kind: 'development-machine-rehearsal', platform: process.platform, arch: process.arch, osRelease: os.release() },
    checks: [],
    unperformed: [
      ['clean-machine-first-launch', 'Requires a clean Mac or fresh VM snapshot, not this development machine.'],
      ['download-quarantine-gatekeeper', 'Requires a real downloaded release and default Gatekeeper first launch; code signature verification is not equivalent.'],
      ['notarization-ticket-validation', 'Report notarization status is a claim; independent final-ticket validation belongs to the signing/clean-device acceptance workflow.'],
      ['fresh-user-no-developer-tools', 'A scrubbed subprocess PATH does not establish a fresh OS user or absence of installed tools.'],
      ['offline-network-disabled', 'The rehearsal uses demo mode with no provider calls, but does not disable the machine network.'],
      ['macos-permissions-and-denial', 'Requires interactive folder permission and denial/recovery checks on the clean device.'],
      ['native-ui-accessibility', 'Requires visual, keyboard and assistive-technology checks.'],
      ['supported-os-and-architectures', 'Requires native Intel/Apple Silicon and minimum/current macOS coverage for each advertised artifact.'],
    ].map(([name, reason]) => ({ name, status: 'not-run', reason })),
  };
}

export function rehearsalEnvironment(temporary) {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(temporary, 'Home'), TMPDIR: path.join(temporary, 'Temporary'), LANG: 'en_US.UTF-8', NODE_NO_WARNINGS: '1' };
}

async function checked(command, args, options) {
  const result = await runProcess(command, args, { timeoutMs: 45000, maxBytes: 100000, ...options });
  assert.equal(result.code, 0, `${path.basename(command)} failed (${result.stopped || result.code}). ${result.output}`);
  assert.equal(result.stopped, null);
  return result.output;
}

async function verifyApplicationSignature(app, manifest) {
  await checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  if (manifest.signingMode) {
    const policy = signingPolicy({ mode: manifest.signingMode, identity: manifest.signingIdentity || '-', teamId: manifest.teamId || undefined });
    for (const target of [app, nodePath(app)]) {
      const details = await checked('/usr/bin/codesign', ['-d', '--verbose=4', target]);
      assertSignatureDetails(details, policy);
    }
  }
}

function bundledDriver(env) {
  return {
    async launch(app, workspace, dataRoot) {
      const output = await checked(path.join(app, 'Contents/MacOS/NexusIDE'), ['--check-bootstrap', '--workspace', workspace, '--data-root', dataRoot], { cwd: workspace, env });
      const result = JSON.parse(output);
      assert.match(result.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' }, 'Native bootstrap left its service running.');
    },
    async seed(app, workspace) {
      await checked(nodePath(app), [cliPath(app), 'run', 'architect', 'Inspect the synthetic release rehearsal workspace.', '--demo'], { cwd: workspace, env });
      const listing = await checked(nodePath(app), [cliPath(app), 'status'], { cwd: workspace, env });
      const id = /architect\s+completed\s+([a-f0-9-]{36})/.exec(listing)?.[1];
      assert.ok(id, 'Demo run was not persisted.');
      return id;
    },
    async readRun(app, workspace, id) {
      return JSON.parse(await checked(nodePath(app), [cliPath(app), 'status', id], { cwd: workspace, env }));
    },
  };
}

// All writes and removals are beneath the fresh mkdtemp tree. Inputs are only copied.
// driver injection is for unit tests; the release entry point always uses real bundled executables.
export async function rehearseLifecycle({ appPath, previousAppPath, driver, onCheck = () => {} }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nexus-release-rehearsal-'));
  const env = rehearsalEnvironment(temporary);
  const execution = driver || bundledDriver(env);
  const workspace = path.join(temporary, 'Synthetic Workspace'), dataRoot = path.join(temporary, 'Application Data');
  const installed = path.join(temporary, 'Applications', 'NexusIDE.app');
  const note = 'Synthetic release rehearsal: preserve user-owned notes.\n';
  try {
    for (const directory of [workspace, dataRoot, env.HOME, env.TMPDIR, path.dirname(installed), path.join(temporary, 'Trash')]) await mkdir(directory, { recursive: true });
    await writeFile(path.join(workspace, 'README.md'), note);
    await cp(previousAppPath || appPath, installed, { recursive: true, verbatimSymlinks: true });
    await execution.launch(installed, workspace, dataRoot);
    onCheck('install-copy-and-native-bootstrap');
    const id = await execution.seed(installed, workspace);
    const saved = await execution.readRun(installed, workspace, id);
    assert.equal(saved.status, 'completed');
    await writeFile(path.join(workspace, '.nexus', 'release-rehearsal-note.json'), JSON.stringify({ note }));
    const agent = path.join(workspace, '.nexus', 'agents', 'architect.json');
    const originalAgent = await readFile(agent, 'utf8');
    const preserved = async (app, project, data) => {
      assert.deepEqual(await execution.readRun(app, project, id), saved, 'Persisted run changed.');
      assert.equal(await readFile(path.join(project, 'README.md'), 'utf8'), note);
      assert.equal(await readFile(path.join(project, '.nexus', 'agents', 'architect.json'), 'utf8'), originalAgent);
      assert.deepEqual(JSON.parse(await readFile(path.join(project, '.nexus', 'release-rehearsal-note.json'), 'utf8')), { note });
      const settings = JSON.parse(await readFile(path.join(data, '.nexus/desktop/settings.json'), 'utf8'));
      assert.equal(await realpath(settings.lastWorkspace), await realpath(project));
    };
    await execution.launch(installed, workspace, dataRoot);
    await preserved(installed, workspace, dataRoot);
    onCheck('relaunch-preserves-project-history-and-agents');
    // The native bootstrap has exited before any SQLite files are copied.
    const backup = path.join(temporary, 'Private Backup');
    await cp(workspace, path.join(backup, 'Workspace'), { recursive: true, verbatimSymlinks: true });
    await cp(dataRoot, path.join(backup, 'Application Data'), { recursive: true, verbatimSymlinks: true });
    await rename(installed, path.join(temporary, 'Previous NexusIDE.app'));
    await cp(appPath, installed, { recursive: true, verbatimSymlinks: true });
    await execution.launch(installed, workspace, dataRoot);
    await preserved(installed, workspace, dataRoot);
    onCheck('app-replacement-preserves-state');
    const trashed = path.join(temporary, 'Trash', 'NexusIDE.app');
    await rename(installed, trashed);
    assert.equal(await readFile(path.join(workspace, 'README.md'), 'utf8'), note);
    assert.ok((await lstat(path.join(workspace, '.nexus'))).isDirectory());
    assert.ok((await lstat(path.join(dataRoot, '.nexus/desktop/settings.json'))).isFile());
    onCheck('uninstall-app-retains-project-and-application-data');
    await rename(trashed, installed);
    await execution.launch(installed, workspace, dataRoot);
    await preserved(installed, workspace, dataRoot);
    onCheck('restore-app-and-reopen-retained-data');
    const restoredWorkspace = path.join(temporary, 'Restored Workspace'), restoredData = path.join(temporary, 'Restored Application Data');
    await cp(path.join(backup, 'Workspace'), restoredWorkspace, { recursive: true, verbatimSymlinks: true });
    await cp(path.join(backup, 'Application Data'), restoredData, { recursive: true, verbatimSymlinks: true });
    await execution.launch(installed, restoredWorkspace, restoredData);
    await preserved(installed, restoredWorkspace, restoredData);
    onCheck('closed-state-backup-and-separate-location-restore');
    return { runStatus: saved.status, isolatedHome: true, scrubbedPath: true, temporaryDataRemoved: true };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function verifyRelease({ appPath, reportPath, dmgPath, previousAppPath } = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  appPath ||= path.join(root, 'dist/NexusIDE.app');
  const receipt = createRehearsalReceipt();
  let mountDirectory, mountPoint, attachAttempted = false;
  let current = 'artifact-metadata-and-digests';
  const passed = name => { receipt.checks.push({ name, status: 'passed' }); };
  try {
    const manifest = JSON.parse(await readFile(manifestPath(appPath), 'utf8'));
    safeVersion(manifest.version);
    assert.ok(['arm64', 'x64'].includes(manifest.arch), 'Unsupported artifact architecture.');
    const stem = `NexusIDE-${manifest.version}-${manifest.arch}`;
    reportPath ||= path.join(path.dirname(appPath), `${stem}.json`);
    dmgPath ||= path.join(path.dirname(appPath), `${stem}.dmg`);
    const artifact = await validateReleaseArtifacts({ appPath, reportPath, dmgPath });
    const { notarized, ...identity } = artifact.identity;
    receipt.artifact = { ...identity, reportedNotarized: notarized, notarizationIndependentlyVerified: false, sourceRevision: artifact.report.sourceRevision, sourceDirty: artifact.report.sourceDirty, reportSha256: artifact.reportSha256, dmgSha256: artifact.report.dmgSha256, bundledNodeSha256: artifact.report.bundledNodeSha256 };
    passed(current);
    current = 'macos-native-architecture';
    assert.equal(process.platform, 'darwin', 'Release lifecycle rehearsal requires macOS.');
    assert.equal(process.arch, artifact.identity.arch, 'Rehearsal requires a native matching-architecture machine.');
    passed(current);
    current = 'disk-image-integrity';
    await checked('/usr/bin/hdiutil', ['verify', dmgPath], { timeoutMs: 120000 });
    passed(current);
    current = 'application-code-signature';
    await verifyApplicationSignature(appPath, manifest);
    passed(current);
    current = 'read-only-disk-image-install-source';
    mountDirectory = await mkdtemp(path.join(os.tmpdir(), 'nexus-release-image-'));
    mountPoint = path.join(mountDirectory, 'Volume');
    await mkdir(mountPoint);
    attachAttempted = true;
    await checked('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, dmgPath], { timeoutMs: 120000 });
    const imageApp = path.join(mountPoint, 'NexusIDE.app');
    await validateReleaseArtifacts({ appPath: imageApp, reportPath, dmgPath });
    await verifyApplicationSignature(imageApp, manifest);
    passed(current);
    let fromVersion = manifest.version;
    if (previousAppPath) {
      current = 'previous-application-validation';
      await assertContainedSymlinks(previousAppPath);
      const previous = JSON.parse(await readFile(manifestPath(previousAppPath), 'utf8'));
      safeVersion(previous.version);
      assert.equal(previous.arch, manifest.arch, 'Previous application architecture differs.');
      await checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', previousAppPath]);
      fromVersion = previous.version;
      passed(current);
    }
    const versionChanged = previousAppPath && fromVersion !== manifest.version;
    receipt.upgrade = { mode: versionChanged ? 'cross-version-replacement' : 'same-version-replacement', fromVersion, toVersion: manifest.version };
    if (!versionChanged) receipt.unperformed.push({ name: 'cross-version-upgrade', status: 'not-run', reason: 'No differently versioned previous app was supplied; same-version app replacement is not migration coverage.' });
    current = 'isolated-install-lifecycle';
    receipt.lifecycle = await rehearseLifecycle({ appPath: imageApp, previousAppPath, onCheck: passed });
    passed(current);
    receipt.verified = true;
  } catch (error) {
    receipt.checks.push({ name: current, status: 'failed', error: String(error.message).slice(0, 1500) });
  } finally {
    if (attachAttempted) {
      try {
        await checked('/usr/bin/hdiutil', ['detach', mountPoint], { timeoutMs: 45000 });
        passed('disk-image-detached');
      } catch {
        // Never recursively remove a mount that may still be attached.
        receipt.verified = false;
        receipt.checks.push({ name: 'disk-image-detached', status: 'failed', error: 'Could not confirm image detachment. Temporary mount was retained.', mountPoint });
        mountDirectory = undefined;
      }
    }
    if (mountDirectory) await rm(mountDirectory, { recursive: true, force: true });
  }
  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keys = { '--app': 'appPath', '--report': 'reportPath', '--dmg': 'dmgPath', '--previous-app': 'previousAppPath' }, options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = keys[process.argv[i]], value = process.argv[i + 1];
    if (!key || options[key] || !value || value.startsWith('--')) throw new Error('Use --app PATH --report PATH --dmg PATH [--previous-app PATH].');
    options[key] = path.resolve(value);
  }
  const receipt = await verifyRelease(options);
  await writeState(process.cwd(), 'verification', 'release-rehearsal.json', receipt);
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.verified) process.exitCode = 1;
}
