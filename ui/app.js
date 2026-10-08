import { createFileEditor } from './file-editor.js';
const $ = id => document.getElementById(id);
const initialToken = location.hash.slice(1);
if (initialToken) { sessionStorage.setItem('nexus-token', initialToken); history.replaceState(null, '', '/'); }
const token = sessionStorage.getItem('nexus-token') || '';
let state, activeJob;
const skillAudits = new Map();
const memoryPanel = $('memory-form').parentElement;
const indexButton = nodeButton();
function nodeButton() { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Rebuild semantic index'; return b; }
const searchInput = document.createElement('input'); searchInput.placeholder = 'Search project memory by meaning'; searchInput.setAttribute('aria-label', 'Semantic memory query');
const searchButton = document.createElement('button'); searchButton.textContent = 'Search by meaning'; searchButton.type = 'button';
const searchResults = document.createElement('pre'); searchResults.setAttribute('aria-live', 'polite');
const semanticControls = document.createElement('div'); semanticControls.className = 'semantic-controls';
semanticControls.append(indexButton, searchInput, searchButton);
memoryPanel.append(semanticControls, searchResults);
let currentDirectory = '.';
const fileEditor = createFileEditor(api);
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
window.addEventListener('beforeunload', event => { if (fileEditor.dirty) { event.preventDefault(); event.returnValue = ''; } });
renderFileEditor();
async function api(path, method = 'GET', data) {
  const response = await fetch('/api/' + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
const node = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const action = fn => async event => { event?.preventDefault(); try { $('notice').textContent = ''; await fn(); } catch (e) { $('notice').textContent = e.message; } };
indexButton.onclick = action(async () => { indexButton.disabled = true; try { const result = await api('memory/index', 'POST', {}); searchResults.textContent = `Indexed ${result.indexed} notes with ${result.model}.`; } finally { indexButton.disabled = false; } });
searchButton.onclick = action(async () => { const result = await api('memory/search', 'POST', { query: searchInput.value }); searchResults.textContent = result.matches.map(m => m.text).join('\n\n') || 'No current indexed project notes.'; if (result.stale) searchResults.textContent += `\n${result.stale} notes need reindexing.`; });
const titles = { workspace: 'Tasks', files: 'Project files', agents: 'Agents', history: 'Run library', memory: 'Memory', settings: 'Connections' };
const filesButton = node('button', 'Project files'); filesButton.dataset.tab = 'files'; document.querySelector('nav').append(filesButton);
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => {
  for (const section of document.querySelectorAll('.tab')) section.hidden = section.id !== button.dataset.tab;
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b === button);
  $('page-title').textContent = titles[button.dataset.tab];
  if (button.dataset.tab === 'files') action(() => loadFiles())();
};
function render() {
  $('project-path').textContent = state.root;
  $('stats').replaceChildren(...[[state.agents.length, 'AVAILABLE AGENTS'], [state.runs.length, 'RUN RECORDS'], [state.skills.length, 'INSTALLED SKILLS']].map(([count, label]) => { const n = node('div', undefined, 'stat'); n.append(node('strong', count), node('span', label)); return n; }));
  const selected = $('agent-select').value;
  $('agent-select').replaceChildren(...state.agents.map(a => { const o = node('option', a.name); o.value = a.name; return o; }), ...state.teams.map(t => { const name = t.slice(0, -5), o = node('option', 'Team · ' + name); o.value = 'team:' + name; return o; }));
  if ([...$('agent-select').options].some(o => o.value === selected)) $('agent-select').value = selected;
  $('agent-cards').replaceChildren(...state.agents.map(a => { const card = node('button', undefined, 'agent-card'); card.append(node('h3', a.name), node('p', a.instructions.slice(0, 125)), node('small', Object.entries(a.permissions).filter(([,v]) => v).map(([k]) => k).join(' · '))); card.onclick = () => { $('agent-editor').value = JSON.stringify(a, null, 2); }; return card; }));
  $('history-list').replaceChildren(...state.runs.map(r => { const row = node('div', undefined, 'row'), b = node('button', r.agent + ' · ' + r.status); b.onclick = action(async () => { const run = await api('runs/' + r.id); $('transcript').textContent = JSON.stringify(run, null, 2); }); row.append(b, node('small', new Date(r.started).toLocaleString())); return row; }));
  $('memories').replaceChildren(...state.memories.map(m => node('p', m.text, 'row')));
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
  if (job) { activeJob = job.id; $('activity').textContent = job.events.map(e => e.type === 'text' ? e.text : e.type === 'tool-result' ? `${e.name}: ${e.content}` : `[${e.step || ''} ${e.type}] ${e.name || e.status || ''}`).join('\n\n') + (job.error ? '\nError: ' + job.error : '') + (job.plan ? '\nPlan saved. Select its team name to run it after review.\n' + JSON.stringify(job.plan, null, 2) : ''); }
  $('cancel').disabled = !job || job.status !== 'running';
  const lastEvent = job?.events.at(-1);
  if (job?.status === 'running' && lastEvent?.type === 'model-request') {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(lastEvent.at)) / 1000));
    $('activity').textContent += `\n\nWaiting for ${lastEvent.model} · ${seconds}s elapsed. You can cancel this task.`;
  }
  $('run-form').querySelector('[type="submit"]').disabled = state.jobs.some(j => j.status === 'running');
  $('approvals').replaceChildren(...state.approvals.map(a => { const panel = node('article', undefined, 'panel approval'); panel.append(node('h3', 'Your approval is needed'), node('pre', JSON.stringify(a.request, null, 2))); for (const [label, allow] of [['Approve', true], ['Decline', false]]) { const b = node('button', label); b.onclick = action(async () => { await api('approval', 'POST', { id: a.id, allow }); await refresh(); }); panel.append(b); } return panel; }));
}
async function refresh() { state = await api('state'); render(); }
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
$('save-agent').onclick = action(async () => { await api('agent', 'PUT', JSON.parse($('agent-editor').value)); await refresh(); $('notice').textContent = 'Agent saved.'; });
$('memory-form').onsubmit = action(async () => { await api('memory', 'POST', { text: $('memory-text').value }); $('memory-text').value = ''; await refresh(); });
$('save-config').onclick = action(async () => { await api('config', 'PUT', JSON.parse($('config-editor').value)); $('notice').textContent = 'Connections saved.'; });
(async () => { try { await refresh(); $('config-editor').value = JSON.stringify(await api('config'), null, 2); } catch (e) { $('notice').textContent = e.message; } setInterval(() => refresh().catch(e => { $('notice').textContent = e.message; }), 2000); })();
