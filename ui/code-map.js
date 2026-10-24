// All graph strings remain text. No remote HTML, inline handlers, or source execution.
export function createCodeMap({ api, openSource }) {
  const $ = name => document.getElementById('code-map-' + name);
  const element = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  let connection, busy = false, loaded = false;
  const clear = () => { $('results').replaceChildren(); $('neighbors').replaceChildren(); $('neighbors').hidden = true; $('freshness').textContent = ''; };
  const controls = () => {
    const consent = connection?.available && $('approved').checked;
    $('connect').disabled = busy || !consent;
    $('project').disabled = busy || !consent || !$('project').value;
    $('query').disabled = busy || !consent || !$('project').value;
    $('search').disabled = busy || !consent || !$('project').value;
    $('approved').disabled = busy || !connection?.available;
    $('refresh').disabled = busy;
  };
  const run = fn => async event => { event?.preventDefault(); if (busy) return; busy = true; controls(); try { await fn(); } catch (e) { $('status').textContent = e.message; } finally { busy = false; controls(); } };
  const query = data => api('code-map', 'POST', { ...data, approved: $('approved').checked, digest: connection?.digest });
  const freshness = result => { $('freshness').textContent = `Scope: ${result.project.scope} · Index recorded: ${result.freshness.indexedAt} · ${result.freshness.statuses.join(', ') || 'Coverage unknown'}. ${result.freshness.warning}`; };
  function symbolCard(symbol, selected = false) {
    const card = element('div', undefined, 'code-map-symbol' + (selected ? ' selected' : ''));
    const label = element('button', symbol.name, 'code-map-symbol-name text-button'); label.type = 'button';
    label.title = symbol.qualifiedName;
    label.onclick = run(() => neighbors(symbol.qualifiedName));
    card.append(label, element('small', symbol.qualifiedName));
    if (symbol.strategy) card.append(element('small', `${symbol.strategy}${symbol.confidence !== null ? ` · confidence ${symbol.confidence}` : ''}${symbol.test ? ' · test' : ''}`));
    if (symbol.path) {
      const source = element('button', `${symbol.path}${symbol.lines ? ':' + symbol.lines : ''} ↗`, 'text-button code-map-source'); source.type = 'button';
      source.onclick = run(() => openSource(symbol.path, symbol.lines)); card.append(source);
    }
    return card;
  }
  async function neighbors(symbol) {
    $('status').textContent = 'Reading direct relationships…';
    const result = await query({ operation: 'neighbors', project: $('project').value, symbol });
    freshness(result);
    const grid = element('div', undefined, 'code-map-grid');
    for (const [heading, symbols, selected] of [['Callers →', result.callers, false], ['Selected function →', [result.selected], true], ['Callees', result.callees, false]]) {
      const column = element('section', undefined, 'code-map-column'); column.append(element('h2', heading));
      if (!symbols.length) column.append(element('p', 'No direct relationships returned.', 'helper'));
      for (const value of symbols) column.append(symbolCard(value, selected));
      grid.append(column);
    }
    $('neighbors').replaceChildren(grid); $('neighbors').hidden = false;
    $('status').textContent = `${result.callers.length} callers · ${result.callees.length} callees shown.${result.truncated ? ' Results limited; additional relationships were omitted.' : ''} Select a related function to continue. Source line locations come from the index.`;
    $('neighbors').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  const load = run(async () => {
    loaded = true; connection = undefined; $('approved').checked = false; clear();
    $('project').replaceChildren(element('option', 'Load indexes first'));
    $('project').firstChild.value = '';
    connection = await api('code-map');
    $('connection').textContent = connection.available ? `Local codebase-memory-mcp · scope ${connection.scope}. ${connection.note}` : connection.reason;
    $('command').hidden = !connection.available;
    $('command').textContent = connection.available ? connection.command : '';
    $('status').textContent = connection.available ? 'Review the connection above, then allow queries and load its indexes.' : 'Set up the optional backend in Connections to use this view.';
  });
  $('refresh').onclick = load;
  $('approved').onchange = () => { if (!$('approved').checked) clear(); controls(); };
  $('connect').onclick = run(async () => {
    clear(); $('status').textContent = 'Loading indexes inside this workspace…';
    const result = await query({ operation: 'projects' });
    const options = result.projects.map(p => { const o = element('option', `${p.name} · ${p.scope}`); o.value = p.name; return o; });
    if (!options.length) { const option = element('option', 'No index in the approved scope'); option.value = ''; options.push(option); }
    $('project').replaceChildren(...options);
    $('status').textContent = result.projects.length ? `${result.projects.length} indexes available.${result.truncated ? ' Project list is limited to the first 50 entries.' : ''} Search for a function to begin.` : 'No eligible index was found. Index your source folder with the reviewed backend first.';
  });
  $('project').onchange = () => { clear(); controls(); };
  $('form').onsubmit = run(async () => {
    clear(); $('status').textContent = 'Searching the code index…';
    const result = await query({ operation: 'search', project: $('project').value, query: $('query').value });
    freshness(result);
    $('results').replaceChildren(...result.symbols.map(symbol => symbolCard(symbol)));
    $('status').textContent = `${result.symbols.length} symbols shown.${result.truncated ? ' Results limited; narrow your query.' : ''} Select a symbol to see its relationships.`;
  });
  return { load: () => { if (!loaded) return load(); } };
}
