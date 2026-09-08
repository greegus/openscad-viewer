import AppKit
import QuickLookUI
import os

/// The interactive 3D viewer: display modes, overlays and the inspect/measure tools.
///
/// Host-agnostic. Geometry arrives through a `GeometryProvider`, so this same controller
/// backs the Quick Look panel (which must render out of process) and the standalone app
/// (which renders in process) without knowing which it is.
/// Quick Look does not size our view and `autoresizingMask` is not enough on its own — the
/// root can grow beyond the panel, and the controls then fall off the right edge. Hosts that
/// have this problem opt in through `pinsToHostView`; a window does not, and must not, because
/// a content view pinned to the window's frame view covers the title bar and the resize
/// margins along with it.
private final class RootView: NSView {

    /// Only a host that does not size us needs this — see `pinsToHostView`.
    var pinsToHostView = false

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        guard pinsToHostView, let host = superview else { return }
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: host.leadingAnchor),
            trailingAnchor.constraint(equalTo: host.trailingAnchor),
            topAnchor.constraint(equalTo: host.topAnchor),
            bottomAnchor.constraint(equalTo: host.bottomAnchor),
        ])
    }
}

open class ViewerViewController: NSViewController, QLPreviewingController {

    /// Actions the page cannot perform itself, by id. The host names what it can do and
    /// handles the callback; the viewer only carries the request across.
    public var hostActions: [String] = [] {
        didSet { if isViewLoaded { webView.setHostActions(hostActions) } }
    }

    /// How much of the viewer this host wants: `"full"` for the app, `"preview"` for the
    /// Quick Look panel, which shows the view controls alone — no tools, no parts list, no
    /// details readout. Both run the same page, so the two never drift apart.
    public var chrome: String = "full" {
        didSet { if isViewLoaded { webView.setChrome(chrome) } }
    }

    /// Called when the palette runs one of `hostActions`.
    public var onHostAction: ((String) -> Void)?

    /// Opens the command palette — for a menu item, since a key equivalent is taken by the
    /// menu before the page ever sees it.
    @objc public func showCommandPalette(_ sender: Any?) {
        webView.openPalette()
    }

    /// Where the geometry comes from — in-process for an app, over XPC for an extension.
    public var geometryProvider: GeometryProvider?

    /// Pin the root view to whatever it is added to, for a host that does not size it itself.
    ///
    /// Quick Look needs this. A window must not have it: AppKit adds a content view to the
    /// window's private frame view, which spans the *whole* window — so pinning to it stretches
    /// the view over the title bar and the resize borders, and the web view then swallows the
    /// drags that would move or resize the window.
    public var pinsToHostView = false {
        didSet {
            // isViewLoaded, not viewIfLoaded: the latter is macOS 14+, we target 13.
            if isViewLoaded { (view as? RootView)?.pinsToHostView = pinsToHostView }
        }
    }

    /// Quick Look failures are otherwise invisible — this is the only trace left behind.
    /// Read with: log show --last 5m --predicate 'subsystem == "com.greegus.OpenSCADViewer"'
    private static let log = Logger(subsystem: "com.greegus.OpenSCADViewer", category: "preview")


    /// Standard viewing directions.


    private let webView = ScadWebView(frame: .zero)
    private let spinner = NSProgressIndicator()
    private let message = NSTextField(labelWithString: "")
    private var fileURL: URL?
    private var probe: WebGLProbe?
    private var meshLoaded = false

    public override func loadView() {
        let root = RootView(frame: NSRect(x: 0, y: 0, width: 800, height: 620))

        webView.translatesAutoresizingMaskIntoConstraints = false
        // Content must not dictate the size, or Quick Look builds a view larger than the panel.
        for axis in [NSLayoutConstraint.Orientation.horizontal, .vertical] {
            webView.setContentCompressionResistancePriority(.defaultLow, for: axis)
            webView.setContentHuggingPriority(.defaultLow, for: axis)
        }

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false

        message.translatesAutoresizingMaskIntoConstraints = false
        message.textColor = .secondaryLabelColor
        message.alignment = .center
        message.isHidden = true

        // One stack for the whole control row: it stays centred while it fits and clamps to
        // the left edge when it does not, rather than being cut off on both sides.
        // The tools (Inspect, Measure, Section) live in the page, as a floating panel at the
        // bottom of the view, so their state and their look stay with the tools themselves.
        // The viewer tells us when the camera has been rotated off a preset direction.
        webView.onMessage = { [weak self] text in
            guard let self else { return }
            if text.hasPrefix("action: ") {
                let id = String(text.dropFirst("action: ".count))
                DispatchQueue.main.async { self.onHostAction?(id) }
            }
        }
        webView.setHostActions(hostActions)
        webView.setChrome(chrome)

        // Every control lives in the page now — the tools at the bottom, display, projection and
        // the view cube at the top right — so the web view fills the whole panel.
        let subviews: [NSView] = [webView, spinner, message]
        for v in subviews { root.addSubview(v) }

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: root.topAnchor, constant: 8),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 8),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -8),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -8),
            spinner.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            message.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            message.centerYAnchor.constraint(equalTo: root.centerYAnchor),
        ])

        // We do not dictate a default window size at all — Quick Look derives the panel itself
        // and our view pins to it. Every attempt to fix a size here (preferredContentSize as
        // well as our own constraints) overrode the pinning and the view stopped tracking the window.
        root.pinsToHostView = pinsToHostView
        root.autoresizingMask = [.width, .height]   // how a window sizes us
        view = root
        if WebGLProbe.isEnabled {
            let probe = WebGLProbe()
            self.probe = probe
            probe.run(in: root)
        }
        Self.log.info("loadView finished")
    }

    public override func viewDidLayout() {
        super.viewDidLayout()
        // Make the area Quick Look actually gave us visible in the log.
        Self.log.info("layout: view \(NSStringFromRect(self.view.bounds), privacy: .public) host \(NSStringFromRect(self.view.superview?.bounds ?? .zero), privacy: .public)")
    }

    // MARK: - QLPreviewingController

    public func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
        fileURL = url
        Self.log.info("preparePreview: \(url.path, privacy: .public)")
        // Return immediately; the render finishes asynchronously so the panel opens without delay.
        handler(nil)
        loadMesh()
    }

    /// The interactive view needs a real mesh, i.e. a full CGAL render (seconds, not milliseconds).
    private func loadMesh() {
        guard let url = fileURL else { return }
        message.isHidden = true

        if meshLoaded { return }
        guard let provider = geometryProvider else {
            show(error: "no geometry provider was set")
            return
        }
        spinner.startAnimation(nil)

        provider.materials(for: url) { [weak self] result in
            guard let self else { return }
            self.spinner.stopAnimation(nil)
            switch result {
            case .success(let data):
                Self.log.info("materials ok: \(data.count) B")
                self.meshLoaded = true
                self.webView.show(materials: data)
            case .failure(let error):
                Self.log.error("mesh failed: \(error.localizedDescription, privacy: .public)")
                self.show(error: error.localizedDescription)
            }
        }
    }

    /// Spinner plus a line of text, for work the viewer itself did not start — an export, say.
    public func showBusy(_ text: String) {
        message.stringValue = text
        message.isHidden = false
        spinner.startAnimation(nil)
    }

    public func hideBusy() {
        spinner.stopAnimation(nil)
        message.isHidden = true
    }

    private func show(error text: String) {
        message.stringValue = "Could not export the mesh:\n\(text)"
        message.isHidden = false
    }

    /// Re-renders from disk — for a file that changed under us, or on demand.
    public func reload() {
        meshLoaded = false
        loadMesh()
    }

    /// Cmd-R: re-read the file and put the view back the way it opened — hidden pieces
    /// restored, camera reframed. Deliberately more than `reload`, which only refreshes
    /// geometry when the file changes underneath.
    @objc public func reloadModel(_ sender: Any?) {
        webView.resetView()
        reload()
    }
}
