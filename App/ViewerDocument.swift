import AppKit
import UniformTypeIdentifiers

/// One open .scad file.
///
/// `NSDocument` is what buys the Preview-like behaviour: double-click and File → Open, tabs
/// and windows, the recents menu, and window restoration — none of which we implement.
/// `@objc` with an explicit name on purpose: AppKit looks this class up from Info.plist by
/// string, and a Swift class is otherwise registered under its mangled name.
@objc(ViewerDocument)
final class ViewerDocument: NSDocument, NSWindowDelegate, NSToolbarDelegate {

    private(set) var fileWatcher: FileWatcher?
    private weak var viewer: ViewerViewController?
    private let provider = LocalGeometryProvider()
    private var exporting = false

    override class var autosavesInPlace: Bool { false }

    /// Read-only viewer: nothing here edits the file, OpenSCAD and your editor do.
    override func data(ofType typeName: String) throws -> Data {
        throw NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError)
    }

    /// The file is handed to the viewer by URL, not read here — relative `include`/`use` only
    /// resolve against the original path, so the renderer needs the path, not the bytes.
    override func read(from url: URL, ofType typeName: String) throws {}

    override func makeWindowControllers() {
        let viewer = ViewerViewController()
        viewer.geometryProvider = provider   // an app may render in process
        self.viewer = viewer

        let window = NSWindow(contentViewController: viewer)
        // Spelled out rather than left to the default: zoom — and therefore double-clicking
        // the title bar — is only offered on a resizable window.
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 1100, height: 800))
        window.minSize = NSSize(width: 480, height: 360)
        window.title = displayName
        window.tabbingMode = .preferred
        window.delegate = self
        window.setFrameAutosaveName("ScadViewerWindow")
        window.collectionBehavior.insert(.fullScreenPrimary)   // green button / ⌃⌘F

        let toolbar = NSToolbar(identifier: "ViewerToolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        window.toolbar = toolbar

        let controller = NSWindowController(window: window)
        addWindowController(controller)

        if let url = fileURL {
            viewer.preparePreviewOfFile(at: url) { _ in }
            startWatching(url)
        }
    }

    /// Re-render when the file changes on disk — the reason to keep this window open next to
    /// an editor. The cache is keyed on mtime of the file and of every include/use dependency,
    /// so asking again is enough; nothing else has to be invalidated.
    private func startWatching(_ url: URL) {
        fileWatcher = FileWatcher(url: url) { [weak self] in
            self?.viewer?.reload()
        }
    }

    // MARK: - Toolbar

    private static let exportItem = NSToolbarItem.Identifier("exportSTL")

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, Self.exportItem]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.exportItem, .flexibleSpace, .space]
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar: Bool) -> NSToolbarItem? {
        guard id == Self.exportItem else { return nil }
        let item = NSToolbarItem(itemIdentifier: id)
        item.label = "Export STL"
        item.toolTip = "Export the design as an STL mesh"
        item.image = NSImage(systemSymbolName: "square.and.arrow.up",
                             accessibilityDescription: "Export STL")
        // Left to the responder chain rather than targeted at the document, so the menu item
        // and the button reach the same place through the same route.
        item.action = #selector(exportSTL(_:))
        item.isBordered = true
        return item
    }

    // MARK: - Export

    /// Writes the design as a single STL.
    ///
    /// A full CGAL render, so seconds on a first run and instant afterwards from the cache.
    /// Colour is not part of STL, so the per-material split the viewer uses does not apply.
    @objc func exportSTL(_ sender: Any?) {
        guard let url = fileURL, let window = windowControllers.first?.window else { return }

        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "stl") ?? .data]
        panel.nameFieldStringValue = url.deletingPathExtension().lastPathComponent + ".stl"
        panel.canCreateDirectories = true

        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let destination = panel.url, let self else { return }
            self.exporting = true
            self.viewer?.showBusy("Exporting STL…")

            self.provider.mesh(for: url) { result in
                self.exporting = false
                self.viewer?.hideBusy()
                switch result {
                case .success(let data):
                    do { try data.write(to: destination) }
                    catch { self.report(error.localizedDescription, in: window) }
                case .failure(let error):
                    self.report(error.localizedDescription, in: window)
                }
            }
        }
    }

    private func report(_ message: String, in window: NSWindow) {
        let alert = NSAlert()
        alert.messageText = "Could not export the STL"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.beginSheetModal(for: window)
    }

    /// Grey the control out while an export is already running.
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(exportSTL(_:)) { return fileURL != nil && !exporting }
        return super.validateUserInterfaceItem(item)
    }

    /// What zoom expands to. Without this AppKit derives a "standard" frame from the content,
    /// which for a view with no preferred size can be smaller than the screen — so a
    /// double-click on the title bar looked like it did nothing much.
    func windowWillUseStandardFrame(_ window: NSWindow, defaultFrame: NSRect) -> NSRect {
        window.screen?.visibleFrame ?? defaultFrame
    }

    override func close() {
        fileWatcher = nil
        super.close()
    }
}
