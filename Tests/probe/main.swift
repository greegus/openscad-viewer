import AppKit
import WebKit

// Headless probe: opens a .scad in the real ViewerViewController, waits until the model is in,
// evaluates a JavaScript file against the page and prints its result.
//
//     Tests/probe.sh <file.scad> <probe.js>
//
// The script runs inside `(() => { ... })()` and may use `window.debug.*`; whatever it returns
// is printed as JSON. This is how the viewer is measured rather than eyeballed: buffers, faces,
// pixels — see Tests/check.sh for the checks that run on every build.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

func findWebView(_ v: NSView) -> WKWebView? {
    if let w = v as? WKWebView { return w }
    for s in v.subviews { if let w = findWebView(s) { return w } }
    return nil
}

guard CommandLine.arguments.count >= 3,
      let script = try? String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8) else {
    print("usage: probe <file.scad> <probe.js>")
    exit(64)
}

let viewer = ViewerViewController()
viewer.geometryProvider = LocalGeometryProvider()
let window = NSWindow(contentViewController: viewer)
window.setContentSize(NSSize(width: 1000, height: 760))
window.orderBack(nil)
window.contentView?.layoutSubtreeIfNeeded()
viewer.preparePreviewOfFile(at: URL(fileURLWithPath: CommandLine.arguments[1])) { _ in }

let js = script          // a function body: `return` works, and a returned promise is awaited
var waited = 0.0

/// Polls until the page reports pieces, then runs the probe. A render can take a minute the
/// first time (CGAL) and a second from the cache; waiting a fixed time gets one of them wrong.
func poll() {
    guard let web = findWebView(viewer.view) else { print("no webview"); exit(1) }
    web.evaluateJavaScript("window.debug && window.debug.state().status === '' && window.debug.state().pieces > 0") { v, _ in
        if (v as? Bool) == true {
            web.evaluateJavaScript("window.debug.snapshot(); true") { _, _ in
                web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { outcome in
                    var result: Any? = nil
                    switch outcome {
                    case .success(let value): result = value
                    case .failure(let error): print("error: \(error.localizedDescription)"); exit(1)
                    }
                    if let data = try? JSONSerialization.data(withJSONObject: result ?? NSNull(), options: [.fragmentsAllowed]),
                       let text = String(data: data, encoding: .utf8) {
                        print(text)
                    } else {
                        print(result.map { "\($0)" } ?? "null")
                    }
                    exit(0)
                }
            }
        } else {
            waited += 0.5
            if waited > 150 { print("error: model never arrived"); exit(2) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: poll)
        }
    }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: poll)

// Watchdog: a probe whose JavaScript never answers must not live forever. Sixty-five of these
// once piled up and pushed the machine's load average past 70.
DispatchQueue.main.asyncAfter(deadline: .now() + 180) {
    print("error: probe timed out")
    exit(2)
}
app.run()
