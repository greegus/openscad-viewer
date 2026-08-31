import Foundation

/// Renders through the unsandboxed helper. Used by the Quick Look extensions, which may not
/// spawn a process themselves.
///
/// A connection per request on purpose: these are one-shot, seconds apart at most, and a
/// long-lived connection would have to be revalidated after the helper is idled out by launchd.
final class XPCGeometryProvider: GeometryProvider {

    func materials(for url: URL, completion: @escaping (Result<Data, Error>) -> Void) {
        let source = (try? Data(contentsOf: url)) ?? Data()

        let connection = NSXPCConnection(machServiceName: ServiceName.mach, options: [])
        connection.remoteObjectInterface = NSXPCInterface(with: ScadRenderService.self)
        connection.resume()

        var finished = false
        let finish: (Result<Data, Error>) -> Void = { result in
            guard !finished else { return }      // an error handler may fire after the reply
            finished = true
            DispatchQueue.main.async {
                completion(result)
                connection.invalidate()
            }
        }

        let proxy = connection.remoteObjectProxyWithErrorHandler { error in
            finish(.failure(GeometryError.failed(error.localizedDescription)))
        } as? ScadRenderService

        guard let proxy else {
            finish(.failure(GeometryError.failed("render helper unavailable")))
            return
        }

        proxy.exportMaterials(path: url.path, source: source) { data, error in
            if let data {
                finish(.success(data))
            } else {
                finish(.failure(GeometryError.failed(error ?? "unknown error")))
            }
        }
    }
}
