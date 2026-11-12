export function commandMatches(commands, query) {
  const words = query.trim().toLowerCase().split(/\s+/);
  return commands.filter(c => words.every(word => `${c.label} ${c.id}`.toLowerCase().includes(word))).slice(0, 30);
}

export function createWorkbench({ showTab, titles }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'command-palette'; dialog.setAttribute('aria-labelledby', 'command-title');
  const heading = document.createElement('h2'); heading.id = 'command-title'; heading.textContent = 'Go to…';
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search workspaces';
  search.setAttribute('aria-label', 'Search commands'); search.setAttribute('aria-controls', 'command-results');
  const results = document.createElement('div'); results.id = 'command-results';
  const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => dialog.close();
  const commands = Object.entries(titles).map(([id, label]) => ({ id, label }));
  function render() {
    results.replaceChildren();
    for (const command of commandMatches(commands, search.value)) {
      const button = document.createElement('button'); button.textContent = command.label;
      button.onclick = () => { dialog.close(); showTab(command.id); document.getElementById(command.id)?.querySelector('h1')?.focus(); };
      results.append(button);
    }
    if (!results.children.length) { const p = document.createElement('p'); p.textContent = 'No matching workspace.'; results.append(p); }
  }
  search.oninput = render;
  dialog.addEventListener('keydown', event => {
    const buttons = [...results.querySelectorAll('button')], current = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); buttons[Math.min(current + 1, buttons.length - 1)]?.focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); if (current <= 0) search.focus(); else buttons[current - 1]?.focus(); }
    if (event.key === 'Enter' && document.activeElement === search) { event.preventDefault(); buttons[0]?.click(); }
  });
  dialog.append(heading, search, results, close); document.body.append(dialog);
  const open = () => { if (dialog.open) return; search.value = ''; render(); dialog.showModal(); search.focus(); };
  const trigger = document.createElement('button'); trigger.textContent = 'Go to…'; trigger.title = 'Search workspaces (⌘K / Ctrl+K)'; trigger.onclick = open;
  document.querySelector('.breadcrumb').append(trigger);
  document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); open(); } });
  for (const h of document.querySelectorAll('.tab h1')) h.tabIndex = -1;
  // A project-scoped width preference changes layout only, never grants or data.
  const key = 'nexus-pane-width:' + location.port;
  const control = document.createElement('input'); control.type = 'range'; control.min = '25'; control.max = '65'; control.value = '35';
  const label = document.createElement('label'); label.className = 'pane-width-control'; label.textContent = 'File list width'; label.append(control);
  const files = document.getElementById('files');
  const layout = files.querySelector('.split-layout');
  if (layout) {
    files.querySelector('header').after(label);
    try { const value = Number(localStorage.getItem(key)); if (value >= 25 && value <= 65) control.value = String(value); } catch {}
    const resize = () => { layout.style.setProperty('--file-pane-width', control.value + '%'); try { localStorage.setItem(key, control.value); } catch {} };
    control.addEventListener('input', resize); resize();
  }
  return { open };
}
