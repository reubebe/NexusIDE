import { validateVisualSpec, visualRows, visualCsv } from './visual-spec.js';
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const svgNode = (tag, attributes = {}, text) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attributes)) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; return n; };
const colors = ['#204e40', '#864b1f', '#314f8f', '#893d72', '#62611b'];
const compact = n => Number(n.toPrecision(5)).toLocaleString();

// Native controls for existing, trusted renderers. Expansion moves the same
// view into a modal instead of cloning markup or creating a second GPU canvas.
export function createVisualViewport(output) {
  const doc = output.ownerDocument;
  const element = (tag, text, cls) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const shell = element('div', undefined, 'visual-view-shell');
  const controls = element('div', undefined, 'visual-view-actions'); controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', 'Visualization view controls');
  const button = (text, id) => { const b = element('button', text); b.type = 'button'; b.id = id; controls.append(b); return b; };
  const out = button('Zoom out', 'visual-zoom-out'), percent = element('output', '100%'); percent.setAttribute('aria-label', 'Visualization zoom'); percent.setAttribute('aria-live', 'polite'); controls.append(percent);
  const inside = button('Zoom in', 'visual-zoom-in'), fit = button('Fit view', 'visual-fit'), expand = button('Expand view', 'visual-expand');
  const dialog = element('dialog', undefined, 'visual-fullscreen'), heading = element('h2'), close = element('button', 'Close expanded view'); close.type = 'button';
  heading.id = 'visual-expanded-title'; dialog.setAttribute('aria-labelledby', heading.id);
  const header = element('div', undefined, 'visual-view-heading'); header.append(heading, close); dialog.append(header);
  const home = output.parentNode;
  home.insertBefore(shell, output); shell.append(controls, output); doc.body.append(dialog);
  output.classList.add('visual-view-output'); output.tabIndex = 0; output.setAttribute('role', 'region'); output.setAttribute('aria-label', 'Visualization. Scroll to explore when zoomed.');
  let scale = 1, twoDimensional = true, title = 'Visualization', returnFocus;
  function setScale(next) {
    if (!twoDimensional || !Number.isFinite(next)) return;
    scale = Math.max(0.25, Math.min(5, next));
    output.style.setProperty('--visual-view-width', `${scale * 100}%`);
    percent.textContent = `${Math.round(scale * 100)}%`; out.disabled = scale <= 0.25; inside.disabled = scale >= 5;
  }
  function reset() { setScale(1); output.scrollLeft = 0; output.scrollTop = 0; }
  function restore(focus = true) {
    if (controls.parentNode !== shell) shell.append(controls, output);
    if (focus && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = undefined;
  }
  function dismiss(focus = true) { if (dialog.open) dialog.close(); restore(focus); }
  function open() {
    if (typeof dialog.showModal !== 'function' || dialog.open) return;
    returnFocus = doc.activeElement; heading.textContent = title;
    dialog.append(controls, output);
    try { dialog.showModal(); close.focus(); }
    catch (error) { restore(); throw error; }
  }
  dialog.addEventListener('close', () => restore());
  close.onclick = () => dismiss(); expand.onclick = open;
  out.onclick = () => setScale(scale / 1.25); inside.onclick = () => setScale(scale * 1.25); fit.onclick = reset;
  const wheel = event => {
    if (!twoDimensional || (!event.ctrlKey && !event.metaKey) || !Number.isFinite(event.deltaY) || !event.deltaY) return;
    event.preventDefault(); setScale(scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  };
  output.addEventListener('wheel', wheel, { passive: false });
  expand.hidden = typeof dialog.showModal !== 'function';
  return {
    prepare(artifact) {
      dismiss(false); title = artifact.title || 'Visualization'; twoDimensional = artifact.kind !== 'spatial';
      for (const control of [out, percent, inside, fit]) control.hidden = !twoDimensional;
      output.classList.toggle('visual-view-two-dimensional', twoDimensional);
      if (twoDimensional) reset(); else output.style.removeProperty('--visual-view-width');
    },
    close: () => dismiss(false),
    dispose() { dismiss(false); output.removeEventListener('wheel', wheel); home.insertBefore(output, shell); shell.remove(); dialog.remove(); },
  };
}

export function chartExtent(values, { zero = false } = {}) {
  const finite = values.filter(Number.isFinite); let min = finite.length ? Math.min(...finite) : 0, max = finite.length ? Math.max(...finite) : 1;
  if (zero) { min = Math.min(min, 0); max = Math.max(max, 0); }
  if (min === max) { const pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad; }
  return [min, max];
}
export function drawVisual(spec, filter = '') {
  const svg = svgNode('svg', { viewBox: '0 0 900 500', role: 'img', 'aria-label': spec.title, xmlns: 'http://www.w3.org/2000/svg' });
  svg.append(svgNode('rect', { width: 900, height: 500, fill: '#f5f2eb' }), svgNode('title', {}, spec.title));
  const label = (x, y, text, attrs = {}) => svg.append(svgNode('text', { x, y, fill: '#172e27', 'font-size': 14, 'font-family': 'sans-serif', ...attrs }, text));
  if (spec.kind === 'graph') {
    const nodes = spec.nodes.filter(n => !filter || n.label.toLowerCase().includes(filter.toLowerCase())), position = new Map();
    nodes.forEach((n, i) => { const angle = i / nodes.length * Math.PI * 2; position.set(n.id, [450 + Math.cos(angle) * 290, 250 + Math.sin(angle) * 190]); });
    const defs = svgNode('defs'), marker = svgNode('marker', { id: 'visual-arrow', markerWidth: 8, markerHeight: 8, refX: 18, refY: 3, orient: 'auto', markerUnits: 'strokeWidth' }); marker.append(svgNode('path', { d: 'M0,0 L0,6 L7,3 z', fill: '#68796e' })); defs.append(marker); svg.append(defs);
    for (const e of spec.edges) {
      if (!position.has(e.source) || !position.has(e.target)) continue;
      const [x1, y1] = position.get(e.source), [x2, y2] = position.get(e.target);
      const line = svgNode('line', { x1, y1, x2, y2, stroke: '#68796e', 'stroke-width': 1.5, ...(e.relation !== 'extracted' ? { 'stroke-dasharray': '5 4' } : {}), 'marker-end': 'url(#visual-arrow)' });
      line.append(svgNode('title', {}, `${e.source} → ${e.target}: ${e.label} (${e.relation}${e.confidence !== undefined ? ', confidence ' + e.confidence : ''})`)); svg.append(line);
    }
    for (const n of nodes) {
      const [cx, cy] = position.get(n.id), circle = svgNode('circle', { cx, cy, r: 8, fill: colors[0], tabindex: 0, role: 'button', 'aria-label': `${n.label}. Highlight connected edges.` });
      const activate = () => { for (const line of svg.querySelectorAll('line')) line.setAttribute('opacity', line.getAttribute('x1') === String(cx) && line.getAttribute('y1') === String(cy) || line.getAttribute('x2') === String(cx) && line.getAttribute('y2') === String(cy) ? 1 : 0.15); };
      circle.onclick = activate; circle.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); activate(); } }; circle.append(svgNode('title', {}, n.label)); svg.append(circle); label(cx, cy - 14, n.label.length > 28 ? n.label.slice(0, 25) + '…' : n.label, { 'text-anchor': 'middle', 'font-size': 12 });
    }
    return svg;
  }
  const data = spec.data.filter(d => !filter || [d.label, d.series].some(v => v?.toLowerCase().includes(filter.toLowerCase())));
  const left = 90, top = 35, width = 770, height = 380;
  const timeline = spec.kind === 'timeline', bar = spec.kind === 'bar';
  const [xmin, xmax] = chartExtent(timeline ? data.flatMap(d => [d.start, d.end]) : data.map(d => d.x), { zero: timeline });
  const [ymin, ymax] = chartExtent(data.map(d => d.y), { zero: bar });
  const x = n => left + (n - xmin) / (xmax - xmin) * width, y = n => top + height - (n - ymin) / (ymax - ymin) * height;
  svg.append(svgNode('path', { d: `M${left},${top} V${top + height} H${left + width}`, stroke: '#68796e', fill: 'none' }));
  for (let i = 0; i <= 5; i++) {
    if (!bar) { const value = xmin + (xmax - xmin) * i / 5; label(x(value), 440, compact(value), { 'text-anchor': 'middle' }); }
    if (!timeline) { const value = ymin + (ymax - ymin) * i / 5; label(left - 10, y(value) + 5, compact(value), { 'text-anchor': 'end' }); svg.append(svgNode('line', { x1: left, x2: left + width, y1: y(value), y2: y(value), stroke: '#d5dcd4', 'stroke-width': 0.6 })); }
  }
  label(left + width / 2, 478, `${spec.xLabel} (${spec.xUnit})`, { 'text-anchor': 'middle' });
  if (!timeline) label(20, 240, `${spec.yLabel} (${spec.yUnit})`, { transform: 'rotate(-90 20 240)', 'text-anchor': 'middle' });
  const groups = [...new Set(data.map(d => d.series || 'Data'))];
  const color = d => colors[groups.indexOf(d.series || 'Data') % colors.length];
  if (spec.kind === 'line') for (const group of groups) {
    let pen = false, d = '';
    for (const row of data.filter(row => (row.series || 'Data') === group)) { if (row.y === null) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${x(row.x)},${y(row.y)} `; pen = true; }
    svg.append(svgNode('path', { d, fill: 'none', stroke: colors[groups.indexOf(group) % colors.length], 'stroke-width': 2 }));
  }
  data.forEach((row, i) => {
    let shape;
    if (timeline) {
      const rowHeight = Math.min(32, height / Math.max(data.length, 1)), cy = top + i * rowHeight;
      shape = svgNode('rect', { x: x(row.start), y: cy, width: Math.max(2, x(row.end) - x(row.start)), height: Math.max(1, rowHeight - 4), fill: color(row) });
      if (data.length <= 15) label(x(row.start) + 4, cy + 15, row.label.slice(0, 28), { fill: '#ffffff', 'font-size': 12 });
    } else if (bar) {
      const slot = width / Math.max(data.length, 1);
      if (data.length <= 15) label(left + slot * (i + 0.5), 440, row.label.slice(0, 14), { 'text-anchor': 'middle', 'font-size': 12 });
      if (row.y === null) { label(left + slot * (i + 0.5), y(0) - 5, 'N/A', { 'text-anchor': 'middle', 'font-size': 11 }); return; }
      shape = svgNode('rect', { x: left + slot * i + slot * 0.1, y: Math.min(y(row.y), y(0)), width: Math.max(0.2, slot * 0.8), height: Math.max(1, Math.abs(y(row.y) - y(0))), fill: color(row) });
    } else if (row.y !== null) shape = svgNode('circle', { cx: x(row.x), cy: y(row.y), r: 4, fill: color(row) });
    if (shape) { const info = JSON.stringify(row); shape.append(svgNode('title', {}, info)); shape.setAttribute('tabindex', '0'); shape.setAttribute('aria-label', info); svg.append(shape); }
  });
  if (!data.length) label(450, 200, 'No matching data', { 'text-anchor': 'middle' });
  if (data.some(d => d.y === null)) label(860, 22, 'N/A: unavailable value; line gaps are intentional', { 'text-anchor': 'end', 'font-size': 12 });
  return svg;
}

export const exampleVisual = { version: 1, kind: 'bar', title: 'Synthetic example', sources: [{ label: 'Synthetic demonstration, not measured results' }], xLabel: 'Category', xUnit: 'category', yLabel: 'Value', yUnit: 'count', data: [{ label: 'A', y: 8 }, { label: 'B', y: 3 }, { label: 'Unavailable', y: null }] };
export function createVisualizations({ api }) {
  const $ = id => document.getElementById(id);
  const viewport = createVisualViewport($('visual-output'));
  let request = 0, selected, spatial, imageUrl, busy = false, profiles = [], configuration;
  const status = text => { $('visual-status').textContent = text; };
  const run = action => async event => { event?.preventDefault(); if (busy) return; busy = true; try { await action(); } catch (e) { status(e.message); } finally { busy = false; } };
  function cleanup() { viewport.close(); spatial?.dispose(); spatial = undefined; if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = undefined; }
  function download(blob, name) { const url = URL.createObjectURL(blob), a = node('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function bytesBlob(artifact) { return new Blob([Uint8Array.from(atob(artifact.data), c => c.charCodeAt(0))], { type: artifact.mimeType }); }
  async function render(artifact, generation) {
    cleanup(); $('visual-output').replaceChildren(); $('visual-data').replaceChildren(); $('visual-sources').replaceChildren();
    viewport.prepare(artifact);
    $('visual-title').textContent = artifact.title;
    $('visual-provenance').textContent = `Saved ${new Date(artifact.created).toLocaleString()} · ${artifact.source}${artifact.runId ? ' · Run ' + artifact.runId : ''}`;
    $('visual-description').textContent = artifact.spec?.description || '';
    $('visual-filter').disabled = artifact.kind === 'image' || artifact.kind === 'spatial';
    $('visual-csv').disabled = artifact.kind === 'image'; $('visual-svg').disabled = ['image', 'spatial'].includes(artifact.kind);
    $('visual-detail').hidden = false;
    if (artifact.kind === 'image') { imageUrl = URL.createObjectURL(bytesBlob(artifact)); const img = node('img'); img.src = imageUrl; img.alt = artifact.title; img.onerror = () => status('The image header passed validation, but this browser could not decode the pixels.'); $('visual-output').append(img); }
    else {
      const spec = validateVisualSpec(artifact.spec);
      if (spec.kind === 'spatial') {
        $('visual-description').textContent += ` Axes: ${spec.xLabel} (${spec.xUnit}), ${spec.yLabel} (${spec.yUnit}), Z (${spec.zUnit}). Display centered and uniformly scaled to fit; exact coordinates remain in the table.`;
        try { const { mountSpatialView } = await import('./spatial-view.js'); if (generation !== request) return; spatial = mountSpatialView($('visual-output'), spec); }
        catch (e) { status('3D rendering unavailable. Exact coordinates remain in the data table. ' + e.message); }
      } else $('visual-output').append(drawVisual(spec, $('visual-filter').value));
      for (const source of spec.sources) { const li = node('li', source.label + (source.path ? ` · ${source.path}` : '') + (source.at ? ` · ${source.at}` : '')); if (source.url) { const a = node('a', 'Open source'); a.href = source.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(' ', a); } $('visual-sources').append(li); }
      const rows = visualRows(spec), query = $('visual-filter').value.toLowerCase();
      const visible = rows.filter(row => !query || JSON.stringify(row).toLowerCase().includes(query));
      const columns = [...new Set(rows.flatMap(Object.keys))];
      const table = node('table'), caption = node('caption', `${visible.length} of ${rows.length} rows. Exports contain the complete original data.`), head = node('tr');
      for (const c of columns) { const th = node('th', c); th.scope = 'col'; head.append(th); } const thead = node('thead'); thead.append(head); table.append(caption, thead); const body = node('tbody');
      for (const row of visible) { const tr = node('tr'); for (const c of columns) tr.append(node('td', row[c] == null ? 'Unavailable' : String(row[c]))); body.append(tr); } table.append(body); $('visual-data').append(table);
      if (spec.kind === 'graph') { const p = node('p', 'Arrows indicate source → target. Dashed edges are inferred or ambiguous. Confidence is a reported value, not verified certainty.'); $('visual-data').prepend(p); const list = node('ul'); for (const n of spec.nodes) list.append(node('li', `${n.id}: ${n.label}${n.source !== undefined ? ' · ' + spec.sources[n.source].label : ''}`)); $('visual-data').append(list); }
    }
  }
  async function open(id) { const generation = ++request; status('Loading visualization…'); const artifact = await api(`artifacts/${encodeURIComponent(id)}`); if (generation !== request) return; selected = artifact; $('visual-filter').value = ''; $('visual-review-consent').checked = false; $('visual-review-result').textContent = ''; status(''); await render(artifact, generation); }
  async function load() {
    const { artifacts } = await api('artifacts');
    $('visual-list').replaceChildren(...artifacts.map(a => { const b = node('button', `${a.title} · ${a.kind}`, 'file-entry'); b.type = 'button'; b.onclick = run(() => open(a.id)); return b; }));
    $('visual-empty').hidden = artifacts.length > 0;
    profiles = (await api('visual-providers')).profiles;
    const profile = $('visual-review-provider').value;
    $('visual-review-provider').replaceChildren(...profiles.map(p => { const option = node('option', `${p.name} · ${p.model}`); option.value = p.name; return option; }));
    if (profiles.some(p => p.name === profile)) $('visual-review-provider').value = profile;
    updateEndpoint();
    const { tools } = await api('visual-tools');
    $('visual-tools-status').replaceChildren(...tools.map(t => node('p', `${t.title}: ${t.available ? 'Configured' : 'Unavailable'}. ${t.reason}`, 'helper')));
  }
  function updateEndpoint() { const p = profiles.find(p => p.name === $('visual-review-provider').value); $('visual-review-endpoint').textContent = p ? `Image destination: ${p.endpoint}` : 'No vision profile configured. Add vision: true to a supported model profile in Connections.'; $('visual-review-consent').checked = false; }
  $('visual-review-provider').onchange = updateEndpoint;
  $('visual-review-form').onsubmit = run(async () => {
    if (selected?.kind !== 'image') throw new Error('Select an imported image first.');
    const id = selected.id; status('Waiting for visual review…');
    const result = await api('visual-review', 'POST', { id, provider: $('visual-review-provider').value, question: $('visual-review-question').value, approved: $('visual-review-consent').checked });
    $('visual-review-result').textContent = `${result.answer}\n\n${result.limitation}\nReview ${result.id} · Artifact ${id}`; $('visual-review-consent').checked = false; status('Visual review saved.');
  });
  const clearConfiguration = () => { configuration = undefined; $('visual-tool-configure').disabled = true; };
  $('visual-tool-name').onchange = clearConfiguration; $('visual-tool-options').oninput = clearConfiguration;
  $('visual-tools-form').onsubmit = run(async () => { clearConfiguration(); const text = $('visual-tool-options').value, input = { name: $('visual-tool-name').value, options: JSON.parse(text) }; const preview = await api('visual-tools', 'POST', input); if (text !== $('visual-tool-options').value || input.name !== $('visual-tool-name').value) throw new Error('Options changed during preview. Preview the updated configuration.'); configuration = input; $('visual-tool-preview').textContent = JSON.stringify(preview, null, 2); $('visual-tool-configure').disabled = false; });
  $('visual-tool-configure').onclick = run(async () => { if (!configuration || !window.confirm('Apply the displayed scoped connection? This registers tools and an agent; it does not install dependencies.')) return; const result = await api('visual-tools', 'POST', { ...configuration, action: 'configure', approved: true }); $('visual-tool-preview').textContent = JSON.stringify(result, null, 2); clearConfiguration(); await load(); status('Optional tool connection configured.'); });
  $('visual-refresh').onclick = run(load);
  $('visual-example').onclick = () => { $('visual-spec').value = JSON.stringify(exampleVisual, null, 2); status('Synthetic template loaded. Edit the title, sources, units and data before saving.'); };
  $('visual-create').onsubmit = run(async () => { const spec = validateVisualSpec(JSON.parse($('visual-spec').value)); const saved = await api('artifacts', 'POST', { spec }); await load(); await open(saved.id); status('Visualization saved.'); });
  $('visual-import').onsubmit = run(async () => { status('Importing project artifact…'); const saved = await api('artifacts', 'POST', { path: $('visual-path').value }); await load(); await open(saved.id); });
  $('visual-filter').oninput = () => { if (selected) render(selected, request).catch(e => status(e.message)); };
  $('visual-json').onclick = run(async () => { if (selected) download(new Blob([JSON.stringify(selected.spec || { ...selected, data: undefined }, null, 2)], { type: 'application/json' }), `${selected.id}.json`); });
  $('visual-csv').onclick = run(async () => { if (selected?.spec) download(new Blob([visualCsv(selected.spec)], { type: 'text/csv' }), `${selected.id}.csv`); });
  $('visual-svg').onclick = run(async () => { const svg = $('visual-output').querySelector('svg'); if (svg) download(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }), `${selected.id}.svg`); });
  $('visual-png').onclick = run(async () => {
    if (!selected) return;
    if (selected.kind === 'image') return download(bytesBlob(selected), `${selected.id}.${selected.mimeType.split('/')[1]}`);
    let canvas = spatial?.canvas;
    if (!canvas) {
      const svg = $('visual-output').querySelector('svg'); if (!svg) throw new Error('No rendered image is available.');
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
      try { const img = new Image(); await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Could not rasterize the chart. Export SVG instead.')); img.src = url; }); canvas = node('canvas'); canvas.width = 1800; canvas.height = 1000; canvas.getContext('2d').drawImage(img, 0, 0, 1800, 1000); } finally { URL.revokeObjectURL(url); }
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); if (!blob) throw new Error('Image export failed.'); download(blob, `${selected.id}.png`);
  });
  $('visual-delete').onclick = run(async () => { if (!selected || !window.confirm('Delete this saved visualization? Original project files are kept.')) return; await api(`artifacts/${selected.id}`, 'DELETE'); ++request; selected = undefined; cleanup(); $('visual-detail').hidden = true; await load(); status('Visualization deleted.'); });
  return { open, load: () => load().catch(e => status(e.message)), suspend() { ++request; cleanup(); }, resume() { if (selected) render(selected, ++request).catch(e => status(e.message)); } };
}
