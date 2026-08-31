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
    }

    struct Component {
        var box: Box
        /// Boxes removed from this piece by an enclosing `difference()`. The viewer clips the
        /// outline against them, otherwise an edge is drawn straight across a milled groove.
        var cutters: [Box]
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
    /// `linear_extrude` leaves (rounded front profiles here) are skipped — no box to draw.
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

        /// Only translation-only boxes can be compared as axis-aligned extents.
        func extent(_ c: Component) -> (min: [Double], max: [Double])? {
            guard c.cutters.isEmpty else { return nil }
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
