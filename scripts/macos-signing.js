import { runProcess } from '../src/process.js';

export const JIT_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n`;
export const EMPTY_ENTITLEMENTS = '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n';

export function signingPolicy({ mode = 'development', identity = '-', teamId } = {}) {
  if (!['development', 'hardened-rehearsal', 'release'].includes(mode)) throw new Error('Unknown signing mode.');
  if (mode !== 'release' && (identity !== '-' || teamId)) throw new Error('Developer ID identity/team require release mode.');
  if (mode === 'release' && (!/^[A-Fa-f0-9]{40}$/.test(identity) || !/^[A-Z0-9]{10}$/.test(teamId || ''))) throw new Error('Release requires a 40-hex Developer ID certificate fingerprint and 10-character Team ID.');
  return { signingMode: mode, signing: mode === 'release' ? 'developer-id' : 'ad-hoc', hardenedRuntime: mode !== 'development', signingIdentity: mode === 'release' ? identity.toUpperCase() : null, teamId: teamId || null };
}

export function assertIdentity(output, policy) {
  const identities = [...output.matchAll(/\b([A-Fa-f0-9]{40})\s+"([^"\r\n]+)"/g)];
  if (!identities.some(([, fingerprint, name]) => fingerprint.toUpperCase() === policy.signingIdentity && name.startsWith('Developer ID Application: ') && name.endsWith(`(${policy.teamId})`))) throw new Error('Matching valid Developer ID Application identity not found in the local Keychain.');
}

export async function signingPreflight(policy, execute = runProcess) {
  if (policy.signing !== 'developer-id') return;
  const result = await execute('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  if (result.code !== 0) throw new Error('Could not inspect signing identities.');
  assertIdentity(result.output, policy);
}

export function signingArguments(policy, target, entitlements) {
  const args = ['--force', '--sign', policy.signingIdentity || '-'];
  if (policy.hardenedRuntime) args.push('--options', 'runtime');
  args.push(policy.signing === 'developer-id' ? '--timestamp' : '--timestamp=none');
  // Explicit entitlements replace upstream Node's debug/library-validation exceptions.
  if (entitlements) args.push('--entitlements', entitlements, '--generate-entitlement-der');
  return [...args, target];
}

export function assertSignatureDetails(text, policy) {
  if (policy.hardenedRuntime && !/flags=.*\bruntime\b/.test(text)) throw new Error('Missing Hardened Runtime flag.');
  if (policy.signing === 'developer-id') {
    if (!text.split(/\r?\n/).includes(`TeamIdentifier=${policy.teamId}`) || !/^Authority=Developer ID Application:/m.test(text) || !/^Timestamp=.+/m.test(text)) throw new Error('Missing Developer ID authority, team or secure timestamp.');
  }
}

export function assertEntitlements(text, { jit = false } = {}) {
  const keys = [...text.matchAll(/<key>([^<]+)<\/key>/g)].map(match => match[1]);
  if (keys.length !== (jit ? 1 : 0) || (jit && keys[0] !== 'com.apple.security.cs.allow-jit')) throw new Error('Unexpected signed executable entitlements.');
  if (jit && !/<key>com.apple.security.cs.allow-jit<\/key>\s*<true\s*\/>/.test(text)) throw new Error('Missing JIT entitlement.');
}

export async function verifySignedTarget(target, policy, { jit = false, execute = runProcess } = {}) {
  for (const args of [['--verify', '--strict', '--verbose=2', target], ['-d', '--entitlements', '-', '--xml', target], ['-d', '--verbose=4', target]]) {
    const result = await execute('/usr/bin/codesign', args);
    if (result.code !== 0) throw new Error('Signed target verification failed.');
    if (args.includes('--verbose=4')) assertSignatureDetails(result.output, policy);
    if (args.includes('--entitlements')) assertEntitlements(result.output, { jit });
  }
}

export async function verifySignedDmg(target, policy, execute = runProcess) {
  const verification = await execute('/usr/bin/codesign', ['--verify', '--strict', target]);
  const details = await execute('/usr/bin/codesign', ['-d', '--verbose=4', target]);
  if (verification.code !== 0 || details.code !== 0) throw new Error('Disk image signature verification failed.');
  assertSignatureDetails(details.output, { ...policy, hardenedRuntime: false });
}
