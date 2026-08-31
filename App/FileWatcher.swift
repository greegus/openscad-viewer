import Foundation

/// Calls back when a file changes on disk.
///
/// Watches the containing directory rather than the file: editors save by writing a temp file
/// and renaming it over the original, which replaces the inode and leaves a file-level watch
/// pointing at something nobody will ever write to again.
final class FileWatcher {

    private let url: URL
    private let onChange: () -> Void
    private var source: DispatchSourceFileSystemObject?
    private var descriptor: CInt = -1
    private var pending: DispatchWorkItem?
    private var lastSeen: Date?

    init(url: URL, onChange: @escaping () -> Void) {
        self.url = url
        self.onChange = onChange
        start()
    }

    deinit { stop() }

    private func start() {
        let directory = url.deletingLastPathComponent().path
        descriptor = open(directory, O_EVTONLY)
        guard descriptor >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in self?.directoryChanged() }
        source.setCancelHandler { [weak self] in
            if let fd = self?.descriptor, fd >= 0 { close(fd) }
            self?.descriptor = -1
        }
        source.resume()
        self.source = source
        lastSeen = modificationDate()
    }

    private func stop() {
        pending?.cancel()
        source?.cancel()
        source = nil
    }

    private func modificationDate() -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }

    /// A single save can produce several directory events, and a large model costs seconds to
    /// render — so coalesce, and only act when our file's mtime actually moved.
    private func directoryChanged() {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let date = self.modificationDate() else { return }
            guard date != self.lastSeen else { return }
            self.lastSeen = date
            self.onChange()
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }
}
