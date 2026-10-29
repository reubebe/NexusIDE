import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { previewVisualToolConfig, configureVisualTool, visualToolStatus } from '../src/visual-integrations.js';
import { prepareVisualToolCall, startVisualToolWorker } from '../src/visual-tool-worker.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { loadAgent } from '../src/agents.js';
import { connectMcp } from '../src/mcp.js';

const wav = Buffer.from('RIFF0000WAVEfmt ', 'ascii');

async function fixture(t) { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nexus-visual-tools-'))); t.after(() => rm(root, { recursive: true, force: true })); await mkdir(path.join(root, 'media')); return root; }

test('optional setup is side-effect-free until configured and preserves existing profiles', async t => {
  const root = await fixture(t);
  assert.equal((await visualToolStatus(root)).filter(x => x.configured).length, 0);
  const options = { command: process.execPath, scope: 'media' };
  const preview = await previewVisualToolConfig(root, 'earshot', options);
  assert.deepEqual(preview.profile.tools, ['measure']);
  assert.deepEqual((await loadConfig(root)).mcp, {});
  await configureVisualTool(root, 'earshot', options);
  assert.equal((await loadAgent(root, 'audio-reviewer')).permissions.execute, false);
  assert.equal((await configureVisualTool(root, 'earshot', options)).installed, false);
  assert.equal((await visualToolStatus(root)).find(x => x.name === 'earshot').available, true);
  await assert.rejects(configureVisualTool(root, 'earshot', { ...options, cachedModels: true }), /existing connection differs/);
  const config = await loadConfig(root); config.mcp.earshot.args[1] = '{}'; await saveConfig(root, config);
  assert.equal((await visualToolStatus(root)).find(x => x.name === 'earshot').available, false);
});

test('missing executables, unsafe endpoints, and imaging sharing are rejected', async t => {
  const root = await fixture(t);
  await assert.rejects(previewVisualToolConfig(root, 'iris', { command: '/absent/iris', origins: ['https://example.com'] }), /ENOENT/);
  await assert.rejects(previewVisualToolConfig(root, 'iris', { command: process.execPath, origins: ['http://example.com'] }), /HTTPS/);
  await assert.rejects(previewVisualToolConfig(root, 'nninteractive', { command: process.execPath, server: 'https://example.com' }), /sharing/);
  const profile = await previewVisualToolConfig(root, 'nninteractive', { command: process.execPath, server: 'https://example.com', allowImageSharing: true, acknowledgeModelLicense: true });
  assert.ok(!profile.profile.tools.includes('python'));
  await assert.rejects(prepareVisualToolCall(root, profile.settings, 'python', { code: 'print(1)' }), /not granted/);
});

test('worker scopes file input and blocks hardlinks, symlinks and arbitrary output paths', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'media', 'clip.wav'), wav);
  await writeFile(path.join(root, 'outside.wav'), 'fixture');
  const { settings } = await previewVisualToolConfig(root, 'earshot', { command: process.execPath, scope: 'media', cachedModels: true });
  assert.equal((await prepareVisualToolCall(root, settings, 'measure', { path: 'media/clip.wav' })).path, path.join(root, 'media', 'clip.wav'));
  for (const file of ['outside.wav', '../escape.wav', '.env']) await assert.rejects(prepareVisualToolCall(root, settings, 'measure', { path: file }));
  await symlink(path.join(root, 'outside.wav'), path.join(root, 'media', 'link.wav'));
  await assert.rejects(prepareVisualToolCall(root, settings, 'measure', { path: 'media/link.wav' }), /Symbolic/);
  await link(path.join(root, 'outside.wav'), path.join(root, 'media', 'hard.wav'));
  await assert.rejects(prepareVisualToolCall(root, settings, 'measure', { path: 'media/hard.wav' }), /hard links/);
  await assert.rejects(prepareVisualToolCall(root, settings, 'sheet', { path: 'media/clip.wav', out_png: '../secret.png' }), /Unsupported/);
  const sheet = await prepareVisualToolCall(root, settings, 'sheet', { path: 'media/clip.wav' });
  assert.ok(sheet.out_png.startsWith(path.join(root, 'media', 'nexus-visual-output')));
  assert.equal(sheet.include_image, true);
  await assert.rejects(prepareVisualToolCall(root, settings, 'timeline', { path: 'media/clip.wav', cues: '/private/secret.json' }), /Cues must be an inline/);
  assert.deepEqual((await prepareVisualToolCall(root, settings, 'timeline', { path: 'media/clip.wav', cues: [0.2, 1] })).cues, [0.2, 1]);
});

test('Iris accepts only selected starting origins and bounds capture time/size', async t => {
  const root = await fixture(t), { settings } = await previewVisualToolConfig(root, 'iris', { command: process.execPath, origins: ['http://127.0.0.1:1234'] });
  await assert.rejects(prepareVisualToolCall(root, settings, 'capture', { url: 'https://example.com' }), /origins/);
  await assert.rejects(prepareVisualToolCall(root, settings, 'capture', { url: 'file:///tmp/a' }), /origins/);
  await assert.rejects(prepareVisualToolCall(root, settings, 'capture', { url: 'http://127.0.0.1:1234', output: '/tmp/a' }), /Unsupported/);
  await assert.rejects(prepareVisualToolCall(root, settings, 'capture', { url: 'http://127.0.0.1:1234', size: '9999x9999' }), /Viewport/);
  assert.equal((await prepareVisualToolCall(root, settings, 'capture', { url: 'http://127.0.0.1:1234/x', timeout_seconds: 9999 })).timeout_seconds, 40);
});

test('MCP proxy launches reviewed executable with offline defaults and enforces calls end to end', async t => {
  const root = await fixture(t), executable = path.join(root, 'fixture-earshot');
  const sdkRoot = new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url).href;
  await writeFile(executable, `#!${process.execPath}\nimport { Server } from ${JSON.stringify(sdkRoot + 'server/index.js')};\nimport { StdioServerTransport } from ${JSON.stringify(sdkRoot + 'server/stdio.js')};\nimport { ListToolsRequestSchema,CallToolRequestSchema } from ${JSON.stringify(sdkRoot + 'types.js')};\nconst s=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});\ns.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'measure',description:'measure',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}},{name:'llm_critique',description:'upload',inputSchema:{type:'object'}}]}));\ns.setRequestHandler(CallToolRequestSchema,async r=>({content:[{type:'text',text:JSON.stringify({path:r.params.arguments.path,offline:process.env.EARSHOT_OFFLINE,key:process.env.GEMINI_API_KEY??null})}]}));\nawait s.connect(new StdioServerTransport());\n`, { mode: 0o700 });
  await writeFile(path.join(root, 'media', 'fixture.wav'), wav);
  await configureVisualTool(root, 'earshot', { command: executable, scope: 'media' });
  const client = await connectMcp(root, { mcp: ['earshot'] }, async () => true);
  t.after(() => client.close());
  assert.equal(client.tools.length, 1);
  const result = JSON.parse(await client.call(client.tools[0].name, { path: 'media/fixture.wav' }));
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.offline, '1'); assert.equal(data.key, null);
  const denied = JSON.parse(await client.call(client.tools[0].name, { path: '../escape.wav' }));
  assert.equal(denied.isError, true);
});

test('decoder inputs cannot escape scope through playlists or detached imaging data', async t => {
  const root = await fixture(t);
  const earshot = (await previewVisualToolConfig(root, 'earshot', { command: process.execPath, scope: 'media' })).settings;
  await writeFile(path.join(root, 'media', 'playlist.mp3'), '#EXTM3U\nhttps://example.com/private\n');
  await assert.rejects(prepareVisualToolCall(root, earshot, 'measure', { path: 'media/playlist.mp3' }), /playlists/);
  const imaging = (await previewVisualToolConfig(root, 'nninteractive', { command: process.execPath, scope: 'media', server: 'http://127.0.0.1:1527', allowImageSharing: true, acknowledgeModelLicense: true })).settings;
  await writeFile(path.join(root, 'media', 'detached.nrrd'), 'NRRD0005\ndata file: ../../outside.raw\n\ndata');
  await assert.rejects(prepareVisualToolCall(root, imaging, 'load_image', { path: 'media/detached.nrrd' }), /self-contained NRRD/);
  await writeFile(path.join(root, 'media', 'detached.mha'), 'ObjectType = Image\nElementDataFile = ../../outside.raw\n');
  await assert.rejects(prepareVisualToolCall(root, imaging, 'load_image', { path: 'media/detached.mha' }), /self-contained MHA/);
  await writeFile(path.join(root, 'media', 'local.mha'), 'ObjectType = Image\nElementDataFile = LOCAL\n');
  assert.ok((await prepareVisualToolCall(root, imaging, 'load_image', { path: 'media/local.mha' })).path.endsWith('local.mha'));
  const saved = await prepareVisualToolCall(root, imaging, 'save', {});
  assert.ok(saved.out_dir.startsWith(path.join(root, 'media', 'nexus-visual-output')));
  await assert.rejects(prepareVisualToolCall(root, imaging, 'save', { out_dir: '/tmp/escape' }), /Unsupported/);
});
