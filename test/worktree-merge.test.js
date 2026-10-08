import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../src/process.js';
import { createWorktree, mergeWorktree, resolveWorktree } from '../src/worktrees.js';
import { listState } from '../src/state.js';

async function git(cwd, ...args) {
  const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Nexus Test', '-c', 'user.email=test@example.invalid', ...args], { cwd });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.stopped, null);
  return result.output.trim();
}
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nexus-merge-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project with trailing space '); await mkdir(root);
  await git(root, 'init', '-b', 'main');
  await writeFile(path.join(root, 'app.txt'), 'original\n');
  await git(root, 'add', 'app.txt'); await git(root, 'commit', '-m', 'fixture');
  const target = await createWorktree(root, 'change');
  await writeFile(path.join(target, 'app.txt'), 'reviewed edit\n');
  await git(target, 'add', 'app.txt'); await git(target, 'commit', '-m', 'reviewable change');
  return { root, target };
}
test('worktree merge requires approval and fast-forwards reviewed commits while retaining the worktree', async t => {
  const { root, target } = await fixture(t);
  await assert.rejects(mergeWorktree(root, 'change'), /declined/);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'original\n');
  const result = await mergeWorktree(root, 'change', async review => {
    assert.equal(review.type, 'merge-worktree');
    assert.match(review.diff, /reviewed edit/);
    assert.deepEqual(review.files, ['app.txt']);
    return true;
  });
  assert.equal(result.branch, 'main');
  assert.equal(await git(root, 'rev-parse', 'HEAD'), await git(target, 'rev-parse', 'HEAD'));
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'reviewed edit\n');
  assert.equal(await resolveWorktree(root, 'change'), target);
  assert.deepEqual(await listState(root, 'locks'), []);
});
test('worktree merge refuses dirty destinations and changes made during approval', async t => {
  const { root, target } = await fixture(t);
  await writeFile(path.join(root, 'app.txt'), 'local work\n');
  await assert.rejects(mergeWorktree(root, 'change', async () => true), /must be clean/);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'local work\n');
  await writeFile(path.join(root, 'app.txt'), 'original\n');
  await assert.rejects(mergeWorktree(root, 'change', async () => {
    await writeFile(path.join(target, 'app.txt'), 'unreviewed change\n');
    await git(target, 'add', 'app.txt'); await git(target, 'commit', '-m', 'changed during approval');
    return true;
  }), /changed during approval/);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'original\n');
  assert.deepEqual(await listState(root, 'locks'), []);
});
test('worktree merge refuses protected paths before displaying approval contents', async t => {
  const { root, target } = await fixture(t);
  await writeFile(path.join(target, '.env'), 'PRIVATE_FIXTURE=secret');
  await git(target, 'add', '.env'); await git(target, 'commit', '-m', 'protected content');
  let asked = false;
  await assert.rejects(mergeWorktree(root, 'change', async () => { asked = true; return true; }), /Protected path/);
  assert.equal(asked, false);
  await assert.rejects(readFile(path.join(root, '.env')), { code: 'ENOENT' });
});
test('worktree merge refuses divergent histories', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'other.txt'), 'independent work');
  await git(root, 'add', 'other.txt'); await git(root, 'commit', '-m', 'divergent work');
  await assert.rejects(mergeWorktree(root, 'change', async () => true), /diverged/);
});
