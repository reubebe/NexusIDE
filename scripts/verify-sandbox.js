import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { runSandbox } from '../src/sandbox.js';
import { writeState } from '../src/state.js';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/verify-sandbox.js IMAGE@sha256:DIGEST (preinstalled image with sh, awk, and ip)');
const base = await mkdtemp(path.join(os.tmpdir(), 'nexus-live-sandbox-'));
const root = path.join(base, 'workspace'); await mkdir(root);
const receipt = { at: new Date().toISOString(), image, verified: false, syntheticWorkspace: true };
try {
  await writeFile(path.join(root, 'input.txt'), 'synthetic-only');
  await writeFile(path.join(base, 'outside.txt'), 'outside-workspace');
  const script = `set -eux
test "$(cat /workspace/input.txt)" = synthetic-only
printf 'sandbox-output' > /workspace/output.txt
if touch /nexus-denied 2>/dev/null; then exit 11; fi
awk '$2 == "/" { if ($4 !~ /(^|,)ro(,|$)/) exit 1; found=1 } END { if (!found) exit 1 }' /proc/mounts
test "$(awk '/^CapEff:/ {print $2}' /proc/self/status)" = 0000000000000000
test "$(awk '/^NoNewPrivs:/ {print $2}' /proc/self/status)" = 1
ip link show up | awk '$2 == "lo:" {found=1} $1 ~ /^[0-9]+:$/ && $2 != "lo:" {bad=1} END {if (!found || bad) exit 1}'
test -z "$(ip route)"
test ! -e "$1"
printf 'isolation checks passed\n'
`;
  const result = await runSandbox(root, root, 'sh', ['-c', script, 'nexus-check', path.join(base, 'outside.txt')], image);
  assert.equal(result.stopped, null, result.stopped);
  assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(path.join(root, 'output.txt'), 'utf8'), 'sandbox-output');
  assert.equal(await readFile(path.join(base, 'outside.txt'), 'utf8'), 'outside-workspace');
  Object.assign(receipt, { verified: true, checks: ['workspace-read-write', 'root-read-only', 'zero-effective-capabilities', 'no-new-privileges', 'no-active-external-network', 'no-routes', 'outside-file-not-mounted'] });
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally {
  await writeState(process.cwd(), 'verification', 'docker.json', receipt);
  await rm(base, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt, null, 2));
