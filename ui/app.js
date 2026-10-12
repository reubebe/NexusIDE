import { createFileEditor } from './file-editor.js';
import { renderWhenChanged } from './render-cache.js';
import { createProviderPicker } from './provider-picker.js';
const $ = id => document.getElementById(id);
const initialToken = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(initialToken)) { sessionStorage.setItem('nexus-token', initialToken); history.replaceState(null, '', '/'); }
const token = sessionStorage.getItem('nexus-token') || '';
let state, activeJob;
const skillAudits = new Map();
let selectedRun, memoryOffset = 0, memoryRequest = 0, editingMemory, projectMemories = [];
let memoryLoaded = false, lastMemoryJobKey = '';
let memoryEditDirty = false, memoryBusy = false, memoryTotal = 0, memoryPageCount = 0;
let draftRequest = 0, draftReviewBusy = false, distillBusy = false, runRequest = 0;
let draftOffset = 0, draftTotal = 0, draftPageCount = 0;
let projectMemoryRequest = 0, projectMemoryOffset = 0, projectMemoryTotal = 0, projectMemoryLoading = false;
let projectMemoryError = '';
const MEMORY_PAGE_SIZE = 20;
let currentDirectory = '.';
const fileEditor = createFileEditor(api);
window.nexusHasUnsavedChanges = () => fileEditor.dirty || memoryEditDirty || providerPicker.dirty;
const fileStatus = document.createElement('p');
fileStatus.setAttribute('role', 'status');
$('save-file').after(fileStatus);
const reloadFile = document.createElement('button');
reloadFile.type = 'button'; reloadFile.textContent = 'Reload file';
fileStatus.after(reloadFile);
function renderFileEditor() {
  $('file-title').textContent = fileEditor.path || 'Select a file';
  $('file-content').value = fileEditor.draft;
  $('file-content').disabled = !fileEditor.path || fileEditor.loading;
  $('save-file').disabled = fileEditor.busy || !fileEditor.dirty;
  reloadFile.disabled = fileEditor.busy || !fileEditor.path;
  fileStatus.textContent = fileEditor.busy ? 'File request in progress…' : fileEditor.dirty ? 'Unsaved changes' : fileEditor.path ? 'No unsaved changes' : '';
}
$('file-content').addEventListener('input', () => { fileEditor.draft = $('file-content').value; renderFileEditor(); });
window.addEventListener('beforeunload', event => { if (window.nexusHasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; } });
renderFileEditor();
async function api(path, method = 'GET', data) {
  const response = await fetch('/api/' + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
const node = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const action = fn => async event => { event?.preventDefault(); try { $('notice').textContent = ''; await fn(); } catch (e) { $('notice').textContent = e.message; } };
const titles = { workspace: 'Tasks', files: 'Project files', agents: 'Agents', history: 'Run library', memory: 'Memory', settings: 'Connections', terminal: 'Terminal', about: 'About Nexus' };
function showTab(tab) {
  if (!Object.hasOwn(titles, tab)) return;
  for (const section of document.querySelectorAll('.tab')) section.hidden = section.id !== tab;
  for (const b of document.querySelectorAll('[data-tab]')) {
    b.classList.toggle('active', b.dataset.tab === tab);
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  $('page-title').textContent = titles[tab];
  if (tab === 'files') action(() => loadFiles())();
  if (tab === 'memory') action(() => refreshMemories())();
}
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => showTab(button.dataset.tab);
if (initialToken === 'about') showTab('about');
let terminalCursor = 0, terminalTimer;
const cleanTerminalOutput = value => value.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
async function pollTerminal() {
  const result = await api(`terminal/output?cursor=${terminalCursor}`);
  if (result.output) { const output = $('terminal-output'), clean = cleanTerminalOutput(result.output); output.textContent = (output.textContent === 'Terminal is stopped.' ? clean : output.textContent + clean).slice(-200000); output.scrollTop = output.scrollHeight; }
  terminalCursor = result.cursor;
  $('terminal-start').disabled = result.running; $('terminal-stop').disabled = !result.running; $('terminal-input').disabled = !result.running;
  if (result.running) terminalTimer = setTimeout(() => action(pollTerminal)(), 300);
}
$('terminal-start').onclick = action(async () => { await api('terminal/start', 'POST', {}); terminalCursor = 0; $('terminal-output').textContent = ''; clearTimeout(terminalTimer); await pollTerminal(); });
$('terminal-stop').onclick = action(async () => { await api('terminal/stop', 'POST', {}); clearTimeout(terminalTimer); $('terminal-output').textContent += '\n[terminal stopped]'; await pollTerminal(); });
$('terminal-form').onsubmit = action(async () => { const input = $('terminal-input'); await api('terminal/input', 'POST', { input: input.value + '\n' }); input.value = ''; });
pollTerminal().catch(() => {});
function render() {
  $('project-path').textContent = state.root;
  $('stats').replaceChildren(...[[state.agents.length, 'AVAILABLE AGENTS'], [state.runs.length, 'RUN RECORDS'], [state.skills.length, 'INSTALLED SKILLS']].map(([count, label]) => { const n = node('div', undefined, 'stat'); n.append(node('strong', count), node('span', label)); return n; }));
  const selected = $('agent-select').value;
  const nextOptionsKey = JSON.stringify([state.agents.map(a => a.name), state.teams]);
  renderWhenChanged($('agent-select'), nextOptionsKey, () => {
    $('agent-select').replaceChildren(...state.agents.map(a => { const o = node('option', a.name); o.value = a.name; return o; }), ...state.teams.map(t => { const name = t.slice(0, -5), o = node('option', 'Team · ' + name); o.value = 'team:' + name; return o; }));
    if ([...$('agent-select').options].some(o => o.value === selected)) $('agent-select').value = selected;
  });
  renderMemoryAgentOptions();
  providerPicker.setAgents(state.agents);
  renderWhenChanged($('agent-cards'), JSON.stringify(state.agents), () => $('agent-cards').replaceChildren(...state.agents.map(a => { const card = node('button', undefined, 'agent-card'); card.append(node('h3', a.name), node('p', a.instructions.slice(0, 125)), node('small', Object.entries(a.permissions).filter(([,v]) => v).map(([k]) => k).join(' · '))); card.onclick = action(async () => { $('agent-editor').value = JSON.stringify(a, null, 2); renderLoadout(a); await loadProjectMemories(true); }); return card; })));
  renderWhenChanged($('history-list'), JSON.stringify(state.runs), () => $('history-list').replaceChildren(...state.runs.map(r => { const row = node('div', undefined, 'row'), b = node('button', r.agent + ' · ' + r.status); b.onclick = action(async () => { const request = ++runRequest; selectedRun = undefined; renderDistillButton(); const run = await api('runs/' + r.id); if (request !== runRequest) return; selectedRun = run; $('transcript').textContent = JSON.stringify(run, null, 2); renderDistillButton(); }); row.append(b, node('small', new Date(r.started).toLocaleString())); return row; })));
  renderDistillButton();
  $('skills').replaceChildren(...state.skills.map(s => {
    const n = node('div', undefined, 'row'), audit = node('button', 'Audit skill');
    audit.type = 'button';
    audit.setAttribute('aria-label', `Audit ${s.name}`);
    audit.onclick = action(async () => {
      skillAudits.set(s.name, await api('skills/audit?name=' + encodeURIComponent(s.name)));
      render();
    });
    n.append(node('strong', s.name), node('p', s.description), audit);
    if (skillAudits.has(s.name)) {
      const report = skillAudits.get(s.name);
      if (!report.scan) n.append(node('p', 'Could not verify stored skill: ' + report.error));
      else {
        const { scan } = report, coverage = scan.coverage;
        n.append(node('p', 'Stored contents match the saved record. This does not authenticate the publisher.'),
          node('p', `Checked ${coverage.inspectedFiles} of ${coverage.totalFiles} files as text. ${scan.counts.high} high and ${scan.counts.medium} medium indicators.`),
          node('small', scan.note));
        if (coverage.truncated) n.append(node('p', 'Finding limit reached. The report is incomplete.'));
        if (coverage.skipped.length) n.append(node('p', 'Skipped resources: ' + coverage.skipped.map(f => `${f.file} (${f.reason})`).join(', ')));
        if (scan.findings.length) {
          const detail = node('details'), list = node('ul');
          detail.append(node('summary', 'Review indicators'));
          list.append(...scan.findings.map(f => node('li', `${f.severity} · ${f.file}:${f.line} — ${f.title}`)));
          detail.append(list); n.append(detail);
        }
      }
    }
    return n;
  }));
  const job = state.jobs.find(j => j.id === activeJob) || state.jobs.at(-1);
  if (job) { activeJob = job.id; $('activity').textContent = `Task status: ${job.status}\n\n` + job.events.map(e => e.type === 'text' ? e.text : e.type === 'tool-result' ? `${e.name}: ${e.content}` : `[${e.step || ''} ${e.type}] ${e.name || e.status || ''}`).join('\n\n') + (job.error ? '\nError: ' + job.error : '') + (job.plan ? '\nPlan saved. Select its team name to run it after review.\n' + JSON.stringify(job.plan, null, 2) : ''); }
  $('cancel').disabled = !job || job.status !== 'running';
  const lastEvent = job?.events.at(-1);
  if (job?.status === 'running' && lastEvent?.type === 'model-request') {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(lastEvent.at)) / 1000));
    $('activity').textContent += `\n\nWaiting for ${lastEvent.model} · ${seconds}s elapsed. You can cancel this task.`;
  }
  $('run-form').querySelector('[type="submit"]').disabled = state.jobs.some(j => j.status === 'running');
  planButton.disabled = state.jobs.some(j => j.status === 'running');
  const nextApprovalsKey = JSON.stringify(state.approvals);
  renderWhenChanged($('approvals'), nextApprovalsKey, () => {
    $('approvals').replaceChildren(...state.approvals.map(a => { const panel = node('article', undefined, 'panel approval'); panel.append(node('h3', 'Your approval is needed'), node('pre', JSON.stringify(a.request, null, 2))); for (const [label, allow] of [['Approve', true], ['Decline', false]]) { const b = node('button', label); b.onclick = action(async () => { await api('approval', 'POST', { id: a.id, allow }); await refresh(); }); panel.append(b); } return panel; }));
  });
  const memoryJobKey = JSON.stringify(state.jobs.map(j => [j.id, j.status]));
  if (memoryLoaded && lastMemoryJobKey && memoryJobKey !== lastMemoryJobKey && !$('memory').hidden) action(() => refreshDrafts())();
  lastMemoryJobKey = memoryJobKey;
}
async function refresh() { state = await api('state'); render(); }
const layerLabels = { L1: 'Facts & decisions', L2: 'Summary', L3: 'Preference' };
function memoryOption(value, text) { const option = node('option', text); option.value = value; return option; }
function memoryLabel(text, input) { const label = node('label', text); label.append(input); return label; }
function memoryDate(value) { return value ? new Date(value).toLocaleString() : 'Never'; }
function localDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function expiryValue(value) { return value ? new Date(value).toISOString() : null; }
function populateCategories(select, layer, selected) {
  const categories = layer === 'L2' ? ['summary'] : layer === 'L3' ? ['preference'] : ['fact', 'decision', 'constraint', 'procedure'];
  select.replaceChildren(...categories.map(category => memoryOption(category, category[0].toUpperCase() + category.slice(1))));
  if (categories.includes(selected)) select.value = selected;
}
function renderMemoryAgentOptions() {
  for (const id of ['memory-owner', 'memory-search-agent', 'memory-filter-agent']) {
    const select = $(id), selected = select.value;
    renderWhenChanged(select, JSON.stringify(state.agents.map(a => a.name)), () => {
      select.replaceChildren(...(id === 'memory-owner' ? [] : [memoryOption('', 'Project only')]), ...state.agents.map(a => memoryOption(a.name, a.name)));
      if ([...select.options].some(o => o.value === selected)) select.value = selected;
    });
  }
}
function memorySource(memory) {
  const provenance = memory.provenance;
  const source = provenance?.runId ? `Run ${provenance.runId}` : memory.source || 'User';
  return `${source} · Revision ${memory.revision || 1} · ${memory.status || 'active'}`;
}
function updateMemoryControls() {
  const locked = Boolean(editingMemory) || memoryBusy;
  for (const id of ['memory-filter-agent', 'memory-filter-layer', 'memory-filter-status', 'memory-refresh']) $(id).disabled = locked;
  for (const button of $('memories').querySelectorAll('[data-memory-record-action]')) button.disabled = locked;
  $('memory-previous').disabled = locked || memoryOffset === 0;
  $('memory-next').disabled = locked || memoryOffset + memoryPageCount >= memoryTotal;
}
function closeMemoryEditor(form) {
  editingMemory = undefined; memoryEditDirty = false; form.remove(); updateMemoryControls();
}
function appendEvidence(parent, evidence) {
  for (const item of evidence || []) {
    const quote = node('blockquote', item.quote, 'memory-evidence');
    quote.append(node('cite', `Message ${item.messageIndex + 1}`));
    parent.append(quote);
  }
}
function memoryRecord(memory, { editable = false } = {}) {
  const article = node('article', undefined, 'memory-record');
  const meta = node('div', undefined, 'memory-meta');
  meta.append(node('span', `${memory.layer || 'L1'} · ${memory.category || 'fact'}`, 'soft-pill'), node('span', memory.scope === 'agent' ? `Private to ${memory.agent}` : 'Project'));
  article.append(meta, node('p', memory.text, 'memory-text'), node('p', memorySource(memory), 'helper'));
  if (memory.textTruncated) article.append(node('p', 'Text shortened to fit the recall budget. Open Saved memories to read the full record.', 'helper'));
  const details = node('details'), summary = node('summary', 'Source & history');
  details.append(summary, node('p', `Created ${memoryDate(memory.created)}${memory.updated ? ' · Updated ' + memoryDate(memory.updated) : ''}`, 'helper'), node('p', `Expires: ${memoryDate(memory.expiresAt)}${memory.lastUsed ? ' · Last recalled ' + memoryDate(memory.lastUsed) : ''}`, 'helper'));
  if (memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now()) details.append(node('p', 'Expired memories are excluded from recall.', 'helper'));
  appendEvidence(details, memory.provenance?.evidence);
  if (editable) {
    const historyButton = node('button', 'View revisions', 'text-button'), history = node('div');
    let historyOffset = 0;
    historyButton.type = 'button'; historyButton.onclick = action(async () => {
      if (historyButton.disabled) return;
      historyButton.disabled = true;
      try {
        const { versions } = await api(`memory/${encodeURIComponent(memory.id)}/history?offset=${historyOffset}&limit=50`);
        history.append(...versions.map(v => { const row = node('div', undefined, 'memory-version'); row.append(node('small', `Revision ${v.revision || 1} · ${v.status || 'active'} · ${memoryDate(v.updated || v.created)}`), node('p', v.text)); return row; }));
        historyOffset += versions.length;
        historyButton.hidden = versions.length < 50; historyButton.textContent = 'Load older revisions';
      } finally { historyButton.disabled = false; }
    });
    details.append(historyButton, history);
  }
  article.append(details);
  if (editable) {
    const controls = node('div', undefined, 'editor-actions'), edit = node('button', 'Edit', 'text-button'), archive = node('button', memory.status === 'archived' ? 'Restore' : 'Archive', 'text-button');
    edit.type = archive.type = 'button'; edit.dataset.memoryRecordAction = archive.dataset.memoryRecordAction = '';
    edit.onclick = action(async () => { if (editingMemory || memoryBusy) throw new Error('Save or cancel the open memory edit first.'); editingMemory = memory.id; openMemoryEditor(article, memory); updateMemoryControls(); });
    archive.onclick = action(async () => {
      if (editingMemory || memoryBusy) throw new Error('Finish the current memory change first.');
      memoryBusy = true; updateMemoryControls();
      try { await api(`memory/${encodeURIComponent(memory.id)}`, 'PATCH', { expectedRevision: memory.revision || 1, status: memory.status === 'archived' ? 'active' : 'archived' }); await refreshMemories(); }
      catch (e) { throw new Error(`${e.message} Refresh saved memories to load the latest revision.`); }
      finally { memoryBusy = false; updateMemoryControls(); }
    });
    controls.append(edit, archive); article.append(controls);
  }
  return article;
}
function openMemoryEditor(article, memory) {
  article.querySelector('.memory-inline-editor')?.remove();
  const form = node('form', undefined, 'memory-inline-editor'), text = node('textarea'), fields = node('div', undefined, 'memory-fields');
  text.rows = 4; text.required = true; text.maxLength = 16000; text.value = memory.text;
  const layer = node('select'), category = node('select'), expiry = node('input');
  layer.append(...Object.entries(layerLabels).map(([value, label]) => memoryOption(value, `${value} · ${label}`))); layer.value = memory.layer || 'L1';
  populateCategories(category, layer.value, memory.category); layer.onchange = () => populateCategories(category, layer.value);
  expiry.type = 'datetime-local'; expiry.value = localDateTime(memory.expiresAt);
  fields.append(memoryLabel('Layer', layer), memoryLabel('Category', category), memoryLabel('Expires (optional)', expiry));
  const buttons = node('div', undefined, 'editor-actions'), save = node('button', 'Save changes', 'secondary'), cancel = node('button', 'Cancel edit', 'text-button'), error = node('p', undefined, 'helper');
  save.type = 'submit'; cancel.type = 'button'; error.setAttribute('role', 'status');
  const values = () => JSON.stringify([text.value, layer.value, category.value, expiry.value]);
  const original = values();
  form.addEventListener('input', () => { memoryEditDirty = values() !== original; });
  form.addEventListener('change', () => { memoryEditDirty = values() !== original; });
  cancel.onclick = action(async () => { closeMemoryEditor(form); await refreshMemoryList(); });
  buttons.append(save, cancel); form.append(memoryLabel('Memory', text), fields, buttons, error); article.append(form); text.focus();
  form.onsubmit = action(async () => {
    if (save.disabled) return;
    const controls = [...form.querySelectorAll('input,select,textarea,button')];
    controls.forEach(control => { control.disabled = true; }); error.textContent = '';
    try {
      await api(`memory/${encodeURIComponent(memory.id)}`, 'PATCH', { expectedRevision: memory.revision || 1, text: text.value, layer: layer.value, category: category.value, expiresAt: expiry.value === localDateTime(memory.expiresAt) ? memory.expiresAt ?? null : expiryValue(expiry.value) });
    } catch (e) { error.textContent = `${e.message} Your changes are still here. Cancel edit to reload the saved version.`; return; }
    finally { controls.forEach(control => { control.disabled = false; }); }
    closeMemoryEditor(form); await refreshMemories(); $('notice').textContent = 'Memory updated.';
  });
}
async function refreshMemoryList() {
  if (editingMemory) return;
  const request = ++memoryRequest;
  const params = new URLSearchParams({ status: $('memory-filter-status').value, offset: String(memoryOffset), limit: String(MEMORY_PAGE_SIZE) });
  if ($('memory-filter-agent').value) params.set('agent', $('memory-filter-agent').value);
  if ($('memory-filter-layer').value) params.set('layer', $('memory-filter-layer').value);
  const { memories, total } = await api('memory?' + params);
  if (request !== memoryRequest || editingMemory) return;
  if (!memories.length && memoryOffset > 0) { memoryOffset = Math.max(0, memoryOffset - MEMORY_PAGE_SIZE); return refreshMemoryList(); }
  $('memories').replaceChildren(...memories.map(m => memoryRecord(m, { editable: true })));
  $('memory-list-status').textContent = total ? `${total} saved ${total === 1 ? 'memory' : 'memories'}` : 'No saved memories match these filters.';
  $('memory-page').textContent = total ? `${memoryOffset + 1}–${memoryOffset + memories.length} of ${total}` : '';
  memoryTotal = total; memoryPageCount = memories.length; updateMemoryControls();
}
async function refreshDrafts() {
  const request = ++draftRequest;
  const { drafts, total } = await api(`memory/drafts?offset=${draftOffset}&limit=${MEMORY_PAGE_SIZE}`);
  if (request !== draftRequest) return;
  if (!drafts.length && draftOffset > 0) { draftOffset = Math.max(0, draftOffset - MEMORY_PAGE_SIZE); return refreshDrafts(); }
  draftTotal = total; draftPageCount = drafts.length;
  $('memory-draft-page').textContent = total ? `Extraction batches ${draftOffset + 1}–${draftOffset + drafts.length} of ${total}` : '';
  renderWhenChanged($('memory-drafts'), JSON.stringify([draftOffset, drafts]), () => {
    const records = drafts.flatMap(draft => (draft.candidates || []).filter(c => c.status === 'pending').map(candidate => {
      const article = node('article', undefined, 'memory-record');
      article.append(node('div', `${candidate.layer} · ${candidate.category} · Private to ${candidate.agent}`, 'memory-meta'), node('p', candidate.text, 'memory-text'), node('p', `Run ${draft.runId || draft.provenance?.runId || 'unknown'} · Proposal revision ${draft.revision}`, 'helper'));
      if (draft.provider) article.append(node('p', `Proposed by ${draft.provider.name} · ${draft.provider.model}`, 'helper'));
      appendEvidence(article, candidate.evidence);
      const controls = node('div', undefined, 'editor-actions');
      for (const [label, decision] of [['Approve memory', 'approve'], ['Reject', 'reject']]) {
        const button = node('button', label, decision === 'approve' ? 'secondary' : 'text-button'); button.type = 'button';
        button.onclick = action(async () => {
          if (draftReviewBusy) return;
          draftReviewBusy = true; updateDraftControls();
          try { await api(`memory/drafts/${encodeURIComponent(draft.id)}/review`, 'POST', { candidateId: candidate.id, decision, expectedRevision: draft.revision }); await refreshMemories(); $('notice').textContent = decision === 'approve' ? `Memory approved for ${candidate.agent}. Select that agent under Saved memories to view it.` : 'Proposal rejected.'; }
          catch (e) { await refreshDrafts(); throw e; }
          finally { draftReviewBusy = false; updateDraftControls(); }
        }); controls.append(button);
      }
      article.append(controls); return article;
    }));
    $('memory-drafts').replaceChildren(...(records.length ? records : [node('p', total > drafts.length ? 'No memories awaiting review on this page. Check other extraction batches for more proposals.' : 'No memories awaiting review.', 'helper')]));
  });
  updateDraftControls();
}
function updateDraftControls() {
  for (const button of $('memory-drafts').querySelectorAll('button')) button.disabled = draftReviewBusy;
  $('memory-refresh-drafts').disabled = draftReviewBusy;
  $('memory-draft-previous').disabled = draftReviewBusy || draftOffset === 0;
  $('memory-draft-next').disabled = draftReviewBusy || draftOffset + draftPageCount >= draftTotal;
}
function invalidateRecallPreview() {
  if ($('memory-results').childElementCount) {
    $('memory-results').replaceChildren();
    $('memory-search-status').textContent = 'Preview recall again to use the current memories and agent selection.';
  }
}
async function refreshMemories() { invalidateRecallPreview(); await Promise.all([refreshMemoryList(), refreshDrafts()]); memoryLoaded = true; }
async function loadProjectMemories(reset = false) {
  if (projectMemoryLoading && !reset) return;
  const request = ++projectMemoryRequest;
  if (reset) { projectMemories = []; projectMemoryOffset = 0; projectMemoryTotal = 0; }
  projectMemoryLoading = true; projectMemoryError = ''; renderLoadout(JSON.parse($('agent-editor').value));
  try {
    const { memories, total } = await api(`memory?status=active&limit=100&offset=${projectMemoryOffset}`);
    if (request !== projectMemoryRequest) return;
    projectMemoryOffset += memories.length; projectMemoryTotal = total;
    projectMemories = [...new Map([...projectMemories, ...memories.filter(m => m.scope === 'project')].map(m => [m.id, m])).values()];
  } catch (error) {
    if (request === projectMemoryRequest) projectMemoryError = 'Could not load project memories. Try again.';
    throw error;
  } finally {
    if (request === projectMemoryRequest) { projectMemoryLoading = false; renderLoadout(JSON.parse($('agent-editor').value)); }
  }
}
function renderLoadout(agent) {
  const loadout = agent.memoryLoadout || {}, ids = loadout.ids || [];
  $('memory-loadout').disabled = false;
  $('loadout-project').value = loadout.project || 'all'; $('loadout-items').value = loadout.maxItems ?? 8; $('loadout-chars').value = loadout.maxChars ?? 12000;
  $('loadout-selection').hidden = $('loadout-project').value !== 'selected';
  $('loadout-more').hidden = !projectMemoryLoading && !projectMemoryError && projectMemoryOffset >= projectMemoryTotal;
  $('loadout-more').disabled = projectMemoryLoading;
  $('loadout-more').textContent = projectMemoryError ? 'Retry loading memories' : 'Load more memories';
  $('loadout-status').textContent = projectMemoryLoading ? 'Loading project memories…' : projectMemoryError || `${projectMemories.length} of ${projectMemoryTotal} active project memories loaded.`;
  const options = projectMemories.map(m => memoryOption(m.id, m.text.slice(0, 150)));
  for (const id of ids) if (!projectMemories.some(m => m.id === id)) options.push(memoryOption(id, `Saved selection · ${id}`));
  $('loadout-ids').replaceChildren(...options); for (const option of $('loadout-ids').options) option.selected = ids.includes(option.value);
  for (const input of document.querySelectorAll('[data-loadout-layer]')) input.checked = (loadout.layers || ['L1', 'L2', 'L3']).includes(input.value);
}
function updateLoadout(report = true) {
  for (const input of [$('loadout-items'), $('loadout-chars')]) if (!input.validity.valid) { if (report) input.reportValidity(); return; }
  const definition = JSON.parse($('agent-editor').value);
  definition.memoryLoadout = { project: $('loadout-project').value, ids: [...$('loadout-ids').selectedOptions].map(o => o.value), layers: [...document.querySelectorAll('[data-loadout-layer]:checked')].map(input => input.value), maxItems: Number($('loadout-items').value), maxChars: Number($('loadout-chars').value) };
  $('loadout-selection').hidden = definition.memoryLoadout.project !== 'selected';
  $('agent-editor').value = JSON.stringify(definition, null, 2);
}
for (const input of $('memory-loadout').querySelectorAll('input,select')) input.onchange = action(async () => updateLoadout());
for (const input of [$('loadout-items'), $('loadout-chars')]) input.oninput = () => { try { updateLoadout(false); } catch {} };
$('loadout-more').onclick = action(async () => loadProjectMemories());
$('agent-editor').addEventListener('change', action(async () => renderLoadout(JSON.parse($('agent-editor').value))));
function renderDistillButton() { $('distill-run').disabled = distillBusy || selectedRun?.status !== 'completed' || state.jobs.some(j => j.status === 'running'); }
$('distill-run').onclick = action(async () => {
  if (distillBusy) return;
  if (selectedRun?.status !== 'completed') throw new Error('Choose a completed run first.');
  distillBusy = true; renderDistillButton();
  try {
    const result = await api('memory/distill', 'POST', { runId: selectedRun.id, demo: false });
    activeJob = result.id; showTab('workspace'); await refresh(); $('notice').textContent = 'Review the extraction request below. Proposed memories will appear in Memory after the task completes.';
  } finally { distillBusy = false; renderDistillButton(); }
});
$('memory-layer').onchange = () => populateCategories($('memory-category'), $('memory-layer').value);
$('memory-scope').onchange = () => { const privateMemory = $('memory-scope').value === 'agent'; $('memory-owner-field').hidden = !privateMemory; $('memory-owner').required = privateMemory; };
for (const id of ['memory-filter-agent', 'memory-filter-layer', 'memory-filter-status']) $(id).onchange = action(async () => {
  if (editingMemory) throw new Error('Save or cancel the open memory edit before changing filters.');
  memoryOffset = 0; await refreshMemoryList();
});
$('memory-previous').onclick = action(async () => { if (editingMemory) throw new Error('Save or cancel the open memory edit first.'); memoryOffset = Math.max(0, memoryOffset - MEMORY_PAGE_SIZE); await refreshMemoryList(); });
$('memory-next').onclick = action(async () => { if (editingMemory) throw new Error('Save or cancel the open memory edit first.'); memoryOffset += MEMORY_PAGE_SIZE; await refreshMemoryList(); });
$('memory-refresh').onclick = action(refreshMemoryList);
$('memory-refresh-drafts').onclick = action(refreshDrafts);
$('memory-draft-previous').onclick = action(async () => { if (draftReviewBusy) return; draftOffset = Math.max(0, draftOffset - MEMORY_PAGE_SIZE); await refreshDrafts(); });
$('memory-draft-next').onclick = action(async () => { if (draftReviewBusy) return; draftOffset += MEMORY_PAGE_SIZE; await refreshDrafts(); });
$('memory-search-form').onsubmit = action(async () => {
  const button = $('memory-search-form').querySelector('[type="submit"]'); if (button.disabled) return; button.disabled = true;
  try {
    const result = await api('memory/search', 'POST', { query: $('memory-query').value, agent: $('memory-search-agent').value || undefined, mode: $('memory-search-mode').value });
    $('memory-results').replaceChildren(...result.matches.map(m => memoryRecord(m)));
    $('memory-search-status').textContent = [`${result.matches.length} ${result.matches.length === 1 ? 'memory' : 'memories'} recalled · ${result.mode || $('memory-search-mode').value}`, result.warning, result.truncated ? 'Results were limited to the agent’s context budget.' : '', result.stale ? `${result.stale} memories need reindexing.` : ''].filter(Boolean).join(' ');
  } finally { button.disabled = false; }
});
$('memory-index').onclick = action(async () => {
  $('memory-index').disabled = true;
  try { const result = await api('memory/index', 'POST', {}); $('memory-search-status').textContent = `Indexed ${result.indexed} memories: ${result.embedded} updated, ${result.reused} reused.`; }
  finally { $('memory-index').disabled = false; }
});
async function loadFiles() {
  const result = await api('files?path=' + encodeURIComponent(currentDirectory));
  $('folder-path').textContent = currentDirectory;
  $('file-list').replaceChildren(...result.entries.map(entry => {
    const b = node('button', entry, 'file-entry');
    b.onclick = action(async () => {
      const relative = (currentDirectory === '.' ? '' : currentDirectory + '/') + entry.replace(/\/$/, '');
      if (entry.endsWith('/')) { currentDirectory = relative; await loadFiles(); }
      else {
        if (fileEditor.dirty) throw new Error('Save your changes, or use Reload file to discard them, before opening another file.');
        const opening = fileEditor.open(relative); renderFileEditor();
        try { await opening; } finally { renderFileEditor(); }
      }
    }); return b;
  }));
}
$('parent-folder').onclick = action(async () => { currentDirectory = currentDirectory.includes('/') ? currentDirectory.slice(0, currentDirectory.lastIndexOf('/')) : '.'; await loadFiles(); });
$('save-file').onclick = action(async () => {
  const saving = fileEditor.save(); renderFileEditor();
  try { await saving; $('notice').textContent = fileEditor.dirty ? 'File saved. Newer edits are still unsaved.' : 'File saved.'; }
  finally { renderFileEditor(); }
});
reloadFile.onclick = action(async () => {
  if (fileEditor.dirty && !window.confirm('Discard unsaved changes and reload this file from disk?')) return;
  const opening = fileEditor.open(fileEditor.path, true); renderFileEditor();
  try { await opening; } finally { renderFileEditor(); }
});
$('run-form').onsubmit = action(async () => { const choice = $('agent-select').value; const result = await api('run', 'POST', { ...(choice.startsWith('team:') ? { team: choice.slice(5) } : { agent: choice }), task: $('task').value, demo: $('demo').checked, allowCommands: $('commands').checked }); activeJob = result.id; await refresh(); });
const planButton = node('button', 'Plan this task first →', 'subtle'); planButton.type = 'button'; $('run-form').append(planButton);
planButton.onclick = action(async () => { const result = await api('run', 'POST', { mode: 'plan', task: $('task').value, demo: $('demo').checked }); activeJob = result.id; await refresh(); });
$('cancel').onclick = action(async () => { await api('cancel', 'POST', { id: activeJob }); await refresh(); });
$('save-agent').onclick = action(async () => {
  if (!$('memory-loadout').disabled) for (const input of [$('loadout-items'), $('loadout-chars')]) if (!input.reportValidity()) return;
  await api('agent', 'PUT', JSON.parse($('agent-editor').value)); invalidateRecallPreview(); await refresh(); $('notice').textContent = 'Agent saved.';
});
$('memory-form').onsubmit = action(async () => {
  const button = $('memory-form').querySelector('button'); if (button.disabled) return; button.disabled = true;
  try {
    const scope = $('memory-scope').value;
    await api('memory', 'POST', { text: $('memory-text').value, layer: $('memory-layer').value, category: $('memory-category').value, scope, ...(scope === 'agent' ? { agent: $('memory-owner').value } : {}), expiresAt: expiryValue($('memory-expiry').value) });
    $('memory-text').value = ''; $('memory-expiry').value = ''; await refreshMemories(); $('notice').textContent = 'Memory saved.';
  } finally { button.disabled = false; }
});
const option = (value, label) => { const o = node('option', label); o.value = value; return o; };
const providerPicker = createProviderPicker(api, renderProviders);
function renderProviders() {
  const picker = providerPicker, p = picker.catalog.find(p => p.id === picker.provider);
  renderWhenChanged($('provider-picker'), JSON.stringify(picker.catalog), () => {
    $('provider-picker').replaceChildren(option('', 'Choose a provider / account'), ...picker.catalog.map(p => option(p.id, `${p.label} · ${p.credential === 'available' ? 'key detected' : p.credential === 'placeholder' ? 'example key' : 'key needed'}`)));
  });
  $('provider-picker').value = picker.provider;
  $('provider-picker').disabled = picker.busy;
  renderWhenChanged($('model-picker'), JSON.stringify([picker.provider, p?.credential, picker.loading, picker.models]), () => {
    const placeholder = picker.loading ? 'Loading account models…' : !p ? 'Choose a provider / account first' : p.credential !== 'available' ? 'API key needed' : 'Choose a model';
    $('model-picker').replaceChildren(option('', placeholder), ...picker.models.map(id => option(id, id)), ...(!picker.loading && p?.credential === 'available' ? [option('__custom__', 'Enter a model ID…')] : []));
  });
  $('model-picker').value = picker.model;
  $('model-picker').disabled = picker.busy || picker.loading || p?.credential !== 'available';
  $('custom-model-label').hidden = picker.model !== '__custom__';
  if ($('custom-model').value !== picker.customModel) $('custom-model').value = picker.customModel;
  $('custom-model').disabled = picker.busy;
  renderWhenChanged($('provider-route'), JSON.stringify(picker.agents.map(a => a.name)), () => {
    $('provider-route').replaceChildren(option('default', 'Workspace default'), ...picker.agents.map(a => option(a.name, a.name)));
  });
  $('provider-route').value = picker.route;
  $('provider-route').disabled = picker.busy;
  $('provider-status').textContent = [picker.note, p?.note].filter(Boolean).join(' ');
  $('provider-selection-status').textContent = picker.selectionStatus;
  $('connect-provider').disabled = !picker.canConnect;
  $('refresh-providers').disabled = picker.busy || picker.refreshing || picker.loading;
  $('save-config').disabled = picker.busy || !picker.config || !picker.dirty;
  if ($('config-editor').value !== picker.draft) $('config-editor').value = picker.draft;
  $('config-status').textContent = picker.busy ? 'Saving connections…' : picker.dirty ? 'Unsaved advanced edits. Save these before choosing a model.' : picker.config ? 'Connections saved.' : 'Loading connections…';
}
$('config-editor').addEventListener('input', () => providerPicker.setDraft($('config-editor').value));
$('provider-picker').onchange = action(() => providerPicker.selectProvider($('provider-picker').value));
$('model-picker').onchange = () => { providerPicker.model = $('model-picker').value; renderProviders(); };
$('custom-model').oninput = () => { providerPicker.customModel = $('custom-model').value; renderProviders(); };
$('provider-route').onchange = () => { providerPicker.route = $('provider-route').value; renderProviders(); };
$('refresh-providers').onclick = action(async () => {
  if ($('refresh-providers').disabled) return;
  const provider = providerPicker.provider, model = providerPicker.modelId;
  await providerPicker.refreshProviders();
  if (provider && provider === providerPicker.provider) await providerPicker.selectProvider(provider, model);
});
$('provider-form').onsubmit = action(async () => { if (!$('connect-provider').disabled) await providerPicker.connect(); });
$('save-config').onclick = action(async () => {
  if ($('save-config').disabled) return;
  await providerPicker.saveConfig();
  $('notice').textContent = providerPicker.dirty ? 'Connections saved. Newer edits are still unsaved.' : 'Connections saved.';
});
(async () => { try { await refresh(); await providerPicker.loadConfig(); await providerPicker.refreshProviders(); } catch (e) { $('notice').textContent = e.message; } setInterval(() => refresh().catch(e => { $('notice').textContent = e.message; }), 2000); })();
