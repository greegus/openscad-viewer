import AppKit
import WebKit
import os

/// Interactive 3D in a WKWebView (Three.js). It replaced SceneKit because of materials:
/// three.js can load per-object colours, which STL + SceneKit cannot express.
///
/// Content is served through a custom scheme rather than loadHTMLString: relative ESM imports
/// (`import ... from 'three'`) need resolvable URLs, and the scheme also lets us add
/// COOP/COEP headers later should SharedArrayBuffer ever be needed.
final class ScadWebView: NSView, WKScriptMessageHandler, WKNavigationDelegate {

    static let scheme = "scadview"
    private static let log = Logger(subsystem: "com.greegus.ScadQuickLook", category: "webview")

    private let handler = ResourceHandler()
    private var webView: WKWebView!
    private var pendingMode: String?
    private var pendingTool: String?
    private var pendingEdges: Bool?
    private var pendingPieces: Bool?
    private var pendingProjection: String?
    private var pendingView: String?

    /// Messages the page sends back, so the controls can follow what the viewer is doing.
    var onMessage: ((String) -> Void)?
    private var loaded = false

    override init(frame: NSRect) {
        super.init(frame: frame)

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(handler, forURLScheme: Self.scheme)
        config.userContentController.add(self, name: "viewer")

        webView = WKWebView(frame: bounds, configuration: config)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.allowsMagnification = false
        addSubview(webView)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Hands over one mesh per material and loads the page.
    /// The blob is `[4-byte LE header length][header JSON][STL blobs]` — see ScadRenderer.
    func show(materials blob: Data) {
        guard blob.count > 4 else { return }
        let length = Int(blob.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian })
        guard blob.count > 4 + length,
              let header = try? JSONSerialization.jsonObject(with: blob.subdata(in: 4..<(4 + length))) as? [String: Any],
              let entries = header["parts"] as? [[String: Any]] else { return }

        var offset = 4 + length
        var manifest: [[String: Any]] = []
        let components = header["components"] as? [[String: Any]] ?? []
        var blobs: [Data] = []
        for entry in entries {
            guard let size = entry["size"] as? Int, offset + size <= blob.count else { break }
            blobs.append(blob.subdata(in: offset..<(offset + size)))
            manifest.append(["color": entry["color"] ?? [0.78, 0.78, 0.78, 1.0]])
            offset += size
        }
        handler.parts = blobs
        handler.manifest = (try? JSONSerialization.data(
            withJSONObject: ["parts": manifest, "components": components]))
        reloadOrLoad()
    }

    /// Fallback path: a single colourless mesh.
    func show(mesh: Data) {
        handler.mesh = mesh
        handler.manifest = nil
        handler.parts = []
        reloadOrLoad()
    }

    private func reloadOrLoad() {
        if loaded {
            webView.evaluateJavaScript("loadMesh()")
        } else {
            let url = URL(string: "\(Self.scheme)://app/index.html")!
            webView.load(URLRequest(url: url))
        }
    }

    /// Edge overlay on/off. Independent of the display mode.
    func setEdges(_ on: Bool) {
        guard loaded else { pendingEdges = on; return }
        webView.evaluateJavaScript("setEdges(\(on))")
    }

    /// Outline of every individual piece on/off — shows how parts join inside the union.
    func setPieces(_ on: Bool) {
        guard loaded else { pendingPieces = on; return }
        webView.evaluateJavaScript("setPieces(\(on))")
    }

    /// One of the standard viewing directions: "3d", "front", "left", "right", "top".
    func setView(_ name: String) {
        guard loaded else { pendingView = name; return }
        webView.evaluateJavaScript("setView('\(name)')")
    }

    /// "perspective" or "isometric".
    func setProjection(_ kind: String) {
        guard loaded else { pendingProjection = kind; return }
        webView.evaluateJavaScript("setProjection('\(kind)')")
    }

    /// "none" or "measure".
    func setTool(_ tool: String) {
        guard loaded else { pendingTool = tool; return }
        webView.evaluateJavaScript("setTool('\(tool)')")
    }

    /// "normal" or "xray"; stored before the page loads and applied once it finishes.
    func setMode(_ mode: String) {
        guard loaded else { pendingMode = mode; return }
        webView.evaluateJavaScript("setMode('\(mode)')")
    }

    // MARK: - WebKit

    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        loaded = true
        if let mode = pendingMode { setMode(mode); pendingMode = nil }
        if let tool = pendingTool { setTool(tool); pendingTool = nil }
        if let edges = pendingEdges { setEdges(edges); pendingEdges = nil }
        if let pieces = pendingPieces { setPieces(pieces); pendingPieces = nil }
        if let projection = pendingProjection { setProjection(projection); pendingProjection = nil }
        if let name = pendingView { setView(name); pendingView = nil }
    }

    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        Self.log.error("navigation failed: \(e.localizedDescription, privacy: .public)")
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
        Self.log.error("WebContent process crashed")
        loaded = false
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        Self.log.info("viewer: \(String(describing: message.body), privacy: .public)")
        if let text = message.body as? String { onMessage?(text) }
    }
}

/// Serves static files from Web/ inside the appex bundle, plus the mesh from memory.
private final class ResourceHandler: NSObject, WKURLSchemeHandler {

    var mesh: Data?
    var manifest: Data?
    var parts: [Data] = []

    private static let types = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "json": "application/json",
        "stl": "model/stl",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        // "scadview://app/vendor/three.module.min.js" → "vendor/three.module.min.js"
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        let data: Data?
        if path == "mesh.stl" {
            data = mesh
        } else if path == "materials.json" {
            data = manifest
        } else if path.hasPrefix("part"), path.hasSuffix(".stl"),
                  let index = Int(path.dropFirst(4).dropLast(4)), parts.indices.contains(index) {
            data = parts[index]
        } else {
            // SCAD_WEB_DIR is a test hook: the harness runs outside the appex and has no Resources.
            let base = ProcessInfo.processInfo.environment["SCAD_WEB_DIR"].map(URL.init(fileURLWithPath:))
                ?? Bundle(for: ScadWebView.self).resourceURL?.appendingPathComponent("Web")
            // Allow nothing outside Web/ — the scheme is local, but the path comes from JS.
            let file = base?.appendingPathComponent(path).standardizedFileURL
            let inside = file?.path.hasPrefix(base?.standardizedFileURL.path ?? "\u{0}") ?? false
            data = inside ? file.flatMap { try? Data(contentsOf: $0) } : nil
        }

        guard let data else {
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
            return
        }

        let mime = Self.types[url.pathExtension] ?? "application/octet-stream"
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": mime,
                                                      "Content-Length": "\(data.count)"])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
