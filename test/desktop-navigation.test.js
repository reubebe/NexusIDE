import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../src/process.js';

test('native project switch discards once and retains same-session navigation protection', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nexus-native-navigation-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const urls = [];
  for (let i = 0; i < 2; i++) {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<script>window.fixtureReady=true; window.nexusHasUnsavedChanges=()=>true</script>Unsaved project fixture');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    urls.push(`http://127.0.0.1:${server.address().port}/`);
  }

  // Compile the actual native delegate with an isolated entry point. A real
  // WKWebView loads each project; no app preferences or real workspaces change.
  const source = await readFile(new URL('../desktop/macos/NexusDesktop.swift', import.meta.url), 'utf8');
  const entry = source.lastIndexOf('let application = NSApplication.shared');
  assert.ok(entry > 0);
  const harness = `
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let first = URL(string: "${urls[0]}")!
let second = URL(string: "${urls[1]}")!
let desktop = Desktop(url: first, selectedPath: nil)
desktop.window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
desktop.web = WKWebView(frame: .zero)
desktop.window.contentView = desktop.web
desktop.web.navigationDelegate = desktop
var stage = 0
var evaluating = false
let deadline = Date().addingTimeInterval(15)
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    if Date() > deadline { fputs("Navigation timed out in stage \\(stage)\\n", stderr); exit(1) }
    if stage == 1 && desktop.window.attachedSheet != nil {
        fputs("Repeated discard confirmation after project switch\\n", stderr); exit(1)
    }
    if stage == 2 && desktop.window.attachedSheet != nil {
        print("native-navigation-protection-ok"); exit(0)
    }
    if evaluating || desktop.web.isLoading { return }
    if stage < 2 {
        evaluating = true
        desktop.web.evaluateJavaScript("Boolean(window.fixtureReady)") { value, error in
            evaluating = false
            if error != nil || value as? Bool != true { return }
            if stage == 0 && desktop.web.url == first {
                // Equivalent to the new bootstrap's onReady after the user
                // already approved discarding the first project's edits.
                stage = 1
                desktop.loadSession(second)
            } else if stage == 1 && desktop.web.url == second {
                stage = 2
                desktop.web.load(URLRequest(url: second.appendingPathComponent("other")))
            }
        }
    }
}
desktop.loadSession(first)
application.run()
`;
  const swift = path.join(temporary, 'main.swift'), binary = path.join(temporary, 'navigation-check');
  await writeFile(swift, source.slice(0, entry) + harness);
  const build = await runProcess('/usr/bin/xcrun', ['swiftc', swift, '-o', binary, '-framework', 'AppKit', '-framework', 'WebKit'], { timeoutMs: 90000 });
  assert.equal(build.code, 0, build.output);
  assert.equal(build.stopped, null);
  const result = await runProcess(binary, [], { timeoutMs: 20000 });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.stopped, null);
  assert.match(result.output, /native-navigation-protection-ok/);
});
