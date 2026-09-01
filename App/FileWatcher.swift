import Foundation

/// Calls back when a file changes on disk.
///
/// Watches the file *and* its directory, because editors save in two different ways and each
/// watch alone misses one of them — measured, not assumed:
///
///   - writing in place changes the file's contents but not its directory, so a directory
///     watch never fires;
///   - saving atomically writes a temp file and renames it over the original, which replaces
///     the inode and leaves a file watch pointing at something nobody will write to again.
///
/// So the directory watch is what survives a replacement, and it re-arms the file watch on the
/// new inode.
final class FileWatcher {

    private let url: URL
    private let onChange: () -> Void
    private var directorySource: DispatchSourceFileSystemObject?
    private var fileSource: DispatchSourceFileSystemObject?
    private var pending: DispatchWorkItem?
    private var lastSeen: (date: Date, size: Int)?

    init(url: URL, onChange: @escaping () -> Void) {
        self.url = url
        self.onChange = onChange
        start()
    }

    deinit { stop() }

    private func start() {
        let directory = url.deletingLastPathComponent().path
        let fd = open(directory, O_EVTONLY)
        guard fd >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in self?.changed() }
        // Closes over its own descriptor rather than reading a property: cancelling runs later
        // on the queue, and by then the property may already hold the descriptor of the watch
        // that replaced this one — which it would then close out from under it.
        source.setCancelHandler { close(fd) }
        source.resume()
        directorySource = source

        lastSeen = stamp()
        watchFile()
    }

    /// The file itself, for a save written straight into the existing inode.
    private func watchFile() {
        fileSource?.cancel()
        fileSource = nil

        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .extend, .attrib, .delete, .rename], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            // Replaced out from under us: this descriptor is now the old inode, so follow the
            // path to the new one. The directory watch reports the same save, hence the delay.
            if source.data.contains(.delete) || source.data.contains(.rename) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.watchFile() }
            }
            self.changed()
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        fileSource = source
    }

    private func stop() {
        pending?.cancel()
        directorySource?.cancel()
        directorySource = nil
        fileSource?.cancel()
        fileSource = nil
    }

    /// Modification date and size together: two saves inside one timestamp tick are common
    /// enough that the date alone would swallow the second one.
    private func stamp() -> (date: Date, size: Int)? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let date = attributes[.modificationDate] as? Date else { return nil }
        return (date, (attributes[.size] as? Int) ?? 0)
    }

    /// A single save can produce several events, from both watches, and a large model costs seconds to
    /// render — so coalesce, and only act when our file's mtime actually moved.
    private func changed() {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let now = self.stamp() else { return }
            guard now.date != self.lastSeen?.date || now.size != self.lastSeen?.size else { return }
            self.lastSeen = now
            self.onChange()
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }
}
