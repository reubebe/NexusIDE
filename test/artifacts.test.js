import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVisualArtifact, createImageArtifact, validateImage, listArtifacts, readArtifact, removeArtifact, importArtifact, extractMcpArtifacts, MAX_IMAGE_BYTES } from '../src/artifacts.js';
import { validateVisualSpec, visualCsv } from '../src/visual-spec.js';
import { writeState } from '../src/state.js';
import { startServer } from '../src/server.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS9sAAAAASUVORK5CYII=';
const chart = () => ({ version: 1, kind: 'bar', title: 'Measured fixture', sources: [{ label: 'Synthetic fixture only' }], xLabel: 'Group', xUnit: 'category', yLabel: 'Count', yUnit: 'count', data: [{ label: 'A', y: 2 }, { label: 'Unavailable', y: null }, { label: 'B', y: -3 }] });
async function workspace(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-artifacts-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('visual schema admits typed chart, timeline, graph, and spatial data while preserving missing values', () => {
  const bar = chart(); assert.deepEqual(validateVisualSpec(bar), bar); assert.notEqual(validateVisualSpec(bar), bar);
  for (const kind of ['line', 'scatter']) assert.equal(validateVisualSpec({ ...bar, kind, data: bar.data.map((r, x) => ({ ...r, x })) }).kind, kind);
  assert.equal(validateVisualSpec({ ...bar, kind: 'timeline', xUnit: 's', data: [{ label: 'clip', start: 0, end: 2 }] }).kind, 'timeline');
  const graph = { version: 1, kind: 'graph', title: 'Source graph', sources: [{ label: 'Synthetic' }], nodes: [{ id: 'a', label: 'A', source: 0 }, { id: 'b', label: 'B' }], edges: [{ source: 'a', target: 'b', label: 'Calls', relation: 'extracted', confidence: 0.9 }] };
  assert.deepEqual(validateVisualSpec(graph), graph);
  const spatial = { ...bar, kind: 'spatial', zUnit: 'mm', data: [{ label: 'a', x: 0, y: 0, z: 0 }, { label: 'b', x: 1, y: 0, z: 0 }, { label: 'c', x: 0, y: 1, z: 0 }], triangles: [[0, 1, 2]] };
  assert.deepEqual(validateVisualSpec(spatial), spatial);
  assert.throws(() => validateVisualSpec({ ...graph, edges: [{ ...graph.edges[0], target: 'missing' }] }), /missing node/);
  assert.throws(() => validateVisualSpec({ ...graph, edges: [{ ...graph.edges[0], relation: 'certain' }] }), /relation/);
  assert.throws(() => validateVisualSpec({ ...spatial, triangles: [[0, 1, 3]] }), /vertex/);
});

test('visual schema rejects executable fields, unsafe sources, invalid quantities and oversized collections', () => {
  for (const change of [{ html: '<script>alert(1)</script>' }, { data: [{ label: 'a', y: Infinity }] }, { data: [{ label: 'a', y: '2' }] }, { sources: [] }, { yUnit: '' }, { data: Array.from({ length: 2001 }, () => ({ label: 'a', y: 1 })) }, { kind: 'timeline', xUnit: 'ms', data: [{ label: 'a', start: 0, end: 2 }] }, { kind: 'timeline', xUnit: 's', data: [{ label: 'a', start: 2, end: 1 }] }]) assert.throws(() => validateVisualSpec({ ...chart(), ...change }), /Invalid visualization/);
  for (const source of [{ label: 'bad', url: 'javascript:alert(1)' }, { label: 'bad', url: 'https://user:pass@example.invalid' }, { label: 'bad', path: '../secret' }, { label: 'bad', path: '/secret' }, { label: 'bad', path: '.nexus/state.json' }]) assert.throws(() => validateVisualSpec({ ...chart(), sources: [source] }));
});

test('CSV export quotes data and neutralizes spreadsheet formula labels while retaining numeric signs', () => {
  const spec = chart(); spec.data[0].label = '=HYPERLINK("https://example.invalid")'; spec.data[1].label = 'a,"b"\nrow';
  const csv = visualCsv(spec);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/);
  assert.match(csv, /"a,""b""\nrow"/); assert.match(csv, /"-3"/); assert.ok(!csv.includes("'-3"));
});

test('images accept bounded supported headers and refuse formats, dimensions and oversized payloads', () => {
  const image = validateImage('image/png', png); assert.equal(image.width, 1); assert.equal(image.height, 1);
  for (const [mime, data] of [['image/svg+xml', Buffer.from('<svg/>').toString('base64')], ['image/jpeg', png], ['image/png', 'invalid'], ['image/png', ''], ['image/png', Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')]]) assert.throws(() => validateImage(mime, data));
  const bomb = Buffer.from(png, 'base64'); bomb.writeUInt32BE(10000, 16); bomb.writeUInt32BE(10000, 20);
  assert.throws(() => validateImage('image/png', bomb.toString('base64')), /dimensions/);
  const boundary = Buffer.alloc(MAX_IMAGE_BYTES); Buffer.from(png, 'base64').copy(boundary);
  assert.equal(validateImage('image/png', boundary.toString('base64')).width, 1, 'Maximum supported base64 payload must not overflow the regex stack');
  const noncanonical = png.slice(0, -2) + 'J='; // Same decoded bytes, nonzero unused padding bits.
  assert.equal(Buffer.from(noncanonical, 'base64').equals(Buffer.from(png, 'base64')), true);
  assert.throws(() => validateImage('image/png', noncanonical), /base64|canonical|image/i);
});

test('artifact round-trip stores separate bounded payloads and detects corruption', async t => {
  const root = await workspace(t);
  const saved = await createVisualArtifact(root, chart(), { source: 'Synthetic test', runId: 'run-fixture' });
  assert.match(saved.id, /^[a-f0-9-]+$/); assert.match(saved.sha256, /^[a-f0-9]{64}$/); assert.equal(saved.runId, 'run-fixture');
  const listed = await listArtifacts(root); assert.equal(listed.length, 1); assert.equal(listed[0].spec, undefined);
  assert.deepEqual((await readArtifact(root, saved.id)).spec, chart());
  await writeState(root, 'artifact-data', saved.id + '.json', { spec: { ...chart(), title: 'Changed' } });
  await assert.rejects(readArtifact(root, saved.id), /digest/);
  await removeArtifact(root, saved.id);
  assert.equal((await listArtifacts(root)).length, 0, 'Corrupted payloads can be removed without decoding them');
  const image = await createImageArtifact(root, { title: 'Fixture pixel', mimeType: 'image/png', data: png });
  assert.equal((await readArtifact(root, image.id)).data, png);
  await removeArtifact(root, image.id); await assert.rejects(readArtifact(root, image.id));
});

test('project imports preserve originals and reject private, escaped, symbolic and hard-linked files', async t => {
  const root = await workspace(t), image = Buffer.from(png, 'base64');
  await writeFile(path.join(root, 'pixel.png'), image);
  const saved = await importArtifact(root, 'pixel.png'); assert.equal(saved.kind, 'image'); assert.deepEqual(await readFile(path.join(root, 'pixel.png')), image);
  await writeFile(path.join(root, 'chart.json'), JSON.stringify(chart())); assert.equal((await importArtifact(root, 'chart.json')).kind, 'bar');
  await mkdir(path.join(root, '.env-folder')); await writeFile(path.join(root, '.env-folder', 'pixel.png'), image);
  await symlink(path.join(root, 'pixel.png'), path.join(root, 'linked.png'));
  await writeFile(path.join(root, 'hard-original.png'), image); await link(path.join(root, 'hard-original.png'), path.join(root, 'hard-copy.png'));
  for (const file of ['../outside.png', '/etc/passwd', '.env-folder/pixel.png', 'linked.png', 'hard-copy.png']) await assert.rejects(importArtifact(root, file));
  await assert.rejects(createVisualArtifact(root, { ...chart(), sources: [{ label: 'Private', path: '.ENV-folder/pixel.png' }] }), /Protected/);
});

test('MCP image extraction preserves errors and text, caps retention, and removes inline payloads', async t => {
  const root = await workspace(t);
  const raw = { isError: true, content: [{ type: 'text', text: 'Tool returned partial results.' }, ...Array.from({ length: 5 }, () => ({ type: 'image', mimeType: 'image/png', data: png }))] };
  const result = await extractMcpArtifacts(root, raw, { source: 'fixture/capture', runId: 'fixture-run' });
  assert.equal(result.isError, true); assert.equal(result.content[0].text, raw.content[0].text); assert.equal((await listArtifacts(root)).length, 4);
  assert.equal(JSON.stringify(result).includes(png), false); assert.ok(result.content.some(item => /At most four/.test(item.text)));
  const invalid = await extractMcpArtifacts(root, { isError: false, content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'not-an-image' }] });
  assert.equal(invalid.isError, false); assert.match(invalid.content[0].text, /Image unavailable/);
});

test('MCP binary resources and duplicate image metadata do not leak pixels into model text', async t => {
  const root = await workspace(t);
  const raw = { isError: true, content: [{ type: 'image', mimeType: 'image/png', data: png }, { type: 'resource', resource: { uri: 'file:///fixture.png', mimeType: 'image/png', blob: png } }], structuredContent: { screenshot: png }, _meta: { screenshot: png } };
  const result = await extractMcpArtifacts(root, raw, { source: 'fixture/capture' });
  assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes(png), false);
});

test('artifact API requires authentication and valid origin for import, read and deletion', async t => {
  const root = await workspace(t); await writeFile(path.join(root, 'pixel.png'), Buffer.from(png, 'base64'));
  await symlink(path.join(root, 'pixel.png'), path.join(root, 'linked.png'));
  const app = await startServer({ root, port: 0 }); t.after(() => app.close());
  const base = new URL(app.url).origin, headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(base + '/api/artifacts')).status, 401);
  assert.equal((await fetch(base + '/api/artifacts', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/api/artifacts', { method: 'POST', headers: { ...headers, origin: 'https://example.invalid' }, body: '{}' })).status, 403);
  const created = await fetch(base + '/api/artifacts', { method: 'POST', headers, body: JSON.stringify({ path: 'pixel.png' }) }); assert.equal(created.status, 201);
  const saved = await created.json(); assert.equal((await fetch(base + '/api/artifacts/' + saved.id)).status, 401);
  const fetched = await fetch(base + '/api/artifacts/' + saved.id, { headers }); assert.equal(fetched.status, 200); assert.equal((await fetched.json()).data, png);
  for (const relative of ['../outside.png', 'linked.png', '.nexus/config.json']) assert.equal((await fetch(base + '/api/artifacts', { method: 'POST', headers, body: JSON.stringify({ path: relative }) })).status, 400);
  assert.equal((await fetch(base + '/api/artifacts/' + saved.id, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(base + '/api/artifacts/' + saved.id, { method: 'DELETE', headers })).status, 200);
  assert.deepEqual(await readFile(path.join(root, 'pixel.png')), Buffer.from(png, 'base64'));
});
