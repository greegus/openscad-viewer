import Foundation

/// Names for pieces and groups, read from the design's own comments.
///
/// OpenSCAD keeps no object identity — a module leaves no trace in the CSG dump and comments are
/// stripped from it entirely — so names can only come from the `.scad` text:
///
///     // @group Komoda   @repeat pocet_suflikov
///         // @name Rebro <i>   @count podstava_rebra
///     // @endgroup
///
/// Markers are matched to geometry by order, which is why `@count` and `@repeat` matter: a
/// statement inside a loop or behind a condition produces a number of pieces the comment alone
/// cannot reveal, and without that number every name after it would be off by however many were
/// missed. Both carry OpenSCAD expressions over the design's own variables, so the design has to
/// be asked for their values — see `ScadRenderer.markerValues`.
enum Annotations {

    struct Marker {
        var name: String
        /// Enclosing `@group` names, outermost first.
        var groups: [String]
        /// Expression for how many pieces the next statement makes; nil means one.
        var count: String?
    }

    struct Group {
        var name: String
        /// Expression for how many times the whole group repeats; nil means once.
        var repeats: String?
    }

    /// Markers in source order, which is the order OpenSCAD evaluates them in.
    static func markers(in source: String) -> [Marker] {
        var open: [Group] = []
        var result: [Marker] = []
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false)

        /// A real `@name` sits directly above the statement it names. A design that documents
        /// the convention writes the same words in prose, and that prose has only more comments
        /// under it — which is what tells the two apart.
        func namesSomething(after index: Int) -> Bool {
            for offset in 1...2 where index + offset < lines.count {
                let next = lines[index + offset].trimmingCharacters(in: .whitespaces)
                if !next.isEmpty && !next.hasPrefix("//") { return true }
            }
            return false
        }

        for (index, line) in lines.enumerated() {
            guard let comment = line.range(of: "//") else { continue }
            let text = line[comment.upperBound...].trimmingCharacters(in: .whitespaces)

            if let (name, extra) = tagged("@group", in: text) {
                open.append(Group(name: name, repeats: value(of: "@repeat", in: extra)))
            } else if text.hasPrefix("@endgroup") {
                if !open.isEmpty { open.removeLast() }
            } else if let (name, extra) = tagged("@name", in: text), namesSomething(after: index) {
                result.append(Marker(name: name, groups: open.map(\.name),
                                     count: value(of: "@count", in: extra)))
            }
        }
        return result
    }

    /// Groups in source order, so their `@repeat` counts can be looked up.
    static func groups(in source: String) -> [Group] {
        var result: [Group] = []
        for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
            guard let comment = line.range(of: "//") else { continue }
            let text = line[comment.upperBound...].trimmingCharacters(in: .whitespaces)
            if text.contains("<Meno>") || text.contains("<výraz>") { continue }
            if let (name, extra) = tagged("@group", in: text) {
                result.append(Group(name: name, repeats: value(of: "@repeat", in: extra)))
            }
        }
        return result
    }

    /// Every expression the design asks us to evaluate, deduplicated.
    ///
    /// Placeholders inside a name count too: `Zadná stena (polia 1–<zs_poli>)` names a model
    /// variable, not a loop index, and only the design knows what it holds.
    static func expressions(in source: String) -> [String] {
        var seen: [String] = []
        let all = markers(in: source).compactMap(\.count)
            + groups(in: source).compactMap(\.repeats)
            + markers(in: source).flatMap { placeholders(in: $0.name) }
        for e in all where !seen.contains(e) { seen.append(e) }
        return seen
    }

    /// `<name>` placeholders, minus the loop indices the generator fills in.
    static func placeholders(in name: String) -> [String] {
        var result: [String] = []
        var rest = Substring(name)
        while let open = rest.firstIndex(of: "<"), let close = rest[open...].firstIndex(of: ">") {
            let inner = String(rest[rest.index(after: open)..<close])
            if inner != "i" && inner != "k" && !inner.isEmpty { result.append(inner) }
            rest = rest[rest.index(after: close)...]
        }
        return result
    }

    /// One entry per piece the design expects to produce, in evaluation order.
    ///
    /// A marker with `@count 3` claims three pieces and numbers them, substituting `<i>` and
    /// `<k>`; one with `@count 0` claims none, which is how a switched-off feature stays out of
    /// the way instead of stealing the next piece's name. A group with `@repeat 4` contributes
    /// its whole run four times.
    static func expand(_ source: String, values: [String: Int]) -> [Marker] {
        let repeats = Dictionary(groups(in: source).map { ($0.name, $0.repeats) },
                                 uniquingKeysWith: { first, _ in first })
        var result: [Marker] = []

        for marker in markers(in: source) {
            let times = marker.groups
                .compactMap { repeats[$0] ?? nil }
                .compactMap { values[$0] }
                .reduce(1, *)
            let count = marker.count.flatMap { values[$0] } ?? (marker.count == nil ? 1 : 0)

            for pass in 0..<max(times, 0) {
                for index in 0..<max(count, 0) {
                    result.append(Marker(name: numbered(marker.name, index + 1, pass + 1, values),
                                         groups: marker.groups, count: nil))
                }
            }
        }
        return result
    }

    private static func numbered(_ name: String, _ i: Int, _ k: Int,
                                 _ values: [String: Int] = [:]) -> String {
        var result = name
            .replacingOccurrences(of: "<i>", with: String(i))
            .replacingOccurrences(of: "<k>", with: String(k))
        for placeholder in placeholders(in: result) {
            if let value = values[placeholder] {
                result = result.replacingOccurrences(of: "<\(placeholder)>", with: String(value))
            }
        }
        return result
    }

    /// `@tag value` at the start, plus whatever follows for further tags on the same line.
    private static func tagged(_ tag: String, in text: String) -> (String, String)? {
        guard text.hasPrefix(tag) else { return nil }
        let rest = text.dropFirst(tag.count).trimmingCharacters(in: .whitespaces)
        guard !rest.isEmpty else { return nil }

        // A second tag ends the name; so does a trailing comment.
        var name = rest
        var extra = ""
        if let at = rest.range(of: "@") {
            name = String(rest[..<at.lowerBound])
            extra = String(rest[at.lowerBound...])
        }
        if let slashes = name.range(of: "//") { name = String(name[..<slashes.lowerBound]) }
        return (name.trimmingCharacters(in: .whitespaces), extra)
    }

    private static func value(of tag: String, in text: String) -> String? {
        guard let at = text.range(of: tag) else { return nil }
        var rest = String(text[at.upperBound...]).trimmingCharacters(in: .whitespaces)
        if let slashes = rest.range(of: "//") {
            rest = String(rest[..<slashes.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        return rest.isEmpty ? nil : rest
    }
}
