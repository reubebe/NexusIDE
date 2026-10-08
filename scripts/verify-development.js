import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { installAgent } from '../src/agents.js';
import { saveConfig, defaultConfig } from '../src/config.js';
import { runWorkflow } from '../src/workflows.js';
import { runProcess } from '../src/process.js';
import { readState, writeState } from '../src/state.js';

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nexus-development-check-')));
const receipt = { at: new Date().toISOString(), verified: false, syntheticWorkspace: true, model: process.argv[2] || 'gpt-oss:20b', checks: [] };
try {
  await writeFile(path.join(root, 'add.cjs'), 'module.exports = (a, b) => a - b;\n');
  await writeFile(path.join(root, 'add.test.cjs'), 'const { test } = require("node:test"); const assert = require("node:assert/strict"); const add = require("./add.cjs"); test("addition", () => { assert.equal(add(2, 3), 5); assert.equal(add(-4, 1), -3); assert.equal(add(0, 0), 0); });\n');
  await saveConfig(root, { ...structuredClone(defaultConfig), providers: { local: { kind: 'compatible', model: receipt.model, baseUrl: 'http://127.0.0.1:11434/v1' } }, routes: { default: 'local' } });
  for (const agent of [
    { name: 'coder', permissions: { read: true, write: true, execute: false }, instructions: 'Read add.cjs and add.test.cjs. Fix only add.cjs to export a CommonJS function adding its two numeric arguments. Use write_file to actually make the fix; do not edit the test. Report the file changed.' },
    { name: 'tester', permissions: { read: true, write: false, execute: true }, instructions: 'Run the test using run_command with command "node", args ["--test"], path ".". Report the observed exit code and test results. Do not edit files.' },
    { name: 'reviewer', permissions: { read: true, write: false, execute: false }, instructions: 'Read add.cjs and add.test.cjs. Review correctness of the actual implementation and report any remaining issue. Do not claim to have run tests yourself.' },
  ]) await installAgent(root, { version: 1, ...agent });
  const approvals = [];
  const run = await runWorkflow({ root, task: 'Fix the incorrect addition implementation, run the tests and review the result.', allowCommands: true,
    workflow: { version: 1, name: 'development-check', steps: [
      { id: 'implement', agent: 'coder', task: 'Fix add.cjs without modifying the test.' },
      { id: 'test', agent: 'tester', task: 'Run node --test and report actual results.', dependsOn: ['implement'] },
      { id: 'review', agent: 'reviewer', task: 'Review the fix against the tests.', dependsOn: ['test'] },
    ] },
    approve: async request => {
      const allowed = request.path === 'add.cjs' && !request.type || request.type === 'command' && request.command === 'node' && JSON.stringify(request.args) === '["--test"]' && request.cwd === root;
      approvals.push({ type: request.type || 'write', allowed }); return allowed;
    },
    onEvent: event => { if (['step-start', 'tool', 'finish'].includes(event.type)) console.log(JSON.stringify({ type: event.type, step: event.step, tool: event.name, status: event.status })); },
  });
  assert.equal(run.status, 'completed');
  const coder = await readState(root, 'runs', `${run.steps.implement.run}.json`), tester = await readState(root, 'runs', `${run.steps.test.run}.json`);
  assert.ok(coder.events.some(e => e.type === 'tool' && e.name === 'write_file'));
  assert.ok(tester.events.some(e => e.type === 'tool' && e.name === 'run_command'));
  const tests = await runProcess(process.execPath, ['--test'], { cwd: root });
  assert.equal(tests.code, 0, tests.output);
  Object.assign(receipt, { verified: true, checks: ['real-local-model-approved-code-edit', 'tester-command-executed', 'independent-test-exit-zero', 'sequential-review-handoff'], approvals, steps: Object.keys(run.steps) });
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally { await writeState(process.cwd(), 'verification', 'development.json', receipt); await rm(root, { recursive: true, force: true }); }
console.log(JSON.stringify(receipt, null, 2));
