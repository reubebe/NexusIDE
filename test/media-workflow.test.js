import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from '../src/process.js';
import { validateEditDecisionList, previewMediaEdit, recordMediaReview } from '../src/media-workflow.js';

const plan = { version: 1, title: 'Synthetic boundary review', width: 160, height: 120, fps: 10, clips: [{ path: 'red.mp4', start: 0, end: 0.3 }, { path: 'blue.mp4', start: 0, end: 0.3 }] };
async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-media-edit-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('edit plans reject invalid spans, excessive rendering and unsafe types', () => {
  assert.equal(validateEditDecisionList(plan).clips.length, 2);
  for (const change of [{ width: 99999 }, { fps: 0 }, { clips: [{ path: 'x.mp4', start: 4, end: 3 }] }, { clips: [{ path: 'https://example.com/x.mp4', start: 0, end: 2000 }] }, { clips: [{ path: 'x.m3u8', start: 0, end: 2 }] }, { arbitraryFilter: 'movie=/private' }]) assert.throws(() => validateEditDecisionList({ ...plan, ...change }));
});

test('declined rendering creates no outputs and failure produces a retained receipt', async t => {
  const root = await fixture(t); await writeFile(path.join(root, 'red.mp4'), 'synthetic invalid media');
  const one = { ...plan, clips: [plan.clips[0]] };
  await assert.rejects(previewMediaEdit(root, one), /declined/);
  assert.deepEqual(await readdir(root), ['red.mp4']);
  let error;
  try { await previewMediaEdit(root, one, { approve: async () => true, ffprobe: '/missing/ffprobe' }); } catch (e) { error = e; }
  assert.match(error.message, /ENOENT/);
  const receipt = JSON.parse(await readFile(path.join(root, error.outputDirectory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.review.status, 'pending');
});

test('real ffmpeg preview preserves source bytes and generates reviewable boundaries', { timeout: 60000 }, async t => {
  const check = await runProcess('ffmpeg', ['-version']).catch(() => null);
  if (check?.code !== 0) return t.skip('ffmpeg is not installed; real media validation unavailable');
  const probe = await runProcess('ffprobe', ['-version']).catch(() => null);
  if (probe?.code !== 0) return t.skip('ffprobe is not installed');
  const root = await fixture(t);
  for (const color of ['red', 'blue']) {
    const made = await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', `color=c=${color}:s=160x120:r=10:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, color + '.mp4')]);
    assert.equal(made.code, 0, made.output);
  }
  const before = await readFile(path.join(root, 'red.mp4'));
  const result = await previewMediaEdit(root, plan, { approve: async request => { assert.equal(request.network, false); assert.equal(request.sources.length, 2); return true; } });
  assert.deepEqual(await readFile(path.join(root, 'red.mp4')), before);
  assert.equal(result.receipt.status, 'preview-ready'); assert.equal(result.receipt.review.status, 'pending');
  assert.equal(result.reviewFrames.length, 2); assert.equal(result.timeline.data[1].start, 0.3);
  const frames = await Promise.all(result.reviewFrames.map(frame => readFile(path.join(root, frame.path))));
  assert.notEqual(createHash('sha256').update(frames[0]).digest('hex'), createHash('sha256').update(frames[1]).digest('hex'));
  const output = JSON.parse((await runProcess('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(root, result.preview)])).output);
  assert.ok(output.streams.some(s => s.codec_type === 'audio')); assert.ok(Math.abs(Number(output.format.duration) - 0.6) < 0.2);
  const review = await recordMediaReview(root, result.directory, { decision: 'accepted', notes: 'Synthetic source colors and silent audio checked.' });
  assert.equal(review.decision, 'accepted'); assert.ok(await readFile(path.join(root, review.path)));
});

test('preview timeout terminates subprocess and retains a failed receipt', async t => {
  const root = await fixture(t), executable = path.join(root, 'slow-probe');
  await writeFile(path.join(root, 'red.mp4'), 'fixture');
  await writeFile(executable, `#!${process.execPath}\nsetInterval(()=>{},10000);\n`, { mode: 0o700 });
  const start = performance.now(); let error;
  try { await previewMediaEdit(root, { ...plan, clips: [plan.clips[0]] }, { ffprobe: executable, timeoutMs: 1000, approve: async () => true }); } catch (e) { error = e; }
  assert.ok(error); assert.ok(performance.now() - start < 5000);
  const receipt = JSON.parse(await readFile(path.join(root, error.outputDirectory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.commands[0].stopped, 'cancelled');
});
