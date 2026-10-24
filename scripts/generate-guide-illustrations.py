#!/usr/bin/env python3
"""Build offline SVG guide diagrams and annotated screenshot wrappers. No services."""
from pathlib import Path
from html import escape
import base64
import textwrap
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/assets/guide'
OUT.mkdir(parents=True, exist_ok=True)
BG, PANEL, LINE = '#101218', '#191d28', '#353c51'
INK, MUTED, ACCENT, GREEN, GOLD = '#f3f4fa', '#bbc3d5', '#b1c0ff', '#8cdec5', '#f2cd91'

def txt(x, y, value, size=20, color=INK, weight=400):
    return f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" font-weight="{weight}" font-family="Arial, Helvetica, sans-serif">{escape(str(value))}</text>'

def lines(x, y, value, width=40, size=19, color=MUTED, gap=28):
    result=[]
    for paragraph in value.split('\n'):
        for line in textwrap.wrap(paragraph, width=width, break_long_words=False, break_on_hyphens=False) or ['']:
            result.append(txt(x,y,line,size,color)); y+=gap
    return ''.join(result)

def rect(x,y,w,h,color=PANEL,stroke=LINE,r=16):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{color}" stroke="{stroke}"/>'

def arrow(x1,y1,x2,y2,color=ACCENT):
    return f'<path d="M{x1},{y1} L{x2},{y2}" fill="none" stroke="{color}" stroke-width="2.5" marker-end="url(#arrow)"/>'

def badge(x,y,n):
    return f'<circle cx="{x}" cy="{y}" r="19" fill="{ACCENT}" stroke="{BG}" stroke-width="3"/>'+txt(x-6,y+7,n,19,BG,700)

def save(name,title,subtitle,body,height=720):
    svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{height}" viewBox="0 0 1200 {height}" role="img" aria-labelledby="title desc">
<title id="title">{escape(title)}</title><desc id="desc">{escape(subtitle)}</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10Z" fill="{ACCENT}"/></marker></defs>
<rect width="1200" height="{height}" rx="22" fill="{BG}"/>
{txt(40,48,'NEXUSIDE / FIELD GUIDE',14,ACCENT,700)}{txt(40,91,title,32,INK,700)}{txt(40,126,subtitle,18,MUTED)}
{body}{txt(40,height-24,'NexusIDE guide • Read the accompanying instructions for requirements and limits.',14,MUTED)}
</svg>'''
    (OUT/name).write_text(svg)

def grid(name,title,subtitle,cards,footer):
    body=''
    for i,(heading,content) in enumerate(cards):
        col,row=i%3,i//3; x,y=40+col*380,166+row*224
        body+=rect(x,y,360,202)+badge(x+30,y+32,i+1)+txt(x+59,y+38,heading,21,INK,700)
        body+=lines(x+23,y+79,content,33,18,gap=26)
        if col<2: body+=arrow(x+363,y+105,x+377,y+105)
    y=166+((len(cards)+2)//3)*224
    body+=rect(40,y,1120,72,stroke=ACCENT)+lines(60,y+30,footer,110,18,color=INK,gap=25)
    save(name,title,subtitle,body,y+126)

grid('install-paths.svg','Choose your starting point','Pick the interface first, then open the project that owns the agents.',[
 ('macOS app','Open the DMG. Drag NexusIDE to Applications. Open the app and select a project folder.'),
 ('Source checkout','Install Node 22.18+ and Git. Run npm install, then npm link in the Nexus source folder.'),
 ('Windows / Linux','Use the CLI and browser dashboard from source. The packaged native app is currently macOS-only.'),
 ('Create workspace','Run nexus init in the intended project. Existing definitions are kept; missing defaults are added.'),
 ('Choose a model','Use Offline demo first, or start Ollama / export provider keys before launching Nexus.'),
 ('Run and inspect','Describe one outcome. Review requested actions, then inspect the run record and file changes.')
], 'App installation and project state are separate: each project keeps its own .nexus folder.')

grid('connection-states.svg','A key is only the first step','Each status answers a different question about a model connection.',[
 ('Key detected','The running Nexus process can see an environment variable. No key value is shown.'),
 ('Models listed','The selected account answered a catalog request. No project task was sent.'),
 ('Route saved','Use this model assigns that selection to the workspace default or one agent.'),
 ('Text verified','A synthetic generation request succeeded for the chosen profile and model.'),
 ('Tools verified','The model requested tools, consumed their results, and returned an observed answer.'),
 ('Workflow reviewed','Inspect real changes, evidence and tests. A successful API check does not certify a workflow.')
], 'If a check fails, inspect that account and model. Nexus does not rotate accounts or regions automatically.')

# Three accounts/profiles, effective route precedence shown separately.
body=''
for i,(head,sub) in enumerate([('Provider account','Environment name only'),('Saved profile','Endpoint + model + key reference'),('Assigned agent','Role-specific connection')]):
    x=40+i*380
    body+=txt(x,184,head,22,INK,700)+txt(x,213,sub,17,MUTED)
rows=[('OpenAI / Account 1','OPENAI_API_KEY','openai-primary','MODEL_A','architect'),('OpenAI / Account 2','OPENAI_API_KEY2','openai-second','MODEL_B','coder'),('Ollama / local','No API key','ollama-local','INSTALLED_MODEL','reviewer')]
for i,(label,key,profile,model,agent) in enumerate(rows):
    y=240+i*110
    for j,(a,b) in enumerate([(label,key),(profile,model),(agent,'Explicit route')]):
        x=40+j*380; body+=rect(x,y,350,90)+txt(x+18,y+34,a,21,INK,700)+txt(x+18,y+65,b,17,MUTED)
        if j<2: body+=arrow(x+355,y+45,x+376,y+45)
body+=rect(40,596,1120,90,stroke=ACCENT)+txt(60,628,'Effective model selection for an individual agent run',20,INK,700)+txt(60,661,'Per-run override → agent-pinned profile → agent route → workspace default → runtime environment',18,ACCENT)
save('provider-routing.svg','Two accounts, several agent routes','Example assignments; these are labels, not preconfigured accounts or model recommendations.',body,744)

grid('approval-gates.svg','What authorizes an action?','Instructions describe the work. Runtime checks decide what is allowed.',[
 ('Agent capability','Read, write and execute permissions determine which built-in tools an agent receives.'),
 ('Run opt-in','Commands also require Allow command requests or the CLI --allow-commands option.'),
 ('Action decision','Read the exact write, command, application or MCP request. Approve or decline that action.'),
 ('Execute once','An approved action runs with its configured scope. Host commands use your OS account.'),
 ('Observe result','Tool output and approval decisions are recorded. Failed tools do not become successful prose.'),
 ('Stop or continue','Cancel stops future work. Three identical failed tool calls stop a run. Completed writes stay applied.')
], 'MCP access also needs an assigned connection and explicit tool allowlist; an agent prompt cannot grant access.')

body=''
positions=[(40,180,'1','Plan','Architect reads source and proposes the work.'),(420,180,'2','Plan review','Distinct model: approve, revise or block.'),(800,180,'3','Build gate','Human approval before implementation.'),(800,420,'4','Implement','Coder changes files and runs permitted checks.'),(420,420,'5','Inspect','Fresh distinct model reads current source.'),(40,420,'6','Human review','Inspect diffs and tests. Decide whether to commit.')]
for x,y,n,title,content in positions:
    body+=rect(x,y,360,195)+badge(x+30,y+33,n)+txt(x+59,y+39,title,23,INK,700)+lines(x+22,y+84,content,30,20)
body+=arrow(403,275,415,275)+arrow(783,275,795,275)+arrow(980,379,980,413)+arrow(796,517,785,517)+arrow(416,517,405,517)
body+=txt(43,667,'A revise verdict uses a bounded new plan round. A blocked or invalid verdict stops the workflow.',18,GOLD)
save('independent-review-flow.svg','Independent review, with evidence','Different accounts for the same model do not make independent reviewers.',body,728)

grid('checkpoint-resume.svg','Continue without replaying completed work','Checkpoint mode is explicit and currently available through the CLI.',[
 ('Opt in','Start a supported file-tool team with --checkpoint. No memory, MCP, applications or commands.'),
 ('Save boundaries','Nexus stores completed stages and fingerprints of accessible files, config, skills and model choices.'),
 ('Stop and inspect','A failed or cancelled workflow keeps its history. Inspect files and pending stages before continuing.'),
 ('Validate resume','team resume ID checks unchanged inputs and asks approval. Active or legacy workflows are refused.'),
 ('Reuse safely','Completed stages are reused. An unfinished write-capable stage is blocked because effects are uncertain.'),
 ('New linked record','Pending stages run with their normal approvals. One claim per checkpoint; at most two continuations.')
], 'A changed workspace needs a new task. Checkpoints do not undo writes or capture external service state.')

body=''
for i,(layer,desc,color) in enumerate([('L1','Facts • decisions • constraints • procedures',GREEN),('L2','Project and task summaries',ACCENT),('L3','Lasting user preferences',GOLD)]):
    y=175+i*112
    body+=rect(40,y,610,90,stroke=color)+txt(62,y+39,layer,26,color,700)+txt(126,y+39,desc,21,INK)+txt(126,y+69,'Project scope or one owning agent',17,MUTED)
body+=arrow(662,332,707,332)
body+=rect(722,175,438,314,stroke=ACCENT)+txt(745,217,'Agent selection',25,INK,700)
body+=lines(745,260,'Project: all / selected / none\nAgent: own private notes only\nChoose layers and context budget\nExclude expired / archived notes\nRelevant keywords + recent L2/L3',36,19,gap=33)
body+=rect(40,548,1120,110,stroke=GREEN)+txt(61,583,'Startup context and retrieval',22,INK,700)+lines(61,620,'Eligible notes inform the task. Saving a proposed note needs approval; extracted draft memories stay inactive until reviewed.',104,19)
save('memory-selection.svg','What does an agent remember?','Memory selection narrows context; it does not enable tools or grant authority.',body,717)

grid('retrieval-pipeline.svg','Two kinds of retrieval','Memory notes and project code/documents have separate indexes.',[
 ('Save or edit','Write governed memory notes, or edit normal source files and project documents.'),
 ('Refresh index','Memory keywords update on save. Code search needs project index. Semantic vectors refresh explicitly.'),
 ('Optional embeddings','A local embedding model converts eligible text to vectors. It is separate from the chat model.'),
 ('Search','Choose lexical for local keywords. Hybrid combines keywords and current vectors when available.'),
 ('Check freshness','Changed or deleted content is excluded. Read warnings, stale counts and truncated coverage.'),
 ('Verify source','Open the original file or note. Retrieved context is evidence to assess, not automatic proof.')
], 'Indexing is incremental and explicit, not a background file watcher. Semantic commands require current vectors.')

grid('integration-boundaries.svg','Connect only what the task needs','Optional capabilities have their own installation, grants and evidence.',[
 ('Research Harness','Separate research project and Python environment. Reader bridge returns scoped evidence and saved context.'),
 ('Cortex','Separate pinned Python engine and brain. Three bounded tools read notes with hashes and status labels.'),
 ('Code map','Existing codebase-memory index. Direct caller/callee queries; inspect current source to confirm edges.'),
 ('Anatomy','Bundled optional SVG subset and technical-illustrator agent. Commands are disabled by default.'),
 ('Managed runtimes','TradingAgents and OpenMontage need their own setup, environment, launch approval and validation.'),
 ('Native adaptations','Checkpoint/retry patterns, RAM guidance and offline RRSI-inspired evaluation use the Nexus runtime.')
], 'Installing Nexus does not install every model, private knowledge base or external application.')

body=''
for i,(title,caption) in enumerate([('VS Code','Thin launcher → integrated terminal'),('Zed','Agent Client Protocol or tasks'),('Terminal / desktop','CLI or shared browser dashboard')]):
    x=40+i*380
    body+=rect(x,182,360,122)+txt(x+22,224,title,25,INK,700)+lines(x+22,261,caption,32,18)
    body+=arrow(x+180,309,x+180,370)
body+=rect(40,378,1120,130,stroke=ACCENT)+txt(70,421,'One project / one shared Nexus runtime',27,INK,700)+txt(70,461,'Agent definitions • provider routes • approvals • history • memory',22,MUTED)
body+=rect(40,558,1120,98)+lines(65,596,'Open the intended project in each interface. The source checkout location is not automatically the workspace you want the agent to change.',100,20)
save('editor-bridges.svg','How editors connect to Nexus','The editor is an interface; the project folder determines configuration and history.',body,719)

grid('backup-recovery.svg','Keep the whole workspace recoverable','A database backup and a complete private project-state backup have different scopes.',[
 ('Live DB snapshot','storage backup creates a consistent SQLite snapshot, including committed WAL data.'),
 ('Stop before copying','Close Nexus processes before copying the full .nexus directory. Retain existing state separately.'),
 ('Save companion state','Keep agents, teams, config, skills and encrypted vault privately. External runtimes need separate backups.'),
 ('Recover a crash','Inspect activity and locks. Mark an orphan interrupted only after its process is confirmed absent.'),
 ('Restore carefully','Use a clean stopped restore folder. Do not pair a restored DB with old WAL/shared-memory files.'),
 ('Check and reopen','Run storage status and doctor. Refresh indexes. Continue deliberately; no tools are auto-replayed.')
], 'App removal does not remove project .nexus data. A DMG or Git source checkout is not a private-state backup.')

grid('code-map-tour.svg','From a symbol to the current source','This view uses a separately configured codebase-memory-mcp connection.',[
 ('Review connection','Confirm the executable, approved source scope and requested read access. Select Allow.'),
 ('Load indexes','Choose an index rooted inside the approved workspace. No model request is made.'),
 ('Find symbol','Enter a function or symbol. Up to 20 matches are returned per query.'),
 ('Follow callers','Callers invoke the selected function. Select one to move through the graph.'),
 ('Follow callees','Callees are invoked by the selected function. Direct relationships are bounded to 20 per direction.'),
 ('Open source','Check current files. Index lines can drift; strategy and confidence do not guarantee an edge is correct.')
], 'Missing edges do not prove code is unused. Save or discard a dirty editor draft before opening another file.')

grid('harness-evaluation-flow.svg','Improve the harness with measured evidence','An offline screening command; it never edits source or calls a model.',[
 ('Define change','Record baseline/candidate revisions, one hypothesis and at most three independent edits.'),
 ('Collect evidence','Use fixed development and held-out cases, paired trials, reward scores, tokens and critical failures.'),
 ('Review leakage','A named reviewer checks for task-specific shortcuts. This attestation is supplied, not auto-certified.'),
 ('Evaluate locally','harness evaluate reads bounded JSON. Missing trials count as zero and cannot pass.'),
 ('Apply screening','Both splits need gain above the noise floor. Token growth and critical failures can reject the change.'),
 ('Human decision','Eligible means supplied evidence passed the policy. Inspect the change before adopting it; duplicates reuse history.')
], 'The bundled example is synthetic. It teaches the format and is not benchmark evidence about Nexus.')

# Annotated screenshots remain standalone: embed the reviewed local PNG, never a URL.
def annotate(name,source,title,subtitle,callouts,legend):
    data=source.read_bytes(); encoded=base64.b64encode(data).decode()
    import struct
    width,height=struct.unpack('>II',data[16:24])
    display_w=1120; scale=display_w/width; display_h=height*scale
    body=f'<image x="40" y="160" width="{display_w}" height="{display_h}" href="data:image/png;base64,{encoded}"/>'
    for x,y,n in callouts: body+=badge(round(40+x*scale),round(160+y*scale),n)
    y=185+display_h
    for i,(heading,content) in enumerate(legend):
        row,col=i//2,i%2; x=40+col*570; ly=y+row*96
        body+=badge(x+19,ly+18,i+1)+txt(x+48,ly+24,heading,20,INK,700)+lines(x+48,ly+52,content,48,17,gap=24)
    save(name,title,subtitle,body,int(y+((len(legend)+1)//2)*96+52))

annotate('workspace-annotated.svg',OUT/'workspace.png','Workspace: know where to look','Actual browser screenshot of a minimal synthetic project; its three agents are not the fresh-install total.',[(26,437,1),(26,546,2),(28,733,3),(733,733,4),(27,780,5),(28,874,6)],[('Agent or team','Select the role or dependency-ordered team.'),('Task','Describe an outcome, scope and acceptance checks.'),('Run settings','Offline demo is scripted; commands need explicit opt-in.'),('Run task','Starts execution with the selected settings.'),('Plan first','Saves a proposal without executing the team.'),('Task activity','Follow model/tool events and approval requests.')])
source=ROOT/'.nexus/verification/provider-picker-ui/connections-1280.png'
if source.exists(): shutil.copyfile(source,OUT/'connections.png')
if (OUT/'connections.png').exists():
    annotate('connections-annotated.svg',OUT/'connections.png','Connections: choose, then assign','Synthetic account screenshot with a real local model listing; no cloud or inference request was made.',[(28,382,1),(28,444,2),(28,576,3),(28,626,4),(28,723,5),(28,804,6)],[('Detected credentials','Names show process-level detection, not account verification.'),('Provider / account','Each numbered key is a separate account choice.'),('Model','Choose an installed Ollama model or account model ID.'),('Local guidance','Download-size / RAM comparison is an estimate, not proof of fit.'),('Use for','Choose workspace default or a particular agent.'),('Use this model','Saves the route. Starting a task is a separate action.')])
print('Built',len(list(OUT.glob('*.svg'))),'local SVG guide illustrations.')

if '--render' in sys.argv:
    renderer = shutil.which('rsvg-convert')
    if not renderer:
        raise SystemExit('rsvg-convert is required only for --render; SVG sources were generated.')
    for source in OUT.glob('*-annotated.svg'):
        subprocess.run([renderer, '-w', '1200', '-o', str(source.with_suffix('.png')), str(source)], check=True)
    print('Rendered standalone annotated PNGs for Markdown viewer compatibility.')
