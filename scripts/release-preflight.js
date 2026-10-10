import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/process.js';
import { signingPolicy, signingPreflight } from './macos-signing.js';

export async function releasePreflight() {
  const checks = [];
  async function check(name, operation) {
    try { await operation(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, reason: error.message }); }
  }
  await check('macOS', async () => { if (process.platform !== 'darwin') throw new Error('A macOS release build host is required.'); });
  await check('Developer ID Application', async () => {
    const policy = signingPolicy({ mode: 'release', identity: process.env.NEXUS_CODESIGN_IDENTITY, teamId: process.env.NEXUS_TEAM_ID });
    await signingPreflight(policy);
  });
  for (const name of ['notarytool', 'stapler']) await check(name, async () => {
    const result = await runProcess('/usr/bin/xcrun', ['--find', name]);
    if (result.code !== 0) throw new Error(`Install current Xcode Command Line Tools providing ${name}.`);
  });
  return { readyToSign: checks.every(check => check.passed), notarizationCredentialsChecked: false, checks, note: 'Read-only: no credentials stored, enrollment, signing or upload performed.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await releasePreflight(); console.log(JSON.stringify(result, null, 2));
  if (!result.readyToSign) process.exitCode = 1;
}
