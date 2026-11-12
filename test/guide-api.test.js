import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

test('guide endpoints require authentication and preserve human approval gates', async t => {
 const root=await mkdtemp(path.join(os.tmpdir(),'nexus-guide-api-'));
 const server=await startServer({root,port:0,accountHome:root}),origin=new URL(server.url).origin;
 t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
 for(const route of ['studio','board','sessions','foundry','web-sources','accounts'])assert.equal((await fetch(origin+'/api/'+route)).status,401);
 const api=(route,data,method='POST')=>fetch(origin+'/api/'+route,{method,headers:{authorization:'Bearer '+server.token,'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
 assert.equal((await api('sessions',{path:'session.jsonl',title:'No consent',approved:false})).status,400);
 assert.equal((await api('foundry/generate',{source:'guide.md',provider:'demo',goal:'Generate',rights:'owned',approved:false})).status,400);
 assert.equal((await api('studio/execute',{id:'arbitrary',digest:'bad',approved:false})).status,400);
 const wrongOrigin=await fetch(origin+'/api/board',{headers:{authorization:'Bearer '+server.token,origin:'https://untrusted.invalid'}});assert.equal(wrongOrigin.status,403);
 const created=await api('board',{title:'Human card',description:'fixture',agentEligible:false});assert.equal(created.status,201);const card=await created.json();
 assert.equal((await api('board/'+card.id,{revision:1,comment:'Reviewed'},'PUT')).status,200);
 assert.equal((await api('board/'+card.id,{revision:1,status:'done'},'PUT')).status,400);
 await writeFile(path.join(root,'session.jsonl'),JSON.stringify({type:'user',message:{content:'Fixture context'}}));
 const imported=await api('sessions',{path:'session.jsonl',title:'Fixture',approved:true});assert.equal(imported.status,201);const session=await imported.json();
 const handoff=await (await api('sessions/handoff',{id:session.id,indices:[0],goal:'Review',approved:true})).json();assert.equal(handoff.requiresNewRun,true);
 const state=await (await api('state',null,'GET')).json();assert.equal(state.jobs.length,0);
 assert.equal((await api('sessions/'+session.id,null,'DELETE')).status,200);
});
