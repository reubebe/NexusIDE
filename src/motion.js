import { open, mkdir, mkdtemp, writeFile, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveProjectPath } from './file-policy.js';
import { boundedRead } from './bounded-read.js';
import { runProcess } from './process.js';
const formats = {'.mp4':'mov','.mov':'mov','.m4v':'mov','.webm':'matroska','.mkv':'matroska'};
export async function motionInput(root, relative, { script = false, maxBytes = 500000000 } = {}) {
 const file = await resolveProjectPath(root, relative), ext = path.extname(file).toLowerCase();
 if (script ? ext !== '.py' : !formats[ext]) throw new Error(script ? 'Choose a Python scene file.' : 'Choose local MP4, MOV, M4V, WebM or MKV media.');
 const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('Expected a singly linked regular file within the size limit.');
  const hash = createHash('sha256'); for await (const chunk of handle.createReadStream({autoClose:false})) hash.update(chunk);
  return {file, path:relative, sha256:hash.digest('hex'), bytes:stat.size, format:formats[ext]};
 } finally { await handle.close(); }
}
async function directory(root) { const base=await resolveProjectPath(root,'nexus-visual-output');await mkdir(base,{recursive:true,mode:0o700});return mkdtemp(path.join(base,'motion-')); }
async function unchanged(root, input, script = false) { if ((await motionInput(root,input.path,{script,maxBytes:script?100000:500000000})).sha256 !== input.sha256) throw new Error('Source changed after approval. Review again.'); }
async function run(command,args,cwd,signal,receipt) {
 const result=await runProcess(command,args,{cwd,signal,timeoutMs:120000,maxBytes:100000});
 receipt.commands.push({command,args,code:result.code,stopped:result.stopped});
 if (result.code!==0 || result.stopped) throw new Error(`Render ${result.stopped || 'failed'}. Check the installed renderer and source. No automatic retry.`);
 return result.stdout;
}
async function validateOutput(root, relative, cwd, signal, receipt) {
 const output = await motionInput(root, relative);
 const raw = await run('ffprobe', ['-v','error','-protocol_whitelist','file','-f',output.format,'-i',output.file,'-show_entries','stream=codec_type,width,height:format=duration','-of','json'], cwd, signal, receipt);
 let metadata;
 try { metadata = JSON.parse(raw); } catch { throw new Error('Renderer output metadata is not valid JSON.'); }
 const video = metadata?.streams?.find(stream => stream.codec_type === 'video');
 const duration = Number(metadata?.format?.duration);
 if (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width < 1 || video.height < 1 || video.width > 16384 || video.height > 16384 || !Number.isFinite(duration) || duration <= 0) throw new Error('Renderer did not produce a valid bounded video with positive duration.');
 return { width: video.width, height: video.height, durationSeconds: duration, sha256: output.sha256, bytes: output.bytes };
}
export async function renderAnimation(root,input,{approve=async()=>false,signal}={}) {
 root=await realpath(root);
 if (!input || Object.keys(input).some(k=>!['script','scene','executable'].includes(k)) || !/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(input.scene||'') || !path.isAbsolute(input.executable||'')) throw new Error('Provide a scene class and absolute path of installed manimgl.');
 const source=await motionInput(root,input.script,{script:true,maxBytes:100000}), command=await realpath(input.executable);await access(command,constants.X_OK);
 if ((await approve({type:'animation',script:source.path,sha256:source.sha256,scene:input.scene,executable:command,hostCode:true,note:'Python scene code executes with your account permissions. Review its code and imports before approval.'})) !== true) throw new Error('Animation render declined.');
 signal?.throwIfAborted();await unchanged(root,source,true);
 const dir=await directory(root), receipt={kind:'manimgl',source:{path:source.path,sha256:source.sha256},scene:input.scene,status:'running',commands:[]};
 try {
  await writeFile(path.join(dir,'render-config.yml'),'directories:\n  mirror_module_path: false\n',{flag:'wx',mode:0o600});
  await run(command,[source.file,input.scene,'--write_file','--low_quality','--fps','24','--video_dir',dir,'--file_name','render','--config_file',path.join(dir,'render-config.yml')],dir,signal,receipt);
  const output=path.relative(root,path.join(dir,'render.mp4'));receipt.media=await validateOutput(root,output,dir,signal,receipt);await unchanged(root,source,true);receipt.status='rendered';receipt.output=output;return receipt;
 } catch(error) {receipt.status='failed';receipt.error=error.message;throw error;}
 finally {await writeFile(path.join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});}
}
export async function exportComparison(root,input,{approve=async()=>false,signal,ffmpeg='ffmpeg'}={}) {
 root=await realpath(root);
 if (!input || Object.keys(input).some(k=>!['source','draft','seconds'].includes(k)) || !Number.isFinite(input.seconds) || input.seconds<=0 || input.seconds>120) throw new Error('Comparison duration must be greater than zero and at most 120 seconds.');
 const sources=await Promise.all([input.source,input.draft].map(p=>motionInput(root,p)));
 if ((await approve({type:'video-comparison',sources:sources.map(({file,format,...s})=>s),seconds:input.seconds,preservesOriginals:true,audio:'source only'})) !== true) throw new Error('Comparison export declined.');
 signal?.throwIfAborted();for (const s of sources) await unchanged(root,s);
 const dir=await directory(root), receipt={kind:'comparison',sources:sources.map(({file,format,...s})=>s),seconds:input.seconds,status:'running',commands:[]};
 try {
  const args=['-hide_banner','-loglevel','error','-nostdin','-n'];
  for (const s of sources) args.push('-protocol_whitelist','file','-f',s.format,'-i',s.file);
  args.push('-filter_complex','[0:v]setpts=PTS-STARTPTS,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[a];[1:v]setpts=PTS-STARTPTS,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[b];[a][b]hstack=inputs=2:shortest=1[v]','-map','[v]','-map','0:a:0?','-t',String(input.seconds),'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-shortest','-movflags','+faststart','comparison.mp4');
  await run(ffmpeg,args,dir,signal,receipt);for(const s of sources) await unchanged(root,s);
  receipt.output=path.relative(root,path.join(dir,'comparison.mp4'));receipt.media=await validateOutput(root,receipt.output,dir,signal,receipt);if(receipt.media.width!==1280||receipt.media.height!==360||receipt.media.durationSeconds>input.seconds+0.15)throw new Error('Comparison output does not match the requested dimensions or duration.');receipt.status='rendered';return receipt;
 } catch(error) {receipt.status='failed';receipt.error=error.message;throw error;}
 finally {await writeFile(path.join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});}
}
export async function readMotionMedia(root,relative) {
 const input=await motionInput(root,relative,{maxBytes:50000000});
 const handle=await open(input.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1)throw new Error('Unsafe media file.');const bytes=await boundedRead(handle,50000000);if(createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw new Error('Media changed while reading.');return {bytes,type:({'.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska'})[path.extname(input.file).toLowerCase()]};}
 finally{await handle.close();}
}
