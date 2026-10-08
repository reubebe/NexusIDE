import AppKit
import WebKit

func trustedURL(_ value: String) -> URL? {
    guard let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1",
          let port = url.port, (1...65535).contains(port), url.user == nil, url.password == nil,
          url.path == "/", url.query == nil, let token = url.fragment,
          token.count == 64, token.allSatisfy({ $0.isHexDigit && $0.isASCII }) else { return nil }
    return url
}

guard let input = readLine(), let url = trustedURL(input) else {
    fputs("Desktop host requires a NexusIDE loopback session on stdin.\n", stderr)
    exit(1)
}
if CommandLine.arguments.contains("--check-url") { print("accepted"); exit(0) }

final class Desktop: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    let url: URL
    var window: NSWindow!
    var web: WKWebView!
    init(url: URL) { self.url = url }

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
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit
        menu.addItem(editItem)
        NSApplication.shared.mainMenu = menu
        web.load(URLRequest(url: url))
        NSApplication.shared.activate(ignoringOtherApps: true)
        // The launcher keeps stdin open. If it exits, this window exits too.
        DispatchQueue.global().async {
            _ = FileHandle.standardInput.readDataToEndOfFile()
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = navigationAction.request.url, navigationAction.targetFrame != nil,
              target.scheme == url.scheme, target.host == url.host, target.port == url.port,
              target.user == nil, target.password == nil else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        window.title = "NexusIDE — connection failed; restart nexus desktop"
    }
}

let application = NSApplication.shared
let desktop = Desktop(url: url)
application.delegate = desktop
application.setActivationPolicy(.regular)
application.run()
