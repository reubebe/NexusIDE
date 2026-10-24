import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installOptionalIntegration } from '../src/optional-integrations.js';
import { loadConfig, saveConfig, defaultConfig } from '../src/config.js';
import { loadAgent } from '../src/agents.js';
import { readState, writeState } from '../src/state.js';
import { loadWorkflow } from '../src/workflows.js';
import { auditSkill } from '../src/skills.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-optional-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('review setup keeps user customizations and never assigns paid providers', async t => {
  const root = await fixture(t);
  const first = await installOptionalIntegration(root, 'review');
  assert.equal(first.created.length, 3);
  assert.equal((await loadWorkflow(root, 'independent-review')).reviewPolicy.maxPlanRounds, 2);
  const critic = await loadAgent(root, 'plan-critic');
  critic.instructions = 'Keep my instructions.';
  await writeState(root, 'agents', 'plan-critic.json', critic);
  const again = await installOptionalIntegration(root, 'review');
  assert.equal(again.created.length, 0);
  assert.equal((await loadAgent(root, 'plan-critic')).instructions, critic.instructions);
  assert.deepEqual((await loadConfig(root)).providers, {});
  assert.deepEqual((await loadConfig(root)).routes, {});
  await assert.rejects(installOptionalIntegration(root, 'review', { engine: '/tmp' }), /Only Cortex/);
});

test('Cortex setup pins but never executes the engine and preserves unrelated connections', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), engine = path.join(root, 'cortex.py'), brain = path.join(root, 'brain');
  await mkdir(path.join(brain, 'notes'), { recursive: true });
  await writeFile(engine, 'raise RuntimeError("Do not execute during setup")\n');
  await saveConfig(root, { ...structuredClone(defaultConfig), providers: { local: { kind: 'compatible', model: 'fixture' } }, routes: { default: 'local' }, mcp: { other: { command: 'fixture', args: [], tools: [] } } });
  const result = await installOptionalIntegration(root, 'cortex', { engine, brain });
  assert.deepEqual(result.created, ['cortex-reader']);
  const config = await loadConfig(root);
  assert.deepEqual(config.routes, { default: 'local' });
  assert.ok(config.mcp.other);
  assert.deepEqual(config.mcp.cortex.envKeys, []);
  assert.match(config.mcp.cortex.args[6], /^[a-f0-9]{64}$/);
  assert.deepEqual((await loadAgent(root, 'cortex-reader')).permissions, { read: false, write: false, execute: false });
  assert.deepEqual((await installOptionalIntegration(root, 'cortex', { engine, brain })).created, []);
  await writeFile(engine, '# Changed engine\n');
  await assert.rejects(installOptionalIntegration(root, 'cortex', { engine, brain }), /existing Cortex connection differs/);
  assert.deepEqual(await loadConfig(root), config);
  assert.equal((await readState(root, 'agents', 'cortex-reader.json')).memory, false);
});

test('optional setup rejects unsupported integrations and missing Cortex paths', async t => {
  const root = await fixture(t);
  await assert.rejects(installOptionalIntegration(root, 'unknown'), /Choose cortex/);
  await assert.rejects(installOptionalIntegration(root, 'cortex'), /absolute|requires macOS/);
});

test('Anatomy setup is repeatable and installs an intact skill without execution grants', async t => {
  const root = await fixture(t);
  const first = await installOptionalIntegration(root, 'anatomy');
  assert.ok(first.created.includes('technical-illustrator'));
  const illustrator = await loadAgent(root, 'technical-illustrator');
  assert.equal(illustrator.permissions.execute, false);
  assert.deepEqual(illustrator.skills, ['anatomy']);
  const audit = await auditSkill(root, 'anatomy');
  assert.equal(audit.integrity, 'matches-record');
  assert.equal((await installOptionalIntegration(root, 'anatomy')).created.length, 0);
  assert.deepEqual((await loadConfig(root)).providers, {});
});

test('Cortex setup rejects invalid interpreter values before writing workspace state', async t => {
  const root = await fixture(t);
  for (const python of [true, 42, {}, '', '   ', 'python3\0--unsafe']) {
    await assert.rejects(installOptionalIntegration(root, 'cortex', { engine: '/unused/cortex.py', brain: '/unused/brain', python }), /python must name/);
  }
  assert.deepEqual(await readdir(root), []);
});
