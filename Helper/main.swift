import Foundation

/// LaunchAgent that runs outside the sandbox and does the actual rendering.
final class RenderService: NSObject, ScadRenderService, NSXPCListenerDelegate {

    func render(path: String, source: Data, size: Int, camera: String,
                reply: @escaping (Data?, String?) -> Void) {
        var options = ScadRenderer.Options()
        options.size = size
        options.camera = camera

        let url = URL(fileURLWithPath: path)
        do {
            // Prefer the original file — that keeps include/use of neighbouring files working.
            if FileManager.default.isReadableFile(atPath: path) {
                reply(try ScadRenderer.renderPNG(for: url, options: options), nil)
                return
            }
            // If we cannot see the file (TCC: Desktop/Documents/…), render a copy of the transferred source.
            reply(try ScadRenderer.renderPNG(fromSource: source, originalPath: path, options: options), nil)
        } catch {
            reply(nil, "\(error)")
        }
    }

    func exportMesh(path: String, source: Data, reply: @escaping (Data?, String?) -> Void) {
        let url = URL(fileURLWithPath: path)
        do {
            if FileManager.default.isReadableFile(atPath: path) {
                reply(try ScadRenderer.exportMesh(for: url), nil)
            } else {
                reply(try ScadRenderer.exportMesh(fromSource: source, originalPath: path), nil)
            }
        } catch {
            reply(nil, "\(error)")
        }
    }

    func exportMaterials(path: String, source: Data, reply: @escaping (Data?, String?) -> Void) {
        let url = URL(fileURLWithPath: path)
        do {
            if FileManager.default.isReadableFile(atPath: path) {
                reply(try ScadRenderer.exportMaterials(for: url), nil)
            } else {
                reply(try ScadRenderer.exportMaterials(fromSource: source, originalPath: path), nil)
            }
        } catch {
            reply(nil, "\(error)")
        }
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection conn: NSXPCConnection) -> Bool {
        conn.exportedInterface = NSXPCInterface(with: ScadRenderService.self)
        conn.exportedObject = self
        conn.resume()
        return true
    }
}

let delegate = RenderService()
let listener = NSXPCListener(machServiceName: ServiceName.mach)
listener.delegate = delegate
listener.resume()
RunLoop.main.run()
