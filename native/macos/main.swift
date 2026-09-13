// Meridian ERP :: native macOS host
//
// A real Cocoa application that owns a WKWebView and runs the Node server as
// a child process. No browser is involved: there is no address bar, no tabs,
// no separate app in the Dock, and quitting here stops the server.
//
// Built with the Swift compiler that ships with the Command Line Tools, so
// the whole thing stays buildable on a plain Mac with no project file.
import AppKit
import WebKit
import UniformTypeIdentifiers

// ------------------------------------------------------------- the server

/// Runs `node src/server.mjs` and reports the URL it settles on.
final class ServerProcess {
    private let process = Process()
    private let output = Pipe()
    private var log: FileHandle?
    private(set) var url: URL?

    /// Everything the server printed, kept for the failure dialog.
    private var transcript = ""
    private let lock = NSLock()

    init(nodePath: String, serverPath: String, dataDir: String, logPath: String) {
        process.executableURL = URL(fileURLWithPath: nodePath)
        // Port 0 lets the OS pick, so two copies of Meridian never collide.
        process.arguments = [serverPath, "--data", dataDir, "--port", "0", "--no-open"]
        process.standardOutput = output
        process.standardError = output
        var env = ProcessInfo.processInfo.environment
        env["MERIDIAN_NO_OPEN"] = "1"
        env["NODE_ENV"] = "production"
        process.environment = env

        FileManager.default.createFile(atPath: logPath, contents: nil)
        log = FileHandle(forWritingAtPath: logPath)
        log?.seekToEndOfFile()
    }

    var isRunning: Bool { process.isRunning }

    var recentOutput: String {
        lock.lock(); defer { lock.unlock() }
        return String(transcript.suffix(2000))
    }

    /// Start the server. `onReady` fires once it prints its address;
    /// `onExit` fires if it stops, at any point.
    func start(onReady: @escaping (URL) -> Void, onExit: @escaping (Int32) -> Void) throws {
        var reported = false

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            guard !data.isEmpty else { return }
            self.log?.write(data)
            guard let text = String(data: data, encoding: .utf8) else { return }

            self.lock.lock()
            self.transcript += text
            self.lock.unlock()

            guard !reported else { return }
            for line in text.split(separator: "\n") {
                guard line.hasPrefix("MERIDIAN_READY ") else { continue }
                let raw = line.dropFirst("MERIDIAN_READY ".count).trimmingCharacters(in: .whitespaces)
                guard let found = URL(string: raw) else { continue }
                reported = true
                self.url = found
                DispatchQueue.main.async { onReady(found) }
                break
            }
        }

        process.terminationHandler = { proc in
            DispatchQueue.main.async { onExit(proc.terminationStatus) }
        }
        try process.run()
    }

    /// Ask the server to close its database cleanly, then insist.
    func stop() {
        guard process.isRunning else { return }
        process.terminate()                       // SIGTERM: closes the WAL
        let deadline = Date().addingTimeInterval(4)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
}

// -------------------------------------------------------------- the window

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate,
                         WKUIDelegate, WKDownloadDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var overlay: NSView!
    private var statusLabel: NSTextField!
    private var spinner: NSProgressIndicator!
    private var server: ServerProcess!
    private var appURL: URL?
    private var isQuitting = false
    private var didLoadOnce = false
    // The frame a tiling command last replaced, so "Return to Previous Size"
    // has something to return to. macOS's own system tiling (fn-⌃-F and
    // friends) remembers this itself; ours does the same for the ⌘⌃ menu
    // shortcuts below, which exist for keyboards with no Globe/fn key.
    private var frameBeforeTile: NSRect?

    private let resources = Bundle.main.resourceURL!

    private var dataDir: String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("Meridian", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }

    /// `meridian.json` beside the data. Read before anything is started,
    /// because it is what decides whether to start anything at all.
    private var settings: [String: Any] {
        let path = (dataDir as NSString).appendingPathComponent("meridian.json")
        guard let data = FileManager.default.contents(atPath: path),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return parsed
    }

    private var mode: String { (settings["mode"] as? String) ?? "local" }

    private var remoteURL: URL? {
        guard let remote = settings["remote"] as? [String: Any],
              let raw = remote["url"] as? String, !raw.isEmpty
        else { return nil }
        return URL(string: raw)
    }

    private func writeSettings(_ patch: [String: Any]) {
        var current = settings
        for (k, v) in patch { current[k] = v }
        let path = (dataDir as NSString).appendingPathComponent("meridian.json")
        guard let data = try? JSONSerialization.data(withJSONObject: current, options: [.prettyPrinted, .sortedKeys])
        else { return }
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    /// Build-time self-check: load one URL, confirm it lands in Downloads and
    /// exit. Set by the packaging script's verification step, never by a user.
    private var selfTestURL: URL? {
        ProcessInfo.processInfo.environment["MERIDIAN_SELFTEST_DOWNLOAD"].flatMap(URL.init(string:))
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()
        if let test = selfTestURL {
            // Exercise the real download delegate rather than a copy of it.
            appURL = test
            webView.load(URLRequest(url: test))
            DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
                FileHandle.standardError.write("SELFTEST timeout\n".data(using: .utf8)!)
                exit(2)
            }
            return
        }
        // A client of a server elsewhere has nothing to start: point the
        // window at the server and let it do the work.
        if mode == "remote", let remote = remoteURL {
            appURL = remote
            showOverlay("Connecting to \(remote.host ?? remote.absoluteString)…", spinning: true)
            webView.load(URLRequest(url: remote))
            return
        }
        startServer()
    }

    // The window is the app: closing it should quit, the way a document-less
    // desktop application behaves.
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows visible: Bool) -> Bool {
        if !visible { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationWillTerminate(_ note: Notification) {
        isQuitting = true
        server?.stop()
    }

    // ---------------------------------------------------------------- UI

    private func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1440, height: 920)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Meridian ERP"
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 940, height: 620)
        window.delegate = self
        window.setFrameAutosaveName("MeridianMainWindow")
        window.center()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // The app is a single trusted origin on loopback; nothing else loads.
        config.suppressesIncrementalRendering = false

        webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        if webView.responds(to: Selector(("setInspectable:"))) {
            webView.setValue(true, forKey: "inspectable")     // Web Inspector, for support
        }

        let content = NSView(frame: frame)
        content.autoresizingMask = [.width, .height]
        content.addSubview(webView)
        buildOverlay(in: content, frame: frame)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Shown while the server boots, and again if it ever stops.
    private func buildOverlay(in parent: NSView, frame: NSRect) {
        overlay = NSView(frame: frame)
        overlay.autoresizingMask = [.width, .height]
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        let title = NSTextField(labelWithString: "Meridian ERP")
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        title.alignment = .center
        title.translatesAutoresizingMaskIntoConstraints = false

        statusLabel = NSTextField(labelWithString: "Starting…")
        statusLabel.font = .systemFont(ofSize: 12.5)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.alignment = .center
        statusLabel.maximumNumberOfLines = 4
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        spinner.translatesAutoresizingMaskIntoConstraints = false

        overlay.addSubview(title)
        overlay.addSubview(spinner)
        overlay.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            title.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            title.centerYAnchor.constraint(equalTo: overlay.centerYAnchor, constant: -24),
            spinner.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            spinner.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 14),
            statusLabel.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            statusLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 12),
            statusLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
        ])
        parent.addSubview(overlay)
    }

    private func showOverlay(_ message: String, spinning: Bool) {
        statusLabel.stringValue = message
        spinning ? spinner.startAnimation(nil) : spinner.stopAnimation(nil)
        spinner.isHidden = !spinning
        overlay.isHidden = false
    }

    private func hideOverlay() {
        spinner.stopAnimation(nil)
        overlay.isHidden = true
    }

    // ------------------------------------------------------------ server

    private func startServer() {
        let node = resources.appendingPathComponent("runtime/bin/node").path
        let entry = resources.appendingPathComponent("app/src/server.mjs").path
        let logPath = (dataDir as NSString).appendingPathComponent("meridian.log")

        guard FileManager.default.isExecutableFile(atPath: node) else {
            showOverlay("The bundled Node runtime is missing from this copy of the app.\nRe-download or rebuild it.", spinning: false)
            return
        }

        server = ServerProcess(nodePath: node, serverPath: entry, dataDir: dataDir, logPath: logPath)
        showOverlay("Starting the database…", spinning: true)

        do {
            try server.start(onReady: { [weak self] url in
                guard let self else { return }
                self.appURL = url
                self.statusLabel.stringValue = "Loading…"
                self.webView.load(URLRequest(url: url))
            }, onExit: { [weak self] status in
                guard let self, !self.isQuitting else { return }
                self.showOverlay(
                    "The Meridian service stopped unexpectedly (code \(status)).\n\n"
                    + self.server.recentOutput.split(separator: "\n").suffix(3).joined(separator: "\n")
                    + "\n\nThe full log is in \(self.dataDir)/meridian.log",
                    spinning: false)
            })
        } catch {
            showOverlay("Could not start the Meridian service:\n\(error.localizedDescription)", spinning: false)
        }

        // First run applies migrations and can seed a demo company, which takes
        // a moment; say so rather than leaving a bare spinner.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, self.appURL == nil, self.server.isRunning else { return }
            self.statusLabel.stringValue = "Preparing your company file — this only happens once…"
        }
    }

    // -------------------------------------------------------- navigation

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        didLoadOnce = true
        restoreZoom()
        hideOverlay()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        reportLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        reportLoadFailure(error)
    }

    private func reportLoadFailure(_ error: Error) {
        // A cancelled navigation is what a download looks like; not an error.
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if didLoadOnce { return }
        showOverlay("Could not reach the Meridian service.\n\(error.localizedDescription)", spinning: false)
    }

    /// Keep the app on its own origin; anything else opens in the user's browser.
    func webView(_ webView: WKWebView,
                 decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = action.request.url else { decisionHandler(.allow); return }
        if let app = appURL, target.host == app.host, target.port == app.port {
            decisionHandler(.allow); return
        }
        if target.scheme == "about" || target.scheme == "blob" || target.scheme == "data" {
            decisionHandler(.allow); return
        }
        NSWorkspace.shared.open(target)
        decisionHandler(.cancel)
    }

    /// A response the web view will not render is a file the user asked for.
    func webView(_ webView: WKWebView,
                 decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    // target="_blank" has no tab to open into, so load it here instead.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Meridian ERP"
        alert.informativeText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Meridian ERP"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { r in
            completionHandler(r == .OK ? panel.urls : nil)
        }
    }

    // --------------------------------------------------------- downloads
    // Exports (CSV, XLSX, PDF) come back as downloads. Without this they
    // vanish silently, which is the single most confusing thing a web view
    // dressed as an app can do.

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse,
                 didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction,
                 didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads")
        var target = downloads.appendingPathComponent(suggestedFilename)

        // Never overwrite: "invoices.csv" becomes "invoices 2.csv", as Safari does.
        if FileManager.default.fileExists(atPath: target.path) {
            let name = target.deletingPathExtension().lastPathComponent
            let ext = target.pathExtension
            var n = 2
            repeat {
                let candidate = ext.isEmpty ? "\(name) \(n)" : "\(name) \(n).\(ext)"
                target = downloads.appendingPathComponent(candidate)
                n += 1
            } while FileManager.default.fileExists(atPath: target.path) && n < 200
        }
        completionHandler(target)
        objc_setAssociatedObject(download, &downloadTargetKey, target, .OBJC_ASSOCIATION_RETAIN)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let target = objc_getAssociatedObject(download, &downloadTargetKey) as? URL else { return }
        if selfTestURL != nil {
            let size = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0
            print("SELFTEST_SAVED \(target.path) \(size)")
            exit(0)
        }
        NSWorkspace.shared.activateFileViewerSelecting([target])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if selfTestURL != nil {
            FileHandle.standardError.write("SELFTEST_FAILED \(error.localizedDescription)\n".data(using: .utf8)!)
            exit(3)
        }
        let alert = NSAlert()
        alert.messageText = "The download did not finish"
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window, completionHandler: nil)
    }

    // ------------------------------------------------------------- menus

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Meridian ERP", action: #selector(showAbout), keyEquivalent: "")
            .target = self
        appMenu.addItem(.separator())
        let settingsItem = appMenu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(withTitle: "Connect to a Server…", action: #selector(connectToServer), keyEquivalent: "")
            .target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Show Data Folder", action: #selector(showDataFolder), keyEquivalent: "")
            .target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Meridian ERP", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others",
                                         action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Meridian ERP", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // File: the documents somebody reaches for often enough to want a key.
        let fileItem = NSMenuItem()
        let file = NSMenu(title: "File")
        for (title, route, key) in [
            ("New Invoice", "/txn-new/invoice", "i"),
            ("New Sales Order", "/txn-new/sales_order", "o"),
            ("New Vendor Bill", "/txn-new/vendor_bill", "b"),
            ("New Journal Entry", "/journal-new", "j"),
            ("New Customer", "/new/customer", ""),
            ("New Supplier", "/new/vendor", ""),
        ] {
            let item = NSMenuItem(title: title, action: #selector(navigateFromMenu(_:)), keyEquivalent: key)
            item.keyEquivalentModifierMask = [.command, .shift]
            item.representedObject = route
            item.target = self
            file.addItem(item)
        }
        file.addItem(.separator())
        let paletteItem = file.addItem(withTitle: "Find Anything…", action: #selector(openPalette), keyEquivalent: "k")
        paletteItem.target = self
        let findItem = file.addItem(withTitle: "Search Records…", action: #selector(focusSearch), keyEquivalent: "f")
        findItem.target = self
        fileItem.submenu = file
        main.addItem(fileItem)

        // Edit: without this, copy, paste and select-all do nothing at all.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reloadApp), keyEquivalent: "r").target = self
        view.addItem(.separator())
        view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0").target = self
        // Cmd+= is what every Mac app actually binds for "zoom in"; the menu
        // shows Cmd++ and a hidden alternate catches the shifted key too.
        let zoomInItem = view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        zoomInItem.target = self
        let zoomInAlt = NSMenuItem(title: "Zoom In", action: #selector(zoomIn), keyEquivalent: "=")
        zoomInAlt.target = self
        zoomInAlt.isHidden = true
        zoomInAlt.isAlternate = false
        view.addItem(zoomInAlt)
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-").target = self
        view.addItem(.separator())
        let fullScreen = view.addItem(withTitle: "Enter Full Screen",
                                      action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view
        main.addItem(viewItem)

        let goItem = NSMenuItem()
        let goMenu = NSMenu(title: "Go")
        for (title, route, key) in [
            ("Dashboard", "/", "1"),
            ("Reports", "/reports", "2"),
            ("Chart of Accounts", "/chart", "3"),
            ("Invoices", "/list/invoice", "4"),
            ("Vendor Bills", "/list/vendor_bill", "5"),
            ("Stock & Reorder", "/inventory", "6"),
            ("Collections", "/collections", "7"),
            ("Pay Bills", "/paybills", "8"),
        ] {
            let item = NSMenuItem(title: title, action: #selector(navigateFromMenu(_:)), keyEquivalent: key)
            item.representedObject = route
            item.target = self
            goMenu.addItem(item)
        }
        goItem.submenu = goMenu
        main.addItem(goItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimise", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(NSMenuItem.separator())

        // macOS's own Window Tiling (fn-⌃-F and friends, System Settings ›
        // Desktop & Dock) already does all of this system-wide for any
        // resizable window, no app code required. These duplicate it on ⌘⌃
        // so it also works from a keyboard with no Globe/fn key, and so it
        // shows up here rather than only in a footnote.
        let moveResize = NSMenu(title: "Move & Resize")
        func tile(_ title: String, _ key: String, _ selector: Selector) {
            let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
            item.keyEquivalentModifierMask = [.command, .control]
            item.target = self
            moveResize.addItem(item)
        }
        tile("Fill", "\r", #selector(tileFill))
        tile("Centre", "c", #selector(tileCenter))
        moveResize.addItem(NSMenuItem.separator())
        tile("Left Half", String(UnicodeScalar(NSLeftArrowFunctionKey)!), #selector(tileLeftHalf))
        tile("Right Half", String(UnicodeScalar(NSRightArrowFunctionKey)!), #selector(tileRightHalf))
        tile("Top Half", String(UnicodeScalar(NSUpArrowFunctionKey)!), #selector(tileTopHalf))
        tile("Bottom Half", String(UnicodeScalar(NSDownArrowFunctionKey)!), #selector(tileBottomHalf))
        moveResize.addItem(NSMenuItem.separator())
        tile("Return to Previous Size", "r", #selector(tileReturnToPrevious))
        let moveResizeItem = NSMenuItem(title: "Move & Resize", action: nil, keyEquivalent: "")
        moveResizeItem.submenu = moveResize
        windowMenu.addItem(moveResizeItem)

        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        // Help: the whole manual, chapter by chapter, opening inside the app.
        // macOS puts a search box at the top of this menu for free, so every
        // chapter title becomes searchable from the keyboard.
        let helpItem = NSMenuItem()
        let help = NSMenu(title: "Help")
        let contents = help.addItem(withTitle: "Meridian ERP Help", action: #selector(navigateFromMenu(_:)), keyEquivalent: "?")
        contents.representedObject = "/help"
        contents.target = self
        help.addItem(.separator())
        // The teaching layer, above the manual: somebody who opens Help because
        // they are new wants to be shown around, not handed nineteen chapters.
        let tour = help.addItem(withTitle: "Take a Guided Tour", action: #selector(startTour), keyEquivalent: "")
        tour.target = self
        let learn = help.addItem(withTitle: "Learning Centre", action: #selector(navigateFromMenu(_:)), keyEquivalent: "")
        learn.representedObject = "/learn"
        learn.target = self
        help.addItem(.separator())
        for (title, chapter) in [
            ("Getting Started", "01-getting-started"),
            ("Guided Tours", "19-guided-tours"),
            ("Working Day to Day", "02-everyday"),
            ("Money Coming In", "03-money-in"),
            ("Subscriptions", "14-subscriptions"),
            ("Money Going Out", "04-money-out"),
            ("Stock", "05-stock"),
            ("The Ledger", "06-ledger"),
            ("Intercompany", "15-intercompany"),
            ("Fixed Assets", "17-fixed-assets"),
            ("Accounting Books", "18-accounting-books"),
            ("Reporting", "07-reporting"),
            ("Operations", "08-operations"),
            ("Tax", "09-tax"),
            ("Setup and Administration", "10-setup-admin"),
            ("Custom Records", "16-custom-records"),
            ("Data and Backups", "11-data"),
            ("Running on a Server", "12-server"),
            ("When Something Goes Wrong", "13-troubleshooting"),
        ] {
            let item = NSMenuItem(title: title, action: #selector(navigateFromMenu(_:)), keyEquivalent: "")
            item.representedObject = "/help/\(chapter)"
            item.target = self
            help.addItem(item)
        }
        help.addItem(.separator())
        let keysItem = help.addItem(withTitle: "Keyboard Shortcuts", action: #selector(showShortcuts), keyEquivalent: "")
        keysItem.target = self
        help.addItem(withTitle: "Show Log File", action: #selector(showLogFile), keyEquivalent: "").target = self
        helpItem.submenu = help
        main.addItem(helpItem)
        NSApp.helpMenu = help

        NSApp.mainMenu = main
    }

    // ------------------------------------------------ menu actions

    /// Menu items carry the route they open, so one action serves them all.
    @objc private func navigateFromMenu(_ sender: NSMenuItem) {
        guard let route = sender.representedObject as? String else { return }
        runInApp("window.__meridianGo && window.__meridianGo(\(jsString(route)))")
    }

    @objc private func openSettings() { navigate(to: "/settings") }
    @objc private func openPalette() { runInApp("window.__meridianPalette && window.__meridianPalette()") }
    @objc private func focusSearch() { runInApp("document.querySelector('.searchbox input')?.focus()") }
    @objc private func showShortcuts() { runInApp("window.__meridianShortcutSheet && window.__meridianShortcutSheet()") }
    @objc private func startTour() { runInApp("window.__meridianTour && window.__meridianTour()") }

    private func navigate(to route: String) {
        runInApp("window.__meridianGo && window.__meridianGo(\(jsString(route)))")
    }

    /// Ask the page to do something. Ignored silently if it has not loaded
    /// yet, which is the only sensible thing a menu can do about that.
    private func runInApp(_ script: String) {
        guard didLoadOnce else { return }
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private func jsString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        return "'\(escaped)'"
    }

    @objc private func showLogFile() {
        let log = (dataDir as NSString).appendingPathComponent("meridian.log")
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: log)])
    }

    /// Point this copy at a Meridian server somewhere else. Written to the
    /// settings file and applied on the next launch, because the window is
    /// already showing whatever it was pointed at this time.
    @objc private func connectToServer() {
        let alert = NSAlert()
        alert.messageText = "Connect to a Meridian server"
        alert.informativeText = "Enter the address of the server holding your company file. "
            + "Leave it empty to go back to running Meridian on this Mac.\n\n"
            + "This takes effect when Meridian next opens."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = "https://meridian.yourcompany.local:8422"
        field.stringValue = remoteURL?.absoluteString ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let entered = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if entered.isEmpty {
            writeSettings(["mode": "local"])
            notifyRestart("Meridian will run on this Mac again when it next opens.")
            return
        }
        guard let url = URL(string: entered), url.scheme == "http" || url.scheme == "https" else {
            let bad = NSAlert()
            bad.messageText = "That is not an address Meridian can use"
            bad.informativeText = "It has to start with http:// or https://."
            bad.runModal()
            return
        }
        var remote = (settings["remote"] as? [String: Any]) ?? [:]
        remote["url"] = url.absoluteString
        writeSettings(["mode": "remote", "remote": remote])
        notifyRestart("Meridian will connect to \(url.host ?? url.absoluteString) when it next opens.")
    }

    private func notifyRestart(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Saved"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit Now")
        alert.addButton(withTitle: "Later")
        if alert.runModal() == .alertFirstButtonReturn { NSApp.terminate(nil) }
    }

    @objc private func reloadApp() {
        guard let url = appURL else { return }
        // Reload from the server rather than the cache, so an updated build
        // is picked up without quitting.
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    @objc private func zoomIn() { setZoom(min(webView.pageZoom + 0.1, 2.5)) }
    @objc private func zoomOut() { setZoom(max(webView.pageZoom - 0.1, 0.6)) }
    @objc private func zoomReset() { setZoom(1.0) }

    /// WKWebView scales everything including the scrollbars, which is the
    /// right way to do it. The page is told as well, so what it remembers and
    /// what Settings shows agree with what is on screen.
    private func setZoom(_ level: CGFloat) {
        webView.pageZoom = level
        UserDefaults.standard.set(Double(level), forKey: "MeridianPageZoom")
        runInApp("window.dispatchEvent(new CustomEvent('meridian:zoom-native',{detail:{level:\(level)}}))")
    }

    private func restoreZoom() {
        let saved = UserDefaults.standard.double(forKey: "MeridianPageZoom")
        if saved > 0.5 { webView.pageZoom = CGFloat(saved) }
    }

    // ---------------------------------------------------- window tiling
    // Mirrors macOS's own Window Tiling actions (Fill, Centre, halves, Return
    // to Previous Size) as real menu commands with their own ⌘⌃ shortcuts —
    // see the comment where the Move & Resize menu is built.

    private func tileTo(_ frame: NSRect) {
        guard let window = window else { return }
        if frameBeforeTile == nil { frameBeforeTile = window.frame }
        window.setFrame(frame, display: true, animate: true)
    }

    @objc private func tileFill() {
        guard let screen = window?.screen ?? NSScreen.main else { return }
        tileTo(screen.visibleFrame)
    }

    @objc private func tileCenter() {
        guard let window = window, let screen = window.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        let size = window.frame.size
        let origin = NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2)
        tileTo(NSRect(origin: origin, size: size))
    }

    private func tileHalf(_ half: (NSRect) -> NSRect) {
        guard let screen = window?.screen ?? NSScreen.main else { return }
        tileTo(half(screen.visibleFrame))
    }

    @objc private func tileLeftHalf() {
        tileHalf { visible in NSRect(x: visible.minX, y: visible.minY, width: visible.width / 2, height: visible.height) }
    }
    @objc private func tileRightHalf() {
        tileHalf { visible in NSRect(x: visible.midX, y: visible.minY, width: visible.width / 2, height: visible.height) }
    }
    @objc private func tileTopHalf() {
        tileHalf { visible in NSRect(x: visible.minX, y: visible.midY, width: visible.width, height: visible.height / 2) }
    }
    @objc private func tileBottomHalf() {
        tileHalf { visible in NSRect(x: visible.minX, y: visible.minY, width: visible.width, height: visible.height / 2) }
    }

    @objc private func tileReturnToPrevious() {
        guard let frame = frameBeforeTile else { return }
        frameBeforeTile = nil
        window?.setFrame(frame, display: true, animate: true)
    }

    @objc private func showDataFolder() {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: dataDir)])
    }

    @objc private func showAbout() {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
        let alert = NSAlert()
        alert.messageText = "Meridian ERP \(version)"
        alert.informativeText = "Cloud ERP and business management.\n\n"
            + "Your data lives in:\n\(dataDir)\n\nEverything runs on this Mac. Nothing is sent anywhere."
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Show Data Folder")
        if alert.runModal() == .alertSecondButtonReturn { showDataFolder() }
    }
}

private var downloadTargetKey: UInt8 = 0

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
