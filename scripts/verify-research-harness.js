// Explicit local-only compatibility check; never opens a real research project.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runProcess } from '../src/process.js';
import { saveConfig } from '../src/config.js';
import { connectMcp } from '../src/mcp.js';
import { writeState } from '../src/state.js';

const [python] = process.argv.slice(2);
if (!python || !path.isAbsolute(python)) throw new Error('Pass the absolute Python path for the updated Research Harness environment.');
const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-harness-compatibility-'));
const project = path.join(root, 'synthetic-paper');
const controller = new AbortController(), cancel = () => controller.abort();
process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
const receipt = { at: new Date().toISOString(), verified: false, realResearchProject: false, cloudCalls: false, checks: [] };
const bridge = fileURLToPath(new URL('../integrations/research-harness-reader.py', import.meta.url));
const bridgeHash = () => readFile(bridge).then(data => createHash('sha256').update(data).digest('hex'));
let connection;
const inspect = `import hashlib,json,sys,subprocess
from pathlib import Path
from contextlib import closing
import research_harness
from research_harness.store import Store
p=Path(research_harness.__file__).parent
source_hash=hashlib.sha256()
for f in sorted(p.rglob('*.py')):
 source_hash.update(str(f.relative_to(p)).encode()); source_hash.update(f.read_bytes())
with closing(Store(sys.argv[1])) as s:
 state_hash=hashlib.sha256('\\n'.join(s.db.iterdump()).encode()).hexdigest()
try:
 revision=subprocess.check_output(['git','-C',str(p),'rev-parse','HEAD'],text=True,stderr=subprocess.DEVNULL,timeout=5).strip()
except (OSError,subprocess.SubprocessError): revision=None
print(json.dumps({'version':research_harness.__version__,'revision':revision,'source':str(p),'sourceHash':source_hash.hexdigest(),'stateHash':state_hash}))`;
async function pythonRun(code, args = [project]) {
  const result = await runProcess(python, ['-c', code, ...args], { cwd: root, signal: controller.signal, timeoutMs: 30000 });
  assert.equal(result.code, 0, result.output);
  return result.output.trim();
}
try {
  const setup = `import json,sys
from pathlib import Path
from research_harness.store import Store
from research_harness.engine import Engine
from research_harness.models import ProjectPolicy,canonical,digest
from research_harness.memory import save_lesson
from research_harness.guidance_packs import save_pack,review_pack
from research_harness.workflow import Conductor
from research_harness.analysis import summarize_csv
from research_harness.studies import save_study,review_study,STUDY_FIELDS
from research_harness.prompt_registry import save_prompt
from research_harness.workbench.research import _answer,_worksheet
from research_harness.retrieval import search_sources
from types import SimpleNamespace
p=Path(sys.argv[1]); s=Store.create(p,ProjectPolicy('Nexus synthetic compatibility fixture')); e=Engine(s)
source=p/'source.txt'; source.write_text('An association was observed. Causation was not established.')
e.import_source(source,'S1',{'title':'Synthetic fixture','authors':['Fixture'],'year':'2026','kind':'user_document','access_scope':'full_text'})
e.add_passage('P1','S1','Causation was not established.')
save_pack(s,'Paired',{'title':'Paired measurements','applicability':'Repeated subjects','assumptions':'Same subject in both conditions.','contraindications':'Unpaired data.','procedure':'Compare within-subject differences.','passages':['P1']})
review_pack(s,'Paired',1,'fixture-operator','Synthetic review, not scientific validation')
save_lesson(s,'Lesson',{'text':'Keep subject identifiers.','role':'analyst','origin':'Synthetic review','references':{},'status':'approved','reviewer':'fixture-operator'},operator=True)
c=Conductor(s); c.create('W',{'question':'Synthetic measurements?','paper_type':'narrative_review'})
t=c.lease('W','methodologist','fixture')['task']
c.finish('W',t['id'],t['lease'],{'summary':'Fixture protocol','deliverable':{'protocol':'Preserve paired identifiers.'},'artifacts':{},'issues':[],'tokens_used':0,'model':'fixture','run_id':'fixture'})
out=s.get('workflow','W')['tasks'][0]['output']
data=p/'data.csv'; data.write_text('group,score\\nA,10\\nA,14\\nB,20\\nB,24\\n')
summarize_csv(s,data,'Run1','score','group','points','baseline',1)
hit=search_sources(s,'Causation',1,['S1'])['hits'][0]
service=SimpleNamespace(complete_json=lambda *a,**k:{'value':{'statements':[{'text':'Causation was not established.','citations':[{'evidence_id':hit['evidence_id'],'quote':'Causation was not established.'}]}]},'usage':{},'cost_usd':0})
answer=_answer(service,'fixture',s,{'question':'Causation','source_ids':['S1']})['answer']
citation=answer['statements'][0]['citations'][0]
worksheet=_worksheet(s,{'title':'Rival explanations','outcome':'Observed association','baseline':'No demonstrated causation','hypotheses':[{'explanation':'Confounding','disconfirming_test':'Measure the confounder'}],'citations':[citation]})['worksheet']
fields={f:{'status':'not_reported','value':None,'passages':[]} for f in STUDY_FIELDS}
fields['limitations']={'status':'reported','value':'Causation not established','passages':['P1']}
save_study(s,'Study1',{'source_id':'S1','study_family':'Fixture','fields':fields})
review_study(s,'Study1',1,'fixture-operator','Synthetic review only',operator=True)
save_prompt(s,'Prompt1',{'role':'critic','template':'Preserve uncertainty.','change_notes':'Fixture'})
with s.transaction():
 s.put('prompt_experiment','Experiment1',{'prompt_id':'Prompt1','prompt_version':1,'candidate_id':None,'status':'running','evaluation_scope':'Phrase checks, not scientific accuracy','results':[]})
print(json.dumps({'outputHash':digest(canonical(out).encode()),'citation':citation,'answer':answer['id'],'worksheet':worksheet['id']})); s.close()`;
  const fixture = JSON.parse(await pythonRun(setup));
  const before = JSON.parse(await pythonRun(inspect));
  receipt.harness = { version: before.version, revision: before.revision, source: before.source, sourceHash: before.sourceHash };
  receipt.adapter = { file: 'integrations/research-harness-reader.py', sha256: await bridgeHash() };
  const template = JSON.parse(await readFile(new URL('../integrations/research-harness.example.json', import.meta.url), 'utf8'));
  const context = template.mcp['research-harness-context'];
  context.command = python;
  context.args = [bridge, '--project', project];
  template.mcp.evidence = { command: python, args: ['-m', 'research_harness.mcp_server', '--project', project, '--role', 'writer'], tools: ['list_sources', 'read_source', 'search_sources', 'get_record'], envKeys: [] };
  await saveConfig(root, template);
  const granted = new Set(context.tools);
  connection = await connectMcp(root, { mcp: ['research-harness-context', 'evidence'] }, async request => {
    if (request.type === 'mcp-connect') return ['research-harness-context', 'evidence'].includes(request.name) && !request.envKeys.length;
    return request.type === 'mcp-call' && granted.has(request.tool);
  }, controller.signal);
  assert.equal(connection.tools.length, context.tools.length + 4, 'All and only granted tools must be discoverable.');
  async function call(name, args, server = 'research-harness-context', expectedError = false) {
    const tool = connection.tools.find(tool => tool.description.startsWith(`[${server}/${name}]`));
    assert.ok(tool, `Missing tool ${name}`);
    const response = JSON.parse(await connection.call(tool.name, args));
    assert.equal(Boolean(response.isError), expectedError, JSON.stringify(response));
    if (expectedError) return response;
    return response.structuredContent || JSON.parse(response.content.find(block => block.type === 'text').text);
  }
  await call('list_sources', {}, 'evidence'); receipt.checks.push('legacy-evidence-reader-transport');
  const artifactLoads = [];
  for (const [kind, id] of [['workbench_answer', fixture.answer], ['causal_worksheet', fixture.worksheet], ['prompt_experiment', 'Experiment1']]) {
    const listing = await call('list_workbench_artifacts', { kind, limit: 1 });
    assert.equal(listing.items.length, 1); assert.equal(listing.items[0].id, id); assert.equal(listing.items[0].stale, false);
    const load = listing.items[0].load; artifactLoads.push(load);
    const chunks = []; let offset = 0;
    do {
      const page = await call('read_workbench_artifact', { ...load, start: offset, length: 200 });
      assert.equal(page.content_hash, load.expected_content_hash); assert.ok(page.text.length <= 200);
      chunks.push(page.text); offset = page.next_start;
      assert.ok(chunks.length < 100, 'Artifact paging must make progress.');
    } while (offset !== null);
    const saved = JSON.parse(chunks.join(''));
    assert.equal(saved.record.id, id); assert.equal(saved.context.stale, false);
    if (kind === 'prompt_experiment') assert.equal(saved.record.status, 'running');
    await call('read_workbench_artifact', { ...load, expected_version: load.expected_version + 1 }, undefined, true);
    await call('read_workbench_artifact', { ...load, expected_content_hash: '0'.repeat(64) }, undefined, true);
  }
  await call('list_workbench_artifacts', { kind: 'secrets' }, undefined, true);
  receipt.checks.push('bounded-workbench-answer-worksheet-and-experiment-reads', 'version-and-context-hash-pinned-artifact-paging');
  const document = await call('inspect_source_document', { source_id: 'S1', expected_version: fixture.citation.source_version, citation: fixture.citation });
  assert.equal(document.verified_citation.quote, fixture.citation.quote);
  assert.ok(!('raw' in document)); assert.ok(!('path' in document));
  await call('inspect_source_document', { source_id: 'S1', expected_version: fixture.citation.source_version, citation: { ...fixture.citation, quote: 'Fabricated quote' } }, undefined, true);
  const span = await call('read_span', { source_id: 'S1', start: fixture.citation.start, end: fixture.citation.end });
  assert.equal(span.text, fixture.citation.quote);
  const matrix = await call('read_study_matrix', { reviewed_only: true });
  assert.equal(matrix.rows.length, 1); assert.equal(matrix.rows[0].id, 'Study1');
  receipt.checks.push('original-document-metadata-exact-citations-and-reviewed-study-matrix');
  const lessons = await call('recall_procedural_lessons', { query: 'subject', task_role: 'analyst', limit: 1, max_characters: 6000 });
  assert.ok(lessons.used_characters <= 6000); assert.equal(lessons.lessons.length, 1);
  receipt.checks.push('bounded-reviewed-lesson-recall');
  const methods = await call('methods_reference', { query: 'paired', limit: 1, max_characters: 4000 });
  assert.equal(methods.packs.length, 1); assert.ok(!('procedure' in methods.packs[0]));
  const loaded = await call('read_methods_content', { ...methods.packs[0].load, length: 16000 });
  assert.ok(loaded.complete); assert.match(loaded.text, /Unpaired data/);
  await call('read_methods_content', { pack_id: 'Paired', expected_version: 1 }, undefined, true);
  receipt.checks.push('metadata-discovery-and-version-pinned-full-guidance');
  const parts = []; let start = 0;
  while (start !== null) {
    const page = await call('read_task_output', { workflow_id: 'W', task_id: 'Protocol', expected_output_hash: fixture.outputHash, start, length: 80 });
    assert.equal(page.output_hash, fixture.outputHash); assert.ok(page.text.length <= 80);
    parts.push(page.text); start = page.next_start;
    assert.ok(parts.length < 100, 'Task pagination must make bounded progress.');
  }
  assert.equal(JSON.parse(parts.join('')).summary, 'Fixture protocol');
  await call('read_task_output', { workflow_id: 'W', task_id: 'Protocol', expected_output_hash: '0'.repeat(64) }, undefined, true);
  receipt.checks.push('hash-pinned-task-output-paging-and-stale-hash-rejection');
  const provenance = await call('inspect_analysis_provenance', { run_id: 'Run1', limit: 1 });
  assert.equal(provenance.snapshot.status, 'verified'); assert.equal(provenance.replay.reproduced, false);
  assert.ok(!JSON.stringify(provenance).includes('group,score'));
  receipt.checks.push('read-only-analysis-provenance-not-reproduction');
  await assert.rejects(connection.call('approve_lesson', {}), /not granted/);
  receipt.checks.push('no-approval-execution-acquisition-or-release-grants');
  const after = JSON.parse(await pythonRun(inspect));
  assert.equal(after.sourceHash, before.sourceHash, 'Harness source changed during verification; rerun.');
  assert.equal(after.stateHash, before.stateHash, 'Read-only inspection changed the synthetic project.');
  receipt.checks.push('source-fingerprint-stable-and-project-unchanged');
  // Mutate only the synthetic source: old artifact pins must now fail even
  // though the saved answer/worksheet records themselves have not changed.
  await pythonRun(`import sys\nfrom research_harness.store import Store\nfrom research_harness.engine import Engine\ns=Store(sys.argv[1]); Engine(s).attest_source('S1','fixture-operator','human','Synthetic metadata revision'); s.close()`);
  const revised = JSON.parse(await pythonRun(inspect));
  for (const load of artifactLoads.filter(item => item.kind !== 'prompt_experiment')) {
    await call('read_workbench_artifact', load, undefined, true);
    const listing = await call('list_workbench_artifacts', { kind: load.kind });
    assert.equal(listing.items[0].stale, true);
    assert.equal((await call('read_workbench_artifact', listing.items[0].load)).stale, true);
  }
  const staleMatrix = await call('read_study_matrix', { reviewed_only: true });
  assert.equal(staleMatrix.rows.length, 0); assert.equal(staleMatrix.stale[0].id, 'Study1');
  await connection.close(); connection = undefined;
  const finalState = JSON.parse(await pythonRun(inspect));
  assert.equal(finalState.stateHash, revised.stateHash);
  assert.equal(finalState.sourceHash, before.sourceHash);
  assert.equal(await bridgeHash(), receipt.adapter.sha256);
  receipt.checks.push('changed-source-rejects-old-pins-and-marks-artifacts-stale');
  receipt.verified = true;
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally {
  await connection?.close();
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  await rm(root, { recursive: true, force: true });
  await writeState(process.cwd(), 'verification', 'research-harness-current.json', receipt);
}
console.log(JSON.stringify(receipt, null, 2));
