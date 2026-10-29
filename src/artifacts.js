import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { writeState, readState, listState, deleteState, safeName } from './state.js';
import { resolveProjectPath } from './file-policy.js';
import { boundedRead, utf8Text } from './bounded-read.js';
import { validateVisualSpec } from './visual-spec.js';

export const MAX_IMAGE_BYTES = 5_000_000;
const digest = data => createHash('sha256').update(data).digest('hex');
function identity({ title, source = 'User import', runId } = {}) {
  if (typeof title !== 'string' || !title.trim() || title.length > 240 || typeof source !== 'string' || source.length > 2000) throw new Error('Provide an artifact title and bounded source.');
  if (runId !== undefined) safeName(runId);
  return { title, source, ...(runId ? { runId } : {}) };
}
async function store(root, metadata, payload) {
  if ((await listState(root, 'artifacts')).length >= 500) throw new Error('Artifact limit reached (500). Delete unused artifacts before adding more.');
  const id = randomUUID(), encoded = JSON.stringify(payload);
  const record = { version: 1, id, created: new Date().toISOString(), ...metadata, bytes: Buffer.byteLength(encoded), sha256: digest(encoded) };
  await writeState(root, 'artifact-data', `${id}.json`, payload, { exclusive: true });
  try { await writeState(root, 'artifacts', `${id}.json`, record, { exclusive: true }); }
  catch (e) { await deleteState(root, 'artifact-data', `${id}.json`).catch(() => {}); throw e; }
  return record;
}
export async function createVisualArtifact(root, spec, options = {}) {
  const validated = validateVisualSpec(spec);
  for (const source of validated.sources) if (source.path) await resolveProjectPath(root, source.path);
  return store(root, { ...identity({ ...options, title: validated.title }), kind: validated.kind, mimeType: 'application/json' }, { spec: validated });
}
export function validateImage(mimeType, data) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) || typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || data.length % 4 !== 0) throw new Error('Expected a PNG, JPEG or WebP image under 5 MB.');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== data) throw new Error('Image size is invalid.');
  let width, height;
  if (mimeType === 'image/png') {
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG header.');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mimeType === 'image/jpeg') {
    if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Invalid JPEG header.');
    for (let p = 2; p + 8 < bytes.length;) {
      if (bytes[p++] !== 255) throw new Error('Invalid JPEG marker.');
      while (bytes[p] === 255) p++;
      const marker = bytes[p++]; if (marker === 218 || marker === 217) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      const size = bytes.readUInt16BE(p); if (size < 2 || p + size > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) { height = bytes.readUInt16BE(p + 3); width = bytes.readUInt16BE(p + 5); break; }
      p += size;
    }
  } else {
    if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Invalid WebP header.');
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X') { width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; }
    else if (type === 'VP8 ' && bytes.toString('hex', 23, 26) === '9d012a') { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
    else if (type === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; }
  }
  if (!width || !height || width > 16000 || height > 16000 || width * height > 40_000_000) throw new Error('Image dimensions are missing or exceed 40 megapixels / 16000 pixels per side.');
  return { bytes, width, height };
}
export async function createImageArtifact(root, { mimeType, data, ...options }) {
  const { width, height } = validateImage(mimeType, data);
  return store(root, { ...identity(options), kind: 'image', mimeType, width, height }, { data });
}
export async function listArtifacts(root) {
  const names = await listState(root, 'artifacts');
  const records = [];
  for (const name of names.slice(-500)) records.push(await readState(root, 'artifacts', name));
  return records.sort((a, b) => b.created.localeCompare(a.created));
}
export async function readArtifact(root, id) {
  safeName(id);
  const record = await readState(root, 'artifacts', `${id}.json`), payload = await readState(root, 'artifact-data', `${id}.json`);
  if (digest(JSON.stringify(payload)) !== record.sha256) throw new Error('Artifact contents do not match their saved digest.');
  if (record.kind === 'image') validateImage(record.mimeType, payload.data); else validateVisualSpec(payload.spec);
  return { ...record, ...payload };
}
export async function removeArtifact(root, id) {
  safeName(id);
  await readState(root, 'artifacts', `${id}.json`);
  await deleteState(root, 'artifacts', `${id}.json`);
  await deleteState(root, 'artifact-data', `${id}.json`).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
export async function importArtifact(root, relative, options = {}) {
  const file = await resolveProjectPath(root, relative);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try { bytes = await boundedRead(handle, MAX_IMAGE_BYTES); } finally { await handle.close(); }
  const extension = relative.split('.').at(-1).toLowerCase();
  const mimeType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[extension];
  return mimeType ? createImageArtifact(root, { title: relative.split('/').at(-1), source: relative, ...options, mimeType, data: bytes.toString('base64') })
    : createVisualArtifact(root, JSON.parse(utf8Text(bytes)), { source: relative, ...options });
}

// Remove inline image payloads from model-visible tool text and persist bounded
// artifacts. Storage does not imply permission to transmit pixels to a model.
export async function extractMcpArtifacts(root, result, options) {
  if (!Array.isArray(result?.content)) return result;
  let count = 0, binary = false;
  const content = [];
  for (const item of result.content) {
    const resource = item?.type === 'resource' && item.resource;
    if (item?.type !== 'image' && !resource?.blob && item?.type !== 'audio') { content.push(item); continue; }
    binary = true;
    if (item?.type === 'audio' || resource?.blob && !resource.mimeType?.startsWith('image/')) { content.push({ type: 'text', text: 'Binary resource omitted from model text. Use a reviewed scoped tool to inspect it.' }); continue; }
    try {
      if (++count > 4) throw new Error('At most four images per tool response are retained.');
      const artifact = await createImageArtifact(root, { ...options, title: `${options?.source || 'Tool image'} ${count}`, mimeType: resource?.mimeType || item.mimeType, data: resource?.blob || item.data });
      content.push({ type: 'text', text: JSON.stringify({ artifact, note: 'Image stored in Visualizations. This image payload is omitted from model text; explicit visual review is separate.' }) });
    } catch (error) { content.push({ type: 'text', text: `Image unavailable: ${error.message}` }); }
  }
  // Servers may mirror binary payloads in arbitrary metadata or structured data.
  // Do not replay those duplicate envelopes when processing binary responses.
  return binary ? { isError: result.isError === true, content, omittedBinaryMetadata: true } : { ...result, content };
}
