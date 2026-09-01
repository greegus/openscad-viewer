import Foundation

/// Splits an OpenSCAD design into one mesh per material.
///
/// Why this exists: OpenSCAD discards `color()` when exporting meshes — STL has no notion of
/// colour, and 2021.01 writes no materials into 3MF either (verified: not one `basematerial`).
/// The **CSG dump** does keep `color()`, and a CSG dump is itself a valid OpenSCAD program.
/// So we dump the CSG, prune it once per colour, and export each pruned program separately.
enum CSGSplitter {

    struct Material: Equatable {
        var rgba: [Double]          // nil colour (uncoloured geometry) is represented by `nil` material
    }

    // MARK: - Tree

    final class Node {
        let name: String
        let args: String
        var children: [Node] = []
        init(name: String, args: String) { self.name = name; self.args = args }
    }

    /// A CSG dump is regular: `name(args);` or `name(args) { children }`.
    /// Arguments never contain nested parentheses — everything is already evaluated.
    static func parse(_ text: String) -> Node {
        let pattern = try! NSRegularExpression(pattern: #"([A-Za-z_$][\w$]*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(\{|;)"#,
                                               options: [.dotMatchesLineSeparators])
        let ns = text as NSString
        let root = Node(name: "group", args: "")
        var stack = [root]
        var i = 0

        while i < ns.length {
            let range = NSRange(location: i, length: ns.length - i)
            let match = pattern.firstMatch(in: text, range: range)
            let close = ns.range(of: "}", range: range).location

            if match == nil && close == NSNotFound { break }
            // A closing brace before the next node means the current block ends here.
            if close != NSNotFound, match == nil || close < match!.range.location {
                if stack.count > 1 { stack.removeLast() }
                i = close + 1
                continue
            }

            let m = match!
            let node = Node(name: ns.substring(with: m.range(at: 1)),
                            args: ns.substring(with: m.range(at: 2)))
            stack[stack.count - 1].children.append(node)
            if ns.substring(with: m.range(at: 3)) == "{" { stack.append(node) }
            i = m.range.location + m.range.length
        }
        return root
    }

    static func colour(of node: Node) -> [Double]? {
        guard node.name == "color" else { return nil }
        let numbers = node.args.split(whereSeparator: { !"0123456789.-e".contains($0) })
            .compactMap { Double($0) }
        guard numbers.count >= 3 else { return nil }
        return Array(numbers.prefix(4)) + (numbers.count >= 4 ? [] : [1.0])
    }

    /// Distinct colours in tree order, so the output is stable across runs.
    static func materials(in node: Node) -> [[Double]] {
        var found: [[Double]] = []
        func walk(_ n: Node) {
            if let c = colour(of: n), !found.contains(c) { found.append(c) }
            n.children.forEach(walk)
        }
        walk(node)
        return found
    }

    // MARK: - Pruning

    /// Emits the subtree restricted to `target`.
    ///
    /// The one subtlety: in a *subtrahend* position (operands 2..n of a difference, and all
    /// operands of an intersection) nothing may be pruned. Those shapes cut or constrain the
    /// result, so dropping them would leave holes filled in and produce wrong geometry.
    static func emit(_ node: Node, target: [Double]?, subtrahend: Bool = false, depth: Int = 0) -> String {
        let pad = String(repeating: "\t", count: depth)

        if let c = colour(of: node), !subtrahend, c != target {
            return "\(pad)group();\n"       // different material → contribute nothing
        }
        if node.children.isEmpty {
            return "\(pad)\(node.name)(\(node.args));\n"
        }

        var body = ""
        for (index, child) in node.children.enumerated() {
            let sub = subtrahend
                || (node.name == "difference" && index > 0)
                || node.name == "intersection"
            body += emit(child, target: target, subtrahend: sub, depth: depth + 1)
        }
        return "\(pad)\(node.name)(\(node.args)) {\n\(body)\(pad)}\n"
    }
}

// MARK: - Individual pieces

extension CSGSplitter {

    /// One entry per solid primitive, with its accumulated transform.
    struct Box {
        var matrix: [Double]     // 4×4, row-major (matches three.js Matrix4.set)
        var size: [Double]
        var centered: Bool

        /// True when this only *bounds* the real shape — an extruded cutter, say, whose profile
        /// is rounded. Good enough to clip an outline with, but its own edges are not the
        /// shape's edges, so nothing may be drawn from them.
        var approximate = false

        init(matrix: [Double], size: [Double], centered: Bool, approximate: Bool = false) {
            self.matrix = matrix
            self.size = size
            self.centered = centered
            self.approximate = approximate
        }
    }

    struct Component {
        var box: Box
        /// Outline of an extruded piece in the box's own 2D coordinates, when it has one.
        /// A rounded board is not its bounding box, and drawing the box put square corners
        /// where the board is round.
        var profile: [[Double]]?
        /// Boxes removed from this piece by an enclosing `difference()`. The viewer clips the
        /// outline against them, otherwise an edge is drawn straight across a milled groove.
        var cutters: [Box]

        init(box: Box, cutters: [Box], profile: [[Double]]? = nil) {
            self.box = box
            self.cutters = cutters
            self.profile = profile
        }
    }

    /// Recovers the individual pieces the design is built from.
    ///
    /// The union welds touching panels into one body, so a shelf butting into a side panel
    /// leaves no seam — and where faces end up flush, no edge exists in the mesh at all.
    /// The CSG dump still has each piece as its own `cube` under a chain of `multmatrix`,
    /// so we can reconstruct the piece outlines without any extra CGAL work.
    ///
    /// Only the boxes that survive the CSG are recovered — we want the outline of the
    /// *resulting* object, not of the shapes that were combined to make it:
    ///
    /// - operands 2..n of a `difference()` are cutting tools, not pieces; drawing them would
    ///   put boxes where material was removed (9 of 66 cubes in kniznica.scad),
    /// - operands of an `intersection()` each overstate the result, which is only their
    ///   overlap, so no box is emitted for them either.
    ///
    /// A positive operand that gets partly cut still contributes its full box: that is the
    /// piece's overall extent, and the cut itself already shows up in the mesh edges.
    ///
    /// `linear_extrude` is measured rather than skipped: the CSG dump flattens its 2D shape
    /// into explicit polygons, so the outline can simply be read off — see `shape2D`.
    static func components(in node: Node) -> [Component] {
        var result: [Component] = []

        /// Every box under a node, used to collect the cutting tools of a difference.
        func collectBoxes(_ n: Node, _ transform: [Double], into out: inout [Box]) {
            var current = transform
            if n.name == "multmatrix", let m = matrix(from: n.args) {
                current = multiply(transform, m)
            }
            if n.name == "cube", let c = cube(from: n.args) {
                out.append(Box(matrix: current, size: c.size, centered: c.centered))
            }
            // A cut is not always a cube — a drawer's handle is an extruded rounded profile.
            // Without this the front's outline was never clipped and ran straight across the
            // recess. Bounded rather than exact, and flagged as such.
            if n.name == "linear_extrude", let made = extrude(n, current) {
                var box = made.box
                box.approximate = true
                out.append(box)
                return
            }
            for child in n.children { collectBoxes(child, current, into: &out) }
        }

        func walk(_ n: Node, _ transform: [Double], cutters: [Box], removed: Bool) {
            var current = transform
            if n.name == "multmatrix", let m = matrix(from: n.args) {
                current = multiply(transform, m)
            }
            if n.name == "cube", !removed, let c = cube(from: n.args) {
                result.append(Component(box: Box(matrix: current, size: c.size, centered: c.centered),
                                        cutters: cutters))
            }

            // A board with a rounded corner is an extruded profile, not a cube. Without this it
            // had no piece at all: the Parts overlay skipped it, and holding the modifier fell
            // through to "the whole connected solid" — which, after the union, is the model.
            if n.name == "linear_extrude", !removed, let made = extrude(n, current) {
                result.append(Component(box: made.box, cutters: cutters, profile: made.profile))
                return                       // its 2D children are a profile, not geometry
            }

            if n.name == "difference", let first = n.children.first {
                // Operands 2..n cut the first one: carry them down as cutters, and do not
                // treat them as pieces themselves.
                var inherited = cutters
                for child in n.children.dropFirst() {
                    collectBoxes(child, current, into: &inherited)
                }
                walk(first, current, cutters: inherited, removed: removed)
                for child in n.children.dropFirst() {
                    walk(child, current, cutters: cutters, removed: true)
                }
                return
            }

            for child in n.children {
                // Intersection operands each overstate the result, which is only their overlap.
                walk(child, current, cutters: cutters, removed: removed || n.name == "intersection")
            }
        }

        walk(node, identity, cutters: [], removed: false)
        return merged(result)
    }

    /// Boxes that a `union` welded into one piece must be drawn as one outline.
    ///
    /// `rebro()` in kniznica.scad builds a rib as a body plus a tenon at each end — three
    /// cubes stacked (5 + 770 + 5). Their shared faces are internal to the union and are not
    /// edges of the result, yet drawing all three showed a seam across the rib. The model's
    /// own part list agrees: "Komoda priečka 1 – 15 x 450 x 780 (čapy 5 mm hore aj dole)".
    ///
    /// The rule is deliberately strict — identical extent on two axes and touching on the
    /// third, i.e. a collinear extension and nothing else. An L-shaped join (a shelf butting
    /// into a side panel) stays two pieces; that seam is real and is what Parts is for.
    private static func merged(_ components: [Component]) -> [Component] {
        let tolerance = 1e-6

        /// Only plain translation-only boxes can be compared as axis-aligned extents.
        /// A piece with an outline of its own is not one: merging rebuilds components as bare
        /// boxes, which would throw the outline away and put square corners back on a rounded
        /// board.
        func extent(_ c: Component) -> (min: [Double], max: [Double])? {
            guard c.cutters.isEmpty, c.profile == nil else { return nil }
            let m = c.box.matrix
            let axisAligned = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]
            guard zip(axisAligned, [1.0, 0, 0, 0, 1, 0, 0, 0, 1]).allSatisfy({ abs($0 - $1) < tolerance })
            else { return nil }

            let origin = [m[3], m[7], m[11]]
            let half = c.box.centered ? c.box.size.map { $0 / 2 } : [0, 0, 0]
            let low = (0..<3).map { origin[$0] - half[$0] }
            return (low, (0..<3).map { low[$0] + c.box.size[$0] })
        }

        var boxes: [(min: [Double], max: [Double])] = []
        var passthrough: [Component] = []
        for c in components {
            if let e = extent(c) { boxes.append(e) } else { passthrough.append(c) }
        }

        var changed = true
        while changed {
            changed = false
            outer: for i in boxes.indices {
                for j in boxes.indices where j > i {
                    let a = boxes[i], b = boxes[j]
                    let matching = (0..<3).filter {
                        abs(a.min[$0] - b.min[$0]) < tolerance && abs(a.max[$0] - b.max[$0]) < tolerance
                    }
                    guard matching.count == 2,
                          let axis = (0..<3).first(where: { !matching.contains($0) }),
                          a.max[axis] >= b.min[axis] - tolerance,
                          b.max[axis] >= a.min[axis] - tolerance
                    else { continue }

                    boxes[i] = (min: (0..<3).map { min(a.min[$0], b.min[$0]) },
                                max: (0..<3).map { max(a.max[$0], b.max[$0]) })
                    boxes.remove(at: j)
                    changed = true
                    break outer
                }
            }
        }

        let rebuilt = boxes.map { box -> Component in
            let size = (0..<3).map { box.max[$0] - box.min[$0] }
            let matrix: [Double] = [1, 0, 0, box.min[0],
                                    0, 1, 0, box.min[1],
                                    0, 0, 1, box.min[2],
                                    0, 0, 0, 1]
            return Component(box: Box(matrix: matrix, size: size, centered: false), cutters: [])
        }
        return rebuilt + passthrough
    }

    /// A `linear_extrude` as a box, plus its outline when the profile is a single shape.
    private static func extrude(_ node: Node, _ transform: [Double]) -> (box: Box, profile: [[Double]]?)? {
        let numbers = named(in: node.args)
        guard let height = numbers["height"], height > 0 else { return nil }
        let centered = node.args.contains("center = true")

        var shape: (min: [Double], max: [Double])?
        for child in node.children {
            shape = union(shape, shape2D(child, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))
        }
        guard let shape, shape.max[0] > shape.min[0], shape.max[1] > shape.min[1] else { return nil }

        // The box sits at the profile's own offset, so fold that into the transform.
        let placement = multiply(transform, [1, 0, 0, shape.min[0],
                                             0, 1, 0, shape.min[1],
                                             0, 0, 1, centered ? -height / 2 : 0,
                                             0, 0, 0, 1])
        let box = Box(matrix: placement,
                      size: [shape.max[0] - shape.min[0], shape.max[1] - shape.min[1], height],
                      centered: false)
        // Into the box's own coordinates, which is where the viewer builds its edges.
        let outline = profile(of: node)?.map { [$0[0] - shape.min[0], $0[1] - shape.min[1]] }
        return (box, outline)
    }

    /// The extruded outline, in the box's own coordinates, when the profile is a single shape.
    ///
    /// Only then: an `intersection` of several 2D shapes has an outline this cannot describe,
    /// and a wrong outline is worse than falling back to the box.
    private static func profile(of node: Node) -> [[Double]]? {
        var found: [[Double]] = []
        var shapes = 0

        func walk(_ n: Node, _ transform: [Double]) {
            switch n.name {
            case "polygon", "square", "circle":
                shapes += 1
                let pts = n.name == "polygon" ? points(in: n.args) : []
                found = pts.map { p in
                    [transform[0] * p[0] + transform[1] * p[1] + transform[3],
                     transform[4] * p[0] + transform[5] * p[1] + transform[7]]
                }
            case "intersection":
                // `obrys_zaobleny` clips its rounded outline with a rectangle, so an
                // intersection usually still has one shape that decides the result and others
                // that are only guards. If exactly one polygon spans the whole intersection,
                // that polygon *is* the outline; otherwise there is no single outline to draw.
                guard let extent = shape2D(n, transform) else { shapes += 2; return }
                var binding: [[Double]] = []
                var matches = 0
                for child in n.children {
                    guard let box = shape2D(child, transform),
                          close(box.min[0], extent.min[0]), close(box.min[1], extent.min[1]),
                          close(box.max[0], extent.max[0]), close(box.max[1], extent.max[1])
                    else { continue }
                    var inner: [[Double]] = []
                    var count = 0
                    collect(child, transform, &inner, &count)
                    if count == 1, inner.count >= 3 { binding = inner; matches += 1 }
                }
                if matches == 1 { shapes += 1; found = binding } else { shapes += 2 }

            case "difference", "hull":
                shapes += 2                              // not a single outline; give up
            default:
                var current = transform
                if n.name == "multmatrix", let m = matrix(from: n.args) {
                    current = multiply(transform, m)
                }
                for child in n.children { walk(child, current) }
            }
        }
        for child in node.children { walk(child, identity) }

        return shapes == 1 && found.count >= 3 ? found : nil
    }

    private static func close(_ a: Double, _ b: Double) -> Bool {
        abs(a - b) <= max(1.0, abs(a) * 0.01)
    }

    /// Points of the single polygon under `node`, if that is all there is.
    private static func collect(_ node: Node, _ transform: [Double],
                                _ into: inout [[Double]], _ count: inout Int) {
        switch node.name {
        case "polygon":
            count += 1
            into = points(in: node.args).map { p in
                [transform[0] * p[0] + transform[1] * p[1] + transform[3],
                 transform[4] * p[0] + transform[5] * p[1] + transform[7]]
            }
        case "square", "circle":
            count += 1
        case "intersection", "difference", "hull":
            count += 2
        default:
            var current = transform
            if node.name == "multmatrix", let m = matrix(from: node.args) {
                current = multiply(transform, m)
            }
            for child in node.children { collect(child, current, &into, &count) }
        }
    }

    /// Extent of a 2D subtree. The dump has already evaluated circles and hulls into polygons,
    /// so this only has to combine what is left the way each operator does.
    private static func shape2D(_ node: Node, _ transform: [Double]) -> (min: [Double], max: [Double])? {
        var current = transform
        if node.name == "multmatrix", let m = matrix(from: node.args) {
            current = multiply(transform, m)
        }

        switch node.name {
        case "polygon":
            return transformed(points(in: node.args), current)
        case "square":
            let size = named(in: node.args)
            let sx = size["size"] ?? sizePair(node.args)?.0 ?? 0
            let sy = sizePair(node.args)?.1 ?? sx
            guard sx > 0, sy > 0 else { return nil }
            let centred = node.args.contains("center = true")
            let low = centred ? [-sx / 2, -sy / 2] : [0, 0]
            return transformed([low, [low[0] + sx, low[1] + sy]], current)
        case "circle":
            guard let r = named(in: node.args)["r"], r > 0 else { return nil }
            return transformed([[-r, -r], [r, r]], current)
        case "intersection":
            // Only the overlap survives, so the extent is the intersection of the extents.
            var result: (min: [Double], max: [Double])?
            for child in node.children {
                guard let box = shape2D(child, current) else { continue }
                guard let current = result else { result = box; continue }
                result = (min: [Swift.max(current.min[0], box.min[0]), Swift.max(current.min[1], box.min[1])],
                          max: [Swift.min(current.max[0], box.max[0]), Swift.min(current.max[1], box.max[1])])
            }
            return result
        case "difference":
            // What is cut away can only shrink it, so the first operand bounds the result.
            return node.children.first.flatMap { shape2D($0, current) }
        case "offset":
            let delta = named(in: node.args)["delta"] ?? named(in: node.args)["r"] ?? 0
            guard let box = shape2D(node.children.first ?? node, current) else { return nil }
            return (min: [box.min[0] - delta, box.min[1] - delta],
                    max: [box.max[0] + delta, box.max[1] + delta])
        default:
            var result: (min: [Double], max: [Double])?
            for child in node.children { result = union(result, shape2D(child, current)) }
            return result
        }
    }

    private static func union(_ a: (min: [Double], max: [Double])?,
                              _ b: (min: [Double], max: [Double])?) -> (min: [Double], max: [Double])? {
        guard let a else { return b }
        guard let b else { return a }
        return (min: [Swift.min(a.min[0], b.min[0]), Swift.min(a.min[1], b.min[1])],
                max: [Swift.max(a.max[0], b.max[0]), Swift.max(a.max[1], b.max[1])])
    }

    private static func transformed(_ pts: [[Double]], _ m: [Double]) -> (min: [Double], max: [Double])? {
        guard !pts.isEmpty else { return nil }
        var lo = [Double.infinity, .infinity]
        var hi = [-Double.infinity, -.infinity]
        for p in pts {
            let x = m[0] * p[0] + m[1] * p[1] + m[3]
            let y = m[4] * p[0] + m[5] * p[1] + m[7]
            lo = [Swift.min(lo[0], x), Swift.min(lo[1], y)]
            hi = [Swift.max(hi[0], x), Swift.max(hi[1], y)]
        }
        return (min: lo, max: hi)
    }

    /// `points = [[x, y], …]` — the dump writes the profile out in full.
    private static func points(in args: String) -> [[Double]] {
        guard let start = args.range(of: "points = [") else { return [] }
        let tail = args[start.upperBound...]
        let end = tail.range(of: "]]")?.upperBound ?? tail.endIndex
        let body = tail[..<end]

        var result: [[Double]] = []
        for pair in body.components(separatedBy: "[").dropFirst() {
            let numbers = pair.split(whereSeparator: { !"0123456789.-e".contains($0) })
                .compactMap { Double($0) }
            if numbers.count >= 2 { result.append([numbers[0], numbers[1]]) }
        }
        return result
    }

    /// `name = value` pairs, for the scalars an operator carries.
    private static func named(in args: String) -> [String: Double] {
        var result: [String: Double] = [:]
        for part in args.components(separatedBy: ",") {
            let halves = part.components(separatedBy: "=")
            guard halves.count == 2 else { continue }
            let key = halves[0].trimmingCharacters(in: .whitespaces)
            if let value = Double(halves[1].trimmingCharacters(in: .whitespaces)) { result[key] = value }
        }
        return result
    }

    private static func sizePair(_ args: String) -> (Double, Double)? {
        guard let start = args.range(of: "size = [") else { return nil }
        let tail = args[start.upperBound...]
        let end = tail.firstIndex(of: "]") ?? tail.endIndex
        let numbers = tail[..<end].split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        return numbers.count >= 2 ? (numbers[0], numbers[1]) : nil
    }

    private static let identity: [Double] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

    private static func matrix(from args: String) -> [Double]? {
        let numbers = args.split(whereSeparator: { !"0123456789.-e".contains($0) }).compactMap { Double($0) }
        return numbers.count == 16 ? numbers : nil
    }

    private static func multiply(_ a: [Double], _ b: [Double]) -> [Double] {
        var out = [Double](repeating: 0, count: 16)
        for row in 0..<4 {
            for col in 0..<4 {
                var sum = 0.0
                for k in 0..<4 { sum += a[row * 4 + k] * b[k * 4 + col] }
                out[row * 4 + col] = sum
            }
        }
        return out
    }

    private static func cube(from args: String) -> (size: [Double], centered: Bool)? {
        let centered = args.contains("center = true")
        let numbers = args.split(whereSeparator: { !"0123456789.-e".contains($0) }).compactMap { Double($0) }
        if numbers.count >= 3 { return (Array(numbers.prefix(3)), centered) }
        if numbers.count == 1 { return ([numbers[0], numbers[0], numbers[0]], centered) }
        return nil
    }
}
