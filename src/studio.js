import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { constants } from 'node:fs';
import { open, mkdir, mkdtemp, writeFile, realpath, unlink, readdir, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolveProjectPath } from './file-policy.js';
import { boundedRead } from './bounded-read.js';
import { validateImage } from './artifacts.js';
import { readState, writeState, listState, safeName, deleteState } from './state.js';
import { runProcess } from './process.js';
import { runMediaProcess } from './media-process.js';
import { hostname } from 'node:os';
import { previewMediaEdit, validateEditDecisionList } from './media-workflow.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const types = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.mp4':'video/mp4', '.mov':'video/quicktime', '.webm':'video/webm', '.pdf':'application/pdf', '.svg':'image/svg+xml' };
const object = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).every(k => keys.includes(k));
export async function bytesAt(root, relative, limit = 50_000_000) {
  const file = await resolveProjectPath(root, relative);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Choose a singly linked project file under 50 MB.'); return await boundedRead(handle, limit); }
  finally { await handle.close(); }
}
async function outputDirectory(root) {
  root = await realpath(root); const base = await resolveProjectPath(root, 'nexus-studio-output');
  await mkdir(base, { recursive: true, mode: 0o700 }); return { root, dir: await mkdtemp(path.join(base, 'edit-')) };
}
export async function studioCapabilities() {
  const engines = await Promise.all(['ffmpeg', 'ffprobe', ...(process.platform==='darwin'?['/usr/bin/swift']:[])].map(async command => {
    try { const result = await runProcess(command, [command.endsWith('swift')?'--version':'-version'], { timeoutMs: 5000, maxBytes: 20000 }); return { id: command, state: result.code === 0 && !result.stopped ? 'launchable' : 'unavailable', version: result.stdout.split('\n')[0].slice(0,200), observedAt: new Date().toISOString() }; }
    catch { return { id: command, state: 'unavailable' }; }
  }));
  return { engines, operations: ['image.adjust', 'video.edit', 'design.layout', 'motion.animate', ...(process.platform === 'darwin' ? ['pdf.organize'] : [])], limitations: ['Raster adjustments use an 8-bit PNG output; no RAW, layers or color-profile fidelity guarantee.', 'External parsers run on the host after approval.'] };
}
export async function importStudioAsset(root, input) {
  if (!object(input, ['path','title','rights']) || typeof input.path !== 'string' || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || typeof input.rights !== 'string' || input.rights.length > 1000) throw new Error('Provide a project path, title and source rights note (unknown is permitted).');
  const mimeType = types[path.extname(input.path).toLowerCase()];
  if (!mimeType || mimeType === 'image/svg+xml') throw new Error('Import PNG, JPEG, WebP, MP4, MOV, WebM or PDF. External SVG is not imported.');
  if((await listState(root,'studio-assets')).length>=500)throw new Error('Studio asset limit reached. Remove unused library records first.');
  const bytes = await bytesAt(root,input.path); let metadata = {};
  if (mimeType.startsWith('image/')) { const {width,height} = validateImage(mimeType,bytes.toString('base64')); metadata={width,height}; }
  if (mimeType === 'application/pdf' && bytes.subarray(0,5).toString() !== '%PDF-') throw new Error('Invalid PDF signature.');
  const record = { version:1,id:randomUUID(),created:new Date().toISOString(),kind:mimeType.split('/')[0],path:input.path,title:input.title.trim(),rights:input.rights || 'unknown',mimeType,bytes:bytes.length,sha256:hash(bytes),...metadata };
  await writeState(root,'studio-assets',record.id+'.json',record,{exclusive:true}); return record;
}
export async function listStudioAssets(root) {
  const names = await listState(root,'studio-assets');
  const assets = await Promise.all(names.slice(-500).map(name=>readState(root,'studio-assets',name)));
  return assets.sort((a,b)=>b.created.localeCompare(a.created));
}
export async function readStudioAsset(root,id) {
  safeName(id); const asset = await readState(root,'studio-assets',id+'.json');
  const bytes = await bytesAt(root,asset.path);
  if(hash(bytes)!==asset.sha256) throw new Error('Asset has moved or changed. Import the current file as a new source.');
  return {asset,bytes};
}
export function validateStudioRecipe(value) {
  if(!value || typeof value !== 'object' || Array.isArray(value))throw new Error('Provide an edit recipe.');
  if(value.operation==='image.adjust') {
    if(!object(value,['operation','assetId','crop','rotate','brightness','contrast','saturation']))throw new Error('Unsupported image adjustment.');
    safeName(value.assetId);
    const recipe={operation:value.operation,assetId:value.assetId,rotate:value.rotate??0,brightness:value.brightness??0,contrast:value.contrast??1,saturation:value.saturation??1};
    if(![0,90,180,270].includes(recipe.rotate)||!Number.isFinite(recipe.brightness)||Math.abs(recipe.brightness)>1||!Number.isFinite(recipe.contrast)||recipe.contrast<0||recipe.contrast>2||!Number.isFinite(recipe.saturation)||recipe.saturation<0||recipe.saturation>3)throw new Error('Adjustment is out of range.');
    if(value.crop!==undefined){if(!object(value.crop,['x','y','width','height'])||!['x','y','width','height'].every(k=>Number.isSafeInteger(value.crop[k]))||value.crop.x<0||value.crop.y<0||value.crop.width<1||value.crop.height<1)throw new Error('Invalid crop rectangle.');recipe.crop=value.crop;}
    return recipe;
  }
  if(value.operation==='pdf.organize') {
    if(process.platform!=='darwin')throw new Error('PDF organization currently requires macOS PDFKit and Swift.');
    if(!object(value,['operation','assetId','pages','rotation','note'])||!Array.isArray(value.pages)||!value.pages.length||value.pages.length>300||!value.pages.every(n=>Number.isInteger(n)&&n>0&&n<=300)||![0,90,180,270].includes(value.rotation)||typeof value.note!=='string'||value.note.length>2000)throw new Error('Choose 1–300 page numbers, a rotation and an optional bounded comment.');
    safeName(value.assetId);return structuredClone(value);
  }
  if(value.operation==='motion.animate') {
    if(!object(value,['operation','assetId','seconds','startX','startY','endX','endY','background'])||!Number.isFinite(value.seconds)||value.seconds<.1||value.seconds>30||![value.startX,value.startY,value.endX,value.endY].every(n=>Number.isFinite(n)&&n>=0&&n<=1000)||!/^#[\da-f]{6}$/i.test(value.background))throw new Error('Choose a 0.1–30 second motion and bounded keyframe coordinates.');
    safeName(value.assetId);return structuredClone(value);
  }
  if(value.operation==='video.edit') {if(!object(value,['operation','plan']))throw new Error('Unsupported video option.');return {operation:value.operation,plan:validateEditDecisionList(value.plan)};}
  if(value.operation==='design.layout') {
    if(!object(value,['operation','title','width','height','background','items'])||typeof value.title!=='string'||value.title.length>200||![value.width,value.height].every(n=>Number.isInteger(n)&&n>=100&&n<=4000)||!/^#[\da-f]{6}$/i.test(value.background)||!Array.isArray(value.items)||value.items.length>100)throw new Error('Invalid page layout.');
    for(const item of value.items){if(!object(item,['kind','x','y','width','height','color','text','size'])||!['rect','text'].includes(item.kind)||![item.x,item.y].every(n=>Number.isFinite(n)&&n>=0&&n<=4000)||!/^#[\da-f]{6}$/i.test(item.color))throw new Error('Invalid page element.');if(item.kind==='rect'&&![item.width,item.height].every(n=>Number.isFinite(n)&&n>0&&n<=4000))throw new Error('Invalid shape size.');if(item.kind==='text'&&(typeof item.text!=='string'||item.text.length>2000||!Number.isInteger(item.size)||item.size<6||item.size>200))throw new Error('Invalid text element.');}
    return structuredClone(value);
  }
  throw new Error('Unsupported Studio operation.');
}
export async function planStudioEdit(root,input) {
  const recipe=validateStudioRecipe(input),sources=[];
  if(recipe.assetId){const {asset}=await readStudioAsset(root,recipe.assetId);if(recipe.operation==='pdf.organize'?asset.mimeType!=='application/pdf':!['image/png','image/jpeg','image/webp'].includes(asset.mimeType))throw new Error('Choose a compatible source asset.'); if(recipe.crop&&(recipe.crop.x+recipe.crop.width>asset.width||recipe.crop.y+recipe.crop.height>asset.height))throw new Error('Crop is outside image bounds.');sources.push({id:asset.id,path:asset.path,sha256:asset.sha256});}
  if(recipe.plan)for(const clip of recipe.plan.clips){const bytes=await bytesAt(root,clip.path);sources.push({path:clip.path,sha256:hash(bytes)});}
  const plan={version:1,id:randomUUID(),created:new Date().toISOString(),recipe,sources,outputArea:recipe.operation==='video.edit'?'nexus-visual-output':'nexus-studio-output',limits:{inputBytes:50000000,outputBytes:50000000,timeoutMs:recipe.operation==='video.edit'?300000:60000},losses:recipe.operation==='image.adjust'?'8-bit raster PNG; layers and color-profile fidelity not preserved':recipe.operation==='pdf.organize'?'Page copies and annotations; signatures may become invalid':recipe.operation==='video.edit'?'Video and audio are re-encoded; metadata tracks are not preserved':'Review rendered typography, color and timing before sharing'};
  plan.digest=hash(JSON.stringify(plan)); await writeState(root,'studio-plans',plan.id+'.json',plan,{exclusive:true});return plan;
}
export async function executeStudioPlan(root,{id,digest},{approve=async()=>false,signal}={}) {
  safeName(id);const plan=await readState(root,'studio-plans',id+'.json');
  const {digest:stored,...payload}=plan;
  if(digest!==stored||hash(JSON.stringify(payload))!==stored)throw new Error('Edit plan changed. Review it again.');
  if((await approve({type:'studio-edit',...plan,hostExecution:plan.recipe.operation!=='design.layout'})) !== true)throw new Error('Studio edit declined.');
  signal?.throwIfAborted();
  for(const s of plan.sources)if(hash(await bytesAt(root,s.path))!==s.sha256)throw new Error('Source changed after approval.');
  if((await listState(root,'studio-assets')).length>=500)throw new Error('Studio asset limit reached. Remove unused library records first.');
  await writeState(root,'studio-claims',id+'.json',{created:new Date().toISOString()},{exclusive:true});
  const {root:canonical,dir}=await outputDirectory(root),job={version:1,id,planId:id,status:'running',started:new Date().toISOString(),pid:process.pid,host:hostname(),directory:path.relative(canonical,dir),operation:plan.recipe.operation,commands:[],sources:plan.sources};
  await writeState(root,'studio-jobs',id+'.json',job);
  let output;
  try {
    const r=validateStudioRecipe(plan.recipe);let mimeType,width,height;job.limits={...plan.limits,cpuSecondsPerProcess:60,fileSizeUpperBoundBytes:50000000};job.losses=plan.losses;
    if(['image.adjust','video.edit','motion.animate'].includes(r.operation)){const version=await runProcess('ffmpeg',['-version'],{signal,timeoutMs:5000,maxBytes:20000});if(version.code!==0||version.stopped)throw new Error('FFmpeg version check failed.');job.engineVersion=version.stdout.split('\n')[0];}else if(r.operation==='design.layout')job.engineVersion='Nexus SVG layout writer v1';
    if(r.operation==='image.adjust') {
      const {asset,bytes}=await readStudioAsset(root,r.assetId);const source=path.join(dir,'input'+path.extname(asset.path).toLowerCase());await writeFile(source,bytes,{flag:'wx',mode:0o600});
      const filters=[];if(r.crop)filters.push(`crop=${r.crop.width}:${r.crop.height}:${r.crop.x}:${r.crop.y}`);
      if(r.rotate===90)filters.push('transpose=1');if(r.rotate===180)filters.push('hflip','vflip');if(r.rotate===270)filters.push('transpose=2');
      filters.push(`eq=brightness=${r.brightness}:contrast=${r.contrast}:saturation=${r.saturation}`);
      const args=['-hide_banner','-loglevel','error','-nostdin','-n','-protocol_whitelist','file','-i',source,'-vf',filters.join(','),'-frames:v','1','-update','1','output.png'];
      const result=await runMediaProcess('ffmpeg',args,{cwd:dir,signal,timeoutMs:60000,maxBytes:100000});job.commands.push({command:'ffmpeg',args,code:result.code,stopped:result.stopped});if(result.code!==0||result.stopped)throw new Error('Image render failed or cancelled.');
      output=path.relative(canonical,path.join(dir,'output.png'));mimeType='image/png';const checked=validateImage(mimeType,(await bytesAt(root,output)).toString('base64'));width=checked.width;height=checked.height;
    } else if(r.operation==='pdf.organize') {
      const {bytes}=await readStudioAsset(root,r.assetId);const source=path.join(dir,'source.pdf');await writeFile(source,bytes,{flag:'wx',mode:0o600});
      const request={input:source,output:path.join(dir,'organized.pdf'),preview:path.join(dir,'preview.png'),pages:r.pages,rotation:r.rotation,note:r.note};
      const result=await runMediaProcess('/usr/bin/swift',[fileURLToPath(new URL('../scripts/studio-pdf.swift',import.meta.url))],{cwd:dir,input:JSON.stringify(request),signal,timeoutMs:60000,maxBytes:50000});
      job.commands.push({command:'Apple PDFKit via Swift',code:result.code,stopped:result.stopped});if(result.code!==0||result.stopped)throw new Error('PDF export failed. Check page selection and the installed macOS Swift tools.');job.pdf=JSON.parse(result.stdout);output=path.relative(canonical,request.output);mimeType='application/pdf';job.preview=path.relative(canonical,request.preview);
    } else if(r.operation==='motion.animate') {
      const {asset,bytes}=await readStudioAsset(root,r.assetId);const source=path.join(dir,'input'+path.extname(asset.path));await writeFile(source,bytes,{flag:'wx',mode:0o600});
      const x=`${r.startX}+(${r.endX-r.startX})*t/${r.seconds}`,y=`${r.startY}+(${r.endY-r.startY})*t/${r.seconds}`;
      const args=['-v','error','-nostdin','-n','-loop','1','-i',source,'-f','lavfi','-i',`color=c=0x${r.background.slice(1)}:s=1280x720:r=24:d=${r.seconds}`,'-filter_complex',`[0:v]scale=240:240:force_original_aspect_ratio=decrease[image];[1:v][image]overlay=x='${x}':y='${y}':shortest=1[v]`,'-map','[v]','-t',String(r.seconds),'-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','animation.mp4'];
      const result=await runMediaProcess('ffmpeg',args,{cwd:dir,signal,timeoutMs:60000,maxBytes:50000});job.commands.push({command:'ffmpeg',args,code:result.code,stopped:result.stopped});if(result.code!==0||result.stopped)throw new Error('Motion export failed or cancelled.');output=path.relative(canonical,path.join(dir,'animation.mp4'));mimeType='video/mp4';width=1280;height=720;
      const probe=await runProcess('ffprobe',['-v','error','-show_entries','format=duration','-of','json',path.join(dir,'animation.mp4')],{signal,timeoutMs:10000,maxBytes:10000});if(probe.code!==0||probe.stopped)throw new Error('Motion output validation failed.');job.durationSeconds=Number(JSON.parse(probe.stdout).format?.duration);if(!Number.isFinite(job.durationSeconds)||Math.abs(job.durationSeconds-r.seconds)>.15)throw new Error('Motion duration mismatch.');
    } else if(r.operation==='video.edit') {
      const result=await previewMediaEdit(root,r.plan,{approve:async()=>true,signal});output=result.preview;mimeType='video/mp4';job.mediaReceipt=result;
      const probe=await runProcess('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',await resolveProjectPath(root,output)],{signal,timeoutMs:10000,maxBytes:30000});if(probe.code||probe.stopped)throw new Error('Export could not be inspected.');const info=JSON.parse(probe.stdout),video=info.streams.find(s=>s.codec_type==='video');if(!video||!Number.isFinite(Number(info.format.duration))||Math.abs(Number(info.format.duration)-r.plan.clips.reduce((n,c)=>n+c.end-c.start,0))>0.25)throw new Error('Export timing does not match the edit.');width=video.width;height=video.height;job.durationSeconds=Number(info.format.duration);
    } else {
      const escape=s=>s.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}" viewBox="0 0 ${r.width} ${r.height}"><title>${escape(r.title)}</title><rect width="100%" height="100%" fill="${r.background}"/>${r.items.map(i=>i.kind==='rect'?`<rect x="${i.x}" y="${i.y}" width="${i.width}" height="${i.height}" fill="${i.color}"/>`:`<text x="${i.x}" y="${i.y}" font-family="sans-serif" font-size="${i.size}" fill="${i.color}">${escape(i.text)}</text>`).join('')}</svg>`;
      await writeFile(path.join(dir,'layout.svg'),svg,{flag:'wx',mode:0o600});output=path.relative(canonical,path.join(dir,'layout.svg'));mimeType='image/svg+xml';width=r.width;height=r.height;
    }
    signal?.throwIfAborted();for(const s of plan.sources)if(hash(await bytesAt(root,s.path))!==s.sha256)throw new Error('Source changed during render.');
    const bytes=await bytesAt(root,output),asset={version:1,id:randomUUID(),created:new Date().toISOString(),title:r.plan?.title||r.title||({ 'image.adjust':'Adjusted image', 'pdf.organize':'Organized PDF', 'motion.animate':'Keyframe animation' }[r.operation]),kind:mimeType.split('/')[0],mimeType,path:output,sha256:hash(bytes),bytes:bytes.length,width,height,...(job.preview?{preview:job.preview,previewSha256:hash(await bytesAt(root,job.preview))}:{}),parents:plan.sources.map(s=>s.id).filter(Boolean),recipe:r,planId:id,rights:'inherits source rights; review before sharing'};
    await writeState(root,'studio-assets',asset.id+'.json',asset,{exclusive:true});job.status='completed';job.output=output;job.assetId=asset.id;job.outputSha256=asset.sha256;return job;
  }catch(error){job.status=signal?.aborted?'cancelled':'failed';job.error=error.message;
    // Only fixed, newly-created output names are removed. Inputs and receipts
    // remain available for diagnosis, and no failed file is registered as an asset.
    for(const name of ['output.png','organized.pdf','preview.png','animation.mp4','layout.svg'])await unlink(path.join(dir,name)).catch(e=>{if(e.code!=='ENOENT')job.cleanupError='Some incomplete files could not be removed.';});
    if(output&&job.mediaReceipt)await unlink(await resolveProjectPath(root,output)).catch(()=>{job.cleanupError='Incomplete media export requires cleanup.';});
    throw error;}
  finally{job.finished=new Date().toISOString();await writeState(root,'studio-jobs',id+'.json',job);await writeFile(path.join(dir,'receipt.json'),JSON.stringify(job,null,2),{flag:'wx',mode:0o600});}
}
export async function studioHistory(root) {
  return Promise.all((await listState(root,'studio-jobs')).slice(-100).map(async name=>{const j=await readState(root,'studio-jobs',name);if(j.status==='running'&&j.host===hostname()&&Number.isSafeInteger(j.pid)&&j.pid>0){try{process.kill(j.pid,0);}catch(e){if(e.code==='ESRCH'){j.status='interrupted';j.recoveryAvailable=true;j.error='Owning process is absent; no operation was replayed.';}}}return j;}));
}

export async function readStudioPreview(root,id){const {asset}=await readStudioAsset(root,id);if(!asset.preview||!asset.previewSha256)throw new Error('No preview recorded for this asset.');const bytes=await bytesAt(root,asset.preview,5000000);if(hash(bytes)!==asset.previewSha256)throw new Error('Preview changed. Export a new revision.');validateImage('image/png',bytes.toString('base64'));return bytes;}

export async function removeStudioAsset(root, { id, approved }) {
  safeName(id);if(approved!==true)throw new Error('Approve removing this library record. Files will be retained.');
  await deleteState(root,'studio-assets',id+'.json');return {removed:true,filesRetained:true};
}

export async function cleanupStudioScratch(root,{id,approved}) {
  safeName(id);if(approved!==true)throw new Error('Approve cleanup of generated scratch copies.');
  const job=await readState(root,'studio-jobs',id+'.json');
  if(job.status==='running')throw new Error('Finish or recover this job before cleanup.');
  const assets=await Promise.all((await listState(root,'studio-assets')).map(name=>readState(root,'studio-assets',name)));
  const protectedPaths=new Set(assets.flatMap(a=>[a.path,a.preview]).filter(Boolean));
  const removed=[];let bytesRemoved=0;
  for(const directory of [job.directory,job.mediaReceipt?.directory].filter(Boolean)){
    if(!['nexus-studio-output','nexus-visual-output'].includes(path.dirname(directory))||!/^edit-[a-zA-Z0-9_-]+$/.test(path.basename(directory)))throw new Error('Invalid generated scratch directory.');
    const absolute=await resolveProjectPath(root,directory);
    for(const name of await readdir(absolute)){
      if(!/^(?:input\.(?:png|jpe?g|webp)|source\.pdf|clip-\d+\.mp4|concat\.txt)$/.test(name))continue;
      const relative=path.join(directory,name);if(protectedPaths.has(relative))continue;
      const target=await resolveProjectPath(root,relative),stat=await lstat(target);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('Scratch cleanup refuses links and non-regular files.');
      await unlink(target);removed.push(relative);bytesRemoved+=stat.size;
    }
  }
  job.cleanup={at:new Date().toISOString(),removed,bytesRemoved};
  await writeState(root,'studio-jobs',id+'.json',job);return job.cleanup;
}

export async function recoverStudioJob(root,{id,approved}) {
  safeName(id);if(approved!==true)throw new Error('Approve marking the abandoned job interrupted.');
  const job=await readState(root,'studio-jobs',id+'.json');
  if(job.status!=='running'||job.host!==hostname()||!Number.isSafeInteger(job.pid)||job.pid<1)throw new Error('Only a locally owned running job can be recovered.');
  try{process.kill(job.pid,0);throw new Error('Owning process is still active.');}catch(error){if(error.code!=='ESRCH')throw error;}
  job.status='interrupted';job.finished=new Date().toISOString();job.error='Owning process absent. No operation replayed; review a new plan to try again.';
  await writeState(root,'studio-jobs',id+'.json',job);return job;
}
