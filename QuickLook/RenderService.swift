import Foundation

/// XPC contract between the sandboxed extension and the unsandboxed helper.
/// The extension may not spawn processes, the helper may — hence the split.
@objc public protocol ScadRenderService {
    /// - path:   original path (for relative include/use, and for the cache key)
    /// - source: file contents; the helper falls back to these if it cannot see the path (TCC)
    func render(path: String,
                source: Data,
                size: Int,
                camera: String,
                reply: @escaping (Data?, String?) -> Void)

    /// Exports an STL mesh for the interactive 3D view. Unlike the image preview this is a
    /// full CGAL render — seconds, not milliseconds — so it is separate and cached on its own.
    func exportMesh(path: String,
                    source: Data,
                    reply: @escaping (Data?, String?) -> Void)

    /// One mesh per material. Returns a packed blob: 4-byte LE header length,
    /// header JSON (`{parts:[{color,size}]}`), then the STL blobs back to back.
    func exportMaterials(path: String,
                         source: Data,
                         reply: @escaping (Data?, String?) -> Void)
}

public enum ServiceName {
    public static let mach = "com.greegus.OpenSCADViewer.Renderer"
}
