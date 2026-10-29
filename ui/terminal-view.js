import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';

export function createTerminalView({ api, notice }) {
  const $ = id => document.getElementById(id);
  const terminal = new Terminal({ cursorBlink: true, scrollback: 2000, fontSize: 13, screenReaderMode: true,
    theme: { background: '#090a0d', foreground: '#d4d9e5', cursor: '#f1c88b' } });
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open($('terminal-output'));
  // Do not let arbitrary CLI output silently read/write the clipboard or open
  // links. Users can copy a login URL and open it in their browser themselves.
  terminal.parser.registerOscHandler(52, () => true);
  let cursor = 0, session, timer, running = false, pending = Promise.resolve(), polling;
  function input(value) {
    if (!running || !value) return;
    const sessionId = session;
    for (let start = 0; start < value.length; start += 8000) {
      const chunk = value.slice(start, start + 8000);
      pending = pending.then(() => api('terminal/input', 'POST', { input: chunk, sessionId })).catch(error => notice(error.message));
    }
  }
  terminal.onData(input);
  function resize() {
    if (!$('terminal').hidden && $('terminal-output').clientWidth) {
      fit.fit();
      if (running) api('terminal/resize', 'POST', { cols: Math.max(20, Math.min(400, terminal.cols)), rows: Math.max(5, Math.min(150, terminal.rows)) }).catch(error => notice(error.message));
    }
  }
  new ResizeObserver(resize).observe($('terminal-output'));
  async function poll() {
    if (polling) return polling;
    clearTimeout(timer);
    polling = (async () => {
      let result = await api(`terminal/output?cursor=${cursor}`);
      if (result.id !== session) {
        session = result.id; cursor = 0; terminal.reset();
        if (result.id) result = await api('terminal/output?cursor=0');
      }
      if (result.output) terminal.write(result.output);
      const started = result.running && !running;
      cursor = result.cursor; running = result.running;
      $('terminal-start').disabled = running; $('terminal-stop').disabled = !running; $('terminal-input').disabled = !running;
      $('terminal-session').textContent = result.account
        ? `${result.account.provider} · ${result.account.label} · ${result.account.mode === 'api' ? 'API key' : 'CLI sign-in'} · ${running ? 'running; verify identity and billing in the CLI' : 'stopped'}`
        : running ? 'Local shell running' : 'Terminal is stopped.';
      if (started) resize();
      if (running) timer = setTimeout(() => poll().catch(error => notice(error.message)), 200);
    })();
    try { await polling; } finally { polling = null; }
  }
  async function start(options = {}) {
    await api('terminal/start', 'POST', options); await polling; await poll(); resize(); terminal.focus();
  }
  $('terminal-start').onclick = () => start().catch(error => notice(error.message));
  $('terminal-stop').onclick = () => api('terminal/stop', 'POST', {}).then(poll).catch(error => notice(error.message));
  $('terminal-form').onsubmit = event => { event.preventDefault(); input($('terminal-input').value + '\r'); $('terminal-input').value = ''; };
  poll().catch(error => notice(error.message));
  return { start, resize, poll };
}
