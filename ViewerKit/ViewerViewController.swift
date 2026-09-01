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

    /// Camera projection. Isometric is orthographic: parallel edges stay parallel, so
    /// thicknesses can be compared across the model without foreshortening.
    private static let projections: [(title: String, id: String)] = [
        ("Persp", "perspective"),
        ("Iso", "isometric"),
    ]

    /// Standard viewing directions.
    /// The initial camera is a three-quarter view, which is not one of these — so the picker
    /// starts with nothing selected rather than claiming a direction the camera is not on.
    private static let views: [(title: String, id: String)] = [
        ("Front", "front"), ("Back", "back"),
        ("Left", "left"), ("Right", "right"),
        ("Top", "top"), ("Bottom", "bottom"),
    ]

    /// Inspection tools. Mutually exclusive, and both can be off.
    private static let tools: [(title: String, id: String)] = [
        ("Inspect", "inspect"),
        ("Measure", "measure"),
    ]

    /// 3D display modes. Adding another (wireframe, section) is one line here and in index.html.
    private static let modes: [(title: String, id: String)] = [
        ("Solid", "normal"),
        ("X-ray", "xray"),
    ]

    private let webView = ScadWebView(frame: .zero)
    private var modePicker: NSSegmentedControl!
    private var toolPicker: NSSegmentedControl!
    private var controlRow: NSStackView!
    private var projectionPicker: NSSegmentedControl!
    private var viewPicker: NSSegmentedControl!
    private var edgesToggle: NSButton!
    private var piecesToggle: NSButton!
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

        // Display mode.
        modePicker = NSSegmentedControl(labels: Self.modes.map(\.title), trackingMode: .selectOne,
                                        target: self, action: #selector(changeDisplayMode))
        modePicker.selectedSegment = 0
        modePicker.translatesAutoresizingMaskIntoConstraints = false

        projectionPicker = NSSegmentedControl(labels: Self.projections.map(\.title),
                                              trackingMode: .selectOne,
                                              target: self, action: #selector(changeProjection))
        projectionPicker.selectedSegment = 1      // isometric by default

        viewPicker = NSSegmentedControl(labels: Self.views.map(\.title), trackingMode: .selectOne,
                                        target: self, action: #selector(changeViewDirection))
        viewPicker.selectedSegment = -1
        viewPicker.translatesAutoresizingMaskIntoConstraints = false
        projectionPicker.translatesAutoresizingMaskIntoConstraints = false

        edgesToggle = NSButton(checkboxWithTitle: "Edges", target: self, action: #selector(toggleEdges))
        edgesToggle.state = .on          // matches the viewer's default
        edgesToggle.translatesAutoresizingMaskIntoConstraints = false

        piecesToggle = NSButton(checkboxWithTitle: "Parts", target: self, action: #selector(togglePieces))
        piecesToggle.state = .on          // matches the viewer's default
        piecesToggle.translatesAutoresizingMaskIntoConstraints = false

        // A toggle-button group rather than a picker: either tool can be switched off again,
        // so `.selectAny` plus mutual exclusion in the action, not `.selectOne`.
        toolPicker = NSSegmentedControl(labels: Self.tools.map(\.title), trackingMode: .selectAny,
                                        target: self, action: #selector(changeTool))
        toolPicker.translatesAutoresizingMaskIntoConstraints = false

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
        controlRow = NSStackView(views: [modePicker, projectionPicker, viewPicker,
                                         edgesToggle, piecesToggle, toolPicker])
        controlRow.orientation = .horizontal
        controlRow.alignment = .centerY
        controlRow.spacing = 10
        controlRow.setCustomSpacing(14, after: viewPicker)
        controlRow.setCustomSpacing(14, after: piecesToggle)
        controlRow.translatesAutoresizingMaskIntoConstraints = false

        // The viewer tells us when the camera has been rotated off a preset direction.
        webView.onMessage = { [weak self] text in
            guard text == "view: none" else { return }
            DispatchQueue.main.async { self?.viewPicker.selectedSegment = -1 }
        }

        let subviews: [NSView] = [webView, controlRow, spinner, message]
        for v in subviews { root.addSubview(v) }

        // Centred, but never past the left edge. The left clamp is required and the right one
        // optional, so a row too wide for the panel gives way on the right — where the tools
        // matter least — instead of hiding the mode picker off-screen on the left.
        let centred = controlRow.centerXAnchor.constraint(equalTo: root.centerXAnchor)
        centred.priority = .defaultHigh
        let rightEdge = controlRow.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor,
                                                            constant: -8)
        rightEdge.priority = .defaultLow

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: root.topAnchor, constant: 8),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 8),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -8),
            webView.bottomAnchor.constraint(equalTo: controlRow.topAnchor, constant: -8),
            controlRow.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
            controlRow.leadingAnchor.constraint(greaterThanOrEqualTo: root.leadingAnchor, constant: 8),
            centred,
            rightEdge,
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
        Self.log.info("layout: view \(NSStringFromRect(self.view.bounds), privacy: .public) host \(NSStringFromRect(self.view.superview?.bounds ?? .zero), privacy: .public) controls \(NSStringFromRect(self.controlRow.frame), privacy: .public)")
    }

    // MARK: - QLPreviewingController

    public func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
        fileURL = url
        Self.log.info("preparePreview: \(url.path, privacy: .public)")
        // Return immediately; the render finishes asynchronously so the panel opens without delay.
        handler(nil)
        loadMesh()
    }

    @objc private func toggleEdges() {
        webView.setEdges(edgesToggle.state == .on)
    }

    @objc private func changeProjection() {
        webView.setProjection(Self.projections[projectionPicker.selectedSegment].id)
    }

    @objc private func changeViewDirection() {
        let index = viewPicker.selectedSegment
        guard Self.views.indices.contains(index) else { return }
        webView.setView(Self.views[index].id)
    }

    @objc private func togglePieces() {
        webView.setPieces(piecesToggle.state == .on)
    }

    @objc private func changeTool() {
        // Turning one on turns the other off; turning the active one off leaves no tool.
        let selected = toolPicker.selectedSegment
        for index in Self.tools.indices where index != selected {
            toolPicker.setSelected(false, forSegment: index)
        }
        let active = toolPicker.isSelected(forSegment: selected) ? Self.tools[selected].id : "none"
        webView.setTool(active)
    }

    @objc private func changeDisplayMode() {
        webView.setMode(Self.modes[modePicker.selectedSegment].id)
    }

    /// The interactive view needs a real mesh, i.e. a full CGAL render (seconds, not milliseconds).
    private func loadMesh() {
        guard let url = fileURL else { return }
        message.isHidden = true
        webView.setMode(Self.modes[max(modePicker.selectedSegment, 0)].id)

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
