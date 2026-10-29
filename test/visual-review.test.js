import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProvider } from '../src/providers.js';
import { saveConfig } from '../src/config.js';
import { createImageArtifact } from '../src/artifacts.js';
import { reviewVisualArtifact, visualReviewProfiles } from '../src/visual-review.js';
import { projectFiles, projectPins } from '../src/project-files.js';
import { listState, readState } from '../src/state.js';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const message = {role:'user',content:'Inspect this synthetic pixel.',images:[{mimeType:'image/png',data:png}]};
for (const kind of ['compatible','anthropic']) test(`${kind} vision uses explicit capability and the documented image shape`, async t => {
  let calls = 0;
  t.mock.method(globalThis,'fetch',async (_url, options) => {
    calls++; const body = JSON.parse(options.body), content = body.messages[0].content;
    assert.equal(content[1].text, message.content);
    if (kind === 'compatible') assert.deepEqual(content[0],{type:'image_url',image_url:{url:'data:image/png;base64,'+png}});
    else assert.deepEqual(content[0],{type:'image',source:{type:'base64',media_type:'image/png',data:png}});
    return Response.json(kind === 'compatible' ? {choices:[{finish_reason:'stop',message:{content:'One red pixel.'}}]} : {content:[{type:'text',text:'One red pixel.'}],stop_reason:'end_turn'});
  });
  const env = {NEXUS_PROVIDER:kind,NEXUS_MODEL:'synthetic',NEXUS_BASE_URL:'http://127.0.0.1:1234/v1'};
  await assert.rejects(createProvider(env).complete([message]), /not enabled vision/); assert.equal(calls,0);
  assert.equal((await createProvider(env,{vision:true}).complete([message])).text,'One red pixel.'); assert.equal(calls,1);
  await assert.rejects(createProvider(env,{vision:true}).complete([{...message,role:'tool'}]),/user message/);
});
test('visual reviews require selected vision profile and consent, retain evidence without pixels',async t=>{
  const root = await mkdtemp(path.join(os.tmpdir(),'nexus-vision-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await saveConfig(root,{version:1,providers:{vision:{kind:'compatible',model:'fixture',baseUrl:'http://127.0.0.1:1234/v1',vision:true},text:{kind:'compatible',model:'fixture',baseUrl:'http://127.0.0.1:1234/v1'}},routes:{},mcp:{}});
  const artifact=await createImageArtifact(root,{title:'Fixture',mimeType:'image/png',data:png});
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:'Visible red; no functional tests performed.'}}],usage:{prompt_tokens:2,completion_tokens:3}});});
  assert.equal((await visualReviewProfiles(root)).length,1);
  await assert.rejects(reviewVisualArtifact(root,artifact.id,{provider:'vision',question:'Color?'}),/Approve/);
  await assert.rejects(reviewVisualArtifact(root,artifact.id,{provider:'text',question:'Color?',approved:true}),/vision/);assert.equal(calls,0);
  const result=await reviewVisualArtifact(root,artifact.id,{provider:'vision',question:'Color?',approved:true});
  const saved=await readState(root,'visual-reviews',(await listState(root,'visual-reviews'))[0]);
  assert.equal(saved.artifactDigest,artifact.sha256);assert.equal(saved.id,result.id);assert.equal(JSON.stringify(saved).includes(png),false);assert.equal(calls,1);
});
test('project file metadata and folder pins omit protected paths and unsafe links',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nexus-files-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'reports'));await writeFile(path.join(root,'data.txt'),'abcd');await writeFile(path.join(root,'.env'),'secret');await symlink('/tmp',path.join(root,'outside'));
  const list=await projectFiles(root);assert.deepEqual(list.entries,['reports/','data.txt']);assert.equal(list.metadata[1].size,4);
  assert.deepEqual(await projectPins(root,['reports','reports']),['reports']);await assert.rejects(projectPins(root,['outside']),/links/);await assert.rejects(projectPins(root,['../']),/leaves/);await assert.rejects(projectPins(root,['data.txt']),/folders/);
  await rm(path.join(root,'reports'),{recursive:true});assert.deepEqual(await projectPins(root),[]);
});
