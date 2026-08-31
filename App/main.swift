import AppKit

/// Container app. Its only jobs are (a) to carry the extensions,
/// (b) to declare the UTI for .scad, (c) to give the user settings.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let pathField = NSTextField(string: "")
    private let status = NSTextField(labelWithString: "")

    func applicationDidFinishLaunching(_ note: Notification) {
        let defaults = UserDefaults(suiteName: Config.suiteName)
        pathField.stringValue = defaults?.string(forKey: "openscadPath")
            ?? ScadRenderer.locateOpenSCAD() ?? ""
        pathField.placeholderString = "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"

        let title = NSTextField(labelWithString: "OpenSCAD Viewer")
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        let label = NSTextField(labelWithString: "OpenSCAD path:")

        let save = NSButton(title: "Save", target: self, action: #selector(save))
        let clear = NSButton(title: "Clear cache", target: self, action: #selector(clearCache))
        status.textColor = .secondaryLabelColor
        refreshStatus()

        let stack = NSStackView(views: [title, label, pathField,
                                        NSStackView(views: [save, clear]), status])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        pathField.widthAnchor.constraint(equalToConstant: 460).isActive = true

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 220),
                          styleMask: [.titled, .closable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "OpenSCAD Viewer"
        window.contentView = stack
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func save() {
        UserDefaults(suiteName: Config.suiteName)?.set(pathField.stringValue, forKey: "openscadPath")
        refreshStatus()
    }

    @objc private func clearCache() {
        let dir = ScadRenderer.cacheDirectory
        for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] {
            try? FileManager.default.removeItem(at: f)
        }
        refreshStatus()
    }

    private func refreshStatus() {
        let found = ScadRenderer.locateOpenSCAD()
        let count = ((try? FileManager.default.contentsOfDirectory(atPath: ScadRenderer.cacheDirectory.path)) ?? []).count
        status.stringValue = (found == nil ? "⚠️ OpenSCAD not found" : "✅ OpenSCAD: \(found!)")
            + "  ·  cache: \(count) items"
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
