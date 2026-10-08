import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runProcess, commandEnvironment } from '../src/process.js';
import { writeState } from '../src/state.js';

const code = process.argv[2] || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
const source = fileURLToPath(new URL('../', import.meta.url));
const base = await mkdtemp(path.join(os.tmpdir(), 'nexus-vscode-check-'));
const workspace = path.join(base, 'workspace'), userData = path.join(base, 'user-data');
const receipt = { at: new Date().toISOString(), verified: false, syntheticWorkspace: true };
try {
  await mkdir(workspace);
  await mkdir(path.join(userData, 'User'), { recursive: true });
  await writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'nexuside.cliPath': path.join(source, 'src', 'cli.js'),
    'nexuside.nodePath': process.execPath,
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
  }));
  const reportFile = path.join(base, 'result.json');
  const result = await runProcess(code, [
    '--new-window', '--wait', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--sync', 'off',
    '--user-data-dir', userData, '--extensions-dir', path.join(base, 'extensions'),
    '--extensionDevelopmentPath=' + path.join(source, 'extensions', 'vscode'),
    '--extensionTestsPath=' + path.join(source, 'extensions', 'vscode', 'host-check.cjs'), workspace,
  ], { cwd: source, timeoutMs: 60000, env: { ...commandEnvironment(), NEXUS_VERIFY_RESULT: reportFile } });
  try { Object.assign(receipt, JSON.parse(await readFile(reportFile, 'utf8'))); }
  catch { throw new Error(`VS Code did not produce a test receipt. ${result.stopped || result.output.slice(-2000)}`); }
  if (result.code !== 0 || result.stopped || !receipt.verified) throw new Error(receipt.error || `VS Code host check failed: ${result.stopped || result.code}`);
} catch (error) { receipt.verified = false; receipt.error = error.message; process.exitCode = 1; }
finally {
  await writeState(process.cwd(), 'verification', 'vscode.json', receipt);
  if (receipt.verified) await rm(base, { recursive: true, force: true });
  else console.log('Host diagnostics retained at: ' + base);
}
console.log(JSON.stringify(receipt, null, 2));
