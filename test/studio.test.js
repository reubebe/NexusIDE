import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink,link} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {importStudioAsset,planStudioEdit,executeStudioPlan,readStudioAsset,listStudioAssets,studioHistory,validateStudioRecipe} from '../src/studio.js';
import {runProcess} from '../src/process.js';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'nexus-studio-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('real image edit preserves source, validates crop, saves derivative and rejects duplicate execution',async t=>{
 const root=await fixture(t);const r=await runProcess('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=160x120','-frames:v','1','-update','1',path.join(root,'source.png')]);assert.equal(r.code,0,r.output);
 const original=await readFile(path.join(root,'source.png'));const asset=await importStudioAsset(root,{path:'source.png',title:'Synthetic red',rights:'generated fixture'});
 const plan=await planStudioEdit(root,{operation:'image.adjust',assetId:asset.id,crop:{x:0,y:0,width:80,height:60},rotate:90,brightness:.2});
 await assert.rejects(executeStudioPlan(root,plan),/declined/);
 const result=await executeStudioPlan(root,plan,{approve:async()=>true});const saved=await readStudioAsset(root,result.assetId);
 assert.equal(saved.asset.width,60);assert.equal(saved.asset.height,80);assert.notEqual(saved.asset.sha256,asset.sha256);assert.deepEqual(await readFile(path.join(root,'source.png')),original);assert.equal(saved.asset.parents[0],asset.id);
 await assert.rejects(executeStudioPlan(root,plan,{approve:async()=>true}),{code:'EEXIST'});assert.equal((await studioHistory(root))[0].status,'completed');
 await assert.rejects(planStudioEdit(root,{operation:'image.adjust',assetId:asset.id,crop:{x:150,y:0,width:80,height:60}}),/bounds/);
});
test('layout output is real escaped SVG and source/digest changes cannot reuse approval',async t=>{
 const root=await fixture(t);const plan=await planStudioEdit(root,{operation:'design.layout',title:'Fixture',width:800,height:600,background:'#ffffff',items:[{kind:'text',x:20,y:50,color:'#112233',size:20,text:'<script> & text'}]});
 await assert.rejects(executeStudioPlan(root,{...plan,digest:'bad'},{approve:async()=>true}),/changed/);
 const result=await executeStudioPlan(root,plan,{approve:async()=>true});const {bytes}=await readStudioAsset(root,result.assetId);assert.match(bytes.toString(),/&lt;script&gt; &amp; text/);assert.doesNotMatch(bytes.toString(),/<script>/);assert.equal((await listStudioAssets(root)).length,1);
 assert.throws(()=>validateStudioRecipe({...plan.recipe,items:[{kind:'text',x:0,y:0,color:'url(http://bad)',size:20,text:'unsafe'}]}));
 await writeFile(path.join(root,result.output),'changed');await assert.rejects(readStudioAsset(root,result.assetId),/changed/);
});
test('real video edit exports requested duration through the shared media engine',async t=>{
 const root=await fixture(t);const r=await runProcess('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:s=160x120:r=24:d=1','-c:v','libx264','-pix_fmt','yuv420p',path.join(root,'source.mp4')]);assert.equal(r.code,0,r.output);
 const plan=await planStudioEdit(root,{operation:'video.edit',plan:{version:1,title:'Trim',width:160,height:120,fps:24,clips:[{path:'source.mp4',start:0,end:.5}]}});
 const result=await executeStudioPlan(root,plan,{approve:async()=>true});assert.ok(Math.abs(result.durationSeconds-.5)<.25);assert.equal(result.status,'completed');assert.equal((await readStudioAsset(root,result.assetId)).asset.kind,'video');
});
test('actual keyframe animation produces bounded MP4 while retaining the input',async t=>{const root=await fixture(t);const r=await runProcess('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=80x60','-frames:v','1','-update','1',path.join(root,'source.png')]);assert.equal(r.code,0,r.output);const asset=await importStudioAsset(root,{path:'source.png',title:'Motion source',rights:'synthetic'});const plan=await planStudioEdit(root,{operation:'motion.animate',assetId:asset.id,seconds:.5,startX:0,startY:0,endX:500,endY:200,background:'#ffffff'});const result=await executeStudioPlan(root,plan,{approve:async()=>true});assert.equal(result.status,'completed');assert.ok(Math.abs(result.durationSeconds-.5)<.15);await readStudioAsset(root,asset.id);});
test('cancelled render preserves input, records cancellation and publishes no derivative',async t=>{
 const root=await fixture(t);await runProcess('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=80x60','-frames:v','1','-update','1',path.join(root,'source.png')]);
 const asset=await importStudioAsset(root,{path:'source.png',title:'Cancel fixture',rights:'synthetic'});
 const plan=await planStudioEdit(root,{operation:'motion.animate',assetId:asset.id,seconds:30,startX:0,startY:0,endX:500,endY:200,background:'#ffffff'});
 const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),100);
 try{await assert.rejects(executeStudioPlan(root,plan,{approve:async()=>true,signal:controller.signal}));}finally{clearTimeout(timer);}
 assert.equal((await listStudioAssets(root)).length,1);await readStudioAsset(root,asset.id);
 assert.equal((await studioHistory(root))[0].status,'cancelled');
 assert.throws(()=>validateStudioRecipe({operation:'image.adjust',assetId:asset.id,crop:{}}),/crop/);
});
test('real JPEG/WebP and MOV/WebM inputs export through the claimed native paths',async t=>{
 const root=await fixture(t);
 for(const extension of ['jpg','webp']){
  const filename='source.'+extension;if(extension==='webp')await writeFile(path.join(root,filename),Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64'));else {const generated=await runProcess('ffmpeg',['-v','error','-f','lavfi','-i','color=green:s=160x120','-frames:v','1',path.join(root,filename)]);assert.equal(generated.code,0,generated.output);}
  const asset=await importStudioAsset(root,{path:filename,title:extension,rights:'synthetic'});
  const plan=await planStudioEdit(root,{operation:'image.adjust',assetId:asset.id,rotate:90});
  const output=await executeStudioPlan(root,plan,{approve:async()=>true});const checked=await readStudioAsset(root,output.assetId);assert.equal(checked.asset.width,extension==='webp'?1:120);assert.equal(checked.asset.height,extension==='webp'?1:160);await readStudioAsset(root,asset.id);
 }
 for(const extension of ['mov','webm']){
  const filename='source.'+extension,generated=await runProcess('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:s=160x120:r=24:d=0.5','-c:v',extension==='webm'?'libvpx':'libx264',path.join(root,filename)]);assert.equal(generated.code,0,generated.output);
  const plan=await planStudioEdit(root,{operation:'video.edit',plan:{version:1,title:extension,width:160,height:120,fps:24,clips:[{path:filename,start:0,end:.5}]}});
  const result=await executeStudioPlan(root,plan,{approve:async()=>true});assert.ok(Math.abs(result.durationSeconds-.5)<.25);
 }
});
test('Studio rejects protected paths, links, malformed inputs and changed approved sources',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'bad.png'),'not an image');await writeFile(path.join(root,'.env'),'private');
 await symlink('bad.png',path.join(root,'linked.png'));await link(path.join(root,'bad.png'),path.join(root,'hard.png'));
 for(const file of ['../outside.png','.env','linked.png','hard.png','bad.png'])await assert.rejects(importStudioAsset(root,{path:file,title:'blocked',rights:'fixture'}));
 await assert.rejects(importStudioAsset(root,{path:'bad.png',title:'blocked',rights:'fixture'}));
 const generated=await runProcess('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=80x60','-frames:v','1','-update','1',path.join(root,'source.png')]);assert.equal(generated.code,0,generated.output);
 const asset=await importStudioAsset(root,{path:'source.png',title:'Source',rights:'synthetic'}),plan=await planStudioEdit(root,{operation:'image.adjust',assetId:asset.id});await writeFile(path.join(root,'source.png'),'changed');
 await assert.rejects(executeStudioPlan(root,plan,{approve:async()=>true}),/Source changed/);assert.equal((await studioHistory(root)).length,0);
});
test('actual PDFKit page rotation and annotation preserve the original PDF',async t=>{if(process.platform!=='darwin'){t.skip('PDFKit requires macOS');return;}const root=await fixture(t);const helper=path.join(root,'fixture.swift');await writeFile(helper,'import Foundation\nimport AppKit\nimport PDFKit\nlet document=PDFDocument()\nlet image=NSImage(size:NSSize(width:200,height:120))\nimage.lockFocus();NSColor.red.setFill();NSRect(x:0,y:0,width:200,height:120).fill();image.unlockFocus()\ndocument.insert(PDFPage(image:image)!,at:0)\ndocument.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))\n');const generated=await runProcess('/usr/bin/swift',[helper,path.join(root,'source.pdf')],{timeoutMs:60000});assert.equal(generated.code,0,generated.output);const original=await readFile(path.join(root,'source.pdf'));const asset=await importStudioAsset(root,{path:'source.pdf',title:'PDF fixture',rights:'synthetic'});const plan=await planStudioEdit(root,{operation:'pdf.organize',assetId:asset.id,pages:[1],rotation:90,note:'Fixture annotation'});const result=await executeStudioPlan(root,plan,{approve:async()=>true});assert.equal(result.pdf.pages,1);assert.equal(result.pdf.rotation,90);assert.equal(result.status,'completed');assert.deepEqual(await readFile(path.join(root,'source.pdf')),original);assert.notDeepEqual((await readStudioAsset(root,result.assetId)).bytes,original);});
