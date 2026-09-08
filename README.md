# SCAD Quick Look

Previews of `.scad` files in Finder — icons and Gallery view, plus an interactive 3D
Quick Look panel (spacebar). Rendering is done by the locally installed OpenSCAD.

## Why it looks like this (the constraint that shaped everything)

The first, obvious version was a single `QLThumbnailProvider` that ran OpenSCAD itself.
macOS refused to load it:

```
pkd: rejecting; Ignoring mis-configured plugin at [.../ScadThumbnail.appex]:
     plug-ins must be sandboxed
```

A Quick Look plug-in **must** be sandboxed, and the sandbox will not let it spawn another
process. So rendering has to happen outside the extension. Hence the three-part split:

```
Finder ──► ScadThumbnail.appex ─┐
           (sandbox, draws)     │  XPC (mach service)
Finder ──► ScadPreview.appex   ─┘        │
           (sandbox, WKWebView)          ▼
                              ScadRenderHelper (LaunchAgent, unsandboxed)
                                         │  Process()
                                         ▼
                              OpenSCAD  (PNG · STL · CSG)
                                         │
                                         ▼
                              ~/Library/Caches/com.greegus.OpenSCADViewer
```

### Layout

```
Core/        renderer and CSG analysis — no UI, no XPC, no host assumptions
Viewer/      the 3D viewer: index.html, ES modules, vendored three.js
ViewerKit/   Swift wrapper over Viewer/ — ScadWebView, ViewerViewController
QuickLook/   the two appexes, the XPC contract and the render helper
App/         the standalone viewer app
```

The seam that makes this work is `GeometryProvider` in `Core/`. A Quick Look extension must
be sandboxed and so cannot spawn OpenSCAD; it renders through the XPC helper
(`XPCGeometryProvider`). A normal app has no such limit and renders in process
(`LocalGeometryProvider`). Both hand the viewer the same bytes, so `ViewerViewController`
never learns which host it is in — that difference used to live inside it.

- **The appexes** are sandboxed (the system will not load them otherwise) and hold
  `temporary-exception.mach-lookup.global-name` for our XPC service.
- **The helper** is a LaunchAgent with `MachServices`, so launchd starts it on demand and
  may idle it out. It runs outside the sandbox, so it may run OpenSCAD.
- **The cache** is keyed on `path + mtime + size` of the file **and of every include/use
  dependency**, plus render options. So the preview also re-renders when only a library it
  includes changes. It is kept under 200 MB (LRU by mtime).

## What the preview does

- **Interactive 3D only.** The pre-rendered views (3D / Front / Side / Top) were removed;
  the static OpenCSG render remains only for Finder thumbnails. Consequence: opening a file
  for the first time waits ~4 s for the CGAL mesh (later opens are instant from cache). If
  that grates, the static render can come back as an immediate placeholder that 3D covers.
- **Three.js in a WKWebView** (`Web/index.html`, `Web/vendor/`), with `OrbitControls`.
  Content is served through a custom `scadview://` scheme (`WKURLSchemeHandler`) rather
  than `loadHTMLString`, because relative ESM imports (`import ... from 'three'`) need
  resolvable URLs — and the scheme leaves room to add COOP/COEP headers should
  `SharedArrayBuffer` ever be needed.
- **Materials** (`Shared/CSGSplitter.swift`). The solid view shows the design's own
  `color()` materials, including transparency for glass. OpenSCAD drops colour when
  exporting meshes: STL has no notion of it, and 2021.01 writes no materials into 3MF
  either (verified — not one `basematerial`). But the **CSG dump keeps `color()`**, and a
  CSG dump is itself a valid OpenSCAD program. So the helper dumps the CSG (~0.2 s, no
  CGAL), prunes the tree once per colour, and exports each pruned program separately. The
  exports run concurrently, so wall clock stays at roughly one mesh: 6 materials in 3.7 s
  versus 3.9 s for a single colourless mesh.

  The subtlety in pruning: in a *subtrahend* position (operands 2..n of a difference, all
  operands of an intersection) nothing may be pruned — those shapes cut or constrain the
  result, and dropping them would fill holes back in. Geometry shared through an
  intersection across two materials therefore appears in both passes; a known approximation.
- **Display modes**: `Solid` / `X-ray`. X-ray is the *same* shaded render as solid — same
  material colours, same lighting — only translucent, so structure reads without losing what
  the materials are. Alpha is capped (`XRAY_ALPHA_CAP`) rather than scaled, so glass that is
  already transparent in the design does not get multiplied into invisibility, and
  `depthWrite` is off or every panel would occlude the ones behind it. Modes are data
  (`MODES` in index.html, `modes` in PreviewViewController) — adding a wireframe or section
  mode is a couple of lines.
- **Parts** toggle: outlines every individual piece. The union welds touching panels into one
  body, so a shelf butting into a side panel leaves no seam in the mesh — and flush faces
  leave no edge at all. The outlines come from the CSG tree instead, where each piece is
  still its own `cube` under a chain of `multmatrix`; `CSGSplitter.components` accumulates
  the transforms and the viewer draws the boxes.

  The outline must describe the *resulting* object, not the shapes combined to build it, and
  that takes two things. First, operands 2..n of a `difference()` are cutting tools (9 of 66
  cubes in kniznica.scad) and operands of an `intersection()` each overstate the result, so
  neither yields a piece. Second, a piece that *is* cut carries its cutters along, and the
  viewer clips the outline against them (`pieceOutline` in `Web/picking.js`: a slab test per
  cutter gives the span of each edge that lies inside the removed box, and those spans are
  subtracted). Without that, an edge is drawn straight across a milled groove — see
  `Tests/groove.scad`, where the board's end-face edge would otherwise bridge the opening. The
  clipped outline is shared with Inspect's highlight, so the two never disagree.

  The mirror case is `union`. `rebro()` builds a rib as a body plus a tenon at each end —
  three stacked cubes (5 + 770 + 5) whose shared faces are internal to the union, yet all
  three were outlined and a seam appeared across the rib. `CSGSplitter.merged` folds boxes
  that are collinear extensions of one another: identical extent on two axes and touching on
  the third, nothing looser. That takes kniznica.scad from 57 pieces to 49 (4 ribs × 2 tenons)
  and makes the ribs read `15 × 450 × 780`, matching the design's own part list
  ("Komoda priečka 1 – 15 x 450 x 780 (čapy 5 mm hore aj dole)"). An L-shaped join — a shelf
  butting into a side panel — stays two pieces; that seam is real and is what Parts is for. Costs nothing extra: it rides along in the
  material manifest, no additional CGAL pass. Drawn exactly like the mesh edges — same black,
  same opacity, depth-tested — so switching it on adds the missing seams to the drawing rather
  than revealing hidden pieces. `linear_extrude` leaves (rounded front profiles) are skipped;
  they have no box.

  Coincident lines are handled by offsetting the **fill**, not the lines: `solidMaterial`
  sets `polygonOffset` (factor/units 1), pushing surfaces one depth unit back so an overlay
  lying exactly on a surface wins, while geometry genuinely in front still occludes it.
  Biasing the lines forward instead does **not** work — with `near = radius/100` and a far
  plane in the thousands, NDC depth is non-linear enough that a small clip-space nudge is
  worth centimetres in world space, more than a panel is thick, so edges occluded by other
  panels punch straight through.
- **Projection**: `Persp` / `Iso`, isometric (orthographic) by default. Both cameras get clip
  planes derived from the model's extent — a perspective camera's defaults (0.1 to 1000) are
  nowhere near a design measured in millimetres, so switching to it used to show an empty view
  with the whole model beyond the far plane. The swap also carries the framing across, undoing
  the orthographic zoom that pinch changes, so the view does not jump — parallel edges stay
  parallel, so thicknesses can be compared across the model without foreshortening. Two camera
  objects are swapped in place; the tools are handed a `view` holder rather than a camera, so
  they always read the active one instead of one captured at construction.
- **Standard views**: `Front` / `Back` / `Left` / `Right` / `Top` / `Bottom`, given in the model's own axes
  (OpenSCAD is Z-up) and rotated into three.js space. They keep the current distance and
  target, so switching direction does not also re-zoom. Verified by reading the camera
  direction back in model axes: front `[0,-1,0]`, left `[-1,0,0]`, right `[1,0,0]`,
  top `[0,0,1]`. The initial camera is a three-quarter view, which is not one of the four, so
  the picker starts with nothing selected.

  A preset stops being active as soon as the camera is **rotated** off it, and the button
  deselects. The rule compares the camera direction rather than listening for interaction
  events, so zooming and panning — which leave the direction alone — keep the preset.
  Verified: `setView(front)` → zoom → pan all stay `front`; a rotate clears it.
- **The control row** lives in one `NSStackView`, centred while it fits and clamped to the
  left edge when it does not: the left constraint is required, the right one optional, so a
  row too wide for the panel gives way on the right instead of hiding the mode picker.
### What counts as a face

A face is a **surface with identity**, not a set of triangles: a cylindrical wall is one face
bounded by two circles however many strips it was tessellated into, and two boards welded flush
share a plane without sharing a face. Grouping triangles by coplanarity can express neither, so
faces come from the CSG — a box has six planes, an extruded profile two caps plus one face per
run of its outline (a curved run giving a cylinder), and every cut contributes the surface it
leaves, so a drilled hole gives the piece a cylindrical wall it did not have before.

Curved surfaces are matched first, and that ordering is load-bearing. A cylinder tangent to a
wall touches it along a line, and there its surface is locally coplanar with the wall and shares
its normal — so with planes matched first, the facets along that tangent were claimed by the
wall. Two tangent lines crossing on one face drew a star of wall-coloured strips through the
middle of the cut. The more specific surface has to win, and every vertex is tested rather than
the centroid, which on a curve is pulled inside and looks flatter than the facet is.

The mesh is then asked only which triangles cover each face, matched by position and orientation
**and bounded by the piece**: a shelf's end and the wall it stops against share a plane and a
normal, and only the fact that the shelf's end lies within the shelf tells them apart. "Within"
is measured as area, not by the centroid: the cabinet's side and the chest's below it are flush
in one plane, the union welds them into one polygon, and a triangle of that polygon spans both
boards — by centroid it belonged to one of them and the other showed a hole with a diagonal
edge. By area it belongs to both, each drawing and measuring its own clipped part (the wall
reads 1220 mm, not the welded 2020). The boundary is the box *minus the box cuts*: a drawer
bottom's end showing through the wall's groove lies in the plane of the wall's end, inside the
wall's box, and is the bottom's face, not the wall's. A triangle matching no face is left out
rather than guessed at.

The mesh also has *less* than the face where something rests on it: the union removes a surface
wherever another solid touches, so a wall's mesh has a hole the size of each shelf end placed
against it — 3 × 15 × 250 mm² short of 1220 × 450 on the cabinet's side. The wall is still a
whole board; the shelf is only placed against it. Where another piece's box rests against a box
face from outside, the rectangle of contact is added to the face as a **patch** (never inside the
piece's own cuts), and the highlight and the area read the whole board: 5490 cm², not 5377.5.

Where a curve begins is decided the same way for faces and for edges, and the rule took three
corrections to get right. A vertex turning under 1.5° is tessellation noise on a straight side;
one turning 30° or more is a corner — without that class a shelf with one rounded corner and
three sharp ones fitted a single arc of radius 454 through its whole outline. In between is a step
of an arc, but only if the segment is as long as a neighbouring step, because OpenSCAD samples
arcs in equal steps: the flat between two rounded corners meets each arc at a tangent, so both
its ends turn gently, and by turns alone two arcs and a 287 mm flat fused into one arc of radius
642. Finally an arc that ends in a corner keeps its first and last step, which the vertex rule
alone would shed as stray one-step sides — a step beside an arc whose far end lies on the arc's
circle belongs to it. A drilled hole is a run round the whole outline and is fitted from three
points a third of the way round, since its two ends are the same point.

The outline itself is read from the 2D tree: `polygon`, `square`, `circle`, `hull`, `offset`
(`delta`, and `r` on a convex shape — inward as moved edges, outward as edges plus arcs sampled
with the same fragment count OpenSCAD uses, so the outline lands on the mesh's vertices) and the
`intersection` of convex shapes, by clipping. Anything else falls back to the box, since a wrong
outline is worse than a coarse one. `offset(r = 30) offset(r = -30) square(...)` — the usual way
to round all four corners — gives a 100-point outline whose four arcs claim 48 triangles each. Measured on `Tests/cylinder.scad`: six planes and two cylinders account for all 1152
triangles with none left over, and the wall of a hole reads as one face of 368 triangles.

A shaped cut is clipped against its **prism**, not its bounding box, and contributes the rim it
leaves where it enters and leaves the piece. The box will not do: a cylinder of radius half the
side has a box the size of the whole cube, and clipping against that erases every edge the cube
has. The rim is the cut's own profile drawn at the depths the piece stops it — and it is real
geometry that the mesh cannot supply, since a cylindrical wall is smooth and a tangent line is
not a crease. Two cuts crossing meet in a curve of their own, drawn ruling by ruling; where a
ruling only grazes the other cut — the point where each cylinder touches the wall, and where the
two ellipses of the crossing meet — the crossing of the two rulings is the vertex, or the curve
stops a step short of the rim. `Tests/cylinder.scad`: 600 outline segments, being the cube's
12 edges, two cuts times two circles of 96, and the two crossing curves. Those curves are
picked as what they are: a run no circle fits is tried as an ellipse (a conic fitted in the run's
plane, accepted only if every point lies on it), and the quarters the touch points cut it into are
joined the way arcs of one circle are — hover reports one ellipse of semi-axes 70.7 × 50 mm.

### What counts as an edge

Worth naming, because "edge" means several different things in a CSG model and the viewer treats
them differently:

| term | what it is | an edge of the solid? |
|---|---|---|
| box edge | a 90° crease | yes |
| CSG edge | the perimeter of a groove or pocket | yes |
| arc rim | where a rounded side meets a flat face | yes |
| the rounded surface itself | facets 3.75° apart at `$fn = 96` | **no** — one smooth face |
| silhouette | where the view grazes a curved face | not an edge of the solid, but **drawn**, following the camera — as Fusion does |
| tangent transition | flat meeting round | yes: a boundary between two faces, drawn as Fusion draws it |
| weld seam | where `union` joined two panels | sometimes absent, sometimes spurious |
| inner loop | the boundary of a hole, e.g. a handle recess | yes |

The last two columns matter: on a rounded corner there is **no edge along the curve**, only a
silhouette, so an edge tool has nothing to offer there and that is correct rather than broken.

There used to be two independent edge pipelines and they disagreed on screen. Creases came from
`EdgesGeometry(mesh, 20°)`, which knows nothing about pieces: an edge could run across three
boards welded flush, and where a shelf butts into a wall the faces end up coplanar so no crease
exists and there was nothing to pick — on the corner shelf only the arc rim, the one boundary
in open space, responded at all. Outlines came from the CSG, which knows exactly where a piece
ends. Hover used the first, a selected piece the second.

Everything structural now comes from the CSG. `buildPieceModel()` is the single place a piece is
assembled, and `pieceFeatures()` builds the pickable features one piece at a time, so a feature
cannot span two pieces — not because it is trimmed afterwards, but because it cannot be built
that way. One overlay, one toggle, and the same source for the overlay, Inspect and Measure, so
what you see is what you can pick and what you can measure. The mesh is still what gets shaded —
only CGAL knows the true solid — but it no longer decides what counts as an edge.

Measured on kniznica.scad: 1228 mesh-crease features became 1658 CSG features, and on the corner
shelf the share of its outline that can be picked went from 23 of 74 segments to 71.

- **Zoom** puts both gestures under one law. A trackpad pinch arrives as a wheel event with
  `ctrlKey` set and a two-finger scroll as one without; they used to be handled differently —
  pinch here, scroll through OrbitControls — and it showed, because OrbitControls takes a fixed
  step per event however far the fingers moved, so beside a pinch that scales with the gesture,
  scrolling felt sluggish. Both now scale with `deltaY` and only the multiplier differs, since a
  pinch reports much smaller numbers for the same intent. A cap keeps one mouse notch, which
  sends 100+ where a trackpad sends single digits, from jumping most of the way in. Superseded: A trackpad pinch arrives as a wheel event
  with `ctrlKey` set but much smaller deltas, so through OrbitControls' single `zoomSpeed` it
  felt far weaker than a two-finger scroll; it now gets its own scaling (`PINCH_SPEED`) and
  re-aims the pivot at the start of a gesture, like a drag does. An orthographic camera has no
  distance to change, so there it moves `camera.zoom`, matching what OrbitControls does.
  `window.debug.pinch()` reports the current speed and the last delta seen — the multiplier can
  only really be judged against a real trackpad.
- **View cube** (`Web/viewcube.js`), top right: a small cube drawn in the model's own axes — Top
  is the model's +z, Front its −y — so it reads the same way the standard views do. Its 26
  regions are the six faces, twelve edges and eight corners; clicking one turns the camera to
  look along it (a face a standard view, an edge or corner a three-quarter one) over a quarter of
  a second so the eye can follow, and the region the camera currently looks along is lit, so the
  cube says which view is on and not only which way is up; the lines between a face's centre and
  its edge and corner handles are drawn faintly, so the handles can be seen before they are
  hovered, and every region takes the same tints. It replaced the row of view buttons. A **home** button to its left
  reframes the whole model from the front-right-above, as the file opened — the camera only,
  eased over a quarter of a second like a cube click (direction, up, distance, target and the
  orthographic zoom together); Cmd-R is the reload that also restores hidden pieces. Under the
  cube, two glass pills: Solid / X-ray and Persp / Ortho. With those, the tools at the
  bottom and the cube, every control lives in the page and the native control row is gone — the
  web view fills the window. Edges are toggled from the palette (Cmd-K). Dragging on it
  orbits exactly as dragging on the model does — about the camera's own up, as OrbitControls
  does. It renders into a scissored viewport after the main scene with its own orthographic
  camera copying the main camera's orientation; its pointer events are taken in capture, ahead
  of the tools and the controls. (Viewport and scissor take CSS pixels — given device pixels, on
  a Retina screen the main viewport came back twice too large.) The Top view puts the front edge
  at the bottom of the screen, as its comment always said; the code had it the other way round,
  which the cube's upside-down TOP label was the first to show.
- **Controls** orbit around what the camera is aimed at, not the centre of the model: a
  detail you have zoomed into stays put when you rotate, instead of swinging away around the
  scene centre. The pivot is re-aimed as a gesture begins, one raycast per gesture, and is
  taken along the *view axis* rather than from the point under the cursor — that keeps
  `camera.position - target` pointing the same way, so a standard view stays active instead of
  being cleared by every click. With nothing under the centre the pivot keeps its distance, so
  the orbit radius does not jump. Under an orthographic camera the camera keeps its distance as
  well as its direction when the pivot moves: the new pivot is always on a surface in front of
  the old one, so a camera left standing had its orbit radius shrink at every re-aim until, after
  an afternoon, it stood inside the model and the near plane cut the scene. Its image does not
  depend on where along the view axis it is, so it is moved back — and its near plane is
  negative, so nothing in front of it is ever clipped. The grid is fitted to the parts, not to
  the scene: measured on the scene it fed its own size back and tripled on every reload.
 Damping is off. Inertia makes it hard to land on a precise angle, which is
  what you want when inspecting a joint.
- **Edges** are an independent toggle, not tied to the mode, and black in both modes
  (technical-drawing look) — x-ray keeps the normal background, so there is no reason to
  lighten them.
- **Tools** — `Inspect`, `Measure`, `Section` — are a floating glass panel at the bottom centre of
  the view, in the page, so their state and their look stay with the tools themselves. Keys: **V** or **I**
  Inspect, **M** Measure, **H** home, **Shift+F/K/L/R/T/B** the front, back, left, right, top and
  bottom views (turned to, like a cube click), **Shift+X** solid ↔ x-ray, **S** Section, **Escape** a step back — a live cut, then the tool, to Inspect (in Inspect it clears the
  selection, as before); **P** folds the parts list to its header and opens it again. In the list the **arrows** walk a
  cursor — its row's pieces lit in the scene as a hover would — **Enter** selects a piece or folds
  a group, **Left** folds a group or goes from a piece to its group, **Right** unfolds; while a
  section is live the up and down arrows still move the plane. A group's name selects nothing —
  a group is not a piece — it folds, like its caret. Mutually exclusive, and clicking the active one switches it off. The
  inspection readout sits in the bottom right corner, opposite the parts list.
- **Test fixture**: `Tests/groove.scad` — a board with a groove milled by `difference()`. It
  pins down three behaviours at once: the subtrahend is not outlined as a piece (1 piece, not
  2), the surviving outline is clipped where the groove opens (14 segments, not 12), and the
  groove walls still show as mesh edges.
- **Inspect** (`Web/inspect.js`): hover highlights what is under the cursor, a click selects it.
  Granularity follows the modifier — plain gives the edge under the cursor, else the face;
  holding **Command** gives the whole part, and so does a **double click** on a face. Not Ctrl as well: on macOS Ctrl-click is a
  synthesised secondary click and would collide with the context menu.
  - An edge reports length and the axis it runs along; a face reports its in-plane size, area
    and facing; a part reports its dimensions, volume, model-space corner and an **id**. Every
    number carries the letter of the model axis it lies along, in that axis's colour (the grid's
    red, green and blue): a size reads `W 565 × D 15 × H 1415` — width, depth, height, how
    furniture is quoted, and with the model's z up there is no doubt which number is the upright
    one — so a board the design has turned, or one from a STEP file, no longer leaves you
    guessing which 15 is the thickness. A coordinate keeps the axes themselves, `X Y Z`, and so do the `Facing` and `Along` rows,
    whose whole value is an axis. (Both
    were coloured dots first; a dot needs a legend, a letter does not.) Axes
    are the model's throughout: a Z-up design's top faces Z, whatever the scene calls up.
    An edge names its start and end, an arc its centre, a part its corner — as coordinates in the
    model's axes, each number behind its axis letter, no commas. The panel has a fixed width with
    the labels right-aligned, the id first in its heading and a rule between heading and values,
    and it is not shown at all while there is nothing to say.
  - A "face" is not a triangle. The mesh is a triangle soup, so faces are reconstructed once
    per part by welding triangles that share an edge and lie in the same plane — otherwise
    clicking a panel would select half a rectangle.
  - A rounded board is drawn as its actual **profile**, not as its bounding box: the profile at
    top and bottom, joined by a vertical at every run boundary (a corner, or the tangent where
    a flat blends into an arc) and by none along the arc itself. A tessellated arc is a smooth
    surface with no edges along it, so joining every point would fence every rounded corner in.
    The runs are the same ones the faces are built from (`profileRuns`), so an edge is drawn
    exactly where one face ends and the next begins. For a while the tangent was left out as
    smooth and therefore not an edge; it is an edge of the face, not of the surface, and Fusion
    draws it. Only when the profile is a single shape — two disjoint shapes under one extrude
    have no single outline, and a wrong outline is worse than falling back to the box. Note
    `merged()` must leave these alone: it rebuilds components as bare boxes, which threw
    the profile away and put the square corners straight back.
  - Boards with a rounded corner are `linear_extrude`, not cubes, and used to have no piece at
    all — the Parts overlay skipped them and holding the modifier fell through to "the whole
    connected solid", which after the union is the entire model. The CSG dump flattens a 2D
    profile into explicit `polygon(points = …)`, so `CSGSplitter.shape2D` can simply read its
    extent, honouring what each operator does to it (`intersection` narrows to the overlap,
    `difference` is bounded by its first operand, `offset` grows it). kniznica.scad: 51 pieces
    before, 60 after, including the two 1850 x 450 x 15 boards.
  - As a backstop for shapes that still cannot be boxed, the body fallback refuses anything
    covering more than half the mesh: offering "the whole model" is never what the modifier is
    for.
  - A "part" cannot come from the mesh at all: the union has welded the panels into one body.
    Parts come from the CSG components, same as the Parts overlay. Where boxes nest (a shelf
    inside a carcass) the smallest containing box wins.
  - Occlusion depth is measured **along the ray**, not from the camera position: under an
    orthographic camera the ray starts on the near plane, so the two are not the same thing.
  - **Only visible geometry responds.** Faces come from a raycast so they are front-most for
    free, but edge snapping searched the whole edge list and happily grabbed an edge behind a
    panel, which felt like permanent x-ray. Candidates are now filtered in 2D first, then
    occlusion-tested with one raycast each. In x-ray mode the test is dropped — reaching what
    is behind is the point there.
  - **Grid and axes** (`Web/grid.js`) sit on the model's z = 0 plane. Procedural rather than
    a `GridHelper`: the lines are computed in the fragment shader, so they stay one pixel wide
    at any zoom, antialias through `fwidth`, and fade out radially from the origin instead of
    ending in a hard edge. Two pitches (100 mm and 1000 mm) plus the X and Y axes coloured in
    the same pass; the vertical axis is a separate line, since it cannot live on the ground.
  - **Delete hides the selection**, and the parts list on the left shows it switched off. Only a part or a whole body — hiding one face of a solid would
    make a hole rather than remove a piece. Nothing is deleted: the mesh is rebuilt from a
    pristine copy each time, so restoring is exact and the .scad file is never touched.
    Rebuilt rather than discarded in a shader, because the edge overlay is its own geometry
    derived from the mesh — a shader would leave a hidden piece's edges hanging in the air.
    Measured on the fixture: 52 triangles -> 0 -> 52.
    A hidden piece's box is **cut out** of every triangle it reaches into, and the remainder
    kept (`cutBoxFromPolygons`, the complement of the highlight's `clipToBox`). The two
    simpler rules both fail on the welded mesh. Matching on the centroid handed a triangle
    spanning several panels to whichever box held its middle — hiding one panel tore a wedge
    out of its neighbours. Dropping only triangles lying *wholly* inside the box fixed that
    but left the opposite hole: the back of kniznica.scad's nested unit — bottom board, back
    panel, top board, flush at the rear — is welded into one rectangle 770 mm tall that lies
    wholly inside no piece, so with the whole unit hidden it stayed behind as a grey plane
    belonging to nothing (the chest's right side and its rear batten did the same). Cutting
    leaves exactly the neighbours' share: hiding the chest takes 3 of the welded right side's
    4 triangles' worth and leaves the cabinet's 1220 mm above it; hiding the unit leaves 0
    triangles in its extent. `Tests/hide.scad` pins all three cases down.
    The cut spares one kind of face inside its reach: a polygon lying **in one of the box's own
    planes with its normal pointing into the box**. That face is a neighbour's — the top of the
    board the piece stood on, the wall of the pocket it was let into — and it exists as
    triangles only in *another material's* mesh, since in the piece's own mesh the union has
    welded it away. Cutting it left a hole in kniznica.scad's chest bottom the size of the
    nested unit that had stood on it (`facesIntoBox`; the red block in `Tests/hide.scad`, and
    `debug.areaWithin`, since a face with a hole in it still has triangles). Lookups run against
    a pristine copy of each mesh, since the piece caches hold triangle indices into whatever
    they scanned and the live geometry shrinks with every hide.
  - Holding the modifier lights up the piece's **faces** as well as its outline, and those are
    exactly the triangles Delete removes — so you see what will go before it goes. A welded
    piece has no triangles of its own, so they are recovered by centroid containment in its box
    and cached per piece, or a hover would redo the scan every frame.
  - **Every edge a cut contributes is kept to the piece.** The piece's own edges lie inside its box
  by construction, but a cut's do not: a handle recess deliberately reaches above the top of the
  drawer front so the grip is open, and its rim was being drawn up there in the air — 34 of a
  front's 150 outline segments, and a groove's rim running well past a shelf. Rims, tangents and
  cut-cut intersections are now clipped to the piece's box. The check that found it is worth
  keeping as an invariant: for every piece, no outline segment's midpoint may lie outside the
  piece. kniznica.scad: 65 pieces, 2466 segments, none outside.
- **A cut that only touches a face** is an edge, and it splits the face. A cylinder of radius half
  the side drilled through a cube is tangent to every wall it runs between, and along that line
  the material behind the wall is cut down to nothing; where two such lines cross, the wall has
  zero thickness — which cannot be made. A B-rep kernel treats the tangent as an edge regardless
  of angle, because two faces meet there, and divides the wall into the regions the tangents
  bound. Fusion does exactly this, and now so does the viewer: on `Tests/cylinder.scad` the two
  walls grazed by both cylinders split into four quadrants, the four walls each cylinder passes
  through split in two along the other's tangent. The same tangent is *not* drawn where a
  board's rounded corner meets its straight side — that is intended design, not a warning.
  The viewer's job is to show the model as it would exist in the real world, and a point of zero
  thickness is the kind of thing a joiner needs to see.
- **Two cuts meeting each other** get their intersection curve. Two cylinders drilled through a
  cube meet along a curve which is a crease of the result, belonging to neither cut's rim nor to
  the piece — it belongs to the pair. Worth noting that the old mesh-crease reader found this one
  for free, and taking edges from the CSG means it has to be reconstructed deliberately. It is
  sampled rather than solved: each cut is a prism, so the rulings of one are clipped against the
  other, and the ends of what survives lie on both surfaces at once. That works for any pair of
  prisms, so two crossing grooves get their intersection as readily as two cylinders.
  `Tests/cylinder.scad`: 396 outline segments became 580.
- **A rim reads as one circle.** Two rims crossing on a face divide each other — four edges meet
  at the crossing, so chaining stops there, which is topologically right — but the halves are
  still one circle, and selecting the rim of a hole should give the rim. Arcs sharing a centre, a
  radius and a plane and meeting end to end are joined; the test is strict, so two distinct
  circles that merely touch stay apart. `Tests/cylinder.scad`: eight arcs of 46 segments became
  four circles of 96 with a sweep of 360°.
- **Tessellated arcs read as one edge.** A rounded corner reaches the mesh as a run of
    short chords — the mesh has no idea it was ever a circle. `buildFeatures` walks the edge
    chains (stopping at any vertex where other edges meet, so nothing merges across a
    junction), splits each chain into straight and constant-turn runs, and fits a circle to
    the curved ones. The corner is then one pick reporting `Arc · R 150 mm · 86.3° · length
    226 mm`. On kniznica.scad it finds exactly three radii: R150 ×12 (`radius = 150`), R100 ×2
    (150 − `podstava_ods = 50`, the recessed base) and R2.5 ×6, a 176° bullnose on a 5 mm edge.
    The chain is split at the *middle* points of its curved turns — `p[a+1] … p[b+1]`. Taking a
    wider slice pulls in a point from the straight run, which then fails the circle fit and used
    to leave a stray two-segment fragment at every arc transition: hovering near the end of a
    rounded corner grabbed that fragment instead of the arc. Fixing the slice removed all 14 of
    them and made the sweep exactly 90°, not 86.3°.
    Two guards keep it honest: a turn below 1.5° is tessellation noise on a straight run, not
    curvature (a real OpenSCAD arc turns by `$fa`, 12° by default), and an arc shorter than
    5 mm is discarded — without that, sub-millimetre triangulation noise fitted as
    "R 2.4 mm / 15°" arcs, 311 of them instead of 20.
  - Snap radius is 6 px, deliberately tighter than the measuring tool's 14 px: on a model with
    ~1000 edges a 14 px radius covers nearly the whole surface and faces would be unreachable.
  - **On ids**: OpenSCAD keeps no object identity. The CSG dump contains only geometry and
    operator nodes and not one module name; a 3MF export is a single object called "OpenSCAD
    Model". A design's own names (`nazov` in kniznica.scad, echoed into the part list) never
    reach any export. So the id is ours: the index after merging, deterministic for a given
    design but not stable across edits. The model-space corner is shown alongside it, since
    that is what actually locates a panel in the source.
- **Measuring** (`Web/measure.js`): hovers exactly like Inspect — the same feature picking
  (a tessellated arc is one entity, not 23 chords), the same occlusion rule, the same hover
  highlight, and a hover description in the readout. The one difference is deliberate: while
  a pick is in progress the readout keeps saying what it is waiting for, instead of being
  overwritten by whatever the cursor is passing over.
  Snapping is in screen pixels (6 px, as Inspect — in 3D a nearby edge would win over the one
  under the cursor; it was 14 px while edges were all there was, which then took a face's rim
  wherever the face was meant). A click picks an edge, or — with no edge near — the **face**
  under the cursor, the same CSG face Inspect shows, lent by Inspect so both tools mean the same
  thing; a **vertex** — the end of an edge, within 5 px — takes precedence over both, since it
  lies on them. A circle picked as an edge stands for its **centre** where the other pick is a
  point or another circle: the distance between two holes is between centres, not rims. A second
  click measures. Two straight edges: the shortest connector between the
  **segments** (not lines), so edges that pass each other work too; parallel ones are a pitch,
  otherwise the angle is added. Two parallel planes: the distance between the planes, drawn from
  the picked point straight across — the shelf pitch and the clear width between two sides. Two
  parallel cylinders: axis to axis, the pitch of two holes; a cylinder and a plane along its
  axis: axis to plane. An edge parallel to a plane: its height above it. Anything else: the
  closest pair of points, with the angle where both have a direction. A click is told from a
  drag by movement < 4 px and < 400 ms, so OrbitControls keep working. Esc clears. Both tools
  share the picking helpers in `Web/picking.js`. Verified against the model: shelf tops at
  1150 → 1455 mm measured exactly 305 mm, by edge and by face alike; on `Tests/polyhedron.scad`
  corner to corner 102.0, rim centre to rim centre 80.6, corner to face 25.0.

## Other decisions

- `.scad` has no system UTI (Finder saw it as `dyn.ah62d4rv4ge81g25bqu`), so the container
  app **exports** `org.openscad.scad` itself (`UTExportedTypeDeclarations`). Without that
  there is nothing for an extension to bind to.
- The **original file at its original path** is rendered, so relative `include`/`use` work.
  If the helper cannot see the file (TCC), the extension sends the contents and the helper
  renders a copy in a temp directory — `include` does not work there; a deliberate trade-off.
- OpenSCAD resolves a **relative `-o` path against the input file's directory**, not the
  working directory. Always pass an absolute output path.
- **Watchdog** on every render (15 s for thumbnails, 120 s for meshes); a stuck OpenSCAD
  gets SIGKILL. Finder never waits forever.
- **Thumbnail fallback**: when a render fails (syntax error, missing OpenSCAD) the thumbnail
  draws the first few lines of source — still better than a generic icon.
- Thumbnails use the OpenCSG preview (`--imgsize`), not a full CGAL render: tenths of a
  second instead of minutes.
- Z-up vs Y-up: OpenSCAD is Z-up, three.js is Y-up — without `rotation.x = -π/2` the model
  is upside down. And a model in millimetres spans thousands of units, so the camera has to
  be derived from the bounding sphere; a default `far` plane clips it and the view goes blank.

## Measured

| | time |
|---|---|
| thumbnail, cold (OpenSCAD start + render) | ~1.7 s |
| thumbnail render alone | ~0.26 s |
| thumbnail from cache | ~25 ms |
| render at 2048 px | 0.43 s (same as 1024 — GPU-bound) |
| single STL export (full CGAL) | ~3.9 s |
| 6 materials, exported concurrently | ~3.7 s |
| meshes from cache | ~10 ms |

## Measured: WebView and WebGL inside a sandboxed extension

`Preview/WebGLProbe.swift` is a diagnostic that verified this inside the QL extension
(not in an app). Result:

```json
{"webgl":true,"version":"WebGL 2.0","renderer":"Apple GPU",
 "maxTexture":16384,"wasm":true,"sharedArrayBuffer":false}
```

So WKWebView, hardware-accelerated WebGL 2.0 and WebAssembly all work in the sandbox.
Two things worth knowing:

1. **Without `com.apple.security.network.client` a sandboxed WKWebView never starts** —
   not even for `loadHTMLString` with local content. Navigation simply never finishes.
2. **`SharedArrayBuffer` is unavailable**, so wasm with pthreads (e.g. multithreaded
   Manifold) will not run in this context. A `WKURLSchemeHandler` adding COOP/COEP headers
   would be the way around it.

## The sizing trap

This cost the most time, so: `NSImageView` and `SCNView` report an intrinsic content size
from their content. With a 1400×1400 render, `fittingSize` came out as exactly
**1416×1452** (1400 + 2×8 insets, + 24 for the control row + 12). Quick Look built the
remote view at that size and then cropped it in the panel: zoomed image, controls pushed
off the right edge. The fix has two parts:

1. Lower `contentCompressionResistance` and `contentHugging` to `.defaultLow` so content
   does not dictate size.
2. Pin the root view to its superview with constraints (`viewDidMoveToSuperview`).
   `autoresizingMask` is not enough — it only preserves margins, so the root grows past
   the panel.

And above all: **do not fix a size**, neither via `preferredContentSize` nor via your own
`.defaultHigh` constraints. Both overrode the pinning and the view stopped tracking the
window.

## Debugging

**Checks.** `Tests/check.sh` measures the viewer rather than looking at it: it opens each test
design in the real `ViewerViewController` headlessly (`Tests/probe.sh <file.scad> <probe.js>`
compiles a small host around it and evaluates a JavaScript probe once the model is in) and
asserts on what comes back — every triangle of the drilled cube claimed by a face, four full
circles and two whole ellipses, the wedge's five faces and nine edges, the names in order. Run
it with a design of your own as the argument for coverage, names and arc radii on that too. `install.sh` runs it before anything goes into /Applications (`SKIP_CHECKS=1` to skip).

One check is on pixels, and it is there because of the one bug the buffers could not see: the
hover stroke, first used on an edge as the pointer crosses the model, drew at most that one
segment for the rest of its life — three r160 fixes an instanced geometry's maximum count the
first time it is bound — while the selection stroke, first used on a whole piece, drew
everything. The target, the points and the buffers were identical; the framebuffer was not.
`highlightParity` hovers an edge, then the piece, then selects it, and compares the two sets
of painted pixels with the fills off: 1.000 with the fix, 0.452 without.

Failures inside a Quick Look extension are invisible — they surface only as
"Extension … failed during preview of this document". So the extension logs to its own
subsystem:

```sh
log show --last 5m --info --predicate 'subsystem == "com.greegus.OpenSCADViewer"'
```

A healthy run reads: `loadView finished` → `preparePreview: …` → `materials ok: … B` →
`viewer: loaded 6 part(s), … triangles (materials)`.

If you still see the old version after reinstalling (or the failure message), processes
holding the old bundle copy are still alive — `quicklookd`, `QuickLookUIService` and
`ScadPreview` itself. `install.sh` kills them; by hand:

```sh
killall quicklookd QuickLookUIService ScadPreview ScadThumbnail
```

`qlmanage -t` does **not** go through thumbnail appexes — it shows the system text
thumbnail and looks like the extension is broken. Test with the same API Finder uses:

```sh
swiftc -O -sdk "$(xcrun --show-sdk-path)" Tools/qlprobe.swift \
  -framework QuickLookThumbnailing -framework AppKit -o /tmp/qlprobe
/tmp/qlprobe Tests/groove.scad out.png
```

The viewer also exposes diagnostic hooks for driving it from a test harness:
`window.debug.state()`, `debug.edges()`, `debug.distance(i, j)`, `debug.select(i, j)`,
`debug.cameraDirection()`, `debug.arcs()`, `debug.inspect()`. All diagnostics live under that one
namespace; the seven globals beside it (`setMode`, `setView`, …) are the API Swift drives.

## The standalone app

`OpenSCADViewer.app` is document-based, so opening files, tabs, the recents menu and window
restoration come from AppKit. It reuses `ViewerKit/` unchanged and renders through
`LocalGeometryProvider` — in process, because only a Quick Look plug-in is forced into a
sandbox. It also opens paths given on the command line.

It re-renders when the file changes on disk, which is the point of keeping it open next to an
editor. `FileWatcher` watches the *containing directory*, not the file: editors save by writing
a temp file and renaming it over the original, which replaces the inode and leaves a file-level
watch pointing at something nobody will write to again. Events are coalesced and checked against
the file's mtime, so one save costs one render.

**The render cache keys on a digest of `Core/*.swift`**, generated by `build.sh`. It has to
change whenever the code that fills the manifest changes, or a manifest cached by an older build
is served as current — and a hand-bumped constant was forgotten twice, once leaving pieces
without their tree paths and once without their hull outlines. Both times the code was right and
the data was stale, which is a genuinely confusing thing to debug. The cost is one slower render
after an upgrade.

**Cross section** (the Section tool, or Cmd-K `Cut along X/Y/Z`) cuts the model with a plane
and lets you look inside. With the tool on, **click a face** and the cut goes through that
point, perpendicular to the model axis nearest the face's normal — every cut worth making in
furniture is axis-aligned — with the half toward you removed, since looking inside is the point;
half a millimetre into the material, or the face's own skin and the cap would fight for the
pixels. Before the click, a **ghost** of that cut follows the pointer: a translucent sheet in the
plane the click would cut along, the size of the whole model across it, so the cut is not a guess.
Once cut, a two-headed arrow stands on the plane at the model's centre: dragging it slides the
plane along its axis (the pointer's ray is matched against the axis line), a button beside it
swaps the kept side, and one on its other side shows the cut-away half as a **ghost** — the
x-ray meshes, clipped the other way, over the solid view; off again, the display mode decides
what the x-ray meshes do — and fainter than the x-ray view proper, a reminder of what was cut
rather than a second model to read. Clicking another face cuts there instead. Arrow keys move the plane 1 mm, Shift 10 mm,
Tab flips the kept side. Both buttons sit neutral grey — blue says a toggle is on, and
swapping the kept side is an action, not a state, so only the ghost lights up. **Escape** takes the cut back and leaves the tool on, ready for the
next face; a second Escape leaves the tool. `Cut along X/Y/Z` from the palette starts in the middle
of the model, because a plane at the edge cuts nothing and looks broken. The cut takes the edge
overlay and the silhouettes with it, so no line hangs in the cut.

The cut **outlives the tool**: switching to Inspect or Measure keeps it (the handles go, the
planes stay) and coming back to Section finds the handles where they were; only turning the
tool off — its button again, or `Stop the cross section` — removes it. What the cut took away
is gone for every tool, not just for the eye: a face in the removed half neither lights up under
the pointer nor takes a click, a vertex or edge there cannot be measured or snapped to, the
ghost of a next cut does not appear over it, and it hides nothing behind it. The line of
sight ends where it should, too: a ray that comes in through the removed half and meets the
next surface from inside the material is looking at the **cap**, so that is what it hits —
the piece for a double-click or the list, but no face to light up and nothing to cut at. (The readout had promised
"click a face" and "drag" from the start; neither had been wired up — the tool only ever had
its keys.)

The cut face is drawn rather than left open: clipping removes triangles and leaves a shell, so
panels would look like paper. Filling it uses the stencil buffer — back faces increment, front
faces decrement, and what the count says is inside gets painted in the material's colour. The
renderer is created with `stencil: true` for this; it is not on everywhere by default. The plane
goes on all three materials of every piece — solid, x-ray and edges — since edges missed there
would hang out of the cut, and it comes *off* all of them when the tool stops, or the model
stays cut and reads as missing geometry.

**Naming pieces.** OpenSCAD has no notion of object identity — a module leaves no trace in the
CSG dump and comments are stripped from it entirely — so names come from the design itself, in
one of two ways. If a `dielce.json` lies beside the `.scad` and names it as its `source`, that
manifest is the authority: one entry per piece in render order, with `group` and `name`, written
by the design's own annotation checker, which has already expanded every loop. Its stamp is part
of the cache key, so renaming a piece re-renders. Ids are the pieces' order in the CSG tree
after merging — the order the design writes them in — and change only when the design does. Without a manifest, names come from the
`.scad` comments:

```openscad
// @group Komoda
    // @name Ľavá bočnica
    diel("bocnica", [x0, x0 + hr], y, z);
// @endgroup
```

Two more tags carry the numbers that make the matching work:

```openscad
// @group Šuflíky   @repeat pocet_suflikov
    // @name Rebro <i>   @count podstava_rebra
```

`@count` is how many pieces the next statement makes (a loop, or a condition that may make
none) and `@repeat` how many times a whole group runs. Without them every name after a loop
would be off by however many pieces it produced — worse than no names at all. Both hold
OpenSCAD expressions over the design's own variables, so the design is asked for their values:
a scratch file `include`s it and echoes each one, folded into the run that already produces the
CSG dump, since `echo` makes no geometry. A `@count` of 0 claims nothing, which is how a
switched-off feature stays out of the way instead of stealing the next piece's name. `<i>` and
`<k>` are filled in by the generating loop; any other `<placeholder>` is a model variable and is
evaluated the same way.

There is also a one-line form that opens no block:

```openscad
// @group Komoda   @name Dno
diel("Komoda dno", ...);
```

It names the piece under it and says which group it belongs to, so membership travels with the
statement rather than with its position in the file — a piece moved to another module keeps its
group, and the order of blocks stops mattering. kniznica.scad switched to it after a batten
tagged inside one block but evaluated from another module's body put every name after it off
by one. Groups nest, and one left open at the end of the file closes there. `@group` covers what lies
between it and its `@endgroup` in reading order, not a module as a whole. Named pieces are
matched to geometry **by order** — the dump lists geometry in evaluation order, which is the
order the markers appear in — so `@name` belongs on a call that produces exactly one piece; past
that, names would shift. Matching runs before boxes are merged, since merging reorders, and a
merged piece keeps the first one's name. Where a design provides groups the parts list is built
from those instead of the CSG's own shape: "Komoda" says more than "Group 2", and it is the
structure the author meant rather than the one the evaluator happened to produce.

**Parts list.** Every piece in the model, on the left, grouped the way the design was written,
with a visibility toggle on each piece *and* each group; groups start expanded and the panel
folds away by its header. OpenSCAD exports no names — a module leaves no trace in the CSG dump —
but the *shape* of the tree survives, so each piece carries the path it sits on and the list
groups by that. Chains with nothing to choose between are folded away: the dump has 233 `group()`
nodes, nearly all anonymous wrappers, and without folding you would click through a dozen levels
before reaching a piece. Measured on kniznica.scad: 88 rows, 25 groups, 63 pieces.

Hovering a row lights the piece up in the scene, through the same drawing path a real hover
takes, so the two cannot drift apart in how a piece is shown. Leaving a row hands the highlight
back to the cursor rather than clearing it, or stepping off the list would blank a piece the
pointer is genuinely over.

Note the piece paths also fixed something else — merging only folds *siblings* now. Collinear
boxes were merged on geometry alone, which would swallow two genuinely separate boards that
happen to line up, and geometry cannot tell those apart.

**Command palette** (Cmd-K) searches every action the viewer has: modes, projection, the six
standard views, the overlays, both tools, the selection commands, and whatever the host can do.
It lives in the page rather than in AppKit, because nearly every action is the page's own — and
so it works in the Quick Look panel too, which has no menu bar and no toolbar. Toggles are named
for what they will do ("Hide edges" while they are on), and host actions appear only where they
exist: the Quick Look panel has neither an export nor a reload, and listing something that
cannot run is worse than not listing it. Matching is substring, ranked so a word that starts
with the query wins — with a couple of dozen actions, fuzzy matching mostly produces surprises;
hyphens and spaces do not count ("xray" finds X-ray) and an action can carry other names for
itself ("parallel" finds the orthographic projection). Perspective and orthographic are two
entries, not a toggle; Home view and the parts list are there too, with their keys.

**Live reload.** A save in your editor re-renders the model and leaves the camera exactly where
you put it; only the grid and the clip planes follow the new geometry, since an edit can change
its size. `FileWatcher` watches the file *and* its directory, because editors save in two ways
and either watch alone misses one — measured: writing in place never touches the directory, and
saving atomically replaces the inode a file watch is holding. The directory watch is also what
re-arms the file watch after a replacement.

**Reload** (Cmd-R) re-reads the file and puts the view back the way it opened — hidden pieces
restored, camera reframed. Deliberately more than the automatic refresh that follows a change
on disk, which only replaces the geometry.

**Export STL** is File → Export STL… (Cmd-E) — an untargeted action, so the responder chain
takes it to the document you are looking at rather than to whichever was opened last. (It had a
toolbar button too; the toolbar held nothing else and is gone.) A single mesh, not the per-material split the
viewer uses — STL has no notion of colour. It is a full CGAL render, so seconds the first
time and instant from the cache afterwards.

It registers as `Viewer` with rank `Alternate` for `org.openscad.scad`, so installing it does
not take the double-click away from OpenSCAD itself.

## Install

```sh
./build.sh      # builds build/OpenSCADViewer.app — plain swiftc, no Xcode project
./install.sh    # /Applications + LaunchAgent + extension registration
./uninstall.sh
```

`OpenSCADViewer.app` doubles as settings: the OpenSCAD path and clearing the cache.
OpenSCAD is looked up in this order: `OPENSCAD_PATH` → setting →
`/Applications/OpenSCAD*.app` → homebrew.

## Known limitations / next steps

- Signing is **ad-hoc** — fine locally. Distribution needs a Developer ID and notarisation.
  The Mac App Store is out: the `temporary-exception` entitlement is not accepted there
  (the alternative would be an App Group with a shared cache instead of XPC).
- The helper is installed by hand into `~/Library/LaunchAgents`; the "proper" way is
  `SMAppService.agent` registered from the container app.
- Dependencies are only resolved from relative `include`/`use` next to the file;
  `OPENSCADPATH` libraries do not enter the cache key.
- Pieces the CSG reader knows exactly are cubes, cylinders, extrusions of the 2D shapes listed
  under *What counts as a face*, and polyhedra — a `polyhedron` states its faces outright, so it
  gets them as planes and its edges as the seams between non-coplanar faces (`Tests/polyhedron.scad`:
  a wedge of 5 faces and 9 edges, all 8 triangles claimed). A `sphere` is one spherical face
  with no edge anywhere on it, so nothing static is drawn for it; what a drawing shows of a
  sphere is its **silhouette** — the circle where the view grazes it, smaller than the great
  circle under perspective and pushed toward the eye — and that is recomputed as the camera
  moves, in the edge overlay and in a highlight alike, as Fusion does it. A cylinder with two
  radii and a `rotate_extrude` are **solids of revolution**: the profile is divided into runs the
  same way an extrusion's outline is, and each straight run is one face — a vertical run a
  cylinder, a horizontal one an annulus, a slanted one a cone (with an inner wall, a bore, marked
  inward like a cut's face). The rims between runs are the edges, and a cone's two grazing lines
  follow the camera exactly, since a cone's normal is constant along a generatrix — and so do a
  cylinder's, on a boss, on the wall of a hole, and on a rounded corner (there only while the
  grazing direction falls within the arc the corner covers). A curved run is a **torus** — a
  circle revolved is a plain ring with one face and no rim at all, a rounded edge on a turned
  knob a quarter of one — and its silhouette is sampled round the axis from the same closed-form
  condition. A partial `rotate_extrude(angle)` has the same faces over its sweep, plus two flat
  ends — the profile itself in the planes through the axis at the start and the end of the turn
  — with arcs for rims and the profile's own edges on the ends; the box is the swept extent, not
  the whole ring's, and the axis is carried explicitly since it is no longer at the box's centre. `Tests/polyhedron.scad`: cone, frustum, tube, countersunk board, ring, knob and a quarter ring,
  every triangle claimed, 48 rim segments per circle.
- Line overlays behind semi-transparent geometry still show, because transparent materials
  have `depthWrite` off — visible where piece outlines cross the room walls here.
- Semi-transparent geometry in the design (the room walls here) draws over everything
  because transparent materials have `depthWrite` off. Correct for glass, slightly muddy
  for large planes.
- A translucent block placed against a board shares a plane with it; with equal depth offsets
  the two fought for the pixels frame by frame. Glass sits one depth unit further back than
  wood, so the board always wins — glass against a wall does not tint the wall.
