import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../scripts/desktop-package-utils.js';
import { EMPTY_ENTITLEMENTS, JIT_ENTITLEMENTS } from '../scripts/macos-signing.js';
import { assertAcceptedInfo, assertNotarizable, notarizationStep, NOTARY_STEPS, prepareNotarization, submissionRecord } from '../scripts/notarize-desktop.js';

const appId = '12345678-1234-1234-1234-123456789abc';
const dmgId = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const identity = 'A'.repeat(40), teamId = 'ABCDE12345';
const signature = `CodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=Developer ID Application: Synthetic Example (${teamId})\nTeamIdentifier=${teamId}\nTimestamp=Oct 10, 2026\n`;

// These are command fixtures, not Apple, Gatekeeper, signature or notarization
// evidence. No external command is executed, including on non-macOS CI hosts.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-notary-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'NexusIDE.app');
  const resources = path.join(app, 'Contents', 'Resources');
  const node = path.join(resources, 'runtime', 'bin', 'node');
  const payload = path.join(resources, 'app');
  const native = path.join(payload, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64');
  await mkdir(path.dirname(node), { recursive: true });
  await mkdir(native, { recursive: true });
  await writeFile(node, 'Synthetic Node binary fixture.');
  await writeFile(path.join(payload, 'package-lock.json'), '{"lockfileVersion":3}');
  for (const name of ['pty.node', 'spawn-helper']) await writeFile(path.join(native, name), 'Synthetic native executable fixture.');
  const manifest = {
    version: '0.2.0', arch: 'arm64', sourceRevision: 'b'.repeat(40), sourceDirty: false,
    signing: 'developer-id', signingMode: 'release', hardenedRuntime: true, signingIdentity: identity, teamId,
    lockfileSha256: await sha256(path.join(payload, 'package-lock.json')),
  };
  const manifestFile = path.join(resources, 'build-manifest.json');
  const report = { ...manifest, bundledNodeSha256: await sha256(node), dmgSha256: 'c'.repeat(64), checks: ['synthetic-fixture-only'] };
  const reportFile = path.join(root, 'build-report.json');
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(reportFile, JSON.stringify(report));
  const calls = [], statuses = { [appId]: 'Accepted', [dmgId]: 'Accepted' }, submittedHashes = {};
  const controls = { submitFailure: false, submitOutput: undefined, infoId: undefined, logId: undefined, logStatus: undefined, logHash: undefined, appCodeHash: 'd'.repeat(40), gatekeeperFailure: false };
  const execute = async (program, args) => {
    calls.push({ program, args: [...args] });
    let output = '';
    if (program === '/usr/bin/codesign') {
      if (args.includes('--entitlements')) output = path.basename(args.at(-1)) === 'node' ? JIT_ENTITLEMENTS : EMPTY_ENTITLEMENTS;
      else if (args.includes('--verbose=4')) output = `${signature}CDHash=${controls.appCodeHash}\n`;
      else assert.ok(args.includes('--verify') || args.includes('--sign'), 'Unexpected codesign operation.');
    } else if (program === '/usr/bin/ditto') {
      assert.deepEqual(args.slice(0, 3), ['-c', '-k', '--keepParent']);
      await writeFile(args.at(-1), 'Synthetic ZIP artifact.');
    } else if (program === '/usr/bin/hdiutil') {
      assert.ok(['create', 'verify'].includes(args[0]));
      if (args[0] === 'create') await writeFile(args.at(-1), 'Synthetic DMG artifact.');
    } else if (program === '/usr/bin/xcrun' && args[0] === 'notarytool') {
      assert.ok(['submit', 'info', 'log'].includes(args[1]));
      if (args[1] === 'submit') {
        const id = args[2].endsWith('.zip') ? appId : dmgId;
        submittedHashes[id] = await sha256(args[2]);
        if (controls.submitFailure) return { code: 1, output: 'Synthetic transport interruption after possible upload.' };
        output = controls.submitOutput ?? JSON.stringify({ id, status: 'In Progress' });
      } else if (args[1] === 'info') output = JSON.stringify({ id: controls.infoId ?? args[2], status: statuses[args[2]] });
      else output = JSON.stringify({ jobId: controls.logId ?? args[2], status: controls.logStatus ?? statuses[args[2]], sha256: controls.logHash ?? submittedHashes[args[2]], issues: statuses[args[2]] === 'Invalid' ? [{ message: 'Synthetic rejection.' }] : [] });
    } else if (program === '/usr/bin/xcrun' && args[0] === 'stapler') {
      assert.ok(['staple', 'validate'].includes(args[1]));
      // Model stapling changing DMG bytes; repeating an interrupted finish is
      // idempotent in this fixture, just as the protocol requires.
      if (args[1] === 'staple' && args[2].endsWith('.dmg')) {
        const bytes = await readFile(args[2], 'utf8');
        if (!bytes.endsWith('Synthetic stapled ticket.')) await writeFile(args[2], `${bytes}\nSynthetic stapled ticket.`);
      }
    } else if (program === '/usr/sbin/spctl') {
      assert.equal(args[0], '--assess');
      if (controls.gatekeeperFailure) return { code: 1, output: 'Synthetic Gatekeeper interruption.' };
    }
    else assert.fail(`Unexpected mocked command: ${program} ${args.join(' ')}`);
    return { code: 0, output };
  };
  let job;
  const prepare = async () => {
    const result = await prepareNotarization({ appPath: app, reportPath: reportFile, outputDirectory: path.join(root, 'jobs'), execute });
    job = result.job;
    return result;
  };
  const state = () => readFile(path.join(job, 'state.json'), 'utf8').then(JSON.parse);
  const step = value => notarizationStep({ jobDirectory: job, step: value, profile: 'synthetic-keychain-profile', execute });
  const submissions = () => calls.filter(call => call.program === '/usr/bin/xcrun' && call.args[0] === 'notarytool' && call.args[1] === 'submit');
  return { root, app, node, manifest, manifestFile, report, reportFile, calls, controls, statuses, execute, prepare, step, state, submissions, job: () => job };
}

test('notarization preflight rejects ad-hoc, dirty, non-hardened and mismatched release reports without commands', async t => {
  const f = await fixture(t);
  assertNotarizable(f.manifest, f.report);
  for (const change of [
    { signing: 'ad-hoc' }, { signingMode: 'hardened-rehearsal' }, { hardenedRuntime: false },
    { sourceDirty: true }, { sourceRevision: null }, { arch: 'other' }, { signingIdentity: '-' },
  ]) assert.throws(() => assertNotarizable({ ...f.manifest, ...change }, { ...f.report, ...change }));
  assert.throws(() => assertNotarizable(f.manifest, { ...f.report, teamId: 'ZZZZZ12345' }), /report mismatch/i);
  assert.throws(() => assertNotarizable(f.manifest, { ...f.report, bundledNodeSha256: 'invalid' }), /Invalid bundledNodeSha256/);
  await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, signing: 'ad-hoc' }));
  await assert.rejects(f.prepare(), /Developer ID release/);
  assert.equal(f.calls.length, 0);
});

test('symlinked app roots cannot turn isolated notarization into original-bundle mutation', async t => {
  const f = await fixture(t), link = path.join(f.root, 'Linked.app');
  await symlink(f.app, link);
  await assert.rejects(prepareNotarization({ appPath: link, reportPath: f.reportFile, outputDirectory: path.join(f.root, 'jobs'), execute: f.execute }), /real directory/);
  assert.equal(f.calls.length, 0);
});

test('full mocked notarization completes app and DMG steps with independent submissions and final hashes', async t => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.uploaded, false);
  assert.equal(prepared.next, 'submit-app');
  assert.equal(f.submissions().length, 0);
  let result;
  for (let i = 0; i < NOTARY_STEPS.length; i++) {
    result = await f.step(NOTARY_STEPS[i]);
    assert.equal(result.next, NOTARY_STEPS[i + 1] || 'complete');
  }
  const final = JSON.parse(await readFile(result.artifacts.report, 'utf8'));
  assert.equal(final.notarized, true);
  assert.equal(final.sourceRevision, f.manifest.sourceRevision);
  assert.equal(final.notarization.app.id, appId);
  assert.equal(final.notarization.dmg.id, dmgId);
  assert.equal(final.dmgSha256, await sha256(result.artifacts.dmg));
  assert.notEqual(final.dmgSha256, final.notarization.dmg.sha256, 'Stapling changes the final DMG digest.');
  assert.equal((await f.state()).next, 'complete');
  assert.equal(f.submissions().length, 2);
  for (const submission of f.submissions()) {
    assert.ok(submission.args.includes('--no-wait'));
    assert.ok(submission.args.includes('--keychain-profile'));
    assert.equal(submission.args.includes('--password'), false);
  }
  assert.equal(f.calls.filter(call => call.program === '/usr/sbin/spctl').length, 2);
  await assert.rejects(f.step('finish'), /Expected step complete/);
  await assert.rejects(readFile(path.join(f.job(), '.step-lock')), { code: 'ENOENT' });
});

test('unknown, out-of-order and concurrent notarization steps fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(notarizationStep({ step: 'unknown' }), /Unknown notarization step/);
  await assert.rejects(notarizationStep({ step: 'submit-app', jobDirectory: 'relative', profile: 'profile' }), /absolute job path/);
  await f.prepare();
  await assert.rejects(notarizationStep({ jobDirectory: f.job(), step: 'submit-app', profile: 'not a profile', execute: f.execute }), /Keychain profile/);
  const before = f.calls.length;
  await assert.rejects(f.step('finish'), /Expected step submit-app/);
  assert.equal(f.calls.length, before);
  await mkdir(path.join(f.job(), '.step-lock'));
  await assert.rejects(f.step('submit-app'), { code: 'EEXIST' });
  assert.equal(f.submissions().length, 0);
});

for (const status of ['In Progress', 'Invalid', 'Rejected']) {
  test(`Apple ${status} status cannot advance to packaging`, async t => {
    const f = await fixture(t);
    await f.prepare();
    await f.step('submit-app');
    f.statuses[appId] = status;
    const result = await f.step('check-app');
    assert.equal(result.next, 'check-app');
    assert.equal(result.appStatus, status);
    assert.equal((await f.state()).app.status, status);
    await assert.rejects(f.step('package-dmg'), /Expected step check-app/);
    const logCalls = f.calls.filter(call => call.args[0] === 'notarytool' && call.args[1] === 'log');
    assert.equal(logCalls.length, status === 'In Progress' ? 0 : 1);
    if (status !== 'In Progress') assert.equal(JSON.parse(await readFile(path.join(f.job(), 'app-notary-log.json'), 'utf8')).status, status);
    assert.equal(f.calls.filter(call => call.program === '/usr/bin/hdiutil').length, 0);
  });
}

for (const failure of ['transport', 'unparseable-reply', 'missing-submission-id']) {
  test(`upload ${failure} retains intent and cannot silently resubmit`, async t => {
    const f = await fixture(t);
    await f.prepare();
    if (failure === 'transport') f.controls.submitFailure = true;
    else f.controls.submitOutput = failure === 'unparseable-reply' ? 'not JSON' : JSON.stringify({ status: 'In Progress' });
    await assert.rejects(f.step('submit-app'));
    const state = await f.state();
    assert.equal(state.next, 'submit-app');
    assert.equal(state.app.id, null);
    assert.ok(state.app.intentAt);
    assert.match(state.app.sha256, /^[0-9a-f]{64}$/);
    f.controls.submitFailure = false;
    f.controls.submitOutput = undefined;
    await assert.rejects(f.step('submit-app'), /Upload already attempted/);
    assert.equal(f.submissions().length, 1);
    assert.deepEqual(await f.state(), state);
  });
}

test('changed submitted ZIP or DMG is rejected before asking Apple for status', async t => {
  for (const kind of ['app', 'dmg']) {
    const f = await fixture(t);
    await f.prepare();
    await f.step('submit-app');
    if (kind === 'dmg') {
      await f.step('check-app');
      await f.step('package-dmg');
      await f.step('submit-dmg');
    }
    const file = path.join(f.job(), kind === 'app' ? 'NexusIDE.zip' : 'NexusIDE-0.2.0-arm64.dmg');
    await writeFile(file, 'Changed after upload.');
    const infoCalls = () => f.calls.filter(call => call.args[0] === 'notarytool' && call.args[1] === 'info').length;
    const before = infoCalls();
    await assert.rejects(f.step(`check-${kind}`), /artifact or ID changed/);
    assert.equal(infoCalls(), before);
    assert.equal((await f.state()).next, `check-${kind}`);
  }
});

test('changed bundled runtime and release report mismatches fail before upload', async t => {
  const f = await fixture(t);
  await writeFile(f.reportFile, JSON.stringify({ ...f.report, sourceRevision: 'd'.repeat(40) }));
  await assert.rejects(f.prepare(), /Build report mismatch: sourceRevision/);
  assert.equal(f.calls.length, 0);
  await writeFile(f.reportFile, JSON.stringify(f.report));
  await f.prepare();
  await writeFile(path.join(f.job(), 'volume', 'NexusIDE.app', 'Contents', 'Resources', 'runtime', 'bin', 'node'), 'Changed runtime.');
  await assert.rejects(f.step('submit-app'), /digest mismatch/);
  assert.equal(f.submissions().length, 0);
  assert.equal((await f.state()).app, null);
});

test('submission IDs, unknown status and inconsistent Apple logs cannot mark acceptance', async t => {
  assert.deepEqual(submissionRecord(JSON.stringify({ id: appId })), { id: appId, status: 'Submitted' });
  assert.throws(() => submissionRecord('{"id":"not-a-uuid"}'), /valid submission ID/);
  assert.equal(assertAcceptedInfo({ id: appId.toUpperCase(), status: 'Accepted' }, appId), true);
  assert.throws(() => assertAcceptedInfo({ id: dmgId, status: 'Accepted' }, appId), /ID mismatch/);
  assert.throws(() => assertAcceptedInfo({ id: appId, status: 'Unexpected' }, appId), /Unknown notarization status/);
  for (const change of [{ infoId: dmgId }, { logId: dmgId }, { logStatus: 'Invalid' }, { logHash: '0'.repeat(64) }]) {
    const f = await fixture(t);
    await f.prepare();
    await f.step('submit-app');
    Object.assign(f.controls, change);
    await assert.rejects(f.step('check-app'), /mismatch/);
    assert.equal((await f.state()).next, 'check-app');
  }
});

test('prepared archive and app signature changes are caught before any upload intent', async t => {
  for (const kind of ['zip', 'signature', 'dmg']) {
    const f = await fixture(t);
    await f.prepare();
    if (kind === 'dmg') {
      await f.step('submit-app');
      await f.step('check-app');
      await f.step('package-dmg');
    }
    if (kind === 'signature') f.controls.appCodeHash = 'e'.repeat(40);
    else await writeFile(path.join(f.job(), kind === 'zip' ? 'NexusIDE.zip' : 'NexusIDE-0.2.0-arm64.dmg'), 'Modified prepared artifact.');
    const before = f.submissions().length;
    await assert.rejects(f.step(kind === 'dmg' ? 'submit-dmg' : 'submit-app'), /Prepared .* changed/);
    assert.equal(f.submissions().length, before);
    assert.equal((await f.state())[kind === 'dmg' ? 'dmg' : 'app'], null);
  }
});

test('accepted archive or disk-image replacement cannot advance packaging or finish', async t => {
  for (const kind of ['app', 'dmg']) {
    const f = await fixture(t);
    await f.prepare();
    await f.step('submit-app');
    await f.step('check-app');
    if (kind === 'dmg') {
      await f.step('package-dmg');
      await f.step('submit-dmg');
      await f.step('check-dmg');
    }
    await writeFile(path.join(f.job(), kind === 'app' ? 'NexusIDE.zip' : 'NexusIDE-0.2.0-arm64.dmg'), 'Changed after acceptance.');
    const stapleCalls = () => f.calls.filter(call => call.args[0] === 'stapler' && call.args[1] === 'staple').length;
    const before = stapleCalls();
    await assert.rejects(f.step(kind === 'app' ? 'package-dmg' : 'finish'), /Accepted .* changed/);
    assert.equal(stapleCalls(), before);
  }
});

test('interrupted finish preserves uploaded DMG bytes and retries without a new submission', async t => {
  const f = await fixture(t);
  await f.prepare();
  for (const step of NOTARY_STEPS.slice(0, -1)) await f.step(step);
  const original = path.join(f.job(), 'NexusIDE-0.2.0-arm64.dmg');
  const originalHash = await sha256(original);
  f.controls.gatekeeperFailure = true;
  await assert.rejects(f.step('finish'), /spctl failed/);
  assert.equal((await f.state()).next, 'finish');
  assert.equal(await sha256(original), originalHash);
  const intermediate = path.join(f.job(), 'release', path.basename(original));
  const stapledHash = await sha256(intermediate);
  assert.notEqual(stapledHash, originalHash);
  f.controls.gatekeeperFailure = false;
  const completed = await f.step('finish');
  assert.equal(completed.next, 'complete');
  assert.equal(await sha256(original), originalHash);
  assert.equal(await sha256(completed.artifacts.dmg), stapledHash);
  assert.equal(f.submissions().length, 2);
});
