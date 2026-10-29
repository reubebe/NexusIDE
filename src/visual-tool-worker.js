import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstat, mkdir, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { commandEnvironment } from './process.js';
import { resolveProjectPath } from './file-policy.js';
import { previewVisualToolConfig } from './visual-integrations.js';

const fields = {
  capture: ['url', 'selector', 'padding', 'full_page', 'size', 'dark', 'format', 'wait_ms', 'wait_for', 'scale', 'timeout_seconds'],
  measure: ['path', 'start', 'end', 'music', 'light', 'full'], describe: ['path', 'start', 'end', 'top', 'full'],
  match: ['path', 'query', 'alts', 'start', 'end', 'full'], find: ['path', 'query', 'top', 'kind', 'win', 'hop', 'start', 'end', 'full'],
  timeline: ['path', 'video', 'cues', 'start', 'end', 'detail', 'full'], sheet: ['path', 'video', 'cues', 'start', 'end', 'detail', 'full'],
  critique: ['path', 'video', 'fast', 'full'],
  load_image: ['path', 'spacing', 'channel'], image_info: [], view: ['center', 'object', 'axes', 'size', 'window', 'show_objects', 'overlay'],
  montage: ['axis', 'n', 'object', 'slice_range', 'window', 'show_objects', 'overlay'], projection: ['axis', 'mode', 'window'], render3d: ['object', 'views', 'show_neighbors'],
  new_object: ['name', 'extent'], bbox: ['corner1', 'corner2', 'preview'], scribble: ['points', 'positive', 'axis', 'preview'], point: ['position', 'positive', 'preview'],
  undo: [], stats: ['object'], commit: ['notes', 'keep_largest', 'min_component_size', 'overlap'], discard: [], edit_object: ['object'], list_objects: [], save: [],
};
const within = (base, target) => { const rel = path.relative(base, target); return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };

async function inputFile(root, scope, value) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('Choose a project file path.');
  const canonical = await realpath(root);
  const target = await resolveProjectPath(canonical, path.isAbsolute(value) ? path.relative(canonical, value) : value);
  if (!within(scope, target)) throw new Error('File is outside the approved tool scope.');
  const stat = await lstat(target);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 500_000_000) throw new Error('Use a regular file without hard links, at most 500 MB.');
  return target;
}

async function inputHeader(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Input file changed; use a regular unlinked file.');
    const bytes = Buffer.alloc(65536), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

// A safe outer filename is insufficient: playlists and detached imaging headers
// can make a decoder read a second path or URL. Admit self-contained containers.
async function checkContainer(name, file) {
  const bytes = await inputHeader(file), ascii = bytes.toString('latin1');
  if (name === 'nninteractive') {
    if (/\.nrrd$/i.test(file)) {
      const end = ascii.search(/\r?\n\r?\n/), header = end < 0 ? '' : ascii.slice(0, end);
      if (!header.startsWith('NRRD') || /^data\s*file\s*:/im.test(header)) throw new Error('Use a self-contained NRRD without a detached data file.');
    } else if (/\.mha$/i.test(file)) {
      if (!/^ElementDataFile\s*=\s*LOCAL\s*$/im.test(ascii) || /^ElementDataFile\s*=\s*(?!LOCAL\s*$)\S+/im.test(ascii)) throw new Error('Use a self-contained MHA with ElementDataFile = LOCAL.');
    }
    return;
  }
  const extension = path.extname(file).toLowerCase();
  const accepted = {
    '.wav': ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE',
    '.aif': ascii.startsWith('FORM') && ['AIFF', 'AIFC'].includes(ascii.slice(8, 12)),
    '.aiff': ascii.startsWith('FORM') && ['AIFF', 'AIFC'].includes(ascii.slice(8, 12)),
    '.flac': ascii.startsWith('fLaC'), '.ogg': ascii.startsWith('OggS'), '.opus': ascii.startsWith('OggS'),
    '.mp3': ascii.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0),
    '.m4a': ascii.slice(4, 8) === 'ftyp', '.mp4': ascii.slice(4, 8) === 'ftyp',
    '.mov': ['ftyp', 'moov', 'wide', 'mdat'].includes(ascii.slice(4, 8)),
    '.webm': bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    '.mkv': bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  };
  if (!Object.hasOwn(accepted, extension) || !accepted[extension]) throw new Error('Choose a self-contained supported audio/video container; playlists and disguised text inputs are not accepted.');
}

export async function prepareVisualToolCall(root, settings, tool, input) {
  const { version, name, ...options } = settings;
  if (version !== 1) throw new Error('Unsupported worker settings.');
  const preview = await previewVisualToolConfig(root, name, options);
  if (!preview.profile.tools.includes(tool) || !Object.hasOwn(fields, tool)) throw new Error('Tool is not granted.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 20000 || Object.keys(input).some(key => !fields[tool].includes(key))) throw new Error('Unsupported or oversized tool arguments. Output locations are managed by Nexus.');
  const args = structuredClone(input), scope = await resolveProjectPath(root, settings.scope);
  // Upstream also accepts a cues filename. Keep this adapter's cues inline so
  // that an alternate file-reading parameter cannot bypass the approved scope.
  if (args.cues != null && (!Array.isArray(args.cues) || args.cues.length > 500 || args.cues.some(n => !Number.isFinite(n) || n < 0 || n > 86400))) throw new Error('Cues must be an inline list of at most 500 nonnegative times in seconds.');
  if (name === 'iris') {
    if (typeof args.url !== 'string') throw new Error('Screenshot URL is required.');
    const url = new URL(args.url);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || !settings.origins.includes(url.origin)) throw new Error('Screenshot URL is outside the approved starting origins.');
    if (args.selector && args.full_page) throw new Error('Choose an element or full-page capture.');
    args.timeout_seconds = Math.min(40, Math.max(1, Number(args.timeout_seconds ?? 30) || 30));
    args.wait_ms = Math.min(5000, Math.max(0, Number(args.wait_ms ?? 0) || 0));
    if (args.scale !== undefined && (!Number.isFinite(args.scale) || args.scale < 0.5 || args.scale > 3)) throw new Error('Image scale must be 0.5–3.');
    if (args.size !== undefined && !['desktop', 'iphone', 'ipad'].includes(args.size)) {
      const match = /^(\d{2,4})x(\d{2,4})$/.exec(args.size);
      if (!match || +match[1] > 2560 || +match[2] > 2560) throw new Error('Viewport must be a preset or at most 2560×2560.');
    }
  } else {
    for (const key of ['path', 'video']) if (args[key] !== undefined && args[key] !== null) { args[key] = await inputFile(root, scope, args[key]); await checkContainer(name, args[key]); }
    if (['load_image', 'measure', 'describe', 'match', 'find', 'timeline', 'sheet', 'critique'].includes(tool) && !args.path) throw new Error('An input path is required.');
    if (name === 'nninteractive' && tool === 'load_image' && !/\.(nii(\.gz)?|nrrd|mha|tiff?|png|jpe?g|npy)$/i.test(args.path)) throw new Error('Unsupported image/volume format.');
    if (tool === 'sheet' || tool === 'save') {
      const relative = path.join(settings.scope, 'nexus-visual-output', randomUUID());
      const directory = await resolveProjectPath(root, relative);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (tool === 'sheet') { args.out_png = path.join(directory, 'audio-sheet.png'); args.include_image = true; }
      else args.out_dir = directory;
    }
  }
  return args;
}

export async function startVisualToolWorker(settings, root = process.cwd()) {
  const { version, name, ...options } = settings;
  if (version !== 1) throw new Error('Unsupported worker settings.');
  const preview = await previewVisualToolConfig(root, name, options), env = commandEnvironment();
  let args;
  if (name === 'iris') args = ['mcp'];
  else if (name === 'earshot') {
    args = ['mcp'];
    Object.assign(env, { EARSHOT_OFFLINE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' });
  } else {
    const output = await resolveProjectPath(root, path.join(settings.scope, 'nexus-visual-output', randomUUID()));
    await mkdir(output, { recursive: true, mode: 0o700 });
    args = ['--server', settings.server, '--python', 'off', '--workdir', output];
    if (process.env.NN_INTERACTIVE_API_KEY) env.NN_INTERACTIVE_API_KEY = process.env.NN_INTERACTIVE_API_KEY;
  }
  const client = new Client({ name: 'nexus-visual-worker', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: settings.command, args, env, cwd: root, stderr: 'pipe', maxBufferSize: 12_000_000 });
  transport.stderr?.on('data', () => {});
  const server = new Server({ name: `nexus-${name}`, version: '1.0.0' }, { capabilities: { tools: {} } });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await Promise.allSettled([client.close(), server.close()]); };
  try {
    await client.connect(transport, { timeout: 15000 });
    const upstream = await client.listTools({}, { timeout: 15000 });
    const granted = upstream.tools.filter(tool => preview.profile.tools.includes(tool.name)).map(tool => {
      const schema = structuredClone(tool.inputSchema);
      schema.properties = Object.fromEntries(Object.entries(schema.properties || {}).filter(([key]) => fields[tool.name].includes(key)));
      schema.additionalProperties = false;
      if (schema.properties.cues) schema.properties.cues = { type: 'array', items: { type: 'number', minimum: 0, maximum: 86400 }, maxItems: 500, description: 'Inline cue times in seconds. Cue filenames are not accepted.' };
      if (schema.required) schema.required = schema.required.filter(key => fields[tool.name].includes(key));
      return { ...tool, inputSchema: schema };
    });
    if (!granted.length) throw new Error('Upstream exposes none of the reviewed tool names.');
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: granted }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        if (!granted.some(t => t.name === request.params.name)) throw new Error('Tool is not available.');
        const prepared = await prepareVisualToolCall(root, settings, request.params.name, request.params.arguments || {});
        return await client.callTool({ name: request.params.name, arguments: prepared }, undefined, { timeout: 55000 });
      } catch (error) {
        // A timed-out request may still occupy a model/GPU. Close its process;
        // another run can create a fresh connection after the failure is reviewed.
        if (/timeout|timed out/i.test(error.message)) await client.close().catch(() => {});
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
    server.onclose = () => { void close(); };
    await server.connect(new StdioServerTransport());
    process.once('SIGTERM', () => { void close(); });
    process.once('SIGINT', () => { void close(); });
    return { close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await startVisualToolWorker(JSON.parse(process.argv[2] || 'null')); }
  catch (error) { process.stderr.write(`Visual worker: ${error.message}\n`); process.exitCode = 1; }
}
