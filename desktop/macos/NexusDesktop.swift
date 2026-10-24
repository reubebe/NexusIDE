import AppKit
import WebKit
import Darwin

func trustedURL(_ value: String) -> URL? {
    guard let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1",
          let port = url.port, (1...65535).contains(port), url.user == nil, url.password == nil,
          url.path == "/", url.query == nil, let token = url.fragment,
          token.count == 64, token.allSatisfy({ $0.isHexDigit && $0.isASCII }) else { return nil }
    return url
}

func workspaceURL(_ path: String) -> URL? {
    guard path.hasPrefix("/"), !path.contains("\0") else { return nil }
    let url = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
    var directory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), directory.boolValue else { return nil }
    return url
}

// Only the child pipe carries the session token: never arguments, environment, logs, or defaults.
final class BootstrapHost {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private let lock = NSLock()
    private let stopLock = NSLock()
    private var state = "new"
    private var timeout: DispatchWorkItem?
    let workspace: URL
    let dataRoot: String?
    var pid: Int32 { process.processIdentifier }

    init(workspace: URL, dataRoot: String? = nil) { self.workspace = workspace; self.dataRoot = dataRoot }

    private func changeState(from old: [String], to new: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard old.contains(state) else { return false }
        state = new
        return true
    }

    func start(onReady: @escaping (URL, String) -> Void, onFailure: @escaping (String) -> Void,
               onExit: @escaping () -> Void) {
        guard changeState(from: ["new"], to: "starting") else { return }
        let fail: (String) -> Void = { message in
            if self.changeState(from: ["starting"], to: "failed") { self.timeout?.cancel(); onFailure(message) }
        }
        guard let resources = Bundle.main.resourceURL else { fail("The bundled runtime is missing. Reinstall NexusIDE."); return }
        let node = resources.appendingPathComponent("runtime/bin/node")
        let bootstrap = resources.appendingPathComponent("app/src/desktop-bootstrap.js")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: bootstrap.path) else {
            fail("The bundled runtime is missing. Reinstall NexusIDE or use nexus desktop from a source checkout."); return
        }
        process.executableURL = node
        process.arguments = [bootstrap.path, "--workspace", workspace.path]
        if let dataRoot = dataRoot { process.arguments! += ["--data-root", dataRoot] }
        process.currentDirectoryURL = workspace
        var environment = [
            "HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(),
            "USER": NSUserName(), "LOGNAME": NSUserName(), "LANG": "en_US.UTF-8",
            "PATH": node.deletingLastPathComponent().path + ":/usr/bin:/bin:/usr/sbin:/sbin"
        ]
        // The owned runtime resolves provider keys; no credential is copied into
        // arguments, app preferences or browser state. Keep unrelated variables
        // (including Node startup hooks) outside the child environment.
        let inherited = ProcessInfo.processInfo.environment
        for name in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY",
                     "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "ZHIPUAI_API_KEY", "DASHSCOPE_API_KEY"] {
            if let value = inherited[name] { environment[name] = value }
            // Additional accounts use canonical suffixes 2...99. Construct the
            // exact names so unrelated variables and malformed suffixes stay out.
            for account in 2...99 {
                let accountName = name + String(account)
                if let value = inherited[accountName] { environment[accountName] = value }
            }
        }
        process.environment = environment
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        process.terminationHandler = { _ in
            if self.changeState(from: ["starting"], to: "failed") {
                self.timeout?.cancel(); onFailure("The local runtime could not start. Check that the selected project is writable and the app is intact.")
            } else if self.changeState(from: ["ready"], to: "failed") { onExit() }
        }
        do { try process.run() } catch { fail("The bundled runtime could not be launched. Reinstall NexusIDE."); return }
        // Drain stderr without logging potentially sensitive provider or session data.
        DispatchQueue.global().async { while !self.errors.fileHandleForReading.availableData.isEmpty {} }
        let deadline = DispatchWorkItem {
            if self.changeState(from: ["starting"], to: "failed") {
                onFailure("The local runtime did not become ready within 30 seconds.")
                self.stop()
            }
        }
        timeout = deadline
        DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: deadline)
        DispatchQueue.global().async {
            var pending = Data()
            var parsed = false
            while true {
                let data = self.output.fileHandleForReading.availableData
                if data.isEmpty { break }
                if parsed { continue }
                pending.append(data)
                if let newline = pending.firstIndex(of: 10) {
                    guard newline <= 16_384,
                          let record = try? JSONSerialization.jsonObject(with: pending.prefix(upTo: newline)) as? [String: Any],
                          let value = record["url"] as? String, let url = trustedURL(value),
                          let root = record["root"] as? String,
                          workspaceURL(root)?.path == self.workspace.path else {
                        fail("The local runtime returned an invalid startup response."); self.stop(); return
                    }
                    parsed = true; pending.removeAll()
                    if self.changeState(from: ["starting"], to: "ready") {
                        self.timeout?.cancel(); onReady(url, root)
                    }
                } else if pending.count > 16_384 {
                    fail("The local runtime returned an oversized startup response."); self.stop(); return
                }
            }
        }
    }

    func stop() {
        stopLock.lock(); defer { stopLock.unlock() }
        guard changeState(from: ["new", "starting", "ready", "failed"], to: "stopping") else { return }
        timeout?.cancel()
        try? input.fileHandleForWriting.close()
        // EOF is the normal shutdown protocol. Escalation is only for this owned process.
        let grace = Date().addingTimeInterval(9)
        while process.isRunning && Date() < grace { usleep(20_000) }
        if process.isRunning { process.terminate() }
        let deadline = Date().addingTimeInterval(1)
        while process.isRunning && Date() < deadline { usleep(20_000) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.contains("--check-url") {
    guard let input = readLine(), trustedURL(input) != nil else {
        fputs("Desktop host requires a NexusIDE loopback session on stdin.\n", stderr); exit(1)
    }
    print("accepted"); exit(0)
}
var sessionURL: URL?
var selectedPath: String?
var dataRoot: String?
let checkBootstrap = arguments.contains("--check-bootstrap")
var index = 0
while index < arguments.count {
    switch arguments[index] {
    case "--session-stdin":
        guard arguments.count == 1, let input = readLine(), let url = trustedURL(input) else {
            fputs("Desktop host requires a NexusIDE loopback session on stdin.\n", stderr); exit(1)
        }
        sessionURL = url
    case "--workspace", "--data-root":
        guard index + 1 < arguments.count else { fputs("Missing desktop path argument.\n", stderr); exit(1) }
        if arguments[index] == "--workspace" { selectedPath = arguments[index + 1] }
        else { dataRoot = arguments[index + 1] }
        index += 1
    case "--check-bootstrap": break
    default: fputs("Unknown desktop argument.\n", stderr); exit(1)
    }
    index += 1
}
if dataRoot != nil && (!checkBootstrap || !dataRoot!.hasPrefix("/") || dataRoot!.contains("\0")) {
    fputs("--data-root requires an absolute path and --check-bootstrap.\n", stderr); exit(1)
}
if checkBootstrap {
    guard let path = selectedPath, let workspace = workspaceURL(path) else {
        fputs("--check-bootstrap requires --workspace with an existing absolute project folder.\n", stderr); exit(1)
    }
    let host = BootstrapHost(workspace: workspace, dataRoot: dataRoot)
    let done = DispatchSemaphore(value: 0)
    let resultLock = NSLock()
    var result: [String: Any]?
    var failure = "The bundled runtime check failed."
    host.start(onReady: { url, root in
        resultLock.lock(); result = ["root": root, "origin": "http://127.0.0.1:\(url.port!)", "pid": host.pid]; resultLock.unlock(); done.signal()
    }, onFailure: { message in resultLock.lock(); failure = message; resultLock.unlock(); done.signal() }, onExit: { done.signal() })
    _ = done.wait(timeout: .now() + 35)
    host.stop()
    resultLock.lock()
    guard let result = result, let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
          let json = String(data: data, encoding: .utf8) else { fputs(failure + "\n", stderr); exit(1) }
    print(json); exit(0)
}

final class Desktop: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    var url: URL?
    let selectedPath: String?
    var bootstrap: BootstrapHost?
    var window: NSWindow!
    var web: WKWebView!
    var allowExit = false
    var checkingClose = false
    var checkingNavigation = false
    var sessionNavigationPending = false
    init(url: URL?, selectedPath: String?) { self.url = url; self.selectedPath = selectedPath }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 850),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "NexusIDE"
        window.delegate = self
        window.minSize = NSSize(width: 760, height: 560)
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        let menu = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "Quit NexusIDE", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu
        menu.addItem(applicationItem)
        let fileItem = NSMenuItem()
        let file = NSMenu(title: "File")
        file.autoenablesItems = false
        let openProject = file.addItem(withTitle: "Open Project…", action: #selector(chooseProject), keyEquivalent: "o")
        openProject.target = self
        openProject.isEnabled = url == nil
        fileItem.submenu = file
        menu.addItem(fileItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit
        menu.addItem(editItem)
        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        let back = viewMenu.addItem(withTitle: "Back", action: #selector(goBack), keyEquivalent: "[")
        back.target = self
        let forward = viewMenu.addItem(withTitle: "Forward", action: #selector(goForward), keyEquivalent: "]")
        forward.target = self
        viewItem.submenu = viewMenu
        menu.addItem(viewItem)
        NSApplication.shared.mainMenu = menu
        NSApplication.shared.activate(ignoringOtherApps: true)
        if let url = url {
            loadSession(url)
            // CLI mode does not own the server; the launcher owns its lifetime.
            DispatchQueue.global().async {
                _ = FileHandle.standardInput.readDataToEndOfFile()
                DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
            }
        } else {
            startWorkspace()
        }
    }

    // The bundled guide and full-size diagrams are same-origin pages. Give the
    // native shell the navigation controls a browser normally supplies.
    @objc func goBack() { if web.canGoBack { web.goBack() } }
    @objc func goForward() { if web.canGoForward { web.goForward() } }

    func loadSession(_ session: URL) {
        url = session
        sessionNavigationPending = true
        web.load(URLRequest(url: session))
    }

    @objc func chooseProject() {
        guard !checkingClose && !checkingNavigation else { return }
        checkingClose = true
        confirmDiscard(forProjectSwitch: true) { allowed in
            self.checkingClose = false
            if allowed { self.startWorkspace(forceSelection: true) }
        }
    }

    func startWorkspace(forceSelection: Bool = false) {
        let defaults = UserDefaults.standard
        var workspace: URL?
        if !forceSelection, let selectedPath = selectedPath {
            guard let selected = workspaceURL(selectedPath) else { startupFailed("Choose an existing project folder with an absolute path."); return }
            workspace = selected
        } else if !forceSelection, let remembered = defaults.string(forKey: "NexusIDEWorkspace") {
            workspace = workspaceURL(remembered)
        }
        if workspace == nil {
            let picker = NSOpenPanel()
            picker.title = "Choose your NexusIDE project"
            picker.message = "NexusIDE adds default agents only when missing and keeps existing .nexus data intact. Setup does not call models or download anything."
            picker.prompt = "Open project"
            picker.canChooseDirectories = true; picker.canChooseFiles = false; picker.allowsMultipleSelection = false
            picker.canCreateDirectories = true
            guard picker.runModal() == .OK, let picked = picker.url, let selected = workspaceURL(picked.path) else {
                if url != nil { return }
                allowExit = true; NSApplication.shared.terminate(nil); return
            }
            workspace = selected
        }
        let project = workspace!
        bootstrap?.stop()
        url = nil
        window.title = "NexusIDE — starting local runtime"
        let host = BootstrapHost(workspace: project)
        bootstrap = host
        host.start(onReady: { url, root in
            DispatchQueue.main.async {
                guard !self.allowExit, self.bootstrap === host else { return }
                if self.selectedPath == nil || forceSelection { defaults.set(root, forKey: "NexusIDEWorkspace") }
                self.window.title = "NexusIDE — \(project.lastPathComponent)"
                self.loadSession(url)
            }
        }, onFailure: { message in
            DispatchQueue.main.async { if self.bootstrap === host { self.startupFailed(message) } }
        }, onExit: {
            DispatchQueue.main.async {
                if self.bootstrap === host { self.startupFailed("The local runtime stopped unexpectedly. Reopen NexusIDE to resume your project.") }
            }
        })
    }

    func startupFailed(_ message: String) {
        guard !allowExit else { return }
        let alert = NSAlert()
        alert.messageText = "NexusIDE could not open this project"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        allowExit = true
        NSApplication.shared.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) { bootstrap?.stop() }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func confirmDiscard(forProjectSwitch: Bool = false, _ completion: @escaping (Bool) -> Void) {
        guard url != nil else { completion(true); return }
        web.evaluateJavaScript("window.nexusHasUnsavedChanges ? window.nexusHasUnsavedChanges() : false") { value, error in
            if error == nil && (value as? Bool) != true { completion(true); return }
            let alert = NSAlert()
            alert.messageText = forProjectSwitch ? "Switch NexusIDE project?" : "Close NexusIDE?"
            alert.informativeText = "Unsaved edits may be lost. Active tasks will be cancelled."
            alert.addButton(withTitle: "Keep working")
            alert.addButton(withTitle: forProjectSwitch ? "Discard and switch" : "Discard and close")
            alert.beginSheetModal(for: self.window) { completion($0 == .alertSecondButtonReturn) }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if allowExit { return true }
        if checkingClose || checkingNavigation { return false }
        checkingClose = true
        confirmDiscard { allowed in
            self.checkingClose = false
            if allowed { self.allowExit = true; sender.close() }
        }
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if allowExit { return .terminateNow }
        if checkingClose || checkingNavigation { return .terminateCancel }
        checkingClose = true
        confirmDiscard { allowed in
            self.checkingClose = false
            self.allowExit = allowed
            sender.reply(toApplicationShouldTerminate: allowed)
        }
        return .terminateLater
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Discard changes")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertSecondButtonReturn) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = url, let target = navigationAction.request.url, navigationAction.targetFrame?.isMainFrame == true,
              target.scheme == url.scheme, target.host == url.host, target.port == url.port,
              target.user == nil, target.password == nil else { decisionHandler(.cancel); return }
        // Project switching already confirmed discard before stopping the old
        // runtime. WebKit can update webView.url before replacing that dirty
        // document, so track the first trusted navigation explicitly.
        if sessionNavigationPending {
            sessionNavigationPending = false
            decisionHandler(.allow); return
        }
        guard let current = webView.url else { decisionHandler(.allow); return }
        // In-page anchors do not discard the document. Other navigation,
        // including native Back/Forward, must protect dashboard drafts.
        if current.path == target.path && current.query == target.query && current.fragment != target.fragment {
            decisionHandler(.allow); return
        }
        guard !checkingClose && !checkingNavigation else { decisionHandler(.cancel); return }
        checkingNavigation = true
        webView.evaluateJavaScript("window.nexusHasUnsavedChanges ? window.nexusHasUnsavedChanges() : false") { value, error in
            if error == nil && (value as? Bool) != true {
                self.checkingNavigation = false
                decisionHandler(.allow); return
            }
            let alert = NSAlert()
            alert.messageText = "Leave this page?"
            alert.informativeText = "Unsaved edits may be lost. Active tasks will continue in the local runtime."
            alert.addButton(withTitle: "Keep editing")
            alert.addButton(withTitle: "Discard and continue")
            alert.beginSheetModal(for: self.window) { response in
                self.checkingNavigation = false
                decisionHandler(response == .alertSecondButtonReturn ? .allow : .cancel)
            }
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        window.title = "NexusIDE — connection failed; reopen your session"
    }
}

let application = NSApplication.shared
let desktop = Desktop(url: sessionURL, selectedPath: selectedPath)
application.delegate = desktop
application.setActivationPolicy(.regular)
application.run()
