import { lstat, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { runProcess } from './process.js';
import { runSandbox } from './sandbox.js';
import { searchProject } from './search.js';
import { protectedName, resolveProjectPath } from './file-policy.js';
export { resolveProjectPath } from './file-policy.js';
import { boundedRead, utf8Text } from './bounded-read.js';
import { runGit } from './git.js';

const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const toolDefinitions = [
  { name: 'search_code', description: 'Bounded case-insensitive literal text search in project files, with file and line references. No regex execution.', parameters: schema({ query: { type: 'string' } }) },
  { name: 'git_status', description: 'Read Git status for this workspace.', parameters: schema({}) },
  { name: 'git_diff', description: 'Read tracked changes against HEAD, without external diff programs or text converters.', parameters: schema({}) },
  { name: 'run_command', description: 'Run an executable with arguments after explicit approval. This is host execution, not a sandbox. No shell expansion. Timeout 60 seconds; combined output capped at 100 KB.', parameters: schema({ command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, path: { type: 'string' } }) },
  { name: 'list_files', description: 'List one project directory. Protected paths are omitted.', parameters: schema({ path: { type: 'string' } }) },
  { name: 'read_file', description: 'Read a UTF-8 project file, up to 100 KB.', parameters: schema({ path: { type: 'string' } }) },
  { name: 'write_file', description: 'Create or replace a UTF-8 file in an existing directory after user approval.', parameters: schema({ path: { type: 'string' }, content: { type: 'string' } }) },
];
export function availableTools(agent) {
  return toolDefinitions.filter(t => t.name === 'run_command' ? agent.permissions.execute === true : t.name === 'write_file' ? agent.permissions.write : agent.permissions.read);
}
export async function executeTool(root, agent, name, args, approve, { signal, commandMode = 'host', sandboxImage } = {}) {
  signal?.throwIfAborted();
  if (!availableTools(agent).some(t => t.name === name)) throw new Error(`Permission denied: ${name}`);
  if (!args || typeof args !== 'object') throw new Error('Invalid tool arguments.');
  if (name === 'search_code') return JSON.stringify(await searchProject(root, args.query));
  if (name === 'git_status' || name === 'git_diff') {
    let paths = [];
    if (name === 'git_diff') {
      const names = await runGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--'], { signal });
      if (names.code !== 0 || names.stopped) return JSON.stringify(names);
      for (const candidate of names.output.split('\0').filter(Boolean)) {
        try {
          const target = await resolveProjectPath(root, candidate);
          try { if ((await lstat(target)).nlink !== 1) continue; } catch (e) { if (e.code !== 'ENOENT') throw e; }
          paths.push(candidate);
        } catch { /* Omit protected paths from model-visible diffs. */ }
      }
      if (!paths.length) return 'No tracked changes in accessible files.';
    }
    const result = await runGit(root, ['--literal-pathspecs', ...(name === 'git_status' ? ['status', '--short'] : ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...paths])], { signal });
    return JSON.stringify(result);
  }
  const file = await resolveProjectPath(root, args.path);
  if (name === 'run_command') {
    if (typeof args.command !== 'string' || !args.command || args.command.includes('\0') || !Array.isArray(args.args) || args.args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('Expected executable and string arguments.');
    if (!(await lstat(file)).isDirectory()) throw new Error('Command path must be a directory.');
    if (!['host', 'docker'].includes(commandMode)) throw new Error('Invalid command mode.');
    if (!await approve({ type: 'command', command: args.command, args: args.args, cwd: file, mode: commandMode, image: sandboxImage })) return 'Command declined by user.';
    signal?.throwIfAborted();
    await resolveProjectPath(root, args.path);
    return JSON.stringify(commandMode === 'docker' ? await runSandbox(root, file, args.command, args.args, sandboxImage, signal) : await runProcess(args.command, args.args, { cwd: file, signal }));
  }
  if (name === 'list_files') {
    const entries = await readdir(file, { withFileTypes: true });
    return entries.filter(e => !e.isSymbolicLink() && !protectedName(e.name)).slice(0, 500).map(e => e.name + (e.isDirectory() ? '/' : '')).join('\n');
  }
  if (name === 'read_file') {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 100_000 || stat.nlink !== 1) throw new Error('Expected a singly linked regular file under 100 KB.');
      return utf8Text(await boundedRead(handle, 100_000));
    } finally { await handle.close(); }
  }
  if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 100_000) throw new Error('Content must be text under 100 KB.');
  const buffer = Buffer.from(args.content);
  if (buffer.includes(0) || buffer.toString('utf8') !== args.content) throw new Error('Content must be valid UTF-8 text without null bytes.');
  let before = null;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 100000 || stat.nlink !== 1) throw new Error('Expected a singly linked regular file under 100 KB.');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { before = utf8Text(await boundedRead(handle, 100_000)); } finally { await handle.close(); }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!await approve({ path: args.path, before, after: args.content })) return 'Write declined by user.';
  signal?.throwIfAborted();
  await resolveProjectPath(root, args.path);
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | (before === null ? constants.O_CREAT | constants.O_EXCL : 0);
  const handle = await open(file, flags, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 100000) throw new Error('Unsafe write target.');
    if (before !== null && (await boundedRead(handle, 100_000)).toString('utf8') !== before) throw new Error('File changed during approval; request a fresh edit.');
    await handle.truncate(0);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
      if (!bytesWritten) throw new Error('File write made no progress.');
      offset += bytesWritten;
    }
    await handle.sync();
  } finally { await handle.close(); }
  return `Wrote ${args.path}`;
}
