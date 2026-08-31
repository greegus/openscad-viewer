import Foundation
import AppKit
import CryptoKit

/// Locates the OpenSCAD binary, renders .scad to PNG and caches the result.
/// Shared by the thumbnail and preview extensions.
enum ScadRenderer {

    struct Options {
        var size: Int = 512
        /// --camera=tx,ty,tz,rx,ry,rz,dist ; 0 dist + --viewall = auto-fit
        var camera = "0,0,0,65,0,25,0"
        var colorscheme = "Tomorrow"
        var timeout: TimeInterval = 20
    }

    enum RenderError: Error {
        case openscadNotFound
        case timedOut
        case failed(status: Int32, stderr: String)
    }

    // MARK: - Locating the binary

    /// Order: env var -> user default -> /Applications/OpenSCAD*.app -> homebrew.
    static func locateOpenSCAD() -> String? {
        let fm = FileManager.default

        if let p = ProcessInfo.processInfo.environment["OPENSCAD_PATH"], fm.isExecutableFile(atPath: p) {
            return p
        }
        if let p = UserDefaults(suiteName: Config.suiteName)?.string(forKey: "openscadPath"),
           fm.isExecutableFile(atPath: p) {
            return p
        }

        var candidates = ["/opt/homebrew/bin/openscad", "/usr/local/bin/openscad"]
        for dir in ["/Applications", "\(NSHomeDirectory())/Applications"] {
            let apps = (try? fm.contentsOfDirectory(atPath: dir)) ?? []
            for app in apps where app.hasPrefix("OpenSCAD") && app.hasSuffix(".app") {
                candidates.append("\(dir)/\(app)/Contents/MacOS/OpenSCAD")
            }
        }
        return candidates.first { fm.isExecutableFile(atPath: $0) }
    }

    // MARK: - Cache

    static var cacheDirectory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent(Config.suiteName, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Key = path + mtime + size, the same for every include/use dependency, plus render options.
    /// Thanks to mtime the preview re-renders after editing the file or any library it includes.
    static func cacheKey(for url: URL, options: Options) -> String {
        var raw = stamp(for: url)
        for dep in dependencies(of: url) {
            raw += stamp(for: dep)
        }
        raw += "|\(options.size)|\(options.camera)|\(options.colorscheme)|v2"
        return SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func stamp(for url: URL) -> String {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let size = (attrs?[.size] as? Int) ?? 0
        return "\(url.path)|\(mtime)|\(size)"
    }

    /// Files pulled in via `include <...>` / `use <...>`, recursively.
    /// Only relative paths next to the file are resolved — OPENSCADPATH libraries are ignored,
    /// they rarely change and hashing them would make the cache key too slow.
    static func dependencies(of url: URL, seen: Set<String> = []) -> [URL] {
        guard !seen.contains(url.path), seen.count < 32,
              let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }

        let pattern = try! NSRegularExpression(pattern: #"^\s*(?:include|use)\s*<([^>]+)>"#,
                                               options: [.anchorsMatchLines])
        let ns = text as NSString
        var result: [URL] = []
        var visited = seen.union([url.path])

        for m in pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let rel = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
            let dep = URL(fileURLWithPath: rel, relativeTo: url.deletingLastPathComponent())
                .standardizedFileURL
            guard FileManager.default.isReadableFile(atPath: dep.path),
                  !visited.contains(dep.path) else { continue }
            visited.insert(dep.path)
            result.append(dep)
            for sub in dependencies(of: dep, seen: visited) where !visited.contains(sub.path) {
                visited.insert(sub.path)
                result.append(sub)
            }
        }
        return result
    }

    /// The cache is purely derived data — keep it under a limit, oldest goes first (LRU by mtime).
    static func pruneCache(limitBytes: Int = 200 * 1024 * 1024) {
        removeStaleWorkDirectories()

        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: cacheDirectory, includingPropertiesForKeys: keys) else { return }

        var entries = files.compactMap { url -> (URL, Date, Int)? in
            guard let v = try? url.resourceValues(forKeys: Set(keys)),
                  let date = v.contentModificationDate, let size = v.fileSize else { return nil }
            return (url, date, size)
        }
        var total = entries.reduce(0) { $0 + $1.2 }
        guard total > limitBytes else { return }

        entries.sort { $0.1 < $1.1 }
        for (url, _, size) in entries where total > limitBytes {
            try? FileManager.default.removeItem(at: url)
            total -= size
        }
    }

    // MARK: - Render

    /// Renders the file on disk (the helper can reach the original → include/use works).
    static func renderPNG(for url: URL, options: Options = Options()) throws -> Data {
        try render(input: url,
                   cacheKey: cacheKey(for: url, options: options),
                   options: options)
    }

    /// Renders source transferred over XPC — used when the helper cannot see the original.
    /// Relative include/use does not work here; this is a fallback, not the main path.
    static func renderPNG(fromSource data: Data, originalPath: String,
                          options: Options = Options()) throws -> Data {
        try withSourceCopy(of: data, originalPath: originalPath) { input in
            try render(input: input, cacheKey: digest(of: data, options: options), options: options)
        }
    }

    /// Writes transferred source into a scratch directory and runs `body` against it.
    /// Every `fromSource` entry point needs this, so it lives here rather than three times over.
    static func withSourceCopy<T>(of data: Data, originalPath: String,
                                  _ body: (URL) throws -> T) throws -> T {
        let dir = cacheDirectory.appendingPathComponent("src-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let name = URL(fileURLWithPath: originalPath).lastPathComponent
        let input = dir.appendingPathComponent(name.isEmpty ? "model.scad" : name)
        try data.write(to: input)
        return try body(input)
    }

    /// SHA-256 of the transferred bytes, for keying a cache entry on content alone.
    static func contentKey(of data: Data) -> String {
        var hasher = SHA256()
        hasher.update(data: data)
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func render(input: URL, cacheKey key: String, options: Options) throws -> Data {
        try produce(input: input, cacheKey: key, extension: "png", timeout: options.timeout) { output in
            ["-o", output.path,
             "--autocenter", "--viewall",
             "--camera=\(options.camera)",
             "--imgsize=\(options.size),\(options.size)",
             "--colorscheme=\(options.colorscheme)",
             input.path]
        }
    }

    /// Cache lookup, temp output, watchdogged OpenSCAD run, cache write — the shape every
    /// single-file export shares. `arguments` receives the temp path to write to.
    private static func produce(input: URL, cacheKey key: String, extension ext: String,
                                timeout: TimeInterval,
                                arguments: (URL) -> [String]) throws -> Data {
        let cached = cacheDirectory.appendingPathComponent(key + "." + ext)
        if let data = try? Data(contentsOf: cached), !data.isEmpty { return data }

        guard let openscad = locateOpenSCAD() else { throw RenderError.openscadNotFound }

        // Write to a temp file; only a finished result moves into the cache.
        let tmp = cacheDirectory.appendingPathComponent("tmp-\(UUID().uuidString).\(ext)")
        defer { try? FileManager.default.removeItem(at: tmp) }

        let result = try runProcess(openscad, arguments(tmp),
                                    cwd: input.deletingLastPathComponent(), timeout: timeout)

        // Judged by the output, not the exit status: OpenSCAD reports warnings through it.
        guard let data = try? Data(contentsOf: tmp), !data.isEmpty else {
            throw RenderError.failed(status: result.status, stderr: result.stderr)
        }

        try? data.write(to: cached, options: .atomic)
        pruneCache()
        return data
    }

    /// Work directories are removed by `defer`, which never runs if the helper is killed
    /// mid-render. Anything left over from an earlier run is dead weight, so sweep it.
    private static func removeStaleWorkDirectories() {
        let cutoff = Date().addingTimeInterval(-3600)
        let keys: [URLResourceKey] = [.isDirectoryKey, .contentModificationDateKey]
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: cacheDirectory, includingPropertiesForKeys: keys) else { return }

        for entry in entries {
            let name = entry.lastPathComponent
            guard name.hasPrefix("mat-") || name.hasPrefix("src-"),
                  let values = try? entry.resourceValues(forKeys: Set(keys)),
                  values.isDirectory == true,
                  (values.contentModificationDate ?? .distantPast) < cutoff else { continue }
            try? FileManager.default.removeItem(at: entry)
        }
    }

    private static func digest(of data: Data, options: Options) -> String {
        var hasher = SHA256()
        hasher.update(data: data)
        hasher.update(data: Data("\(options.size)|\(options.camera)|\(options.colorscheme)|v1".utf8))
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Mesh export for the interactive 3D view

extension ScadRenderer {

    /// A CGAL render is far more expensive than an image preview, so it gets a bigger ceiling.
    static let meshTimeout: TimeInterval = 120

    static func exportMesh(for url: URL) throws -> Data {
        try exportMesh(input: url, cacheKey: "mesh-" + cacheKey(for: url, options: Options()))
    }

    static func exportMesh(fromSource data: Data, originalPath: String) throws -> Data {
        try withSourceCopy(of: data, originalPath: originalPath) { input in
            try exportMesh(input: input, cacheKey: "mesh-" + contentKey(of: data))
        }
    }

    private static func exportMesh(input: URL, cacheKey key: String) throws -> Data {
        try produce(input: input, cacheKey: key, extension: "stl", timeout: meshTimeout) { output in
            ["-o", output.path, input.path]
        }
    }
}

// MARK: - Per-material export

extension ScadRenderer {

    /// One mesh per material, packed into a single blob for XPC:
    /// `[4-byte LE header length][header JSON][STL blobs back to back]`.
    /// The header lists `{ color: [r,g,b,a], size }` in blob order.
    static func exportMaterials(for url: URL) throws -> Data {
        try exportMaterials(input: url,
                            cacheKey: "mat-" + cacheKey(for: url, options: Options()))
    }

    static func exportMaterials(fromSource data: Data, originalPath: String) throws -> Data {
        try withSourceCopy(of: data, originalPath: originalPath) { input in
            try exportMaterials(input: input, cacheKey: "mat-" + contentKey(of: data))
        }
    }

    private static func exportMaterials(input: URL, cacheKey key: String) throws -> Data {
        let cached = cacheDirectory.appendingPathComponent(key + ".parts")
        if let data = try? Data(contentsOf: cached), !data.isEmpty { return data }

        guard let openscad = locateOpenSCAD() else { throw RenderError.openscadNotFound }

        let work = cacheDirectory.appendingPathComponent("mat-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: work) }

        // The CSG dump is cheap (~0.2 s) — it is only the evaluated tree, no CGAL.
        // Note: OpenSCAD resolves a relative -o against the input's directory, so always pass absolute.
        let csgFile = work.appendingPathComponent("all.csg")
        try run(openscad, ["--export-format=csg", "-o", csgFile.path, input.path],
                cwd: input.deletingLastPathComponent(), timeout: Options().timeout)

        let text = try String(contentsOf: csgFile, encoding: .utf8)
        let tree = CSGSplitter.parse(text)
        var targets: [[Double]?] = CSGSplitter.materials(in: tree)
        // Geometry with no colour ancestor belongs to a default pass.
        targets.append(nil)

        // One CGAL export per material, run concurrently — wall clock stays at roughly
        // the cost of a single mesh (measured: 6 materials in 3.1 s vs 3.9 s for one mesh).
        var blobs = [Data?](repeating: nil, count: targets.count)
        let lock = NSLock()
        let queue = DispatchQueue(label: "scad.materials", attributes: .concurrent)
        let group = DispatchGroup()
        let limit = DispatchSemaphore(value: 4)

        for (index, target) in targets.enumerated() {
            group.enter()
            queue.async {
                limit.wait()
                defer { limit.signal(); group.leave() }

                let source = work.appendingPathComponent("part\(index).csg")
                let stl = work.appendingPathComponent("part\(index).stl")
                let body = CSGSplitter.emit(tree, target: target)
                guard (try? body.write(to: source, atomically: true, encoding: .utf8)) != nil,
                      (try? run(openscad, ["-o", stl.path, source.path], cwd: work, timeout: meshTimeout)) != nil,
                      let data = try? Data(contentsOf: stl), data.count > 84 else { return }

                lock.lock(); blobs[index] = data; lock.unlock()
            }
        }
        group.wait()

        // Drop empty passes — most designs have no uncoloured leftovers.
        var header: [[String: Any]] = []
        var payload = Data()
        for (index, target) in targets.enumerated() {
            guard let blob = blobs[index] else { continue }
            header.append(["color": target ?? [0.78, 0.78, 0.78, 1.0], "size": blob.count])
            payload.append(blob)
        }
        guard !header.isEmpty else { throw RenderError.failed(status: -1, stderr: "no material produced geometry") }

        // The piece outlines ride along in the same header — they are derived from the CSG
        // we already have, so they cost nothing extra.
        func encode(_ b: CSGSplitter.Box) -> [String: Any] {
            ["matrix": b.matrix, "size": b.size, "centered": b.centered]
        }
        // OpenSCAD keeps no object identity — the CSG dump has only geometry and operator
        // nodes, no module names — so the id is ours: the index after merging, which is
        // deterministic for a given design.
        let pieces = CSGSplitter.components(in: tree).enumerated().map { index, component -> [String: Any] in
            var entry = encode(component.box)
            entry["id"] = index + 1
            if !component.cutters.isEmpty { entry["cutters"] = component.cutters.map(encode) }
            return entry
        }
        let json = try JSONSerialization.data(withJSONObject: ["parts": header, "components": pieces])
        var out = Data()
        var length = UInt32(json.count).littleEndian
        withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
        out.append(json)
        out.append(payload)

        try? out.write(to: cached, options: .atomic)
        pruneCache()
        return out
    }

    /// Runs a process with a watchdog. Throws only on timeout — the exit status is returned,
    /// because OpenSCAD reports warnings through it and callers judge success differently.
    @discardableResult
    static func runProcess(_ binary: String, _ arguments: [String],
                           cwd: URL, timeout: TimeInterval) throws -> (status: Int32, stderr: String) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binary)
        proc.arguments = arguments
        proc.currentDirectoryURL = cwd
        let errPipe = Pipe()
        proc.standardError = errPipe
        proc.standardOutput = Pipe()
        try proc.run()

        // Watchdog: a stuck or endless render must not hold up Finder.
        let deadline = Date().addingTimeInterval(timeout)
        while proc.isRunning && Date() < deadline { usleep(50_000) }
        if proc.isRunning {
            proc.terminate()
            usleep(200_000)
            if proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
            throw RenderError.timedOut
        }

        let stderr = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (proc.terminationStatus, stderr)
    }

    /// As `runProcess`, but a non-zero exit is an error — for steps with no output file to judge.
    @discardableResult
    private static func run(_ binary: String, _ arguments: [String],
                            cwd: URL, timeout: TimeInterval) throws -> String {
        let result = try runProcess(binary, arguments, cwd: cwd, timeout: timeout)
        guard result.status == 0 else {
            throw RenderError.failed(status: result.status, stderr: result.stderr)
        }
        return result.stderr
    }
}
