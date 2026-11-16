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
    static func emit(_ node: Node, target: [Double]?, subtrahend: Bool = false, depth: Int = 0,
                     coloured: Bool = false) -> String {
        let pad = String(repeating: "\t", count: depth)

        let own = colour(of: node)
        if let c = own, !subtrahend, c != target {
            return "\(pad)group();\n"       // different material → contribute nothing
        }
        if node.children.isEmpty {
            // A solid with no colour anywhere above it belongs to the default pass alone. It used
            // to survive into every coloured pass as well, so a design with one coloured piece
            // among plain ones had the plain ones twice — in two meshes, the same triangles.
            if target != nil, !coloured, !subtrahend { return "\(pad)group();\n" }
            return "\(pad)\(node.name)(\(node.args));\n"
        }

        var body = ""
        for (index, child) in node.children.enumerated() {
            let sub = subtrahend
                || (node.name == "difference" && index > 0)
                || node.name == "intersection"
            body += emit(child, target: target, subtrahend: sub, depth: depth + 1,
                         coloured: coloured || own != nil)
        }
        return "\(pad)\(node.name)(\(node.args)) {\n\(body)\(pad)}\n"
    }
}

// MARK: - One piece as a solid

extension CSGSplitter {

    /// Emits the program for one piece alone: the solids at `paths`, with everything that cuts
    /// them, and nothing else.
    ///
    /// The union of a design welds its pieces together — where two boards touch, neither has a
    /// face any more — so a piece cannot be taken *out* of the welded mesh without leaving its
    /// neighbours open. Rendered on its own, each piece is a closed solid, and hiding one is
    /// simply not drawing it.
    ///
    /// Subtrahends are kept whole, as in `emit(_:target:)`: they are what cuts the groove.
    static func emit(_ node: Node, keeping paths: Set<[Int]>, path: [Int] = [],
                     subtrahend: Bool = false, depth: Int = 0) -> String {
        let pad = String(repeating: "\t", count: depth)
        if subtrahend || paths.contains(path) { return verbatim(node, depth: depth) }
        // Nothing kept below here: an intersection included, whose operands are no pieces.
        guard node.name != "intersection", paths.contains(where: { $0.starts(with: path) }) else {
            return "\(pad)group();\n"
        }
        var body = ""
        for (index, child) in node.children.enumerated() {
            body += emit(child, keeping: paths, path: path + [index],
                         subtrahend: node.name == "difference" && index > 0, depth: depth + 1)
        }
        return "\(pad)\(node.name)(\(node.args)) {\n\(body)\(pad)}\n"
    }

    private static func verbatim(_ node: Node, depth: Int) -> String {
        let pad = String(repeating: "\t", count: depth)
        if node.children.isEmpty { return "\(pad)\(node.name)(\(node.args));\n" }
        let body = node.children.map { verbatim($0, depth: depth + 1) }.joined()
        return "\(pad)\(node.name)(\(node.args)) {\n\(body)\(pad)}\n"
    }

    /// The colour a piece is drawn in: the outermost `color()` above it, which is the one
    /// `emit(_:target:)` sorts it by. Nil for a piece with none.
    static func colour(at path: [Int], in root: Node) -> [Double]? {
        var node = root
        if let c = colour(of: node) { return c }
        for index in path {
            guard index < node.children.count else { return nil }
            node = node.children[index]
            if let c = colour(of: node) { return c }
        }
        return nil
    }

    /// Whether the pieces at `paths` add up to the whole design. They do not when some solid
    /// belongs to no piece (an intersection, a primitive the reader has no box for), or when a
    /// piece sits under an operator that makes something else of its operands together (a hull
    /// of two cubes is not those two cubes). Then the pieces cannot stand in for the model.
    static func covers(_ root: Node, paths: Set<[Int]>) -> Bool {
        let solids: Set<String> = ["cube", "sphere", "cylinder", "polyhedron", "linear_extrude",
                                   "rotate_extrude", "import", "surface"]
        let blending: Set<String> = ["hull", "minkowski", "resize", "intersection"]
        func walk(_ node: Node, _ path: [Int]) -> Bool {
            if paths.contains(path) { return true }
            if solids.contains(node.name) { return false }
            let below = paths.contains(where: { $0.starts(with: path) })
            if blending.contains(node.name) { return !below && !holdsSolid(node) }
            for (index, child) in node.children.enumerated() {
                if node.name == "difference" && index > 0 { break }      // cutters are no pieces
                if !walk(child, path + [index]) { return false }
            }
            return true
        }
        func holdsSolid(_ node: Node) -> Bool {
            solids.contains(node.name) || node.children.contains(where: holdsSolid)
        }
        return walk(root, [])
    }
}

// MARK: - Individual pieces

extension CSGSplitter {

    /// One entry per solid primitive, with its accumulated transform.
    struct Box {
        var matrix: [Double]     // 4×4, row-major (matches three.js Matrix4.set)
        var size: [Double]
        var centered: Bool

        /// The shape this box stands for, in its own 2D coordinates, when it has one — a circle
        /// for a cylinder, a rounded outline for an extrusion. Without it a round cut can only be
        /// approximated by its bounding box, and for a cylinder of radius half the side that box
        /// *is* the whole cube.
        var profile: [[Double]]?

        /// True when this only *bounds* the real shape — an extruded cutter, say, whose profile
        /// is rounded. Good enough to clip an outline with, but its own edges are not the
        /// shape's edges, so nothing may be drawn from them.
        var approximate = false

        /// An explicit boundary, when the solid states one — a polyhedron. Faces as
        /// `[px, py, pz, nx, ny, nz]` and edges as `[ax, ay, az, bx, by, bz]`, in the box's own
        /// coordinates. With these the box is only a bound, and the viewer builds the piece's
        /// faces and edges from them rather than from the box.
        var faces: [[Double]]?
        var edges: [[Double]]?

        /// A sphere's radius, when the solid is one: a single spherical face with no edges of its
        /// own, drawn by its silhouette.
        var sphere: Double?

        /// A solid of revolution — a cone, a `rotate_extrude` — as the profile it revolves about
        /// the box's own z axis, which runs through the box's centre: `[[r, z], …]` in box
        /// coordinates. A cylinder with two radii is the revolution of a trapezoid.
        var revolve: [[Double]]?
        /// Segments per full turn, as OpenSCAD tessellated it, so rims land on the mesh.
        var fragments: Int?
        /// How far round the profile is swept, in degrees; nil is a full turn. Less than that
        /// leaves two flat ends, and the box no longer has the axis at its centre —
        /// `axisAt` says where, in box coordinates.
        var sweep: Double?
        var axisAt: [Double]?

        init(matrix: [Double], size: [Double], centered: Bool, approximate: Bool = false,
             profile: [[Double]]? = nil) {
            self.matrix = matrix
            self.size = size
            self.centered = centered
            self.approximate = approximate
            self.profile = profile
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

        /// Where this piece sits in the CSG tree, as the child index taken at each level.
        /// OpenSCAD keeps no names — a module leaves no trace in the dump — but the *shape* of
        /// the tree survives, and that is enough to group pieces into the assemblies they were
        /// written as.
        var path: [Int] = []
        /// Every tree position this piece is made of: its own, plus those of the siblings
        /// merging folded into it. What has to be rendered to get the piece as a solid.
        var paths: [[Int]] = []

        /// Name from a `// @name` comment, and the `// @group` names enclosing it.
        var name: String?
        var groups: [String] = []

        init(box: Box, cutters: [Box], profile: [[Double]]? = nil, path: [Int] = []) {
            self.box = box
            self.cutters = cutters
            self.profile = profile
            self.path = path
            self.paths = [path]
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
    /// Pieces, optionally carrying the names their source gives them.
    ///
    /// Names are matched by order, and applied *before* merging, which reorders. The CSG dump
    /// lists geometry in evaluation order — the order the markers appear in — so this holds
    /// while each marked call produces exactly one piece. Anything past the last marker keeps
    /// its number rather than borrowing a name it has no claim to.
    static func components(in node: Node, source: String, values: [String: Int] = [:]) -> [Component] {
        components(in: node, names: Annotations.expand(source, values: values).map { ($0.name, $0.groups) })
    }

    /// Pieces named from a list in evaluation order — the design's own manifest, or its comments
    /// expanded into one.
    static func components(in node: Node, names: [(name: String, groups: [String])]) -> [Component] {
        var pieces = unmerged(in: node)
        for (index, entry) in names.enumerated() where index < pieces.count {
            pieces[index].name = entry.name
            pieces[index].groups = entry.groups
        }
        return merged(pieces)
    }

    static func components(in node: Node) -> [Component] {
        merged(unmerged(in: node))
    }

    /// The pieces as the tree gives them, still in evaluation order — which is what name
    /// matching relies on, and what merging then destroys.
    private static func unmerged(in node: Node) -> [Component] {
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
            // Nor is a cut always a box: a drilled hole is a cylinder. Bounded and flagged as
            // approximate, so it clips an outline without contributing square corners of its own
            // to a round hole.
            if n.name == "cylinder", let made = cylinderBox(n.args, current) {
                var box = made.box
                box.approximate = true
                box.profile = made.profile
                out.append(box)
                return
            }

            // A cut is not always a cube — a drawer's handle is an extruded rounded profile.
            // Without this the front's outline was never clipped and ran straight across the
            // recess. Bounded rather than exact, and flagged as such.
            if n.name == "linear_extrude", let made = extrude(n, current) {
                var box = made.box
                box.approximate = true
                box.profile = made.profile
                out.append(box)
                return
            }
            if var box = bounded(n, current) { box.approximate = true; out.append(box); return }
            for child in n.children { collectBoxes(child, current, into: &out) }
        }

        func walk(_ n: Node, _ transform: [Double], cutters: [Box], removed: Bool, path: [Int]) {
            var current = transform
            if n.name == "multmatrix", let m = matrix(from: n.args) {
                current = multiply(transform, m)
            }
            if n.name == "cube", !removed, let c = cube(from: n.args) {
                result.append(Component(box: Box(matrix: current, size: c.size, centered: c.centered),
                                        cutters: cutters, path: path))
            }

            // A board with a rounded corner is an extruded profile, not a cube. Without this it
            // had no piece at all: the Parts overlay skipped it, and holding the modifier fell
            // through to "the whole connected solid" — which, after the union, is the model.
            if n.name == "cylinder", !removed, let made = cylinderBox(n.args, current) {
                result.append(Component(box: made.box, cutters: cutters, profile: made.profile,
                                        path: path))
                return
            }

            if n.name == "linear_extrude", !removed, let made = extrude(n, current) {
                result.append(Component(box: made.box, cutters: cutters, profile: made.profile,
                                        path: path))
                return                       // its 2D children are a profile, not geometry
            }

            // Solids the reader has no outline for — a polyhedron, a sphere, a revolved profile —
            // are still pieces. Bounded and flagged approximate rather than dropped: a dropped
            // piece is invisible to the list and to picking, and, worse, shifts every name after
            // it by one, since names are matched to geometry by order.
            if !removed, let box = bounded(n, current) {
                result.append(Component(box: box, cutters: cutters, path: path))
                return
            }

            if n.name == "difference", let first = n.children.first {
                // Operands 2..n cut the first one: carry them down as cutters, and do not
                // treat them as pieces themselves.
                var inherited = cutters
                for child in n.children.dropFirst() {
                    collectBoxes(child, current, into: &inherited)
                }
                walk(first, current, cutters: inherited, removed: removed, path: path + [0])
                for (index, child) in n.children.enumerated().dropFirst() {
                    walk(child, current, cutters: cutters, removed: true, path: path + [index])
                }
                return
            }

            for (index, child) in n.children.enumerated() {
                // Intersection operands each overstate the result, which is only their overlap.
                walk(child, current, cutters: cutters, removed: removed || n.name == "intersection",
                     path: path + [index])
            }
        }

        walk(node, identity, cutters: [], removed: false, path: [])
        return result
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
            // Nor is a bounds-only piece: rebuilding it as a box would drop the flag that says so.
            guard c.cutters.isEmpty, c.profile == nil, !c.box.approximate, c.box.faces == nil, c.box.sphere == nil, c.box.revolve == nil else { return nil }
            let m = c.box.matrix
            let axisAligned = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]
            guard zip(axisAligned, [1.0, 0, 0, 0, 1, 0, 0, 0, 1]).allSatisfy({ abs($0 - $1) < tolerance })
            else { return nil }

            let origin = [m[3], m[7], m[11]]
            let half = c.box.centered ? c.box.size.map { $0 / 2 } : [0, 0, 0]
            let low = (0..<3).map { origin[$0] - half[$0] }
            return (low, (0..<3).map { low[$0] + c.box.size[$0] })
        }

        var boxes: [(min: [Double], max: [Double], source: Component)] = []
        var passthrough: [Component] = []
        for c in components {
            if let e = extent(c) { boxes.append((e.min, e.max, c)) } else { passthrough.append(c) }
        }

        /// Only pieces written side by side in the same place may be folded together.
        ///
        /// Merging exists for one board drawn as several cubes, and those are siblings. Without
        /// this test it also swallowed genuinely separate boards that happen to line up — the
        /// cabinet's side panel and the chest's below it are flush and touching, so they became
        /// a single piece and hovering one highlighted both.
        func siblings(_ a: [Int], _ b: [Int]) -> Bool {
            a.count == b.count && a.count > 0 && Array(a.dropLast()) == Array(b.dropLast())
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
                    guard siblings(a.source.path, b.source.path),
                          matching.count == 2,
                          let axis = (0..<3).first(where: { !matching.contains($0) }),
                          a.max[axis] >= b.min[axis] - tolerance,
                          b.max[axis] >= a.min[axis] - tolerance
                    else { continue }

                    // Keeps the first piece's identity — path, and any name it was given — so a
                    // third sibling still compares equal and the name is not lost.
                    var kept = a.source
                    kept.paths += b.source.paths
                    boxes[i] = (min: (0..<3).map { min(a.min[$0], b.min[$0]) },
                                max: (0..<3).map { max(a.max[$0], b.max[$0]) },
                                source: kept)
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
            var piece = Component(box: Box(matrix: matrix, size: size, centered: false), cutters: [],
                                  path: box.source.path)
            piece.name = box.source.name
            piece.groups = box.source.groups
            piece.paths = box.source.paths
            return piece
        }
        // In the order the design wrote them, which is the tree's order. Appending the pieces
        // that could not be merged after the ones that could put every rounded board after
        // every plain one, so a board's id changed whenever the reader learnt its outline.
        return (rebuilt + passthrough).sorted { $0.path.lexicographicallyPrecedes($1.path) }
    }

    /// A `linear_extrude` as a box, plus its outline when the profile is a single shape.
    private static func extrude(_ node: Node, _ transform: [Double]) -> (box: Box, profile: [[Double]]?)? {
        let numbers = named(in: node.args)
        guard let height = numbers["height"], height > 0 else { return nil }
        let centered = node.args.contains("center = true")

        // The outline, when there is one, bounds the shape exactly; the extents are only an
        // upper bound (an intersection can be much smaller than the overlap of its operands).
        let points = profile(of: node)
        var shape: (min: [Double], max: [Double])? = points.flatMap { transformed($0, identity) }
        if shape == nil {
            for child in node.children {
                shape = union(shape, shape2D(child, identity))
            }
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
        let outline = points?.map { [$0[0] - shape.min[0], $0[1] - shape.min[1]] }
        return (box, outline)
    }

    /// The extruded outline, in the box's own coordinates, when the profile is a single shape.
    ///
    /// Only then: two disjoint shapes under one extrude have no single outline, and a wrong
    /// outline is worse than falling back to the box.
    private static func profile(of node: Node) -> [[Double]]? {
        var found: [[Double]]?
        var shapes = 0
        for child in node.children {
            guard let points = outline(of: child, identity) else { shapes += 2; continue }
            shapes += 1
            found = points
        }
        return shapes == 1 && (found?.count ?? 0) >= 3 ? found : nil
    }

    /// The outline of a 2D subtree as points, or nil when it is not a single shape.
    ///
    /// `hull` has to be built here rather than read off: the dump flattens some 2D shapes to an
    /// explicit `polygon` but keeps a hull symbolic, with its circles and squares intact — which
    /// is exactly how the rounded shelves are written, so they had no outline at all and were
    /// drawn as their bounding box.
    private static func outline(of node: Node, _ transform: [Double]) -> [[Double]]? {
        var current = transform
        if node.name == "multmatrix", let m = matrix(from: node.args) {
            current = multiply(transform, m)
        }

        func place(_ pts: [[Double]]) -> [[Double]] {
            pts.map { p in
                [current[0] * p[0] + current[1] * p[1] + current[3],
                 current[4] * p[0] + current[5] * p[1] + current[7]]
            }
        }

        switch node.name {
        case "polygon":
            let pts = points(in: node.args)
            return pts.count >= 3 ? place(pts) : nil

        case "square":
            guard let (sx, sy) = sizePair(node.args) ?? named(in: node.args)["size"].map({ ($0, $0) }),
                  sx > 0, sy > 0 else { return nil }
            let low = node.args.contains("center = true") ? [-sx / 2, -sy / 2] : [0, 0]
            return place([low, [low[0] + sx, low[1]], [low[0] + sx, low[1] + sy], [low[0], low[1] + sy]])

        case "circle":
            guard let r = named(in: node.args)["r"], r > 0 else { return nil }
            // Same vertex count OpenSCAD used, so the outline sits on the mesh rather than
            // just near it.
            let n = fragments(r, named(in: node.args))
            return place((0..<n).map { i in
                let a = 2 * Double.pi * Double(i) / Double(n)
                return [r * cos(a), r * sin(a)]
            })

        case "hull":
            var all: [[Double]] = []
            for child in node.children {
                guard let pts = outline(of: child, current) else { return nil }
                all += pts
            }
            return all.count >= 3 ? convexHull(all) : nil

        case "offset":
            // `delta` moves every edge along its normal and keeps corners sharp, which is exactly
            // the edge-shift construction below. `r` rounds the corners it opens up: on a convex
            // shape a negative `r` opens none, so the same construction is exact; a positive one
            // would need arcs, and the box is more honest than sharp corners in their place.
            guard node.children.count == 1, let pts = outline(of: node.children[0], current) else { return nil }
            let numbers = named(in: node.args)
            if let delta = numbers["delta"] { return delta == 0 ? pts : inset(pts, by: delta) }
            if let r = numbers["r"] {
                if r == 0 { return pts }
                guard isConvex(pts) else { return nil }
                return r < 0 ? inset(pts, by: r) : rounded(pts, by: r, fragments: fragments(r, numbers))
            }
            return pts

        case "intersection":
            // Clipping one polygon by another is exact when the clip is convex; it is wrong in
            // subtle ways when it is not, and a wrong outline is worse than falling back to the
            // box. So every operand has to be convex — which the rounded plans in practice are.
            var result: [[Double]]?
            for child in node.children {
                guard let pts = outline(of: child, current), isConvex(pts) else { return nil }
                result = result.map { clip($0, to: pts) } ?? pts
            }
            return (result?.count ?? 0) >= 3 ? result : nil

        // multmatrix belongs here too: it is a wrapper like the rest, and leaving it out sent
        // every transformed shape — every circle inside a hull — to the default nil.
        case "group", "union", "render", "color", "multmatrix":
            let shapes = node.children.compactMap { outline(of: $0, current) }
            return node.children.count == 1 ? shapes.first : (shapes.count == 1 ? shapes[0] : nil)

        default:
            return nil          // difference: no single outline to draw
        }
    }

    /// How many segments OpenSCAD gives a full circle of radius `r` — `$fn` when set, otherwise
    /// the coarser of `$fa` and `$fs`, never fewer than five. Arcs from `offset(r)` use the
    /// same count, so an outline built with it lands on the mesh's own vertices.
    private static func fragments(_ r: Double, _ numbers: [String: Double]) -> Int {
        if let fn = numbers["$fn"], fn > 0 { return Swift.max(Int(fn), 3) }
        let fa = numbers["$fa"] ?? 12, fs = numbers["$fs"] ?? 2
        return Int(ceil(Swift.max(Swift.min(360 / fa, r * 2 * Double.pi / fs), 5)))
    }

    /// Every edge moved outward by `r` and every corner replaced by an arc about the original
    /// vertex — OpenSCAD's `offset(r)` on a convex shape. Arc steps are the full circle's
    /// `fragments`, starting from the incoming edge's normal, which is how Clipper walks them.
    private static func rounded(_ points: [[Double]], by r: Double, fragments: Int) -> [[Double]] {
        let pts = ccw(points)
        let n = pts.count
        guard n >= 3 else { return pts }
        let step = 2 * Double.pi / Double(fragments)
        var out: [[Double]] = []
        for i in 0..<n {
            let prev = pts[(i + n - 1) % n], v = pts[i], next = pts[(i + 1) % n]
            let from = atan2(-(v[0] - prev[0]), v[1] - prev[1])       // outward normal of the edge in
            var to = atan2(-(next[0] - v[0]), next[1] - v[1])         // and of the edge out
            while to < from - 1e-9 { to += 2 * Double.pi }
            let sweep = to - from
            let steps = Int((sweep / step).rounded())
            for k in 0...Swift.max(steps, 0) {
                let a = steps == 0 ? from : from + sweep * Double(k) / Double(steps)
                let p = [v[0] + r * cos(a), v[1] + r * sin(a)]
                if let last = out.last, abs(last[0] - p[0]) < 1e-9, abs(last[1] - p[1]) < 1e-9 { continue }
                out.append(p)
            }
        }
        if out.count > 1, let f = out.first, let l = out.last,
           abs(f[0] - l[0]) < 1e-9, abs(f[1] - l[1]) < 1e-9 { out.removeLast() }
        return out
    }

    private static func signedArea(_ pts: [[Double]]) -> Double {
        var area = 0.0
        for i in pts.indices {
            let a = pts[i], b = pts[(i + 1) % pts.count]
            area += a[0] * b[1] - b[0] * a[1]
        }
        return area / 2
    }

    /// Counter-clockwise, whichever way the source wound it.
    private static func ccw(_ pts: [[Double]]) -> [[Double]] {
        signedArea(pts) < 0 ? pts.reversed() : pts
    }

    /// Every turn the same way, allowing for the straight runs a sampled arc produces.
    private static func isConvex(_ points: [[Double]]) -> Bool {
        let pts = ccw(points)
        guard pts.count >= 3 else { return false }
        for i in pts.indices {
            let o = pts[i], a = pts[(i + 1) % pts.count], b = pts[(i + 2) % pts.count]
            let turn = (a[0] - o[0]) * (b[1] - a[1]) - (a[1] - o[1]) * (b[0] - a[0])
            if turn < -1e-6 { return false }
        }
        return true
    }

    /// Sutherland–Hodgman: `subject` cut down to what lies inside the convex `window`.
    private static func clip(_ subject: [[Double]], to window: [[Double]]) -> [[Double]] {
        var output = subject
        let w = ccw(window)
        for i in w.indices {
            let a = w[i], b = w[(i + 1) % w.count]
            let input = output
            output = []
            guard !input.isEmpty else { break }
            func inside(_ p: [Double]) -> Bool {
                (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-9
            }
            func cross(_ p: [Double], _ q: [Double]) -> [Double] {
                let d = [q[0] - p[0], q[1] - p[1]], e = [b[0] - a[0], b[1] - a[1]]
                let denom = d[0] * e[1] - d[1] * e[0]
                guard abs(denom) > 1e-12 else { return p }
                let t = ((a[0] - p[0]) * e[1] - (a[1] - p[1]) * e[0]) / denom
                return [p[0] + d[0] * t, p[1] + d[1] * t]
            }
            var previous = input[input.count - 1]
            for point in input {
                if inside(point) {
                    if !inside(previous) { output.append(cross(previous, point)) }
                    output.append(point)
                } else if inside(previous) {
                    output.append(cross(previous, point))
                }
                previous = point
            }
        }
        // Clipping leaves duplicate vertices where an edge ends exactly on the window.
        var cleaned: [[Double]] = []
        for p in output where cleaned.last.map({ abs($0[0] - p[0]) > 1e-6 || abs($0[1] - p[1]) > 1e-6 }) ?? true {
            cleaned.append(p)
        }
        if cleaned.count > 1, let f = cleaned.first, let l = cleaned.last,
           abs(f[0] - l[0]) <= 1e-6, abs(f[1] - l[1]) <= 1e-6 { cleaned.removeLast() }
        return cleaned
    }

    /// Every edge moved outward by `delta` (inward when negative), corners where the moved
    /// edges meet — OpenSCAD's `offset(delta)`.
    private static func inset(_ points: [[Double]], by delta: Double) -> [[Double]] {
        let pts = ccw(points)
        let n = pts.count
        guard n >= 3 else { return pts }
        // Edge i runs from pts[i] to pts[i+1]; its outward normal on a CCW polygon points right.
        let shifted: [(p: [Double], d: [Double])] = (0..<n).map { i in
            let a = pts[i], b = pts[(i + 1) % n]
            let d = [b[0] - a[0], b[1] - a[1]]
            let len = max(1e-12, (d[0] * d[0] + d[1] * d[1]).squareRoot())
            let normal = [d[1] / len, -d[0] / len]
            return ([a[0] + normal[0] * delta, a[1] + normal[1] * delta], d)
        }
        return (0..<n).map { i in
            let prev = shifted[(i + n - 1) % n], next = shifted[i]
            let denom = prev.d[0] * next.d[1] - prev.d[1] * next.d[0]
            guard abs(denom) > 1e-12 else { return next.p }      // parallel: the shift itself
            let t = ((next.p[0] - prev.p[0]) * next.d[1] - (next.p[1] - prev.p[1]) * next.d[0]) / denom
            return [prev.p[0] + prev.d[0] * t, prev.p[1] + prev.d[1] * t]
        }
    }

    /// Andrew's monotone chain, counter-clockwise.
    private static func convexHull(_ points: [[Double]]) -> [[Double]] {
        let sorted = points.sorted { $0[0] == $1[0] ? $0[1] < $1[1] : $0[0] < $1[0] }
        guard sorted.count >= 3 else { return sorted }

        func cross(_ o: [Double], _ a: [Double], _ b: [Double]) -> Double {
            (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
        }
        func chain(_ pts: [[Double]]) -> [[Double]] {
            var out: [[Double]] = []
            for p in pts {
                while out.count >= 2, cross(out[out.count - 2], out[out.count - 1], p) <= 0 {
                    out.removeLast()
                }
                out.append(p)
            }
            out.removeLast()
            return out
        }
        return chain(sorted) + chain(sorted.reversed())
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

    /// A `cylinder` as a box plus the circle it extrudes.
    ///
    /// A cylinder is `linear_extrude(h) circle(r)` under another name, so it is measured the same
    /// way: the box bounds it, and the profile carries the round outline sampled at the same `$fn`
    /// OpenSCAD used, so the outline lands on the mesh rather than near it.
    ///
    /// The x/y centring is folded into the transform rather than into `centered`, which is
    /// all-or-nothing across the three axes: a cylinder is centred in x and y but starts at z = 0
    /// unless asked otherwise, and neither setting of that flag can say so.
    ///
    /// A cone (`r1 != r2`) gets the box alone. Its outline changes along the extrusion and a
    /// single profile cannot describe that; the box at least says where the material is.
    private static func cylinderBox(_ args: String, _ transform: [Double]) -> (box: Box, profile: [[Double]]?)? {
        let numbers = named(in: args)
        guard let height = numbers["h"], height > 0 else { return nil }
        let r1 = numbers["r1"] ?? numbers["r"] ?? (numbers["d1"] ?? numbers["d"]).map { $0 / 2 }
        let r2 = numbers["r2"] ?? numbers["r"] ?? (numbers["d2"] ?? numbers["d"]).map { $0 / 2 }
        guard let low = r1, let high = r2, max(low, high) > 0 else { return nil }

        let radius = Swift.max(low, high)
        let centered = args.contains("center = true")
        let placement = multiply(transform, [1, 0, 0, -radius,
                                             0, 1, 0, -radius,
                                             0, 0, 1, centered ? -height / 2 : 0,
                                             0, 0, 0, 1])
        let box = Box(matrix: placement, size: [radius * 2, radius * 2, height], centered: false)

        let n = fragments(radius, numbers)
        guard abs(low - high) < 1e-9 else {
            // Two radii: a cone, or a frustum — the revolution of a trapezoid about the axis.
            var cone = box
            var profile: [[Double]] = [[0, 0]]
            if low > 0 { profile.append([low, 0]) }
            profile.append([high, height])
            if high > 0 { profile.append([0, height]) }
            cone.revolve = profile
            cone.fragments = n
            return (cone, nil)
        }
        let profile = (0..<n).map { i -> [Double] in
            let a = 2 * Double.pi * Double(i) / Double(n)
            return [radius + radius * cos(a), radius + radius * sin(a)]
        }
        return (box, profile)
    }

    /// A `rotate_extrude` as the revolution of its 2D outline about z. Only a full turn, and only
    /// when the outline is a single shape on the positive side of the axis; anything else falls
    /// back to the bounding box.
    private static func revolved(_ node: Node, _ transform: [Double]) -> Box? {
        let numbers = named(in: node.args)
        let angle = numbers["angle"] ?? 360
        guard angle > 0, angle <= 360 else { return nil }
        guard let outline = profile(of: node), outline.count >= 3,
              outline.allSatisfy({ $0[0] >= -1e-6 }) else { return nil }
        let radius = outline.map { $0[0] }.max() ?? 0
        let rInner = outline.map { $0[0] }.min() ?? 0
        let zMin = outline.map { $0[1] }.min() ?? 0, zMax = outline.map { $0[1] }.max() ?? 0
        guard radius > 0, zMax > zMin else { return nil }

        // The swept extent in x and y: the outer radius at the sweep's ends and at every axis
        // direction it passes, the inner radius likewise — a quarter turn is a quarter of the
        // ring, not the ring's whole box.
        let full = abs(angle - 360) < 1e-6
        var xs = [Double](), ys = [Double]()
        var stops = [0.0, angle]
        for k in stride(from: 0.0, through: 360.0, by: 90.0) where k > 0 && k < angle { stops.append(k) }
        for deg in stops {
            let t = deg * Double.pi / 180
            for r in [rInner, radius] { xs.append(r * cos(t)); ys.append(r * sin(t)) }
        }
        if full { xs = [-radius, radius]; ys = [-radius, radius] }
        let xMin = xs.min()!, xMax = xs.max()!, yMin = ys.min()!, yMax = ys.max()!
        let placement = multiply(transform, [1, 0, 0, xMin, 0, 1, 0, yMin, 0, 0, 1, zMin, 0, 0, 0, 1])
        var box = Box(matrix: placement, size: [xMax - xMin, yMax - yMin, zMax - zMin], centered: false)
        box.revolve = outline.map { [Swift.max(0, $0[0]), $0[1] - zMin] }
        box.fragments = fragments(radius, numbers)
        if !full {
            box.sweep = angle
            box.axisAt = [-xMin, -yMin]
        }
        return box
    }

    /// The bounding box of a solid this reader cannot describe exactly, flagged as such — or nil
    /// for anything that is not one of the known primitives.
    private static func bounded(_ node: Node, _ transform: [Double]) -> Box? {
        var lo: [Double]? = nil, hi: [Double]? = nil
        switch node.name {
        case "polyhedron":
            let pts = triples(in: node.args)
            guard !pts.isEmpty else { return nil }
            lo = (0..<3).map { k in pts.map { $0[k] }.min()! }
            hi = (0..<3).map { k in pts.map { $0[k] }.max()! }
            // A polyhedron states its boundary outright, so the piece gets a real one.
            if let lo, let hi, zip(lo, hi).allSatisfy({ $1 > $0 }) {
                let placement = multiply(transform, [1, 0, 0, lo[0], 0, 1, 0, lo[1], 0, 0, 1, lo[2], 0, 0, 0, 1])
                var box = Box(matrix: placement, size: (0..<3).map { hi[$0] - lo[$0] }, centered: false)
                let local = pts.map { p in (0..<3).map { p[$0] - lo[$0] } }
                let boundary = polyhedronBoundary(local, faces: indexLists(in: node.args))
                if !boundary.faces.isEmpty {
                    box.faces = boundary.faces
                    box.edges = boundary.edges
                    return box
                }
            }
        case "sphere":
            guard let r = named(in: node.args)["r"], r > 0 else { return nil }
            var box = Box(matrix: multiply(transform, [1, 0, 0, -r, 0, 1, 0, -r, 0, 0, 1, -r, 0, 0, 0, 1]),
                          size: [2 * r, 2 * r, 2 * r], centered: false)
            box.sphere = r
            return box
        case "rotate_extrude":
            if let exact = revolved(node, transform) { return exact }
            // The profile sweeps round z: its x extent is the radius, its y extent the height.
            var shape: (min: [Double], max: [Double])?
            for child in node.children { shape = union(shape, shape2D(child, identity)) }
            guard let shape else { return nil }
            let radius = Swift.max(abs(shape.min[0]), abs(shape.max[0]))
            guard radius > 0 else { return nil }
            lo = [-radius, -radius, shape.min[1]]; hi = [radius, radius, shape.max[1]]
        default:
            return nil
        }
        guard let lo, let hi, zip(lo, hi).allSatisfy({ $1 > $0 }) else { return nil }
        let placement = multiply(transform, [1, 0, 0, lo[0], 0, 1, 0, lo[1], 0, 0, 1, lo[2], 0, 0, 0, 1])
        var box = Box(matrix: placement, size: (0..<3).map { hi[$0] - lo[$0] }, centered: false)
        box.approximate = true
        return box
    }

    /// `faces = [[i, j, k, …], …]` of a polyhedron: index lists into its points.
    private static func indexLists(in args: String) -> [[Int]] {
        guard let start = args.range(of: "faces = [") else { return [] }
        let tail = args[start.upperBound...]
        let end = tail.range(of: "]]")?.upperBound ?? tail.endIndex
        var result: [[Int]] = []
        for list in tail[..<end].components(separatedBy: "[").dropFirst() {
            let indices = list.split(whereSeparator: { !"0123456789".contains($0) }).compactMap { Int($0) }
            if indices.count >= 3 { result.append(indices) }
        }
        return result
    }

    /// The faces of a polyhedron as planes and its edges as segments. A face's normal comes from
    /// Newell's method, so a non-convex polygon is handled; an edge is where two faces meet that
    /// are not coplanar — two coplanar faces sharing an edge are one face with a seam, not two.
    private static func polyhedronBoundary(_ pts: [[Double]], faces: [[Int]]) -> (faces: [[Double]], edges: [[Double]]) {
        var planes: [[Double]] = []
        var normals: [[Double]?] = []
        for face in faces {
            guard face.allSatisfy({ $0 < pts.count }) else { normals.append(nil); continue }
            var n = [0.0, 0.0, 0.0]
            var centroid = [0.0, 0.0, 0.0]
            for (k, i) in face.enumerated() {
                let a = pts[i], b = pts[face[(k + 1) % face.count]]
                n[0] += (a[1] - b[1]) * (a[2] + b[2])
                n[1] += (a[2] - b[2]) * (a[0] + b[0])
                n[2] += (a[0] - b[0]) * (a[1] + b[1])
                for j in 0..<3 { centroid[j] += a[j] / Double(face.count) }
            }
            let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).squareRoot()
            guard len > 1e-12 else { normals.append(nil); continue }
            let unit = n.map { $0 / len }
            normals.append(unit)
            planes.append(centroid + unit)
        }

        // Outward, decided by the solid rather than by winding: OpenSCAD asks for faces wound
        // clockwise seen from outside, which makes Newell's normal point inward, but designs
        // wind them either way and OpenSCAD quietly repairs them. If most normals point at the
        // solid's centroid, the whole boundary is inside out and is flipped as one — flipping
        // face by face would break a non-convex solid.
        var solidCentroid = [0.0, 0.0, 0.0]
        for p in pts { for k in 0..<3 { solidCentroid[k] += p[k] / Double(pts.count) } }
        var inward = 0
        for f in planes {
            var dot = 0.0
            for k in 0..<3 { dot += (f[k] - solidCentroid[k]) * f[3 + k] }
            if dot < 0 { inward += 1 }
        }
        if inward * 2 > planes.count {
            planes = planes.map { f in [f[0], f[1], f[2], -f[3], -f[4], -f[5]] }
            normals = normals.map { n in n.map { [-$0[0], -$0[1], -$0[2]] } }
        }

        // One face per plane, not per polygon: a triangulated STEP board arrives as hundreds of
        // triangles, and every one on the same plane is the same face. Coplanar faces are merged
        // into one (its point the mean of theirs); the edge test below already ignores seams
        // between coplanar faces, so this only removes the duplicates.
        var merged: [[Double]] = []
        var planeIndex: [Int: Int] = [:]                 // face index → merged face index
        var keyed: [String: Int] = [:]
        var counts: [Int] = []
        for (f, plane) in planes.enumerated() {
            let n = Array(plane[3...])
            let d = plane[0] * n[0] + plane[1] * n[1] + plane[2] * n[2]
            let key = "\(Int((n[0] * 1000).rounded())),\(Int((n[1] * 1000).rounded())),\(Int((n[2] * 1000).rounded())),\(Int((d * 100).rounded()))"
            if let m = keyed[key] {
                for k in 0..<3 { merged[m][k] += plane[k] }
                counts[m] += 1
                planeIndex[f] = m
            } else {
                keyed[key] = merged.count
                planeIndex[f] = merged.count
                merged.append(plane)
                counts.append(1)
            }
        }
        for m in merged.indices { for k in 0..<3 { merged[m][k] /= Double(counts[m]) } }
        planes = merged

        // Edges: each undirected vertex pair with the faces it belongs to.
        var owners: [String: [Int]] = [:]
        for (f, face) in faces.enumerated() where normals[f] != nil {
            for k in face.indices {
                let a = face[k], b = face[(k + 1) % face.count]
                owners["\(Swift.min(a, b))-\(Swift.max(a, b))", default: []].append(f)
            }
        }
        var edges: [[Double]] = []
        for (key, fs) in owners {
            let ends = key.split(separator: "-").compactMap { Int($0) }
            guard ends.count == 2, ends.allSatisfy({ $0 < pts.count }) else { continue }
            let coplanar = fs.count >= 2 && fs.dropFirst().allSatisfy { f in
                guard let n0 = normals[fs[0]], let n1 = normals[f] else { return false }
                return abs(n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) > 0.9999
            }
            if fs.count >= 2 && coplanar { continue }
            edges.append(pts[ends[0]] + pts[ends[1]])
        }
        return (planes, edges)
    }

    /// `points = [[x, y, z], …]` of a polyhedron.
    private static func triples(in args: String) -> [[Double]] {
        guard let start = args.range(of: "points = [") else { return [] }
        let tail = args[start.upperBound...]
        let end = tail.range(of: "]]")?.upperBound ?? tail.endIndex
        var result: [[Double]] = []
        for triple in tail[..<end].components(separatedBy: "[").dropFirst() {
            let numbers = triple.split(whereSeparator: { !"0123456789.-e".contains($0) }).compactMap { Double($0) }
            if numbers.count >= 3 { result.append(Array(numbers.prefix(3))) }
        }
        return result
    }

    private static func cube(from args: String) -> (size: [Double], centered: Bool)? {
        let centered = args.contains("center = true")
        let numbers = args.split(whereSeparator: { !"0123456789.-e".contains($0) }).compactMap { Double($0) }
        if numbers.count >= 3 { return (Array(numbers.prefix(3)), centered) }
        if numbers.count == 1 { return ([numbers[0], numbers[0], numbers[0]], centered) }
        return nil
    }
}
