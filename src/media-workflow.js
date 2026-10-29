import path from 'node:path';
import { lstat, mkdir, mkdtemp, open, writeFile, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveProjectPath } from './file-policy.js';
import { runProcess } from './process.js';
import { validateVisualSpec } from './visual-spec.js';

const formats = { '.mp4': 'mov', '.mov': 'mov', '.m4v': 'mov', '.webm': 'matroska', '.mkv': 'matroska' };
const strictObject = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k));

export function validateEditDecisionList(value) {
  if (!strictObject(value, ['version', 'title', 'clips', 'width', 'height', 'fps']) || value.version !== 1 || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200 || !Array.isArray(value.clips) || !value.clips.length || value.clips.length > 24) throw new Error('Use a version 1 edit plan with a title and 1–24 clips.');
  const width = value.width ?? 1280, height = value.height ?? 720, fps = value.fps ?? 30;
  if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n % 2 === 0) || width > 1920 || height > 1080 || !Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error('Choose even dimensions up to 1920×1080 and 1–60 fps.');
  let duration = 0;
  const clips = value.clips.map(clip => {
    if (!strictObject(clip, ['path', 'start', 'end']) || typeof clip.path !== 'string' || !clip.path || clip.path.length > 1000 || /[\0\r\n]/.test(clip.path) || path.isAbsolute(clip.path) || !Object.hasOwn(formats, path.extname(clip.path).toLowerCase()) || !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start || clip.end > 86400) throw new Error('Each clip needs a relative MP4/MOV/WebM/MKV path and increasing start/end seconds.');
    duration += clip.end - clip.start;
    return { path: clip.path, start: clip.start, end: clip.end };
  });
  if (duration > 600) throw new Error('Preview duration is limited to 10 minutes.');
  return { version: 1, title: value.title.trim(), width, height, fps, clips };
}

async function sourceIdentity(root, relative) {
  const file = await resolveProjectPath(root, relative), handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 500_000_000) throw new Error('Input must be a regular file without hard links, at most 500 MB.');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return { path: relative, absolute: file, bytes: stat.size, sha256: hash.digest('hex'), dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } finally { await handle.close(); }
}

export async function previewMediaEdit(root, input, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', signal, approve = async () => false, timeoutMs = 300000 } = {}) {
  root = await realpath(root);
  const plan = validateEditDecisionList(input);
  for (const command of [ffmpeg, ffprobe]) if (typeof command !== 'string' || !command || /[\0\r\n]/.test(command)) throw new Error('Invalid media executable.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error('Preview timeout must be 1 second to 15 minutes.');
  const sources = await Promise.all([...new Set(plan.clips.map(c => c.path))].map(file => sourceIdentity(root, file)));
  if (!await approve({ type: 'media-preview', plan, sources: sources.map(({ absolute, dev, ino, mtimeMs, ...source }) => source), durationSeconds: plan.clips.reduce((n, c) => n + c.end - c.start, 0), preservesOriginals: true, network: false, executables: { ffmpeg, ffprobe } })) throw new Error('Media preview declined.');
  const timeout = AbortSignal.timeout(timeoutMs), cancelled = signal ? AbortSignal.any([signal, timeout]) : timeout;
  cancelled.throwIfAborted();
  const base = await resolveProjectPath(root, 'nexus-visual-output');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(base, 'edit-'));
  const receipt = { version: 1, created: new Date().toISOString(), status: 'rendering', title: plan.title, plan, sources: sources.map(({ absolute, dev, ino, mtimeMs, ...source }) => source), review: { status: 'pending', note: 'Inspect preview playback, sound, subtitles if present, and each boundary frame. Preview generation is not editorial approval.' }, commands: [] };
  const run = async (command, args) => {
    cancelled.throwIfAborted();
    const result = await runProcess(command, args, { cwd: directory, signal: cancelled, timeoutMs: Math.min(timeoutMs, 120000), maxBytes: 500000 });
    receipt.commands.push({ executable: command, args, code: result.code, stopped: result.stopped });
    if (result.code !== 0 || result.stopped) throw new Error(`Media command ${result.stopped || `exited ${result.code}`}: ${result.output.slice(-1500)}`);
    return result.output;
  };
  try {
    const metadata = new Map();
    for (const source of sources) {
      const now = await lstat(source.absolute);
      if (now.isSymbolicLink() || now.dev !== source.dev || now.ino !== source.ino || now.size !== source.bytes || now.mtimeMs !== source.mtimeMs) throw new Error('Source changed after approval; review the plan again.');
      const result = JSON.parse(await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-f', formats[path.extname(source.path).toLowerCase()], '-show_format', '-show_streams', '-of', 'json', source.absolute]));
      const duration = Number(result.format?.duration);
      if (!Number.isFinite(duration) || !result.streams?.some(stream => stream.codec_type === 'video')) throw new Error('Input needs a video stream and a finite duration.');
      metadata.set(source.path, { source, duration, audio: result.streams.some(stream => stream.codec_type === 'audio') });
    }
    let elapsed = 0;
    const timeline = { version: 1, kind: 'timeline', title: plan.title, description: 'Edit-decision preview. Time is measured on the output; source in/out points are in the data labels.', xLabel: 'Output time', xUnit: 's', sources: sources.map(s => ({ label: s.path.slice(0, 500), path: s.path })), data: [] };
    for (let i = 0; i < plan.clips.length; i++) {
      const clip = plan.clips[i], info = metadata.get(clip.path), duration = clip.end - clip.start;
      if (clip.end > info.duration + 0.05) throw new Error(`Clip ends beyond source duration: ${clip.path}`);
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file', '-f', formats[path.extname(clip.path).toLowerCase()], '-ss', String(clip.start), '-i', info.source.absolute];
      if (!info.audio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      args.push('-t', String(duration), '-map', '0:v:0', '-map', info.audio ? '0:a:0' : '1:a:0', '-vf', `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${plan.fps}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', `clip-${i}.mp4`);
      await run(ffmpeg, args);
      timeline.data.push({ label: `${clip.path} [${clip.start}–${clip.end}s]`.slice(0, 240), start: elapsed, end: elapsed + duration });
      elapsed += duration;
    }
    await writeFile(path.join(directory, 'concat.txt'), plan.clips.map((_, i) => `file 'clip-${i}.mp4'`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', '-movflags', '+faststart', 'preview.mp4']);
    const reviewFrames = [];
    for (let i = 1; i < timeline.data.length; i++) {
      for (const [side, offset] of [['before', -1 / plan.fps], ['after', 1 / plan.fps]]) {
        const filename = `boundary-${i}-${side}.png`, at = Math.max(0, Math.min(elapsed - 1 / plan.fps, timeline.data[i].start + offset));
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-ss', String(at), '-i', 'preview.mp4', '-frames:v', '1', '-update', '1', filename]);
        reviewFrames.push({ path: path.relative(root, path.join(directory, filename)), at, boundary: i, side });
      }
    }
    receipt.status = 'preview-ready'; receipt.durationSeconds = elapsed; receipt.reviewFrames = reviewFrames;
    validateVisualSpec(timeline);
    await writeFile(path.join(directory, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { directory: path.relative(root, directory), preview: path.relative(root, path.join(directory, 'preview.mp4')), reviewFrames, timeline, receipt };
  } catch (error) { receipt.status = 'failed'; receipt.error = error.message; throw Object.assign(error, { outputDirectory: path.relative(root, directory) }); }
  finally { await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
}

export async function recordMediaReview(root, directory, { decision, notes }) {
  root = await realpath(root);
  if (!['accepted', 'rejected'].includes(decision) || typeof notes !== 'string' || !notes.trim() || notes.length > 5000) throw new Error('Review needs an accepted/rejected decision and concise notes.');
  const target = await resolveProjectPath(root, directory);
  if (path.dirname(path.relative(root, target)) !== 'nexus-visual-output' || !path.basename(target).startsWith('edit-')) throw new Error('Choose a generated preview directory.');
  const file = await resolveProjectPath(root, path.join(directory, 'receipt.json'));
  const stat = await lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1000000) throw new Error('Invalid preview receipt.');
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  if (receipt.status !== 'preview-ready') throw new Error('Only completed previews can be reviewed.');
  const review = { version: 1, reviewed: new Date().toISOString(), decision, notes: notes.trim(), receiptSha256: createHash('sha256').update(await readFile(file)).digest('hex') };
  // Append a unique review record; original plans, footage and prior reviews are retained.
  const reviewDir = await mkdtemp(path.join(target, 'review-'));
  await writeFile(path.join(reviewDir, 'decision.json'), JSON.stringify(review, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...review, path: path.relative(root, path.join(reviewDir, 'decision.json')) };
}
