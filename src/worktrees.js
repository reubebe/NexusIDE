import { mkdir, realpath, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runProcess } from './process.js';
import { resolveProjectPath, executeTool } from './tools.js';
import { acquireWorkspace } from './locks.js';

async function git(root, args) {
  const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root });
  if (result.code !== 0 || result.stopped) throw new Error(`Git failed: ${result.output.trim() || result.stopped}`);
  return result.output.replace(/\r?\n$/, '');
}
function checkName(name) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '')) throw new Error('Worktree names must use lowercase letters, digits, and hyphens.');
}
async function repositoryRoot(root) {
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (await realpath(top) !== await realpath(root)) throw new Error('Run worktree commands from the repository root.');
  return realpath(root);
}
async function managedDirectory(root) {
  const base = await repositoryRoot(root);
  let current = base;
  for (const part of ['.nexus', 'worktrees']) {
    current = path.join(current, part);
    await mkdir(current, { recursive: true });
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Worktree storage cannot be a symbolic link.');
  }
  return current;
}
export async function createWorktree(root, name) {
  checkName(name);
  await git(root, ['rev-parse', '--verify', 'HEAD']);
  const target = path.join(await managedDirectory(root), name);
  await git(root, ['worktree', 'add', '-b', `nexus/${name}`, target, 'HEAD']);
  return target;
}
export async function listWorktrees(root) {
  await repositoryRoot(root);
  return git(root, ['worktree', 'list', '--porcelain']);
}
export async function resolveWorktree(root, name) {
  checkName(name);
  const target = path.join(await managedDirectory(root), name);
  if ((await lstat(target)).isSymbolicLink()) throw new Error('Worktree cannot be a symbolic link.');
  const entries = await listWorktrees(root);
  if (!entries.split('\n').includes(`worktree ${target}`)) throw new Error('This is not a registered NexusIDE worktree.');
  return target;
}
export async function inspectWorktree(root, name) {
  const target = await resolveWorktree(root, name);
  const status = await git(target, ['status', '--short']);
  const safeDiff = await executeTool(target, { permissions: { read: true, write: false } }, 'git_diff', {}, async () => false);
  let diff = safeDiff;
  if (safeDiff !== 'No tracked changes in accessible files.') {
    const result = JSON.parse(safeDiff);
    if (result.code !== 0 || result.stopped) throw new Error('Tracked diff could not be fully inspected.');
    diff = result.output;
  }
  const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: target, maxBytes: 2_000_000 });
  if (result.code !== 0 || result.stopped) throw new Error(`Git failed while listing new files: ${result.output.trim() || result.stopped}`);
  const files = result.output.split('\0').filter(Boolean);
  let total = 0;
  const previews = [];
  for (const relative of files.slice(0, 30)) {
    try {
      const file = await resolveProjectPath(target, relative);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) continue;
        if (stat.size > 100_000 || total + stat.size > 1_000_000) { previews.push(`+++ ${relative} (omitted: inspection size limit)`); continue; }
        const content = await handle.readFile();
        if (content.includes(0) || !Buffer.from(content.toString('utf8'), 'utf8').equals(content)) { previews.push(`+++ ${relative} (omitted: binary or invalid UTF-8)`); continue; }
        total += content.length;
        previews.push(`+++ ${relative}\n${content.toString('utf8')}`);
      } finally { await handle.close(); }
    } catch { /* Skip protected, missing, and unsafe paths. */ }
  }
  if (files.length > 30) previews.push(`... ${files.length - 30} additional untracked files omitted`);
  return `Workspace: ${target}\n\nStatus (protected paths may be omitted from previews):\n${status || '(clean)'}\n\nTracked changes:\n${diff || '(none)'}\n\nNew file previews (max 30 files, 100 KB each, 1 MB total):\n${previews.join('\n\n') || '(none)'}`;
}

async function mergeReview(root, target, name) {
  const targetBranch = await git(root, ['symbolic-ref', '--short', 'HEAD']);
  const sourceBranch = await git(target, ['symbolic-ref', '--short', 'HEAD']);
  if (sourceBranch !== `nexus/${name}`) throw new Error('Worktree branch changed; review it manually.');
  for (const directory of [root, target]) {
    const status = await git(directory, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude,top).nexus']);
    if (status) throw new Error('Both source and destination must be clean. Review and commit worktree changes first.');
    const filters = await runProcess('git', ['config', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], { cwd: directory });
    if (filters.stopped || ![0, 1].includes(filters.code)) throw new Error('Could not inspect Git content filters.');
    if (filters.code === 0) throw new Error('Configured Git content filters require a manual merge.');
  }
  const before = await git(root, ['rev-parse', 'HEAD']);
  const after = await git(target, ['rev-parse', 'HEAD']);
  if (before === after) throw new Error('No new commits to merge.');
  const ancestor = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', 'merge-base', '--is-ancestor', before, after], { cwd: root });
  if (ancestor.code !== 0 || ancestor.stopped) throw new Error('Destination has diverged or ancestry could not be verified. Reconcile the branches manually.');
  const paths = (await git(root, ['diff', '--no-renames', '--name-only', '-z', before, after, '--'])).split('\0').filter(Boolean);
  if (paths.length > 500) throw new Error('Merge exceeds the 500-file review limit.');
  for (const relative of paths) {
    for (const directory of [root, target]) {
      const candidate = await resolveProjectPath(directory, relative);
      try { if ((await lstat(candidate)).nlink !== 1) throw new Error('Merge contains a hard-linked path.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  // Refuse link/submodule changes, including links deleted from the target revision.
  for (const revision of [before, after]) {
    if (!paths.length) continue;
    const tree = await git(root, ['--literal-pathspecs', 'ls-tree', '-r', '-z', revision, '--', ...paths]);
    if (tree.split('\0').filter(Boolean).some(entry => !/^100(?:644|755) blob /.test(entry))) throw new Error('Merging symlinks or submodules requires manual review.');
  }
  const diff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', before, after, '--']);
  if (/^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff)) throw new Error('Binary changes require a manual merge.');
  return { type: 'merge-worktree', name, targetBranch, sourceBranch, before, after, files: paths, diff };
}

export async function mergeWorktree(root, name, approve = async () => false) {
  const target = await resolveWorktree(root, name);
  const releaseRoot = await acquireWorkspace(root, root, randomUUID());
  let releaseTarget;
  try {
    releaseTarget = await acquireWorkspace(root, target, randomUUID());
    const review = await mergeReview(root, target, name);
    if (!await approve(review)) throw new Error('Merge declined.');
    if (JSON.stringify(await mergeReview(root, target, name)) !== JSON.stringify(review)) throw new Error('Branches changed during approval; review the merge again.');
    await git(root, ['merge', '--ff-only', '--no-edit', '--no-stat', review.after]);
    return { name, branch: review.targetBranch, before: review.before, after: await git(root, ['rev-parse', 'HEAD']), files: review.files };
  } finally {
    try { await releaseTarget?.(); } finally { await releaseRoot(); }
  }
}
