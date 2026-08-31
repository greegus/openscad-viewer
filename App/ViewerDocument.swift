import AppKit
import UniformTypeIdentifiers

/// One open .scad file.
///
/// `NSDocument` is what buys the Preview-like behaviour: double-click and File → Open, tabs
/// and windows, the recents menu, and window restoration — none of which we implement.
/// `@objc` with an explicit name on purpose: AppKit looks this class up from Info.plist by
/// string, and a Swift class is otherwise registered under its mangled name.
@objc(ViewerDocument)
final class ViewerDocument: NSDocument, NSWindowDelegate {

    private(set) var fileWatcher: FileWatcher?
    private weak var viewer: ViewerViewController?

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
        viewer.geometryProvider = LocalGeometryProvider()   // an app may render in process
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
