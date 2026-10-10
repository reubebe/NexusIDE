// Explicit, resumable Apple uploads. Importing this module never submits anything.
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runProcess } from '../src/process.js';
import { assertContainedSymlinks, safeVersion, sha256 } from './desktop-package-utils.js';
import { signingPolicy, verifySignedDmg, verifySignedTarget } from './macos-signing.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NOTARY_STEPS = ['submit-app', 'check-app', 'package-dmg', 'submit-dmg', 'check-dmg', 'finish'];

export function assertNotarizable(manifest, report) {
  if (manifest.signing !== 'developer-id' || manifest.signingMode !== 'release' || manifest.hardenedRuntime !== true || manifest.sourceDirty !== false || !/^[0-9a-f]{40}$/.test(manifest.sourceRevision || '')) throw new Error('Only a clean-source, hardened Developer ID release can be notarized.');
  signingPolicy({ mode: 'release', identity: manifest.signingIdentity, teamId: manifest.teamId });
  safeVersion(manifest.version);
  if (!['arm64', 'x64'].includes(manifest.arch)) throw new Error('Invalid release architecture.');
  for (const key of Object.keys(manifest)) if (JSON.stringify(manifest[key]) !== JSON.stringify(report[key])) throw new Error(`Build report mismatch: ${key}`);
  for (const key of ['bundledNodeSha256', 'lockfileSha256']) if (!/^[0-9a-f]{64}$/.test(report[key] || '')) throw new Error(`Invalid ${key}.`);
}

export function submissionRecord(output) {
  const record = JSON.parse(output);
  if (!UUID.test(record.id || '')) throw new Error('Apple returned no valid submission ID; reconcile the retained upload intent before retrying.');
  return { id: record.id, status: record.status || 'Submitted' };
}

export function assertAcceptedInfo(info, id) {
  if (info.id?.toLowerCase() !== id.toLowerCase()) throw new Error('Submission ID mismatch.');
  if (!['Accepted', 'In Progress', 'Invalid', 'Rejected'].includes(info.status)) throw new Error('Unknown notarization status.');
  return info.status === 'Accepted';
}

async function command(execute, program, args) {
  const result = await execute(program, args, { timeoutMs: 60000, maxBytes: 1000000 });
  if (result.code !== 0) throw new Error(`${path.basename(program)} failed (${result.stopped || result.code}). ${result.output}`);
  return result.output;
}

async function save(job, state) {
  const temporary = path.join(job, 'state.json.tmp');
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path.join(job, 'state.json'));
  // Flush the renamed intent and newly created job before a network side effect.
  for (const directory of [job, path.dirname(job)]) {
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
}

function artifactPaths(job, report) {
  if (!['arm64', 'x64'].includes(report.arch)) throw new Error('Invalid release architecture.');
  return { app: path.join(job, 'volume', 'NexusIDE.app'), zip: path.join(job, 'NexusIDE.zip'), dmg: path.join(job, `NexusIDE-${safeVersion(report.version)}-${report.arch}.dmg`), report: path.join(job, `NexusIDE-${safeVersion(report.version)}-${report.arch}.json`) };
}

async function appCodeHash(app, execute) {
  const output = await command(execute, '/usr/bin/codesign', ['-d', '--verbose=4', app]);
  const hash = /^CDHash=([0-9a-f]{40,64})$/m.exec(output)?.[1];
  if (!hash) throw new Error('Missing app CodeDirectory hash.');
  return hash;
}

async function verifyApp(app, report, execute) {
  if (!(await lstat(app)).isDirectory()) throw new Error('Application must be a real directory, not a symlink.');
  const manifest = JSON.parse(await readFile(path.join(app, 'Contents', 'Resources', 'build-manifest.json'), 'utf8'));
  assertNotarizable(manifest, report);
  await assertContainedSymlinks(app);
  const policy = signingPolicy({ mode: 'release', identity: manifest.signingIdentity, teamId: manifest.teamId });
  const payload = path.join(app, 'Contents', 'Resources', 'app');
  const node = path.join(app, 'Contents', 'Resources', 'runtime', 'bin', 'node');
  if (await sha256(node) !== report.bundledNodeSha256 || await sha256(path.join(payload, 'package-lock.json')) !== report.lockfileSha256) throw new Error('Release artifact digest mismatch.');
  await command(execute, '/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  await verifySignedTarget(app, policy, { execute });
  await verifySignedTarget(node, policy, { jit: true, execute });
  for (const name of ['pty.node', 'spawn-helper']) await verifySignedTarget(path.join(payload, 'node_modules', 'node-pty', 'prebuilds', `darwin-${manifest.arch}`, name), policy, { execute });
}

export async function prepareNotarization({ appPath = path.join(root, 'dist', 'NexusIDE.app'), reportPath, outputDirectory = path.join(root, 'dist'), execute = runProcess } = {}) {
  const manifest = JSON.parse(await readFile(path.join(appPath, 'Contents', 'Resources', 'build-manifest.json'), 'utf8'));
  safeVersion(manifest.version);
  if (!['arm64', 'x64'].includes(manifest.arch)) throw new Error('Invalid architecture.');
  const report = JSON.parse(await readFile(reportPath || path.join(root, 'dist', `NexusIDE-${manifest.version}-${manifest.arch}.json`), 'utf8'));
  await verifyApp(appPath, report, execute);
  await mkdir(outputDirectory, { recursive: true });
  const job = await mkdtemp(path.join(outputDirectory, '.notarization-'));
  const artifacts = artifactPaths(job, report);
  await mkdir(path.dirname(artifacts.app));
  await cp(appPath, artifacts.app, { recursive: true, verbatimSymlinks: true });
  await verifyApp(artifacts.app, report, execute);
  await command(execute, '/usr/bin/ditto', ['-c', '-k', '--keepParent', artifacts.app, artifacts.zip]);
  await save(job, { version: 1, report, appCodeHash: await appCodeHash(artifacts.app, execute), zipSha256: await sha256(artifacts.zip), next: 'submit-app', app: null, dmg: null });
  return { job, next: 'submit-app', uploaded: false };
}

export async function notarizationStep({ jobDirectory, step, profile, execute = runProcess } = {}) {
  if (!NOTARY_STEPS.includes(step)) throw new Error('Unknown notarization step.');
  if (!path.isAbsolute(jobDirectory || '')) throw new Error('Use the absolute job path returned by prepare.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(profile || '')) throw new Error('Provide a Keychain profile name, never a password or API key.');
  const job = jobDirectory, lock = path.join(job, '.step-lock');
  await mkdir(lock); // A concurrent/interrupted step fails closed; never force another owner out.
  try {
    const state = JSON.parse(await readFile(path.join(job, 'state.json'), 'utf8'));
    if (state.version !== 1 || state.next !== step) throw new Error(`Expected step ${state.next || 'unknown'}, not ${step}.`);
    const report = state.report, artifacts = artifactPaths(job, report);
    await verifyApp(artifacts.app, report, execute);
    if (state.appCodeHash !== await appCodeHash(artifacts.app, execute)) throw new Error('Prepared app signature changed.');
    const policy = signingPolicy({ mode: 'release', identity: report.signingIdentity, teamId: report.teamId });
    if (step.startsWith('submit-')) {
      const kind = step.slice(7), artifact = kind === 'app' ? artifacts.zip : artifacts.dmg;
      if (state[kind]) throw new Error('Upload already attempted. Retained intent prevents duplicate submissions; inspect Apple history and reconcile manually.');
      if (await sha256(artifact) !== (kind === 'app' ? state.zipSha256 : state.dmgSha256)) throw new Error('Prepared upload artifact changed.');
      if (kind === 'dmg') await verifySignedDmg(artifact, policy, execute);
      state[kind] = { intentAt: new Date().toISOString(), sha256: await sha256(artifact), id: null };
      await save(job, state); // Persist intent BEFORE any network side effect.
      const output = await command(execute, '/usr/bin/xcrun', ['notarytool', 'submit', artifact, '--keychain-profile', profile, '--output-format', 'json', '--no-progress', '--no-wait']);
      Object.assign(state[kind], submissionRecord(output));
      state.next = `check-${kind}`;
    } else if (step.startsWith('check-')) {
      const kind = step.slice(6), submission = state[kind], artifact = kind === 'app' ? artifacts.zip : artifacts.dmg;
      if (!UUID.test(submission?.id || '') || submission.sha256 !== await sha256(artifact)) throw new Error('Submission artifact or ID changed.');
      const info = JSON.parse(await command(execute, '/usr/bin/xcrun', ['notarytool', 'info', submission.id, '--keychain-profile', profile, '--output-format', 'json']));
      const accepted = assertAcceptedInfo(info, submission.id);
      submission.status = info.status;
      if (info.status !== 'In Progress') {
        const log = JSON.parse(await command(execute, '/usr/bin/xcrun', ['notarytool', 'log', submission.id, '--keychain-profile', profile]));
        if (log.jobId?.toLowerCase() !== submission.id.toLowerCase() || log.status !== info.status || log.sha256 !== submission.sha256) throw new Error('Notarization log mismatch.');
        await writeFile(path.join(job, `${kind}-notary-log.json`), JSON.stringify(log, null, 2) + '\n', { mode: 0o600 });
        submission.issues = log.issues || [];
      }
      if (accepted) state.next = kind === 'app' ? 'package-dmg' : 'finish';
    } else if (step === 'package-dmg') {
      if (state.app?.status !== 'Accepted') throw new Error('App is not accepted.');
      if (await sha256(artifacts.zip) !== state.app.sha256) throw new Error('Accepted app archive changed.');
      await command(execute, '/usr/bin/xcrun', ['stapler', 'staple', artifacts.app]);
      await command(execute, '/usr/bin/xcrun', ['stapler', 'validate', artifacts.app]);
      await verifyApp(artifacts.app, report, execute);
      try { await symlink('/Applications', path.join(job, 'volume', 'Applications')); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await writeFile(path.join(job, 'volume', 'READ ME.txt'), 'Drag NexusIDE.app to Applications. Open it and choose a project folder. External models and integration tools are separate prerequisites. Project data stays in PROJECT/.nexus. Keep backups.\n');
      // -ov replaces only this job-owned intermediate after an interrupted packaging attempt.
      await command(execute, '/usr/bin/hdiutil', ['create', '-ov', '-volname', 'NexusIDE', '-srcfolder', path.join(job, 'volume'), '-format', 'UDZO', artifacts.dmg]);
      await command(execute, '/usr/bin/hdiutil', ['verify', artifacts.dmg]);
      await command(execute, '/usr/bin/codesign', ['--force', '--sign', report.signingIdentity, '--timestamp', artifacts.dmg]);
      await verifySignedDmg(artifacts.dmg, policy, execute);
      state.dmgSha256 = await sha256(artifacts.dmg);
      state.next = 'submit-dmg';
    } else {
      if (state.app?.status !== 'Accepted' || state.dmg?.status !== 'Accepted') throw new Error('Both notarizations must be accepted.');
      if (await sha256(artifacts.dmg) !== state.dmg.sha256) throw new Error('Accepted disk image changed.');
      // Preserve uploaded bytes, so every interrupted finish can recheck their digest.
      const finalDmg = path.join(job, 'release', path.basename(artifacts.dmg));
      await mkdir(path.dirname(finalDmg), { recursive: true });
      await copyFile(artifacts.dmg, finalDmg);
      for (const target of [artifacts.app, finalDmg]) {
        await command(execute, '/usr/bin/xcrun', ['stapler', 'staple', target]);
        await command(execute, '/usr/bin/xcrun', ['stapler', 'validate', target]);
      }
      await command(execute, '/usr/bin/codesign', ['--verify', '--deep', '--strict', artifacts.app]);
      await verifySignedDmg(finalDmg, policy, execute);
      await command(execute, '/usr/bin/hdiutil', ['verify', finalDmg]);
      await command(execute, '/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', artifacts.app]);
      await command(execute, '/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', finalDmg]);
      const finalReport = { ...report, notarized: true, limitations: report.limitations?.filter(value => value !== 'Not yet notarized'), dmgSha256: await sha256(finalDmg), notarization: { app: state.app, dmg: state.dmg, finishedAt: new Date().toISOString(), checks: ['app-staple', 'dmg-staple', 'gatekeeper-app', 'gatekeeper-dmg'] } };
      await writeFile(artifacts.report, JSON.stringify(finalReport, null, 2) + '\n');
      artifacts.dmg = finalDmg;
      state.next = 'complete';
    }
    await save(job, state);
    return { job, next: state.next, appStatus: state.app?.status || null, dmgStatus: state.dmg?.status || null, artifacts: state.next === 'complete' ? artifacts : undefined };
  } finally { await rm(lock, { recursive: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') throw new Error('Notarization requires macOS.');
  const [step, jobDirectory, ...extra] = process.argv.slice(2);
  if (extra.length || (step === 'prepare' && jobDirectory)) throw new Error('Usage: notarize-desktop.js prepare | STEP ABSOLUTE_JOB_PATH (set NEXUS_NOTARY_PROFILE for steps).');
  console.log(JSON.stringify(step === 'prepare' ? await prepareNotarization() : await notarizationStep({ jobDirectory, step, profile: process.env.NEXUS_NOTARY_PROFILE }), null, 2));
}
