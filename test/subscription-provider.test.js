import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { saveCliAccount } from '../src/cli-accounts.js';
import {inspectSubscriptionAccount,subscriptionProvider} from '../src/subscription-provider.js';
import { startServer } from '../src/server.js';
import { installAgent, defaults } from '../src/agents.js';
import {validateConfig,defaultConfig} from '../src/config.js';
import {runProcess} from '../src/process.js';
import {createRunBudget} from '../src/run-budget.js';
async function fixture(t) {
 const home=await mkdtemp(path.join(os.tmpdir(),'nexus-sub-test-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const command=path.join(home,'claude');
 await writeFile(command,`#!${process.execPath}\nimport('node:fs').then(fs=>{const args=process.argv.slice(2); if(args.includes('--help')) return console.log('--safe-mode --tools --strict-mcp-config --json-schema --setting-sources --no-session-persistence'); if(args[0]==='auth') return console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:fs.existsSync('${home}/changed')?'other@example.test':'fixture@example.test',apiProvider:'firstParty'})); let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.writeFileSync('${home}/request.json',JSON.stringify({args,prompt:JSON.parse(s),apiKey:process.env.ANTHROPIC_API_KEY||null,cwd:process.cwd()}));console.log(JSON.stringify(fs.existsSync('${home}/response.json')?JSON.parse(fs.readFileSync('${home}/response.json')):{type:'result',subtype:'success',structured_output:{text:'Synthetic answer',calls:[]},usage:{input_tokens:2,output_tokens:3}}));});});`,{mode:0o700});
 const p=await saveCliAccount({provider:'claude',mode:'subscription',label:'Synthetic',command},{home});
 const {accountBinding}=await inspectSubscriptionAccount(p.id,{home});
 return {home,p,provider:subscriptionProvider({accountId:p.id,accountBinding,model:'sonnet'},{home})};
}
test('subscription isolates inference, disables native tools, and validates account on every request',async t=>{
 const {home,provider}=await fixture(t);
 const response=await provider.complete([{role:'user',content:'test'}],[]);
 assert.equal(response.text,'Synthetic answer');assert.deepEqual(response.usage,{input:2,output:3});
 const request=JSON.parse(await readFile(path.join(home,'request.json')));
 assert.equal(request.args[request.args.indexOf('--tools')+1],'');assert.ok(request.args.includes('--safe-mode'));assert.equal(request.apiKey,null);assert.notEqual(request.cwd,home);
 await writeFile(path.join(home,'changed'),'yes');await assert.rejects(provider.complete([],[]),/identity changed/);
});
test('subscription refuses unauthorized calls and malformed response rather than executing anything',async t=>{
 const {home,provider}=await fixture(t);
 for(const result of [{text:'',calls:[{name:'run_command',arguments:'{}'}]},{text:'',calls:[{name:'read_file',arguments:'[]'}]},null]) {
  await writeFile(path.join(home,'response.json'),JSON.stringify({type:'result',subtype:'success',structured_output:result,usage:{input_tokens:1,output_tokens:1}}));
  await assert.rejects(provider.complete([],[{name:'read_file'}]));
 }
});
test('subscription profile schema cannot contain API credentials',()=>{
 assert.throws(()=>validateConfig({...structuredClone(defaultConfig),providers:{sub:{kind:'claude-subscription',model:'sonnet',accountId:'a'.repeat(36),accountBinding:'a'.repeat(64),keyEnv:'ANTHROPIC_API_KEY'}}}),/subscription/);
});
test('process stdin remains private and cancellation kills a blocked child',async()=>{
 const controller=new AbortController();setTimeout(()=>controller.abort(),50);
 const result=await runProcess(process.execPath,['-e',"process.stdin.resume();setInterval(()=>{},1000)"],{input:'private fixture',signal:controller.signal});
 assert.equal(result.stopped,'cancelled');assert.equal(result.output,'');
});
test('shared request and token budgets stop before additional work; unknown usage fails closed',()=>{
 const budget=createRunBudget({maxRequests:2,maxTokens:10});budget.reserve();budget.record({input:2,output:2},true);budget.reserve();assert.throws(()=>budget.reserve(),/request budget/);
 budget.record({input:4,output:3},true);assert.throws(()=>budget.check(),/Token budget/);
 const unknown=createRunBudget({maxTokens:10});unknown.reserve();unknown.record(null,false);assert.throws(()=>unknown.reserve(),/unknown/);
});
test('subscription endpoint preserves independent routes and rejects pinned API agents', async t => {
 const {home,p}=await fixture(t);
 await installAgent(home, defaults[1]);
 await installAgent(home, {...defaults[0], name:'pinned', provider:'api-profile'});
 const app=await startServer({root:home,accountHome:home,port:0});t.after(()=>app.close());
 const api=(name,data)=>fetch(new URL(app.url).origin+'/api/'+name,{method:data?'POST':'GET',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
 const connect=(route,model)=>api('subscription-route',{accountId:p.id,model,route,approved:true});
 assert.equal((await connect('default','sonnet')).status,200);
 const original=await (await api('config')).json();
 assert.equal((await connect('coder','opus')).status,200);
 let config=await (await api('config')).json();
 assert.equal(config.routes.default,original.routes.default);assert.equal(config.providers[config.routes.default].model,'sonnet');assert.equal(config.providers[config.routes.coder].model,'opus');
 assert.equal((await connect('pinned','sonnet')).status,400);
 await writeFile(path.join(home,'changed'),'yes');assert.equal((await connect('coder','opus')).status,200);
 const rebound=await (await api('config')).json();assert.notEqual(rebound.routes.coder,config.routes.coder);assert.equal(rebound.routes.default,original.routes.default);
});
