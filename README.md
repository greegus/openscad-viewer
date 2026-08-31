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
                              ~/Library/Caches/com.greegus.ScadQuickLook
```

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
- **Projection**: `Persp` / `Iso`, isometric (orthographic) by default — parallel edges stay
  parallel, so thicknesses can be compared across the model without foreshortening. Two camera
  objects are swapped in place; the tools are handed a `view` holder rather than a camera, so
  they always read the active one instead of one captured at construction.
- **Standard views**: `Front` / `Left` / `Right` / `Top`, given in the model's own axes
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
- **Controls** have damping off. Inertia makes it hard to land on a precise angle, which is
  what you want when inspecting a joint.
- **Edges** are an independent toggle, not tied to the mode, and black in both modes
  (technical-drawing look) — x-ray keeps the normal background, so there is no reason to
  lighten them.
- **Tools** are a two-button group, `Inspect` and `Measure` — mutually exclusive, and both
  can be off (hence `.selectAny` with mutual exclusion in the action, not `.selectOne`).
- **Test fixture**: `Tests/groove.scad` — a board with a groove milled by `difference()`. It
  pins down three behaviours at once: the subtrahend is not outlined as a piece (1 piece, not
  2), the surviving outline is clipped where the groove opens (14 segments, not 12), and the
  groove walls still show as mesh edges.
- **Inspect** (`Web/inspect.js`): hover highlights what is under the cursor, a click selects it.
  Granularity follows the modifier — plain gives the edge under the cursor, else the face;
  holding **Option** gives the whole part.
  - An edge reports length and the axis it runs along; a face reports its in-plane size, area
    and facing; a part reports `w × d × h`, volume, model-space corner and an **id**.
  - A "face" is not a triangle. The mesh is a triangle soup, so faces are reconstructed once
    per part by welding triangles that share an edge and lie in the same plane — otherwise
    clicking a panel would select half a rectangle.
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
  Snapping is in screen pixels (14 px threshold —
  in 3D a nearby edge would win over the one under the cursor), click picks an edge, a
  second click measures. The distance is the shortest connector between two **segments**
  (not lines), so it also works for edges that pass each other; parallel edges are reported
  as a pitch, otherwise the angle is added. A click is told from a drag by movement < 4 px
  and < 400 ms, so OrbitControls keep working. Esc clears. Both tools share the picking
  helpers in `Web/picking.js`. Verified against the model:
  shelf tops at 1150 → 1455 mm measured exactly 305 mm.

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

Failures inside a Quick Look extension are invisible — they surface only as
"Extension … failed during preview of this document". So the extension logs to its own
subsystem:

```sh
log show --last 5m --info --predicate 'subsystem == "com.greegus.ScadQuickLook"'
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
/tmp/qlprobe ~/Projects/stolarina/kniznica.scad out.png
```

The viewer also exposes diagnostic hooks for driving it from a test harness:
`window.debug.state()`, `debug.edges()`, `debug.distance(i, j)`, `debug.select(i, j)`,
`debug.cameraDirection()`, `debug.arcs()`, `debug.inspect()`. All diagnostics live under that one
namespace; the seven globals beside it (`setMode`, `setView`, …) are the API Swift drives.

## Install

```sh
./build.sh      # builds build/ScadQuickLook.app — plain swiftc, no Xcode project
./install.sh    # /Applications + LaunchAgent + extension registration
./uninstall.sh
```

`ScadQuickLook.app` doubles as settings: the OpenSCAD path and clearing the cache.
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
- Measuring covers edges. Face-to-face distance (pitch of two parallel *faces*) is not
  implemented yet.
- Line overlays behind semi-transparent geometry still show, because transparent materials
  have `depthWrite` off — visible where piece outlines cross the room walls here.
- Semi-transparent geometry in the design (the room walls here) draws over everything
  because transparent materials have `depthWrite` off. Correct for glass, slightly muddy
  for large planes.
