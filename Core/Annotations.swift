import Foundation

/// Names for pieces and groups, read from `// @name` and `// @group` comments in the source.
///
/// OpenSCAD keeps no names of its own — a module leaves no trace in the CSG dump and comments
/// are gone from it entirely — so the only place a name can come from is the `.scad` text.
enum Annotations {

    struct Marker {
        var name: String
        /// Enclosing `@group` names, outermost first.
        var groups: [String]
    }

    /// Markers in source order, which is the order OpenSCAD evaluates them in.
    ///
    /// `@group` opens a region and `@endgroup` closes it. A region still open at the end of the
    /// file closes there, so naming the last group without closing it still works.
    static func markers(in source: String) -> [Marker] {
        var groups: [String] = []
        var result: [Marker] = []

        for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
            guard let comment = line.range(of: "//") else { continue }
            let text = line[comment.upperBound...].trimmingCharacters(in: .whitespaces)

            if let name = value(after: "@group", in: text) {
                groups.append(name)
            } else if text.hasPrefix("@endgroup") {
                if !groups.isEmpty { groups.removeLast() }
            } else if let name = value(after: "@name", in: text) {
                result.append(Marker(name: name, groups: groups))
            }
        }
        return result
    }

    private static func value(after tag: String, in text: String) -> String? {
        guard text.hasPrefix(tag) else { return nil }
        let rest = text.dropFirst(tag.count).trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? nil : rest
    }
}
