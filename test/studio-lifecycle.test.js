import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runMediaProcess } from '../src/media-process.js';
import { cleanupStudioScratch, removeStudioAsset, recoverStudioJob } from '../src/studio.js';
import { writeState, readState } from '../src/state.js';

async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'nexus-studio-life-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('media process enforces a kernel file-size bound without interpreting filenames',async t=>{
 const root=await fixture(t),file=path.join(root,'output;literal.bin');
 const result=await runMediaProcess(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],Buffer.alloc(1000000))",file],{maxFileBytes:4096,cpuSeconds:5,timeoutMs:5000});
 assert.notEqual(result.code,0);assert.ok((await stat(file)).size<=4096);
 assert.throws(()=>runMediaProcess('test',[],{cpuSeconds:Infinity}),/limits/);
});
test('scratch cleanup preserves exports, receipts and registered input assets',async t=>{
 const root=await fixture(t),directory='nexus-studio-output/edit-fixture';await mkdir(path.join(root,directory),{recursive:true});
 for(const name of ['input.png','source.pdf','output.png','receipt.json'])await writeFile(path.join(root,directory,name),'fixture');
 await writeState(root,'studio-jobs','fixture.json',{id:'fixture',status:'completed',directory});
 await writeState(root,'studio-assets','source.json',{id:'source',path:directory+'/source.pdf'});
 await assert.rejects(cleanupStudioScratch(root,{id:'fixture',approved:false}),/Approve/);
 const result=await cleanupStudioScratch(root,{id:'fixture',approved:true});assert.deepEqual(result.removed,[directory+'/input.png']);
 for(const name of ['source.pdf','output.png','receipt.json'])assert.equal(await readFile(path.join(root,directory,name),'utf8'),'fixture');
 await removeStudioAsset(root,{id:'source',approved:true});assert.equal(await readFile(path.join(root,directory,'source.pdf'),'utf8'),'fixture');
 assert.equal((await cleanupStudioScratch(root,{id:'fixture',approved:true})).removed.length,1);
});
test('recovery requires a confirmed absent local owner and never replays tools',async t=>{
 const root=await fixture(t);await writeState(root,'studio-jobs','fixture.json',{id:'fixture',status:'running',host:os.hostname(),pid:process.pid});
 await assert.rejects(recoverStudioJob(root,{id:'fixture',approved:true}),/still active/);
 await writeState(root,'studio-jobs','fixture.json',{id:'fixture',status:'running',host:os.hostname(),pid:2147483647});
 await assert.rejects(recoverStudioJob(root,{id:'fixture',approved:false}),/Approve/);
 assert.equal((await recoverStudioJob(root,{id:'fixture',approved:true})).status,'interrupted');
 assert.equal((await readState(root,'studio-jobs','fixture.json')).status,'interrupted');
});
