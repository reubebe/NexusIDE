import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir, symlink, link, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { motionInput, renderAnimation, exportComparison, readMotionMedia } from '../src/motion.js';
import { runProcess } from '../src/process.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-motion-')); t.after(() => rm(root, { recursive:true, force:true })); return root; }
async function renderer(root, body) { const executable=path.join(root,'fake-manimgl');await writeFile(executable,`#!${process.execPath}\n${body}\n`,{mode:0o700});return executable; }
async function receipt(root) { const base=path.join(root,'nexus-visual-output'), dirs=await readdir(base);assert.equal(dirs.length,1);return JSON.parse(await readFile(path.join(base,dirs[0],'receipt.json'),'utf8')); }
async function mediaAvailable(t) {for(const command of ['ffmpeg','ffprobe']){const result=await runProcess(command,['-version']).catch(()=>null);if(result?.code!==0){t.skip(`${command} unavailable; real media validation not run`);return false;}}return true;}
async function colorClip(root,name,color,duration=1) {const result=await runProcess('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i',`color=c=${color}:s=160x120:r=24:d=${duration}`,'-c:v','libx264','-pix_fmt','yuv420p',path.join(root,name)]);assert.equal(result.code,0,result.output);}

test('motion inputs reject protected paths, links, remote paths and oversized media',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'clip.mp4'),'fixture');
 await symlink(path.join(root,'clip.mp4'),path.join(root,'alias.mp4'));
 for(const file of ['../outside.mp4','.env.mp4','.nexus/clip.mp4','/absolute.mp4','https://example.com/clip.mp4','alias.mp4','clip.m3u8'])await assert.rejects(motionInput(root,file));
 await link(path.join(root,'clip.mp4'),path.join(root,'hard.mp4'));await assert.rejects(motionInput(root,'hard.mp4'),/singly linked/);
 const handle=await open(path.join(root,'large.mp4'),'wx');await handle.truncate(500000001);await handle.close();await assert.rejects(motionInput(root,'large.mp4'),/size limit/);
 await writeFile(path.join(root,'large.py'),'#'.repeat(100001));await assert.rejects(motionInput(root,'large.py',{script:true,maxBytes:100000}),/size limit/);
});

test('animation refusal and changed approval inputs prevent renderer execution and output creation',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'scene.py'),'# original scene');
 const executable=await renderer(root,"throw new Error('must not execute');"),input={script:'scene.py',scene:'Example',executable};
 await assert.rejects(renderAnimation(root,input,{approve:async request=>{assert.equal(request.hostCode,true);assert.equal(request.sha256,digest(Buffer.from('# original scene')));return false;}}),/declined/);
 await assert.rejects(renderAnimation(root,input,{approve:async()=>{await writeFile(path.join(root,'scene.py'),'# changed');return true;}}),/changed after approval/);
 assert.ok(!(await readdir(root)).includes('nexus-visual-output'));
 for(const change of [{scene:'Example;touch bad'},{scene:'--help'},{executable:'manimgl'},{extraArgs:['--open']}])await assert.rejects(renderAnimation(root,{...input,...change}));
});

test('animation renderer gets bounded fixed arguments and valid output while originals remain intact',async t=>{
 if(!await mediaAvailable(t))return;const root=await fixture(t);await colorClip(root,'fixture.mp4','red');
 const source='# synthetic renderer fixture; not executed Python\n';await writeFile(path.join(root,'scene.py'),source);
 const executable=await renderer(root,`const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);fs.writeFileSync(path.join(process.cwd(),'argv.json'),JSON.stringify(args));fs.copyFileSync(${JSON.stringify(path.join(root,'fixture.mp4'))},path.join(process.cwd(),'render.mp4'));`);
 const result=await renderAnimation(root,{script:'scene.py',scene:'Example',executable},{approve:async()=>true});
 assert.equal(result.status,'rendered');assert.equal(await readFile(path.join(root,'scene.py'),'utf8'),source);
 const output=path.join(root,result.output),args=JSON.parse(await readFile(path.join(path.dirname(output),'argv.json'),'utf8'));
 assert.equal(args[1],'Example');assert.ok(args.includes('--write_file'));assert.ok(args.includes('--low_quality'));assert.equal(args[args.indexOf('--fps')+1],'24');assert.equal(args[args.indexOf('--video_dir')+1],await realpath(path.dirname(output)));assert.equal(args[args.indexOf('--file_name')+1],'render');assert.ok(!args.includes('--open'));
 assert.equal((await receipt(root)).status,'rendered');const served=await readMotionMedia(root,result.output);assert.equal(served.type,'video/mp4');assert.deepEqual(served.bytes,await readFile(output));
});

test('failed and cancelled animation renders retain failure receipts',async t=>{
 for(const mode of ['failed','cancelled']){
  const root=await fixture(t);await writeFile(path.join(root,'scene.py'),'# synthetic scene');const executable=await renderer(root,mode==='failed'?'process.exit(7);':'setInterval(()=>{},10000);');
  const controller=new AbortController(),timer=mode==='cancelled'?setTimeout(()=>controller.abort(),200):null;
  try {await assert.rejects(renderAnimation(root,{script:'scene.py',scene:'Example',executable},{approve:async()=>true,signal:controller.signal}),/Render/);}finally{if(timer)clearTimeout(timer);}
  const saved=await receipt(root);assert.equal(saved.status,'failed');assert.equal(saved.commands[0].code,mode==='failed'?7:null);assert.equal(saved.commands[0].stopped,mode==='failed'?null:'cancelled');
 }
});

test('comparison refusal and edited source cannot start a renderer',async t=>{
 const root=await fixture(t);for(const name of ['source.mp4','draft.mp4'])await writeFile(path.join(root,name),'synthetic');const input={source:'source.mp4',draft:'draft.mp4',seconds:1};
 await assert.rejects(exportComparison(root,input),/declined/);
 await assert.rejects(exportComparison(root,input,{approve:async()=>{await writeFile(path.join(root,'draft.mp4'),'changed');return true;}}),/changed after approval/);
 assert.ok(!(await readdir(root)).includes('nexus-visual-output'));
 for(const seconds of [0,-1,121,Infinity,NaN,'1'])await assert.rejects(exportComparison(root,{...input,seconds}),/duration/);
});

test('real side-by-side export preserves both sources and produces a bounded 1280x360 video',async t=>{
 if(!await mediaAvailable(t))return;const root=await fixture(t);await colorClip(root,'source.mp4','red',1);await colorClip(root,'draft.mp4','blue',1);
 const hashes=await Promise.all(['source.mp4','draft.mp4'].map(async file=>digest(await readFile(path.join(root,file)))));
 const result=await exportComparison(root,{source:'source.mp4',draft:'draft.mp4',seconds:0.5},{approve:async request=>{assert.equal(request.preservesOriginals,true);assert.equal(request.audio,'source only');assert.equal(request.sources.length,2);return true;}});
 assert.equal(result.status,'rendered');assert.deepEqual(await Promise.all(['source.mp4','draft.mp4'].map(async file=>digest(await readFile(path.join(root,file))))),hashes);
 const probe=await runProcess('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path.join(root,result.output)]);assert.equal(probe.code,0,probe.output);const meta=JSON.parse(probe.stdout),video=meta.streams.find(s=>s.codec_type==='video');assert.equal(video.width,1280);assert.equal(video.height,360);assert.ok(Math.abs(Number(meta.format.duration)-0.5)<0.1);assert.equal((await receipt(root)).status,'rendered');
});

test('a successful renderer exit with non-video output is retained as failure',async t=>{
 if(!await mediaAvailable(t))return;const root=await fixture(t);await writeFile(path.join(root,'scene.py'),'# synthetic scene');
 const executable=await renderer(root,"require('node:fs').writeFileSync('render.mp4','not a movie');");
 await assert.rejects(renderAnimation(root,{script:'scene.py',scene:'Example',executable},{approve:async()=>true}));
 assert.equal((await receipt(root)).status,'failed');
});
