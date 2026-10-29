export function createCliAccounts({ api, terminal, showTerminal, notice }) {
  const $ = id => document.getElementById(id);
  let catalog = [], profiles = [], busy = false;
  function providerChanged() {
    const provider = catalog.find(p => p.id === $('cli-provider').value);
    $('cli-mode').replaceChildren(...(provider?.modes || []).map(mode => new Option(mode === 'api' ? 'Muse API key' : 'Official CLI sign-in / subscription', mode)));
    $('cli-provider-note').textContent = provider?.note || '';
    modeChanged();
  }
  function modeChanged() { $('cli-key-label').hidden = $('cli-mode').value !== 'api'; }
  async function refresh() {
    const data = await api('cli-accounts'); catalog = data.catalog; profiles = data.profiles;
    if (!$('cli-provider').options.length) { $('cli-provider').replaceChildren(...catalog.map(p => new Option(p.label, p.id))); providerChanged(); }
    const selected = $('cli-profile').value;
    $('cli-profile').replaceChildren(new Option('Choose a saved CLI account', ''), ...profiles.map(p => new Option(`${p.label} · ${catalog.find(c => c.id === p.provider)?.label} · ${p.mode === 'api' ? p.keyEnv : 'CLI sign-in'}${p.executableAvailable ? '' : ' · executable missing'}`, p.id)));
    if (profiles.some(p => p.id === selected)) $('cli-profile').value = selected;
    selectionChanged();
  }
  function selectionChanged() {
    const p = profiles.find(p => p.id === $('cli-profile').value);
    $('cli-launch').disabled = busy || !p || !p.executableAvailable || p.credential === 'missing' || p.credential === 'placeholder';
    $('cli-remove').disabled = busy || !p;
  }
  async function action(fn) {
    if (busy) return; busy = true; $('cli-save').disabled = true; selectionChanged();
    try { await fn(); } catch (error) { notice(error.message); }
    finally { busy = false; $('cli-save').disabled = false; selectionChanged(); }
  }
  $('cli-provider').onchange = providerChanged; $('cli-mode').onchange = modeChanged; $('cli-profile').onchange = selectionChanged;
  $('cli-account-form').onsubmit = event => { event.preventDefault(); action(async () => {
    const profile = await api('cli-accounts', 'POST', { provider: $('cli-provider').value, mode: $('cli-mode').value, label: $('cli-label').value.trim(), command: $('cli-command').value.trim(), ...($('cli-mode').value === 'api' ? { keyEnv: $('cli-key').value.trim() } : {}) });
    await refresh(); $('cli-profile').value = profile.id; selectionChanged(); notice('CLI profile saved. Launch it and complete sign-in in the official CLI.');
  }); };
  $('cli-launch').onclick = () => action(async () => {
    const p = profiles.find(p => p.id === $('cli-profile').value);
    if (!confirm(`Launch ${p.label} in this project? The official CLI manages its own permissions, credentials and billing. Stop the current terminal session before switching accounts.`)) return;
    showTerminal(); await terminal.start({ accountId: p.id, approved: true });
  });
  $('cli-remove').onclick = () => action(async () => {
    if (!confirm('Remove this profile? Sign out in the official CLI first if you want to revoke access. Its saved CLI state is retained.')) return;
    await api('cli-accounts/' + $('cli-profile').value, 'DELETE'); await refresh();
  });
  $('cli-refresh').onclick = () => action(refresh);
  refresh().catch(error => notice(error.message));
  return { refresh };
}
