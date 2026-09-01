import AppKit
import os

/// Standalone viewer. Document-based, so opening files, tabs, the recents menu and window
/// restoration come from AppKit rather than from us.
final class AppDelegate: NSObject, NSApplicationDelegate {

    private let settings = SettingsWindowController()
    private static let log = Logger(subsystem: "com.greegus.OpenSCADViewer", category: "app")

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()

        // Files given on the command line: useful on its own, and the only way to drive the
        // app without LaunchServices — which matters for testing.
        let paths = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-") }
        if !paths.isEmpty {
            application(NSApp, open: paths.map { URL(fileURLWithPath: $0) })
        }
    }

    /// AppKit only shows its own open panel when we do not; opening one from
    /// applicationDidFinishLaunching raced the file LaunchServices was about to deliver.
    func applicationShouldOpenUntitledFile(_ app: NSApplication) -> Bool { false }

    func application(_ app: NSApplication, open urls: [URL]) {
        for url in urls {
            NSDocumentController.shared.openDocument(withContentsOf: url, display: true) { document, _, error in
                if let error {
                    fputs("open failed: \(error.localizedDescription)\n", stderr)
                } else {
                    fputs("opened: \(document?.displayName ?? "?")\n", stderr)
                }
            }
        }
    }

    /// Built in code because the app has no nib. Only the items that do something are here.
    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
            .target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide OpenSCAD Viewer", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit OpenSCAD Viewer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "Open…", action: #selector(NSDocumentController.openDocument(_:)), keyEquivalent: "o")
        fileMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileMenu.addItem(withTitle: "Command Palette…",
                         action: #selector(ViewerViewController.showCommandPalette(_:)),
                         keyEquivalent: "k")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Reload", action: #selector(ViewerViewController.reloadModel(_:)),
                         keyEquivalent: "r")
        fileMenu.addItem(.separator())
        // Untargeted: the responder chain takes it to the document showing the file.
        fileMenu.addItem(withTitle: "Export STL…",
                         action: #selector(ViewerDocument.exportSTL(_:)), keyEquivalent: "e")
        fileItem.submenu = fileMenu
        main.addItem(fileItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimise", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    @objc private func showSettings() { settings.show() }

    /// Quitting with no window open is the Preview-like behaviour: the app is its documents.
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
