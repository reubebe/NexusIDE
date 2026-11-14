// Developer-machine lifecycle rehearsal with kernel-enforced network denial.
// This does not certify a clean machine, Gatekeeper or notarization.
import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runProcess } from '../src/process.js';
import { writeState } from '../src/state.js';
import { verifyRelease } from './verify-release.js';

const profile = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(allow network-bind (local ip "localhost:*"))';
const probe = (host, port) => new Promise(resolve => {
  const socket = net.connect({ host, port });
  const finish = result => { socket.destroy(); resolve(result); };
  socket.once('data', data => finish(data.toString()));
  socket.once('error', error => finish(error.code));
  socket.setTimeout(1500, () => finish('TIMEOUT'));
});

if (process.argv.includes('--child')) {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const options = JSON.parse(input);
  // Assert the isolation itself before interpreting any launch as offline.
  // TEST-NET-1 is a documentation address; no live third party is contacted.
  assert.equal(await probe('192.0.2.1', 443), 'EPERM', 'External networking was not denied by the kernel.');
  const server = net.createServer(socket => socket.end('loopback-available'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await probe('127.0.0.1', server.address().port), 'loopback-available'); }
  finally { await new Promise(resolve => server.close(resolve)); }
  const receipt = await verifyRelease(options);
  receipt.suite = 'nexus-offline-desktop-rehearsal-v1';
  receipt.networkIsolation = { mechanism: 'macOS sandbox-exec inherited by child processes', externalProbe: 'EPERM', loopbackProbe: 'passed', profile };
  console.log(JSON.stringify(receipt));
  if (!receipt.verified) process.exitCode = 1;
} else {
  assert.equal(process.platform, 'darwin', 'Offline desktop verification requires macOS.');
  const { values } = parseArgs({ options: { app: { type: 'string' }, report: { type: 'string' }, dmg: { type: 'string' } } });
  const result = await runProcess('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, fileURLToPath(import.meta.url), '--child'], {
    input: JSON.stringify({ appPath: values.app, reportPath: values.report, dmgPath: values.dmg }), timeoutMs: 300000, maxBytes: 150000,
  });
  let receipt;
  try { receipt = JSON.parse(result.stdout); }
  catch { receipt = { suite: 'nexus-offline-desktop-rehearsal-v1', verified: false, cleanMachineVerified: false, releaseCertified: false, error: result.stderr || result.stopped || 'No verification receipt returned.' }; }
  if (result.code !== 0 || result.stopped) receipt.verified = false;
  await writeState(process.cwd(), 'verification', 'offline-desktop.json', receipt);
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.verified) process.exitCode = 1;
}
