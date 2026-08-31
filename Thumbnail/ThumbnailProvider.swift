import AppKit
import QuickLookThumbnailing

/// Sandboxed extension: it may not render itself (it cannot spawn processes),
/// so it asks the helper over XPC.
final class ThumbnailProvider: QLThumbnailProvider {

    override func provideThumbnail(for request: QLFileThumbnailRequest,
                                   _ handler: @escaping (QLThumbnailReply?, Error?) -> Void) {
        let url = request.fileURL
        let side = min(request.maximumSize.width, request.maximumSize.height)
        let canvas = CGSize(width: side, height: side)
        // Render at 2× the logical size so it is not blurry on Retina.
        let pixels = min(1024, max(256, Int(side * request.scale * 2)))
        let source = (try? Data(contentsOf: url)) ?? Data()

        var finished = false
        let done: (NSImage?) -> Void = { image in
            guard !finished else { return }
            finished = true
            let reply = QLThumbnailReply(contextSize: canvas) { () -> Bool in
                Self.drawPage(size: canvas)
                if let image {
                    Self.draw(image: image, in: canvas)
                } else {
                    Self.drawSourceFallback(String(data: source, encoding: .utf8) ?? "", in: canvas)
                }
                return true
            }
            handler(reply, nil)
        }

        let connection = NSXPCConnection(machServiceName: ServiceName.mach, options: [])
        connection.remoteObjectInterface = NSXPCInterface(with: ScadRenderService.self)
        // Helper not running / crashed → do not hang, fall back.
        connection.invalidationHandler = { done(nil) }
        connection.interruptionHandler = { done(nil) }
        connection.resume()

        let proxy = connection.remoteObjectProxyWithErrorHandler { _ in done(nil) } as? ScadRenderService
        guard let proxy else { done(nil); return }

        proxy.render(path: url.path, source: source, size: pixels,
                     camera: ScadRenderer.Options().camera) { data, _ in
            done(data.flatMap(NSImage.init(data:)))
            connection.invalidate()
        }
    }

    // MARK: - Kreslenie

    /// A white "page" with a faint border so the render does not blend into Finder's background.
    private static func drawPage(size: CGSize) {
        let rect = CGRect(origin: .zero, size: size)
        NSColor.white.setFill()
        rect.fill()
        NSColor(white: 0, alpha: 0.18).setStroke()
        let border = NSBezierPath(rect: rect.insetBy(dx: 0.5, dy: 0.5))
        border.lineWidth = 1
        border.stroke()
    }

    private static func draw(image: NSImage, in size: CGSize) {
        let inset = size.width * 0.06
        let box = CGRect(origin: .zero, size: size).insetBy(dx: inset, dy: inset)
        let s = min(box.width / image.size.width, box.height / image.size.height)
        let fitted = CGSize(width: image.size.width * s, height: image.size.height * s)
        image.draw(in: CGRect(x: box.midX - fitted.width / 2, y: box.midY - fitted.height / 2,
                              width: fitted.width, height: fitted.height))
    }

    /// When rendering fails (script error, OpenSCAD missing), at least show the start of the source.
    private static func drawSourceFallback(_ source: String, in size: CGSize) {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false).prefix(14)
        let fontSize = max(3, size.height / 26)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular),
            .foregroundColor: NSColor(white: 0.25, alpha: 1),
        ]
        let inset = size.width * 0.08
        (lines.joined(separator: "\n") as NSString).draw(
            in: CGRect(x: inset, y: inset, width: size.width - 2 * inset, height: size.height - 2 * inset),
            withAttributes: attrs)
    }
}
