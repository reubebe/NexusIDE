import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { importSkill, skillResource } from '../src/skills.js';
import { validateAgent } from '../src/agents.js';

const bundle = fileURLToPath(new URL('../integrations/anatomy/', import.meta.url));

test('Anatomy subset imports without execution, retains attribution and fits resource limits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-anatomy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provenance = JSON.parse(await readFile(path.join(bundle, 'provenance.json'), 'utf8'));
  for (const [file, hash] of Object.entries(provenance.copiedFiles)) {
    assert.equal(createHash('sha256').update(await readFile(path.join(bundle, file))).digest('hex'), hash, file);
  }
  const imported = await importSkill(root, bundle, provenance);
  assert.equal(imported.name, 'anatomy');
  assert.equal(imported.revision, provenance.revision);
  const agent = validateAgent(JSON.parse(await readFile(new URL('../examples/technical-illustrator.json', import.meta.url), 'utf8')));
  assert.equal(agent.permissions.execute, false);
  for (const resource of imported.files) {
    const text = await skillResource(root, agent, 'anatomy', resource);
    assert.ok(Buffer.byteLength(text) < 100000, resource);
  }
  assert.match(await skillResource(root, agent, 'anatomy', 'LICENSE'), /Copyright \(c\) 2026 Ryan/);
  assert.ok(imported.instructions.length < 30000);
  await assert.rejects(skillResource(root, { skills: [] }, 'anatomy', 'kit/iso-kit.mjs'), /not granted/);
});

test('Anatomy example builds offline from its complete local dependency subset', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-anatomy-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(bundle, path.join(root, 'anatomy'), { recursive: true });
  const working = path.join(root, 'anatomy');
  const result = spawnSync(process.execPath, ['examples/dial-indicator/build.mjs', '--light'], { cwd: working, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const html = await readFile(path.join(working, 'examples/dial-indicator/dial-indicator-light.html'), 'utf8');
  assert.match(html, /role="slider"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/);
  assert.doesNotMatch(html, /(?:d|points)="[^"]*(?:NaN|undefined)/);
});
