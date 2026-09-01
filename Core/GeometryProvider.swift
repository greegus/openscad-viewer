import Foundation

/// How the viewer asks for geometry, without knowing who renders it.
///
/// This exists because the two hosts have opposite constraints. A Quick Look extension must
/// be sandboxed and therefore cannot spawn OpenSCAD, so it goes through XPC to an unsandboxed
/// helper. A normal app has no such limit and can render in-process. Both hand the viewer the
/// same bytes, so the difference belongs behind this protocol rather than inside the view
/// controller — which is where it used to live.
public protocol GeometryProvider: AnyObject {

    /// One mesh per material, packed as `[4-byte LE header length][header JSON][STL blobs]`.
    /// See `ScadRenderer.exportMaterials` for the layout.
    func materials(for url: URL, completion: @escaping (Result<Data, Error>) -> Void)

    /// The whole design as one STL. Colour is lost — the format has no notion of it — so this
    /// is for handing geometry to something else, not for the viewer.
    func mesh(for url: URL, completion: @escaping (Result<Data, Error>) -> Void)
}

public enum GeometryError: LocalizedError {
    case failed(String)

    public var errorDescription: String? {
        switch self {
        case .failed(let message): return message
        }
    }
}

/// Renders in this process. Used by the standalone app, where nothing forbids it.
public final class LocalGeometryProvider: GeometryProvider {

    private let queue = DispatchQueue(label: "scad.geometry", qos: .userInitiated)

    public init() {}

    public func materials(for url: URL, completion: @escaping (Result<Data, Error>) -> Void) {
        run(completion) { try ScadRenderer.exportMaterials(for: url) }
    }

    public func mesh(for url: URL, completion: @escaping (Result<Data, Error>) -> Void) {
        run(completion) { try ScadRenderer.exportMesh(for: url) }
    }

    private func run(_ completion: @escaping (Result<Data, Error>) -> Void,
                     _ work: @escaping () throws -> Data) {
        queue.async {
            let result = Result { try work() }
            DispatchQueue.main.async { completion(result) }
        }
    }
}
