import AppKit
import WebKit
import os

/// Diagnostic: checks whether WKWebView and WebGL work inside the sandboxed Quick Look extension.
/// Off by default; to measure, flip `isEnabled` to `true`, rebuild and install.
/// Requires the `com.apple.security.network.client` entitlement (see Thumbnail.entitlements).
final class WebGLProbe: NSObject, WKScriptMessageHandler, WKNavigationDelegate {

    private static let log = Logger(subsystem: "com.greegus.OpenSCADViewer", category: "webgl")

    /// A sandboxed appex does not read the global preferences domain, so a `defaults write`
    /// switch does not work here — flip this to `true` and rebuild instead.
    static var isEnabled: Bool { false }

    private var webView: WKWebView?

    /// Inserts a probe WKWebView into the given view and writes the result to the log.
    func run(in parent: NSView) {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "probe")

        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 256, height: 256), configuration: config)
        web.navigationDelegate = self
        parent.addSubview(web, positioned: .below, relativeTo: nil)
        webView = web
        Self.log.info("WKWebView created")

        // No network — everything inline, no CDN (it would be blocked in the extension anyway).
        web.loadHTMLString("""
        <!doctype html><meta charset="utf-8">
        <canvas id="c" width="128" height="128"></canvas>
        <script>
        function report(o) { window.webkit.messageHandlers.probe.postMessage(JSON.stringify(o)); }
        try {
          const c = document.getElementById('c');
          const gl = c.getContext('webgl2') || c.getContext('webgl');
          if (!gl) { report({ webgl: false, reason: 'kontext sa nevytvoril' }); }
          else {
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            // clear once, so it is clear the context really draws
            gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
            const px = new Uint8Array(4);
            gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            report({
              webgl: true,
              version: gl.getParameter(gl.VERSION),
              renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
              maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
              readPixels: Array.from(px).join(','),
              wasm: typeof WebAssembly === 'object',
              sharedArrayBuffer: typeof SharedArrayBuffer === 'function'
            });
          }
        } catch (e) { report({ webgl: false, reason: String(e) }); }
        </script>
        """, baseURL: nil)
    }

    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        Self.log.info("navigation finished")
        w.evaluateJavaScript("typeof WebAssembly") { value, error in
            Self.log.info("evalJS WebAssembly: \(String(describing: value), privacy: .public) chyba: \(String(describing: error), privacy: .public)")
        }
    }

    func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
        Self.log.error("navigation failed: \(error.localizedDescription, privacy: .public)")
    }

    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        Self.log.error("provisional navigation failed: \(error.localizedDescription, privacy: .public)")
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
        Self.log.error("WebContent process crashed")
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        Self.log.info("WebGL probe: \(String(describing: message.body), privacy: .public)")
    }
}
