import test from 'node:test';
import assert from 'node:assert/strict';
import { JIT_ENTITLEMENTS, EMPTY_ENTITLEMENTS, assertEntitlements, assertIdentity, assertSignatureDetails, signingArguments, signingPolicy, signingPreflight, verifySignedDmg, verifySignedTarget } from '../scripts/macos-signing.js';

const identity = 'A'.repeat(40), teamId = 'ABCDE12345';
const release = signingPolicy({ mode: 'release', identity, teamId });

test('release policy requires explicit mode, exact certificate and team', () => {
  assert.equal(signingPolicy().signing, 'ad-hoc');
  assert.equal(signingPolicy({ mode: 'hardened-rehearsal' }).hardenedRuntime, true);
  for (const options of [{ mode: 'other' }, { identity }, { teamId }, { mode: 'release' }, { mode: 'release', identity: 'Developer ID Application: anything', teamId }, { mode: 'release', identity, teamId: '../bad' }]) assert.throws(() => signingPolicy(options));
  assert.equal(signingPolicy({ mode: 'release', identity: identity.toLowerCase(), teamId }).signingIdentity, identity);
});

test('identity must be a valid matching Developer ID Application, not Installer or Apple Development', async () => {
  const valid = ` 1) ${identity} "Developer ID Application: Example (${teamId})"\n 1 valid identities found`;
  assertIdentity(valid, release);
  for (const output of ['0 valid identities found', valid.replace('Application', 'Installer'), valid.replace('Developer ID Application', 'Apple Development'), valid.replace(teamId, 'ZZZZZ12345'), valid.replace(identity, 'B'.repeat(40))]) assert.throws(() => assertIdentity(output, release));
  await assert.rejects(signingPreflight(release, async () => ({ code: 1, output: valid })), /inspect/);
});

test('signing explicitly sets runtime, timestamp and scoped entitlements without deep signing', () => {
  const args = signingArguments(release, '/app with spaces.app', '/private/jit.plist');
  assert.deepEqual(args, ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', '--entitlements', '/private/jit.plist', '--generate-entitlement-der', '/app with spaces.app']);
  assert.equal(signingArguments(signingPolicy(), 'app').includes('--options'), false);
  assert.ok(signingArguments(signingPolicy({ mode: 'hardened-rehearsal' }), 'app').includes('--timestamp=none'));
});

test('unexpected upstream debug and memory entitlements are rejected', () => {
  assertEntitlements(EMPTY_ENTITLEMENTS);
  assertEntitlements(JIT_ENTITLEMENTS, { jit: true });
  assert.throws(() => assertEntitlements(JIT_ENTITLEMENTS));
  assert.throws(() => assertEntitlements(EMPTY_ENTITLEMENTS, { jit: true }));
  for (const key of ['get-task-allow', 'disable-library-validation', 'allow-unsigned-executable-memory', 'allow-dyld-environment-variables']) assert.throws(() => assertEntitlements(JIT_ENTITLEMENTS.replace('</dict>', `<key>com.apple.security.cs.${key}</key><true/></dict>`), { jit: true }));
});

test('release signature inspection requires runtime, expected team, authority and timestamp', () => {
  const text = `CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=5+7\nAuthority=Developer ID Application: Example (${teamId})\nTeamIdentifier=${teamId}\nTimestamp=Oct 9, 2026\n`;
  assertSignatureDetails(text, release);
  for (const fragment of ['runtime', `TeamIdentifier=${teamId}`, 'Authority=Developer ID Application:', 'Timestamp=Oct 9, 2026']) assert.throws(() => assertSignatureDetails(text.replace(fragment, ''), release));
});

test('signed target verification checks tool failures and inspected entitlements', async () => {
  await assert.rejects(verifySignedTarget('app', signingPolicy(), { execute: async () => ({ code: 1, output: '' }) }), /verification/);
  await assert.rejects(verifySignedTarget('app', signingPolicy(), { execute: async (_cmd, args) => ({ code: 0, output: args.includes('--entitlements') ? JIT_ENTITLEMENTS : '' }) }), /entitlements/);
});

test('disk images need the expected Developer ID and timestamp but not runtime flags', async () => {
  const output = `Authority=Developer ID Application: Example (${teamId})\nTeamIdentifier=${teamId}\nTimestamp=Oct 10, 2026\n`;
  await verifySignedDmg('candidate.dmg', release, async () => ({ code: 0, output }));
  await assert.rejects(verifySignedDmg('candidate.dmg', release, async () => ({ code: 1, output })), /verification failed/);
  await assert.rejects(verifySignedDmg('candidate.dmg', release, async () => ({ code: 0, output: output.replace(`TeamIdentifier=${teamId}`, `TeamIdentifier=${teamId}EXTRA`) })), /team/);
});
