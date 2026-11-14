import { lstat, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { runProcess } from './process.js';
import { runSandbox } from './sandbox.js';
import { searchProject } from './search.js';
import { protectedName, resolveProjectPath } from './file-policy.js';
export { resolveProjectPath } from './file-policy.js';
import { boundedRead, utf8Text } from './bounded-read.js';
import { runGit } from './git.js';
import { createVisualArtifact } from './artifacts.js';

const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const projectPath = { type: 'string', minLength: 1, description: 'Required nonempty path relative to the project. Use "." for the project directory, or e.g. "src/app.js" for a file. Never use an empty path, an absolute path or a guessed workspace prefix.' };
export const toolDefinitions = [
  { name: 'list_board_tasks', description: 'List project tasks explicitly available to this agent. Human-only and other claimed tasks are withheld.', parameters: schema({}) },
  { name: 'get_board_task', description: 'Read an eligible task by ID. Human-only tasks cannot be accessed.', parameters: schema({ id: { type: 'string' } }) },
  { name: 'update_board_task', description: 'Claim, comment or request review on an eligible task after approval. Needs task ID, current revision and changes (claim:true, comment, status:doing|review). Humans authorize completion and archiving.', parameters: schema({ id: { type: 'string' }, changes: { type: 'object' } }) },
  { name: 'studio_edit', description: 'Propose and execute a reviewed Studio recipe using the same engine as the GUI. Operations: image.adjust (assetId, brightness -1..1, contrast 0..2, saturation 0..3, rotate 0/90/180/270, optional crop x/y/width/height); video.edit (version-1 edit plan); design.layout (title,width,height,background and rect/text items); motion.animate (assetId,seconds,startX,startY,endX,endY,background); pdf.organize on macOS (assetId,pages array of 1-based indices,rotation 0/90/180/270,note). Original sources are preserved. Requires write and host command grants and explicit approval.', parameters: schema({ recipe: { type: 'object' } }) },
  { name: 'render_animation', description: 'Render a reviewed ManimGL Python scene to a new MP4 and receipt. Requires write and host command access plus explicit approval. Python and its imports run with host privileges. ManimGL and FFmpeg/ffprobe must already be installed.', parameters: schema({ script: { type: 'string' }, scene: { type: 'string' }, executable: { type: 'string' } }) },
  { name: 'export_video_comparison', description: 'Export two project videos side by side as a new MP4 after approval. Starts both at zero, source audio only, at most 120 seconds. Preserves originals and writes an inspection receipt. Requires write and host command access and installed FFmpeg/ffprobe.', parameters: schema({ source: { type: 'string' }, draft: { type: 'string' }, seconds: { type: 'number', exclusiveMinimum: 0, maximum: 120 } }) },
  { name: 'preview_media_edit', description: 'Render a local video edit preview with ffmpeg after approval. Preserves originals and returns a receipt, timeline and cut-boundary frames. This does not inspect video or transcribe audio. plan: version 1, title, clips [{path,start,end}], optional width,height,fps. Local MP4/MOV/M4V/WebM/MKV only, at most 24 clips and 600 seconds. Requires write and command access.', parameters: schema({ plan: { type: 'object' } }) },
  { name: 'create_visualization', description: 'Save a validated visual in the Visualizations panel after approval. spec is version 1 JSON: kind bar/line/scatter/timeline/graph/spatial, title, sources [{label,path?}], axes xLabel/yLabel/xUnit/yUnit, data [{label,x,y,series?}] (null y means unavailable). Timeline uses xUnit s and data [{label,start,end}]. Graph uses nodes [{id,label}] and edges [{source,target,label,relation:extracted|inferred|ambiguous}]. Spatial uses zUnit and data [{label,x,y,z}], optional triangles [[vertex indices]]. No scripts or HTML.', parameters: schema({ spec: { type: 'object' } }) },
  { name: 'search_code', description: 'Bounded case-insensitive literal text search in project files, with file and line references. No regex execution.', parameters: schema({ query: { type: 'string' } }) },
  { name: 'git_status', description: 'Read Git status for this workspace.', parameters: schema({}) },
  { name: 'git_diff', description: 'Read tracked changes against HEAD, without external diff programs or text converters.', parameters: schema({}) },
  { name: 'run_command', description: 'Run an executable with arguments after explicit approval. This is host execution, not a sandbox. No shell expansion. Timeout 60 seconds; combined output capped at 100 KB.', parameters: schema({ command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, path: projectPath }) },
  { name: 'list_files', description: 'List one project directory. Pass path:"." to list the project root. Protected paths are omitted.', parameters: schema({ path: projectPath }) },
  { name: 'read_file', description: 'Read a UTF-8 project file, up to 100 KB.', parameters: schema({ path: projectPath }) },
  { name: 'write_file', description: 'Create or replace a UTF-8 file in an existing directory after user approval.', parameters: schema({ path: projectPath, content: { type: 'string' } }) },
];
export function availableTools(agent) {
  return toolDefinitions.filter(t => ['preview_media_edit', 'render_animation', 'export_video_comparison', 'studio_edit'].includes(t.name) ? agent.permissions?.execute === true && agent.permissions?.write === true : t.name === 'run_command' ? agent.permissions?.execute === true : ['write_file', 'create_visualization', 'update_board_task'].includes(t.name) ? agent.permissions?.write === true : agent.permissions?.read === true);
}
export async function executeTool(root, agent, name, args, approve, { signal, commandMode = 'host', sandboxImage } = {}) {
  signal?.throwIfAborted();
  if (!availableTools(agent).some(t => t.name === name)) throw new Error(`Permission denied: ${name}`);
  if (!args || typeof args !== 'object') throw new Error('Invalid tool arguments.');
  if (['list_board_tasks','get_board_task','update_board_task'].includes(name)) {
    const { listBoardTasks, getBoardTask, updateBoardTask } = await import('./task-board.js');
    const actor = { kind:'agent', id:agent.name };
    if(name==='list_board_tasks') return JSON.stringify(await listBoardTasks(root,actor));
    if(name==='get_board_task') return JSON.stringify(await getBoardTask(root,args.id,actor));
    await getBoardTask(root,args.id,actor);
    if((await approve({type:'board-update',id:args.id,changes:args.changes})) !== true)return 'Task update declined.';
    signal?.throwIfAborted();return JSON.stringify(await updateBoardTask(root,args.id,args.changes,actor));
  }
  if (name === 'studio_edit') {
    if (commandMode !== 'host') throw new Error('Studio media tools require host mode.');
    const { planStudioEdit, executeStudioPlan } = await import('./studio.js');
    const plan = await planStudioEdit(root,args.recipe);
    return JSON.stringify(await executeStudioPlan(root,plan,{approve,signal}));
  }
  if (['render_animation', 'export_video_comparison'].includes(name)) {
    if (commandMode !== 'host') throw new Error('Motion tools require host command mode; container isolation is not implemented.');
    const { renderAnimation, exportComparison } = await import('./motion.js');
    return JSON.stringify(await (name === 'render_animation' ? renderAnimation : exportComparison)(root, args, { approve, signal }));
  }
  if (name === 'preview_media_edit') {
    if (commandMode !== 'host') throw new Error('Media previews currently require host command mode; container isolation is not implemented for this tool.');
    const { previewMediaEdit } = await import('./media-workflow.js');
    return JSON.stringify(await previewMediaEdit(root, args.plan, { approve, signal, timeoutMs: 60000 }));
  }
  if (name === 'create_visualization') {
    const { validateVisualSpec } = await import('./visual-spec.js');
    const spec = validateVisualSpec(args.spec);
    if ((await approve({ type: 'visualization', title: spec.title, spec })) !== true) return 'Visualization declined.';
    signal?.throwIfAborted();
    return JSON.stringify(await createVisualArtifact(root, spec, { source: `Agent ${agent.name || 'tool'}` }));
  }
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
    if ((await approve({ type: 'command', command: args.command, args: args.args, cwd: file, mode: commandMode, image: sandboxImage })) !== true) return 'Command declined by user.';
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
  if ((await approve({ path: args.path, before, after: args.content })) !== true) return 'Write declined by user.';
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
