import AppKit
import QuickLookUI
import os

/// Quick Look preview (spacebar in Finder): interactive 3D with display modes and tools.
/// Quick Look sizes our view itself and `autoresizingMask` is not enough for that —
/// the root can grow beyond the panel (the controls then fall off the right edge).
/// So we pin ourselves to the host view with constraints.
private final class RootView: NSView {
    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        guard let host = superview else { return }
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: host.leadingAnchor),
            trailingAnchor.constraint(equalTo: host.trailingAnchor),
            topAnchor.constraint(equalTo: host.topAnchor),
            bottomAnchor.constraint(equalTo: host.bottomAnchor),
        ])
    }
}

final class PreviewViewController: NSViewController, QLPreviewingController {

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
        ("Front", "front"), ("Left", "left"), ("Right", "right"), ("Top", "top"),
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

    override func loadView() {
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
        root.autoresizingMask = [.width, .height]   // fallback until there is a superview
        view = root
        // Quick Look ignores the root's own frame — measured: the panel stayed 800×600 no
        // matter what we set — but it does honour this. 20 % above that default.
        preferredContentSize = NSSize(width: 960, height: 720)
        if WebGLProbe.isEnabled {
            let probe = WebGLProbe()
            self.probe = probe
            probe.run(in: root)
        }
        Self.log.info("loadView finished")
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        // Make the area Quick Look actually gave us visible in the log.
        Self.log.info("layout: view \(NSStringFromRect(self.view.bounds), privacy: .public) host \(NSStringFromRect(self.view.superview?.bounds ?? .zero), privacy: .public) controls \(NSStringFromRect(self.controlRow.frame), privacy: .public)")
    }

    // MARK: - QLPreviewingController

    func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
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
        spinner.startAnimation(nil)

        let source = (try? Data(contentsOf: url)) ?? Data()
        let connection = NSXPCConnection(machServiceName: ServiceName.mach, options: [])
        connection.remoteObjectInterface = NSXPCInterface(with: ScadRenderService.self)
        connection.resume()

        let finish: (Data?, String?) -> Void = { [weak self] data, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.spinner.stopAnimation(nil)
                if let data {
                    Self.log.info("materials ok: \(data.count) B")
                    self.meshLoaded = true
                    self.webView.show(materials: data)
                } else {
                    Self.log.error("mesh zlyhal: \(error ?? "-", privacy: .public)")
                    self.message.stringValue = "Could not export the mesh:\n\(error ?? "unknown error")"
                    self.message.isHidden = false
                }
                connection.invalidate()
            }
        }

        let proxy = connection.remoteObjectProxyWithErrorHandler { err in
            finish(nil, err.localizedDescription)
        } as? ScadRenderService
        proxy?.exportMaterials(path: url.path, source: source) { data, error in finish(data, error) }
    }

}
