// Explicit local-only compatibility check; never opens a real research project.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
let connection;
const inspect = `import hashlib,json,sys
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
print(json.dumps({'version':research_harness.__version__,'source':str(p),'sourceHash':source_hash.hexdigest(),'stateHash':state_hash}))`;
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
print(json.dumps({'outputHash':digest(canonical(out).encode())})); s.close()`;
  const fixture = JSON.parse(await pythonRun(setup));
  const before = JSON.parse(await pythonRun(inspect));
  receipt.harness = { version: before.version, source: before.source, sourceHash: before.sourceHash };
  const template = JSON.parse(await readFile(new URL('../integrations/research-harness.example.json', import.meta.url), 'utf8'));
  const context = template.mcp['research-harness-context'];
  context.command = python;
  context.args = ['-m', 'research_harness.agent_server', '--project', project, '--role', 'critic'];
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
  await connection.close(); connection = undefined;
  const after = JSON.parse(await pythonRun(inspect));
  assert.equal(after.sourceHash, before.sourceHash, 'Harness source changed during verification; rerun.');
  assert.equal(after.stateHash, before.stateHash, 'Read-only inspection changed the synthetic project.');
  receipt.checks.push('source-fingerprint-stable-and-project-unchanged');
  receipt.verified = true;
} catch (error) { receipt.error = error.message; process.exitCode = 1; }
finally {
  await connection?.close();
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  await rm(root, { recursive: true, force: true });
  await writeState(process.cwd(), 'verification', 'research-harness-current.json', receipt);
}
console.log(JSON.stringify(receipt, null, 2));
