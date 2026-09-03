import * as THREE from 'three';

// --- axes ---

/// OpenSCAD is Z-up, three.js is Y-up. Every mesh, overlay and camera preset needs this
/// conversion, so it is defined once here rather than as a `-Math.PI / 2` in each caller.
export const MODEL_TO_WORLD = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
const MODEL_ROTATION = new THREE.Matrix4().extractRotation(MODEL_TO_WORLD);
const WORLD_ROTATION = MODEL_ROTATION.clone().invert();

/// Orients an object so its model-space geometry sits correctly in the scene.
export function orientToWorld(object) {
  object.rotation.x = -Math.PI / 2;
  return object;
}

/// A direction given in the model's axes, expressed in world space.
export const modelVector = (v) =>
  new THREE.Vector3(...v).applyMatrix4(MODEL_ROTATION).normalize();

/// The reverse: a world-space direction read back in the model's axes.
export const worldToModelVector = (v) => v.clone().applyMatrix4(WORLD_ROTATION);

/// Shared picking helpers for the inspect and measure tools.
///
/// Snapping happens in screen pixels, not in 3D — that is the only thing that behaves
/// predictably under perspective (a nearby edge must not win over the one under the cursor).

export function toScreen(v, camera, canvas) {
  const p = v.clone().project(camera);
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2((p.x * 0.5 + 0.5) * r.width, (-p.y * 0.5 + 0.5) * r.height);
}

export function cursorPx(event, canvas) {
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2(event.clientX - r.left, event.clientY - r.top);
}

/// Distance from a point to a segment in 2D, plus the parameter t of the closest point.
export function pointToSegment2D(p, a, b) {
  const ab = b.clone().sub(a);
  const len2 = ab.lengthSq();
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / len2));
  return { distance: p.distanceTo(a.clone().addScaledVector(ab, t)), t };
}

/// Edges of every material part, in world coordinates, so picking does not depend on
/// the model's rotation.
export function buildEdgeList(targets) {
  const edges = [];
  for (const { mesh, edgesGeometry } of targets) {
    mesh.updateMatrixWorld(true);
    const pos = edgesGeometry.attributes.position;
    for (let i = 0; i < pos.count; i += 2) {
      const a = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(mesh.matrixWorld);
      if (a.distanceTo(b) > 1e-6) edges.push({ a, b });
    }
  }
  return edges;
}

/// Is `point` the first thing the camera meets along its own line of sight?
/// The point sits exactly on a surface, so the tolerance only has to absorb rounding.
function isVisible(point, camera, canvas, raycaster, occluders, tolerance = 2) {
  const s = toScreen(point, camera, canvas);
  const r = canvas.getBoundingClientRect();
  raycaster.setFromCamera(
    new THREE.Vector2((s.x / r.width) * 2 - 1, -(s.y / r.height) * 2 + 1), camera);
  const hit = raycaster.intersectObjects(occluders, false)[0];
  if (!hit) return true;
  // Depth along the ray, not distance from the camera position: under an orthographic
  // camera the ray starts on the near plane, so the two are not the same thing.
  const depth = point.clone().sub(raycaster.ray.origin).dot(raycaster.ray.direction);
  return depth <= hit.distance + tolerance;
}

/// Nearest edge to the cursor in screen space.
///
/// Pass `occluders` to restrict the search to edges you can actually see — without it the
/// snap happily grabs an edge hidden behind a panel, which feels like permanent x-ray.
/// Candidates are filtered in 2D first, so at most a handful get the occlusion raycast.
export function edgeUnderCursor(px, edges, camera, canvas, threshold = 14, occluders = null) {
  const candidates = [];
  for (const e of edges) {
    const a = toScreen(e.a, camera, canvas);
    const b = toScreen(e.b, camera, canvas);
    const { distance, t } = pointToSegment2D(px, a, b);
    if (distance < threshold) candidates.push({ edge: e, distance, t });
  }
  candidates.sort((x, y) => x.distance - y.distance);
  if (!occluders?.length) return candidates[0]?.edge ?? null;

  const raycaster = new THREE.Raycaster();
  for (const c of candidates) {
    const point = c.edge.a.clone().lerp(c.edge.b, c.t);
    if (isVisible(point, camera, canvas, raycaster, occluders)) return c.edge;
  }
  return null;
}

/// Tells a click from a drag: dragging belongs to OrbitControls, a click to the tool.
export function makeClickDetector(canvas, onClick) {
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { px: cursorPx(e, canvas), time: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = cursorPx(e, canvas).distanceTo(down.px);
    const held = performance.now() - down.time;
    down = null;
    if (moved <= 4 && held <= 400) onClick(cursorPx(e, canvas));
  });
}

/// Which axis a direction is aligned with, if any — handy for reading furniture panels.
export function axisName(direction) {
  const axes = [['X', new THREE.Vector3(1, 0, 0)], ['Y', new THREE.Vector3(0, 1, 0)], ['Z', new THREE.Vector3(0, 0, 1)]];
  for (const [name, axis] of axes) {
    if (Math.abs(Math.abs(direction.dot(axis)) - 1) < 1e-3) return name;
  }
  return null;
}

// --- piece outlines ---

/// The pieces a design is built from, each with its own faces and edges.
///
/// One source of truth, and the reason this exists: edges used to come from two unrelated
/// places. `EdgesGeometry(mesh, 20°)` found creases in the welded mesh, which knows nothing
/// about pieces — so an edge could run across three boards, and where a shelf butts flush into
/// a wall no crease exists at all and there was nothing to pick. Piece outlines came from the
/// CSG, which knows exactly where one piece ends. Hover used the first, a selected piece used
/// the second, and they disagreed on screen.
///
/// Everything structural now comes from the CSG: outlines, picking, and the edge overlay. The
/// mesh is still what gets shaded — only CGAL knows the true solid — but it no longer decides
/// what counts as an edge.
export function buildPieceModel(components) {
  return (components ?? []).map((c) => {
    const local = new THREE.Matrix4().set(...c.matrix);
    const world = new THREE.Matrix4().multiplyMatrices(MODEL_TO_WORLD, local);
    const [sx, sy, sz] = c.size;
    const min = c.centered ? new THREE.Vector3(-sx / 2, -sy / 2, -sz / 2)
                           : new THREE.Vector3(0, 0, 0);

    // Model space for the outline, then straight into the world, so every consumer gets the
    // same coordinates and nobody has to remember which space they are in.
    const outline = pieceOutline(c).slice();
    for (let i = 0; i < outline.length; i += 3) {
      const v = new THREE.Vector3(outline[i], outline[i + 1], outline[i + 2])
        .applyMatrix4(MODEL_TO_WORLD);
      outline[i] = v.x; outline[i + 1] = v.y; outline[i + 2] = v.z;
    }

    const origin = [c.matrix[3], c.matrix[7], c.matrix[11]];
    return {
      id: c.id, name: c.name, groups: c.groups ?? [], source: c, sphere: c.sphere ?? null,
      revolve: c.revolve ?? null, fragments: c.fragments ?? 32,
      size: c.size, world, inverse: world.clone().invert(), outline,
      corner: c.centered ? origin.map((v, i) => v - c.size[i] / 2) : origin,
      box: new THREE.Box3(min, min.clone().add(new THREE.Vector3(sx, sy, sz))),
    };
  });
}

/// The faces of a piece, as surfaces with identity — not as groups of triangles.
///
/// This is the distinction that matters: a cylindrical wall is *one* face bounded by two circles,
/// even though it arrives as 96 tessellated strips, and two boards welded flush share a plane
/// without sharing a face. Grouping triangles by coplanarity cannot express either. So the faces
/// come from the CSG, and the mesh is consulted afterwards only to find which triangles cover
/// each one.
///
/// A face is a plane or a cylinder in world coordinates, which is all the shapes this reader
/// produces: boxes, extruded profiles (a cylinder being the extrusion of a circle), and the cuts
/// taken out of them. A cut contributes its own surface — a drilled hole gives the piece a
/// cylindrical wall it did not have before.
export function pieceFaces(piece) {
  const faces = [];
  const source = piece.source ?? {};
  const toWorld = piece.world;

  // `inward` says which way the surface faces on the finished piece. A piece's own faces look
  // out; a cut's faces look into the hole it left. The mesh's triangles agree with that, so
  // matching on the *signed* normal tells a piece's side apart from the wall it butts against —
  // the two share a plane with opposite normals, and an unsigned test took the wall's 322
  // triangles for the shelf's side.
  const plane = (p0, n, label, tag = null, inward = false) => faces.push({
    kind: 'plane', label, tag, inward,
    point: p0.clone().applyMatrix4(toWorld),
    normal: n.clone().transformDirection(toWorld).normalize(),
    piece,
    dividers: [],       // tangent lines lying in this face, which split it — see below
  });
  /// `extent` is the axial length from `p0`; `arc`, for a rounded corner, three points along the
  /// arc (start, middle, end) at p0's height, so a grazing line is drawn only where the surface
  /// actually is.
  const cylinder = (p0, axis, radius, label, inward = false, extent = null, arc = null) => faces.push({
    kind: 'cylinder', label, radius, inward,
    point: p0.clone().applyMatrix4(toWorld),
    axis: axis.clone().transformDirection(toWorld).normalize(),
    extent,
    arc: arc ? arc.map((q) => q.clone().applyMatrix4(toWorld)) : null,
    piece,
  });
  const sphere = (centre, radius, label) => faces.push({
    kind: 'sphere', label, radius, inward: false,
    point: centre.clone().applyMatrix4(toWorld),
    piece,
  });
  /// A torus about `axis` through `centre`: a tube of radius `rho` around a circle of radius
  /// `major`. `phi` is the part of the tube's profile the face covers, as angles in the
  /// (radial, axial) half-plane — start, middle, end — since a rounded edge is a quarter of it.
  const torus = (centre, axis, major, rho, phi, label, inward = false) => faces.push({
    kind: 'torus', label, major, rho, phi, inward,
    point: centre.clone().applyMatrix4(toWorld),
    axis: axis.clone().transformDirection(toWorld).normalize(),
    piece,
  });
  /// A cone about `axis` from `apex`, widening at `tan` per unit along it, over the axial range
  /// [from, to] from the apex.
  const cone = (apex, axis, tan, from, to, label, inward = false) => faces.push({
    kind: 'cone', label, tan, from, to, inward,
    point: apex.clone().applyMatrix4(toWorld),
    axis: axis.clone().transformDirection(toWorld).normalize(),
    piece,
  });

  addSurfaces(source, piece.box, plane, cylinder, '', sphere, cone, torus);

  // A cut that only touches a face splits it. Where two cylinders each graze the same wall the
  // wall has zero thickness at their crossing, and a B-rep kernel reports that by dividing the
  // wall into the quadrants the two tangents bound — Fusion does exactly this. The tangents are
  // recorded on the face as dividers, and triangle assignment then keeps each region apart.
  if (!source.profile) {
    for (const cut of source.cutters ?? []) {
      const box = prepareBox(cut);
      if (!cut.profile) continue;
      const cutToPiece = new THREE.Matrix4()
        .multiplyMatrices(piece.inverse, MODEL_TO_WORLD)
        .multiply(box.matrix);
      const tangents = tangentEdges({ profile: cut.profile, min: box.min, max: box.max,
                                      toPiece: cutToPiece }, piece.box);
      for (const [a, b] of tangents) {
        // Which face holds this line: the one whose plane both ends lie in.
        const face = faces.find((f) => f.tag
          && Math.abs(a[f.tag.axis] - f.tag.at) < 0.05 && Math.abs(b[f.tag.axis] - f.tag.at) < 0.05);
        if (!face) continue;
        const from = a.clone().applyMatrix4(toWorld);
        const dir = b.clone().applyMatrix4(toWorld).sub(from).normalize();
        // Side is judged across the line within the plane: normal × direction.
        face.dividers.push({ point: from, across: new THREE.Vector3().crossVectors(face.normal, dir).normalize() });
      }
    }
  }

  // Every cut adds the surface it leaves behind, in the piece's coordinates.
  // The box cuts are also remembered on the piece: a face's boundary is the piece's box *minus*
  // its cuts, and triangle assignment needs that — see `assignTriangles`.
  piece.cuts = [];
  for (const cut of source.cutters ?? []) {
    const box = prepareBox(cut);
    // Box cuts only: a round or conical cut's box is not the cut, and subtracting it would take
    // the face around a countersink with it.
    if (!cut.profile && !cut.revolve && !cut.sphere) {
      const cutToPiece = new THREE.Matrix4().multiplyMatrices(piece.inverse, MODEL_TO_WORLD).multiply(box.matrix);
      piece.cuts.push({ box, worldToCut: cutToPiece.clone().invert().multiply(piece.inverse) });
    }
    // Cut space into the piece's own space. The cutter's matrix reaches model space, and
    // `piece.inverse` reaches back from the world, so MODEL_TO_WORLD sits between them —
    // leaving it out applies the piece's own transform twice.
    const cutToPiece = new THREE.Matrix4()
      .multiplyMatrices(piece.inverse, MODEL_TO_WORLD)
      .multiply(box.matrix);
    const place = (v) => v.clone().applyMatrix4(cutToPiece);
    const dir = (v) => v.clone().transformDirection(cutToPiece);
    // A cut's faces look into the hole: the cutter's outer wall is an inward face of the piece,
    // and a bore through the cutter (material left standing inside) would be an outward one.
    addSurfaces(cut, box, (p0, n, label) => plane(place(p0), dir(n), label, null, true),
                (p0, axis, radius, label, inwardOfCutter = false, extent = null, arc = null) => cylinder(place(p0), dir(axis), radius, label, !inwardOfCutter, extent, arc ? arc.map(place) : null),
                'cut ', null,
                (apex, axis, tan, from, to, label, inwardOfCutter = false) => cone(place(apex), dir(axis), tan, from, to, label, !inwardOfCutter),
                (centre, axis, major, rho, phi, label, inwardOfCutter = false) => torus(place(centre), dir(axis), major, rho, phi, label, !inwardOfCutter));
  }
  return faces;
}

/// The revolve profile of a piece as (r, z) points wound counter-clockwise, so that the outward
/// normal of the edge a→b is (dz, −dr) — outward radially when it points away from the axis.
function revolveProfile(source) {
  const pts = source.revolve.map(([r, z]) => new THREE.Vector2(r, z));
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a.x * b.y - b.x * a.y; }
  return area < 0 ? pts.reverse() : pts;
}

/// The faces of a solid of revolution, one per straight run of its profile: a vertical run is
/// a cylinder, a horizontal one a plane (an annulus), a slanted one a cone. A run whose normal
/// points at the axis is an inner wall — a tube's bore — and is marked inward like a cut's face.
/// A curved run would be a torus, which has no face here yet.
function revolveSurfaces(source, box, plane, cylinder, cone, torus, prefix) {
  const { min, max } = box;
  const centre = new THREE.Vector2((min.x + max.x) / 2, (min.y + max.y) / 2);
  const profile = revolveProfile(source);
  const { runs, at, fitOf } = profileRuns(profile.map((p) => [p.x, p.y]));
  const up = new THREE.Vector3(0, 0, 1);
  const n = profile.length;
  for (const run of runs) {
    if (run.curved) {
      // A curved run is a torus: the arc's circle swept round the axis. Which part of the tube,
      // as angles about the arc's centre in the (r, z) half-plane; and whether the material is
      // inside the tube (a rounded edge, a bead) or outside it (a groove, a fillet in a corner) —
      // told by which side of the arc its outward normal falls.
      const fit = fitOf(run);
      if (!fit || !torus) continue;
      const whole = run.end - run.start >= n;
      const a = at(run.start), m = at(Math.floor((run.start + run.end) / 2)), b = at(run.end);
      const ang = (q) => Math.atan2(q.y - fit.centre.y, q.x - fit.centre.x);
      const edge = b.clone().sub(a);
      const outward = new THREE.Vector2(edge.y, -edge.x);           // (dz, −dr) of the chord
      const bulges = whole || outward.dot(m.clone().sub(fit.centre)) > 0;   // normal away from the arc's centre; a full tube always bulges
      torus(new THREE.Vector3(centre.x, centre.y, min.z + fit.centre.y), up, fit.centre.x, fit.radius,
            whole ? null : { start: ang(a), mid: ang(m), end: ang(b) },
            prefix + (bulges ? 'round' : 'fillet'), !bulges);
      continue;
    }
    const a = at(run.start), b = at(run.end);
    if (a.x < 1e-6 && b.x < 1e-6) continue;                       // the axis itself
    const dr = b.x - a.x, dz = b.y - a.y;
    const outwardR = dz, outwardZ = -dr;                           // (dz, −dr) for a CCW profile
    if (Math.abs(dz) < 1e-6) {
      // Annulus at height z.
      plane(new THREE.Vector3(centre.x, centre.y, min.z + a.y), new THREE.Vector3(0, 0, Math.sign(outwardZ)), prefix + (outwardZ > 0 ? 'top' : 'bottom'));
    } else if (Math.abs(dr) < 1e-6) {
      cylinder(new THREE.Vector3(centre.x, centre.y, min.z + Math.min(a.y, b.y)), up, a.x, prefix + (outwardR > 0 ? 'side' : 'bore'), outwardR < 0, Math.abs(dz));
    } else if (cone) {
      // The apex is where the radius would reach zero; the axis is taken from the apex toward
      // the wider end, so the radius grows along it.
      const zApex = a.y - a.x * dz / dr;
      const widening = (a.x < b.x) === (a.y < b.y);               // radius grows with z?
      const axis = new THREE.Vector3(0, 0, widening ? 1 : -1);
      const s1 = Math.abs(a.y - zApex), s2 = Math.abs(b.y - zApex);
      cone(new THREE.Vector3(centre.x, centre.y, min.z + zApex), axis, Math.abs(dr / dz),
           Math.min(s1, s2), Math.max(s1, s2), prefix + 'cone', outwardR < 0);
    }
  }
}

/// The rims of a solid of revolution: a circle at every run boundary of its profile with a
/// radius — an edge between two faces, whether a corner or the tangent where a cone meets a
/// cylinder — in the box's coordinates.
function revolveRims(source, box, fragments, zLow = -Infinity, zHigh = Infinity) {
  const { min, max } = box;
  const centre = new THREE.Vector2((min.x + max.x) / 2, (min.y + max.y) / 2);
  const profile = revolveProfile(source);
  const { runs, at } = profileRuns(profile.map((p) => [p.x, p.y]));
  const rims = [];
  const seen = new Set();
  const add = (r, z) => {
    if (r < 1e-6 || z < zLow - 1e-6 || z > zHigh + 1e-6) return;
    const key = `${r.toFixed(4)}:${z.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    rims.push({ r, z });
  };
  const whole = runs.length === 1 && runs[0].curved;              // a circle revolved: a plain torus, no rim
  if (!whole) for (const run of runs) { const v = at(run.start); add(v.x, v.y); }
  // Where the depth range cuts a slanted or vertical run, the rim is the circle at that depth.
  for (const run of runs) {
    if (run.curved) continue;
    const a = at(run.start), b = at(run.end);
    for (const z of [zLow, zHigh]) {
      if (!Number.isFinite(z)) continue;
      const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
      if (z <= lo + 1e-6 || z >= hi - 1e-6) continue;
      add(a.x + (b.x - a.x) * (z - a.y) / (b.y - a.y), z);
    }
  }
  const edges = [];
  for (const { r, z } of rims) {
    let prev = null;
    for (let i = 0; i <= fragments; i++) {
      const t = 2 * Math.PI * i / fragments;
      const p = new THREE.Vector3(centre.x + r * Math.cos(t), centre.y + r * Math.sin(t), min.z + z);
      if (prev) edges.push([prev, p]);
      prev = p;
    }
  }
  return edges;
}

/// The runs of a profile: each a straight stretch (one side) or a sampled arc (one cylinder).
///
/// Three kinds of vertex, not two: a turn under 1.5° is tessellation noise on a straight side, a
/// turn up to 30° is a step along a tessellated arc, and anything sharper is a corner. With only
/// the first two, a 90° corner counted as "curved" and a shelf with one rounded corner and three
/// sharp ones became a single arc through the whole outline — a cylinder of radius 454 that
/// nothing in the mesh could match, and no side faces at all.
///
/// Runs are what faces are built from and what the edge overlay draws verticals at, so the two
/// cannot disagree on where a side ends and a curve begins. A run boundary is an edge whether it
/// is a corner or a tangent: a rounded corner's blend into the flat is a boundary between two
/// faces, and a B-rep draws it even though nothing creases there — as Fusion does.
function profileRuns(points) {
  const profile = points.map(([x, y]) => new THREE.Vector2(x, y));
  const n = profile.length;
  const STRAIGHT = 1.5 * Math.PI / 180;
  const CORNER = 30 * Math.PI / 180;
  const turn = (i) => {
    const a = profile[(i - 1 + n) % n], b = profile[i % n], c = profile[(i + 1) % n];
    const u = b.clone().sub(a).normalize();
    const v = c.clone().sub(b).normalize();
    return Math.acos(Math.max(-1, Math.min(1, u.dot(v))));
  };
  const kind = (i) => { const t = turn(i); return t < STRAIGHT ? 0 : t < CORNER ? 1 : 2; };

  // Edges, grouped into runs. An edge is on an arc when both its ends are arc vertices *and* it
  // is a step of that arc — as long as a neighbouring step, since a sampled arc has equal steps.
  // Vertex kinds alone are not enough: the flat between two rounded corners meets each arc at a
  // tangent, so both its ends look like arc vertices, and the two arcs and the flat fused into
  // one "arc" — a handle cut with a radius of 642 mm. Straight edges merge only across a
  // straight vertex, so a corner always starts a new side.
  const length = (i) => profile[i % n].distanceTo(profile[(i + 1) % n]);
  const similar = (a, b) => Math.abs(a - b) <= 0.2 * Math.max(a, b);
  const step = (i) => similar(length(i), length(i - 1 + n)) || similar(length(i), length(i + 1));
  const runs = [];
  let current = null;
  for (let i = 0; i < n; i++) {
    const curved = kind(i) === 1 && kind(i + 1) === 1 && step(i);
    const joins = current && current.curved === curved && (curved || kind(i) === 0);
    if (joins) current.end = i + 1;
    else { if (current) runs.push(current); current = { start: i, end: i + 1, curved }; }
  }
  if (current) runs.push(current);

  // An arc that ends in a corner loses its first and last step to the rule above: the corner
  // vertex is not an arc vertex, so the step beside it is not "between two arc vertices" and
  // becomes a stray one-step side. The circle settles it: a single step next to an arc whose
  // far end lies on the arc's circle is part of the arc.
  const at = (i) => profile[((i % n) + n) % n];    // runs may wrap past either end once merged
  // A run round the whole profile — a drilled hole — ends where it starts, so its ends cannot
  // both be fit points; three points a third of the way round each are.
  const fitOf = (run) => {
    const span = run.end - run.start;
    if (span >= n) return circleThrough2D(at(run.start), at(run.start + Math.floor(n / 3)), at(run.start + Math.floor(2 * n / 3)));
    return circleThrough2D(at(run.start), at(Math.floor((run.start + run.end) / 2)), at(run.end));
  };
  const onCircle = (fit, p) => Math.abs(p.distanceTo(fit.centre) - fit.radius) <= Math.max(0.05, fit.radius * 1e-3);
  for (let r = 0; r < runs.length && runs.length > 1; r++) {
    const run = runs[r];
    if (!run.curved) continue;
    const fit = fitOf(run);
    if (!fit) continue;
    const before = runs[(r - 1 + runs.length) % runs.length];
    if (!before.curved && before.end - before.start === 1 && onCircle(fit, at(before.start))) {
      run.start = before.start - (r === 0 ? n : 0);
      runs.splice(runs.indexOf(before), 1);
      if (runs.indexOf(run) < r) r--;
    }
    const after = runs[(runs.indexOf(run) + 1) % runs.length];
    if (after !== run && !after.curved && after.end - after.start === 1 && onCircle(fit, at(after.end))) {
      run.end = after.end + (runs.indexOf(after) === 0 ? n : 0);
      runs.splice(runs.indexOf(after), 1);
      r = runs.indexOf(run);
    }
  }

  return { runs, at, fitOf };
}

/// The surfaces of one primitive — a box, or a profile extruded along z.
function addSurfaces(source, box, plane, cylinder, prefix, sphere = null, cone = null, torus = null) {
  const { min, max } = box;

  if (source.revolve) {
    revolveSurfaces(source, box, plane, cylinder, cone, torus, prefix);
    return;
  }

  // A sphere is one face and nothing else — no edge anywhere on it. What is drawn is its
  // silhouette, which depends on the camera and so is not a face's business (see
  // `sphereSilhouette`).
  if (source.sphere && sphere) {
    sphere(new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2), source.sphere, prefix + 'surface');
    return;
  }

  // A polyhedron states its own faces; they are the piece's faces, not the box's.
  if (source.faces) {
    for (const [px, py, pz, nx, ny, nz] of source.faces) {
      plane(new THREE.Vector3(min.x + px, min.y + py, min.z + pz), new THREE.Vector3(nx, ny, nz), prefix + 'face');
    }
    return;
  }

  if (!source.profile) {
    plane(new THREE.Vector3(min.x, 0, 0), new THREE.Vector3(-1, 0, 0), prefix + 'face', { axis: 'x', at: min.x });
    plane(new THREE.Vector3(max.x, 0, 0), new THREE.Vector3(1, 0, 0), prefix + 'face', { axis: 'x', at: max.x });
    plane(new THREE.Vector3(0, min.y, 0), new THREE.Vector3(0, -1, 0), prefix + 'face', { axis: 'y', at: min.y });
    plane(new THREE.Vector3(0, max.y, 0), new THREE.Vector3(0, 1, 0), prefix + 'face', { axis: 'y', at: max.y });
    plane(new THREE.Vector3(0, 0, min.z), new THREE.Vector3(0, 0, -1), prefix + 'face', { axis: 'z', at: min.z });
    plane(new THREE.Vector3(0, 0, max.z), new THREE.Vector3(0, 0, 1), prefix + 'face', { axis: 'z', at: max.z });
    return;
  }

  // Caps.
  plane(new THREE.Vector3(0, 0, min.z), new THREE.Vector3(0, 0, -1), prefix + 'bottom');
  plane(new THREE.Vector3(0, 0, max.z), new THREE.Vector3(0, 0, 1), prefix + 'top');

  // The side, run by run: a straight stretch of profile is one plane, a curved stretch one
  // cylinder. The runs come from `profileRuns`, the same division the edge overlay draws its
  // verticals at, so a face and the edge bounding it agree by construction.
  const { runs, at, fitOf } = profileRuns(source.profile);
  const n = source.profile.length;

  for (const run of runs) {
    const a = at(run.start);
    const b = at(run.end);
    if (run.curved) {
      const fit = fitOf(run);
      if (fit) {
        const whole = run.end - run.start >= n;
        const m = at(Math.floor((run.start + run.end) / 2));
        cylinder(new THREE.Vector3(fit.centre.x, fit.centre.y, min.z),
                 new THREE.Vector3(0, 0, 1), fit.radius, prefix + 'round side', false, max.z - min.z,
                 whole ? null : [a, m, b].map((q) => new THREE.Vector3(q.x, q.y, min.z)));
      }
    } else {
      const edge = b.clone().sub(a);
      if (edge.lengthSq() > 1e-12) {
        // Outward is settled against the box's own centre, not inferred from winding or from
        // the matrix: a corner shelf built with mirror() has a matrix of negative determinant,
        // which turns a normal that was outward in the profile into one pointing inward once
        // placed — and the shelf's ends then matched the cabinet wall they butt against.
        let outward = new THREE.Vector2(edge.y, -edge.x).normalize();
        const centre = new THREE.Vector2((min.x + max.x) / 2, (min.y + max.y) / 2);
        const mid = a.clone().add(b).multiplyScalar(0.5);
        if (mid.sub(centre).dot(outward) < 0) outward.negate();
        plane(new THREE.Vector3(a.x, a.y, min.z),
              new THREE.Vector3(outward.x, outward.y, 0), prefix + 'side');
      }
    }
  }
}

/// What is drawn of a piece that depends on the camera: a sphere's silhouette, a cone's two
/// grazing lines. Empty for anything else.
export function pieceSilhouette(piece, camera) {
  const out = piece.sphere ? sphereSilhouette(piece, camera)
            : piece.revolve ? revolveSilhouette(piece, camera) : [];
  for (const face of facesOf(piece)) {
    if (face.kind === 'cylinder' && face.extent) out.push(...cylinderSilhouette(face, piece, camera));
    if (face.kind === 'torus') out.push(...torusSilhouette(face, piece, camera));
  }
  return out;
}

/// A piece's faces, built once per piece object; the model is rebuilt on any change, so the
/// cache empties itself.
const faceCache = new WeakMap();
export function facesOf(piece) {
  let faces = faceCache.get(piece);
  if (!faces) { faces = pieceFaces(piece); faceCache.set(piece, faces); }
  return faces;
}

/// The two grazing lines of a cylindrical face — a boss, the wall of a hole, a rounded corner —
/// as Fusion draws them. A cylinder's normal is constant along a generatrix, so the generatrix
/// is on the silhouette when n·(P − E) = 0 for the eye E; with P on the surface that is
/// n·(A − E) + r = 0 for any point A of the axis, exact under perspective. Only within the
/// arc the face actually covers, and clipped to the piece.
function cylinderSilhouette(face, piece, camera) {
  const axis = face.axis;
  const [u, v] = basisAround(axis);
  const eye = camera.isPerspectiveCamera ? camera.position : null;
  const d = eye ? face.point.clone().sub(eye) : camera.getWorldDirection(new THREE.Vector3());
  const angles = grazingAngles(u.dot(d), v.dot(d), eye ? -face.radius : 0);
  if (!angles) return [];
  const out = [];
  for (const theta of angles) {
    const radial = u.clone().multiplyScalar(Math.cos(theta)).addScaledVector(v, Math.sin(theta));
    if (face.arc && !withinArc(face, radial)) continue;
    const a = face.point.clone().addScaledVector(radial, face.radius);
    const b = a.clone().addScaledVector(axis, face.extent);
    // Kept to the piece: a cut's wall reaches past the surface by its overshoot.
    const la = a.clone().applyMatrix4(piece.inverse), lb = b.clone().applyMatrix4(piece.inverse);
    const span = clipToBoxSpan(la, lb, piece.box, 0.05);
    if (!span) continue;
    out.push(a.clone().lerp(b, span[0]), a.clone().lerp(b, span[1]));
  }
  return out;
}

/// Whether an angle round the tube falls within the part of the profile a torus face covers:
/// between start and end, on the side the middle is.
function withinPhi(phi, angle) {
  const forward = ((phi.mid - phi.start + 3 * Math.PI) % (2 * Math.PI)) - Math.PI >= 0 ? 1 : -1;
  const wrap = (t) => ((forward * t) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return wrap(angle - phi.start) <= wrap(phi.end - phi.start) + 1e-3;   // a vertex sits exactly on the end; mesh noise is above 1e-6
}

/// The silhouette of a torus face, sampled round the axis. At each θ the normal round the tube
/// is n = cosφ·radial + sinφ·axis, and n·(P − E) = 0 comes to (a + R)cosφ + b·sinφ = −ρ with
/// a = radial·(c − E), b = axis·(c − E) — two solutions in φ, so two curves, each kept to the
/// part of the tube the face covers. Orthographic: a = radial·d, b = axis·d, and 0 in place of ρ.
function torusSilhouette(face, piece, camera) {
  const axis = face.axis;
  const [u, v] = basisAround(axis);
  const eye = camera.isPerspectiveCamera ? camera.position : null;
  const d = eye ? face.point.clone().sub(eye) : camera.getWorldDirection(new THREE.Vector3());
  const steps = Math.max(48, piece.fragments ?? 48);
  const out = [];
  const branches = [[], []];
  for (let i = 0; i <= steps; i++) {
    const theta = 2 * Math.PI * i / steps;
    const radial = u.clone().multiplyScalar(Math.cos(theta)).addScaledVector(v, Math.sin(theta));
    const angles = grazingAngles(radial.dot(d) + (eye ? face.major : 0), axis.dot(d), eye ? -face.rho : 0);
    if (!angles) { branches[0].push(null); branches[1].push(null); continue; }
    angles.forEach((phi, k) => {
      if (face.phi && !withinPhi(face.phi, phi)) { branches[k].push(null); return; }
      branches[k].push(face.point.clone().addScaledVector(radial, face.major + face.rho * Math.cos(phi))
                                          .addScaledVector(axis, face.rho * Math.sin(phi)));
    });
  }
  for (const pts of branches) {
    for (let i = 0; i + 1 < pts.length; i++) if (pts[i] && pts[i + 1]) out.push(pts[i], pts[i + 1]);
  }
  return out;
}

/// Whether a radial direction falls within the arc a partial cylinder face covers: between its
/// start and end, on the side its middle point is.
function withinArc(face, radial) {
  const [a, m, b] = face.arc;
  const dir = (q) => q.clone().sub(face.point).addScaledVector(face.axis, -q.clone().sub(face.point).dot(face.axis)).normalize();
  const da = dir(a), dm = dir(m), db = dir(b);
  const angle = (x, y) => Math.atan2(new THREE.Vector3().crossVectors(x, y).dot(face.axis), x.dot(y));
  // Measured from the start in the direction the middle lies: the arc covers [0, total].
  const forward = angle(da, dm) >= 0 ? 1 : -1;
  const wrap = (t) => ((forward * t) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return wrap(angle(da, radial)) <= wrap(angle(da, db)) + 1e-3;
}

/// Two unit vectors perpendicular to `axis` and to each other.
function basisAround(axis) {
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(u.dot(axis)) > 0.9) u.set(0, 1, 0);
  u.cross(axis).normalize();
  return [u, new THREE.Vector3().crossVectors(axis, u).normalize()];
}

/// The two angles solving A·cosθ + B·sinθ = C, or null when there are none — every grazing
/// condition on a surface of revolution comes to this form.
function grazingAngles(A, B, C) {
  const m = Math.hypot(A, B);
  if (m < 1e-9 || Math.abs(C) > m) return null;
  const base = Math.atan2(B, A), spread = Math.acos(C / m);
  return [base + spread, base - spread];
}

/// The grazing lines of the conical parts of a solid of revolution. A cone's surface normal is
/// constant along a generatrix, so the generatrix is on the silhouette when that normal is
/// perpendicular to the line of sight to the apex — exact under perspective too, since every
/// point of the generatrix sees the eye in a direction the normal is perpendicular to at once.
/// Cylindrical parts are left alone: they have their rims, and whether a cylinder should show
/// its grazing lines is a question of drawing style still open.
function revolveSilhouette(piece, camera) {
  const out = [];
  const { min, max } = piece.box;
  const centre = new THREE.Vector2((min.x + max.x) / 2, (min.y + max.y) / 2);
  const profile = revolveProfile(piece.source ?? piece);
  const { runs, at } = profileRuns(profile.map((p) => [p.x, p.y]));
  const rot = new THREE.Matrix3().setFromMatrix4(piece.world);
  const axisW = new THREE.Vector3(0, 0, 1).applyMatrix3(rot).normalize();
  const [u, v] = basisAround(axisW);
  const eye = camera.isPerspectiveCamera ? camera.position : null;
  const viewDir = camera.getWorldDirection(new THREE.Vector3());
  for (const run of runs) {
    if (run.curved) continue;
    const a = at(run.start), b = at(run.end);
    const dr = b.x - a.x, dz = b.y - a.y;
    if (Math.abs(dz) < 1e-6 || Math.abs(dr) < 1e-6) continue;        // annulus, cylinder
    if (a.x < 1e-6 && b.x < 1e-6) continue;
    const zApex = a.y - a.x * dz / dr;
    const apex = new THREE.Vector3(centre.x, centre.y, min.z + zApex).applyMatrix4(piece.world);
    const widening = (a.x < b.x) === (a.y < b.y);
    const axis = widening ? axisW.clone() : axisW.clone().negate();
    const tan = Math.abs(dr / dz);
    const d = eye ? apex.clone().sub(eye) : viewDir.clone();
    // n(θ)·d = 0 with n = cosα(cosθ u + sinθ v) − sinα axis  ⇒  A cosθ + B sinθ = tanα (axis·d)
    const angles = grazingAngles(u.dot(d), v.dot(d), tan * axis.dot(d));
    if (!angles) continue;
    const s1 = Math.abs(a.y - zApex), s2 = Math.abs(b.y - zApex);
    for (const theta of angles) {
      const radial = u.clone().multiplyScalar(Math.cos(theta)).addScaledVector(v, Math.sin(theta));
      const pt = (s) => apex.clone().addScaledVector(axis, s).addScaledVector(radial, s * tan);
      out.push(pt(s1), pt(s2));
    }
  }
  return out;
}

/// The silhouette of a sphere piece as seen by `camera`, as segment endpoints in world space.
///
/// A sphere has no edges, so what a drawing shows of one is the circle where the view grazes it
/// — Fusion draws exactly this. From a point at distance d the grazing circle is not the great
/// circle but a smaller one, radius r·√(d² − r²)/d, pushed r²/d toward the eye; an orthographic
/// view sees the great circle perpendicular to its direction. Recomputed as the camera moves.
export function sphereSilhouette(piece, camera, segments = 96) {
  const box = piece.box;
  const centre = new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2,
                                   (box.min.z + box.max.z) / 2).applyMatrix4(piece.world);
  const r = piece.sphere;
  let normal, ringCentre, ringRadius;
  if (camera.isPerspectiveCamera) {
    const toEye = camera.position.clone().sub(centre);
    const d = toEye.length();
    if (d <= r) return [];
    normal = toEye.divideScalar(d);
    ringCentre = centre.clone().addScaledVector(normal, r * r / d);
    ringRadius = r * Math.sqrt(d * d - r * r) / d;
  } else {
    normal = camera.getWorldDirection(new THREE.Vector3()).negate();
    ringCentre = centre;
    ringRadius = r;
  }
  const [u, v] = basisAround(normal);
  const out = [];
  let prev = null;
  for (let i = 0; i <= segments; i++) {
    const a = 2 * Math.PI * i / segments;
    const p = ringCentre.clone().addScaledVector(u, ringRadius * Math.cos(a)).addScaledVector(v, ringRadius * Math.sin(a));
    if (prev) out.push(prev, p);
    prev = p;
  }
  return out;
}

/// Where other pieces rest against a box face of `piece`: the rectangles of contact, as world
/// triangles, to be added to what the mesh has of that face.
///
/// The union removes a surface wherever another solid touches it, so a wall's mesh has a hole
/// exactly the size of each shelf end resting on it. The wall is still a whole board — the shelf
/// is only placed against it — and a joiner highlighting the wall expects the whole board. Only
/// contact from outside counts, and none inside the piece's own cuts: a bottom sitting in a groove
/// is not resting on the face, it is in the piece.
export function contactPatches(piece, face, pieces) {
  if (face.kind !== 'plane' || !face.tag || face.inward || !piece.inverse) return [];
  const axis = face.tag.axis;
  const [u, v] = ['x', 'y', 'z'].filter((k) => k !== axis);
  const atMax = Math.abs(face.tag.at - piece.box.max[axis]) < 1e-6;
  const at = face.tag.at;
  const out = [];
  const corner = new THREE.Vector3();
  for (const other of pieces) {
    if (other === piece || other.sphere) continue;
    // The other piece's box in this piece's space; exact while both are axis-aligned there, and
    // every joint in practice is.
    const toLocal = new THREE.Matrix4().multiplyMatrices(piece.inverse, other.world);
    const box = new THREE.Box3();
    for (const x of [other.box.min.x, other.box.max.x]) for (const y of [other.box.min.y, other.box.max.y]) for (const z of [other.box.min.z, other.box.max.z]) {
      box.expandByPoint(corner.set(x, y, z).applyMatrix4(toLocal));
    }
    // Touching this face from outside: the other's near side lies in the face's plane.
    const near = atMax ? box.min[axis] : box.max[axis];
    if (Math.abs(near - at) > 0.05) continue;
    const u0 = Math.max(box.min[u], piece.box.min[u]), u1 = Math.min(box.max[u], piece.box.max[u]);
    const v0 = Math.max(box.min[v], piece.box.min[v]), v1 = Math.min(box.max[v], piece.box.max[v]);
    if (u1 - u0 < 0.05 || v1 - v0 < 0.05) continue;
    // Not inside one of this piece's own cuts.
    const centre = new THREE.Vector3(); centre[axis] = at; centre[u] = (u0 + u1) / 2; centre[v] = (v0 + v1) / 2;
    const inCut = (piece.cuts ?? []).some((cut) => {
      const q = centre.clone().applyMatrix4(piece.world).applyMatrix4(cut.worldToCut);
      return q.x >= cut.box.min.x - 0.05 && q.x <= cut.box.max.x + 0.05
          && q.y >= cut.box.min.y - 0.05 && q.y <= cut.box.max.y + 0.05
          && q.z >= cut.box.min.z - 0.05 && q.z <= cut.box.max.z + 0.05;
    });
    if (inCut) continue;
    const pt = (a, b) => { const w = new THREE.Vector3(); w[axis] = at; w[u] = a; w[v] = b; return w.applyMatrix4(piece.world); };
    const p00 = pt(u0, v0), p10 = pt(u1, v0), p11 = pt(u1, v1), p01 = pt(u0, v1);
    out.push([p00, p10, p11], [p00, p11, p01]);
  }
  return out;
}

/// Circle through three points in 2D, or null when they are in a line.
function circleThrough2D(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const ux = (a.lengthSq() * (b.y - c.y) + b.lengthSq() * (c.y - a.y) + c.lengthSq() * (a.y - b.y)) / d;
  const uy = (a.lengthSq() * (c.x - b.x) + b.lengthSq() * (a.x - c.x) + c.lengthSq() * (b.x - a.x)) / d;
  const centre = new THREE.Vector2(ux, uy);
  return { centre, radius: centre.distanceTo(a) };
}

/// Which face each triangle of `mesh` covers, as a Map from face to triangle indices.
///
/// The mesh supplies pixels, the CSG supplies identity: a triangle is matched to the face whose
/// surface it lies on and whose orientation it shares. A triangle matching nothing is left out
/// rather than guessed at — better a face that is slightly short than one that swallows its
/// neighbour.
export function assignTriangles(mesh, faces, candidates = null) {
  const position = mesh.geometry.attributes.position;
  const groups = new Map(faces.filter((f) => !f.dividers?.length).map((f) => [f, []]));
  // A divided face yields one sub-face per region its dividers cut it into, created as regions
  // turn up. Each carries its parent, so a readout can still say which wall it is part of.
  const regions = new Map();
  const regionFace = (face, key) => {
    const id = face.label + '#' + key;
    let bucket = regions.get(face);
    if (!bucket) { bucket = new Map(); regions.set(face, bucket); }
    let sub = bucket.get(id);
    if (!sub) {
      sub = { ...face, dividers: [], parent: face, region: key, label: face.label + ' (part)' };
      bucket.set(id, sub);
      groups.set(sub, []);
    }
    return sub;
  };
  // Only the triangles near this piece, when the caller knows which those are: matching every
  // triangle against every face in the design is millions of tests at load time.
  const indices = candidates ?? Array.from({ length: position.count / 3 }, (_, i) => i);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const centroid = new THREE.Vector3(), normal = new THREE.Vector3();
  const offset = new THREE.Vector3();

  // Curved surfaces are tested first, and this is not a detail: a cylinder tangent to a wall
  // touches it along a line, and there its surface is locally coplanar with the wall and shares
  // its normal. With planes tested first, the facets along that tangent were claimed by the wall
  // — two tangent lines crossing on one face drew a star of wall-coloured strips through the
  // middle of the cut. The more specific surface has to win.
  const curved = (f) => (f.kind === 'plane' ? 0 : -1);
  const ordered = [...faces].sort((a, b) => curved(a) - curved(b));

  const local = new THREE.Vector3();
  const slack = 0.5;

  for (const t of indices) {
    a.fromBufferAttribute(position, t * 3).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(position, t * 3 + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(position, t * 3 + 2).applyMatrix4(mesh.matrixWorld);
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    normal.copy(b).sub(a).cross(c.clone().sub(a));
    if (normal.lengthSq() < 1e-18) continue;
    normal.normalize();

    for (const face of ordered) {
      // A face has a boundary as well as a surface. A shelf's end and the wall it stops against
      // share a plane *and* a normal — the shelf ends where the wall begins — so neither the
      // plane nor its sign can tell them apart. What can is extent: the shelf's end lies within
      // the shelf. So the centroid must fall inside the owning piece's box, which is the one
      // thing a neighbour's triangle on the same plane cannot manage.
      const piece = face.piece;
      if (piece?.inverse && piece.box) {
        if (face.kind === 'plane') {
          // "Within the piece" means the triangle has area inside the piece's box, not that its
          // centroid does. Two boards flush in one plane — the cabinet's side above the chest's
          // — are welded into one polygon by the union, and a triangle of that polygon can span
          // both; by centroid it belonged to one of them, or to the gap between, and the other
          // showed a hole with a diagonal edge. By area it belongs to both, each drawing its own
          // clipped part. A neighbour's triangle merely touching the box along an edge — the
          // wall around a shelf's end — has no area inside and is still refused.
          // Nudged a quarter millimetre into the material first: the triangle lies exactly on
          // the box's boundary plane, and arithmetic noise there would clip all of it away.
          // Along the plane the clipping stays exact, which is what keeps the touching wall out.
          const into = face.normal.clone().multiplyScalar(face.inward ? 0.25 : -0.25);
          let area = clippedArea(a, b, c, piece.box, piece.inverse, into);
          // "Has area inside" is relative to the triangle's own: CGAL leaves slivers of a few
          // thousandths of a square millimetre round a rim, wholly inside the face, and an
          // absolute threshold refused them. A neighbour's triangle touching along an edge
          // still has none of its (large) area inside.
          const own = normal.length() > 0 ? b.clone().sub(a).cross(c.clone().sub(a)).length() / 2 : 0;
          const enough = Math.min(0.01, own * 0.5);
          // Minus what lies inside a cut: a groove is not the piece's material, and the end of
          // the drawer bottom showing through the wall's groove is the bottom's face, not the
          // wall's. Only box cuts — a round hole's box would take the whole top of a drilled cube.
          if (!face.inward && area >= enough) {
            for (const cut of piece.cuts ?? []) area -= clippedArea(a, b, c, cut.box, cut.worldToCut, into);
          }
          if (area < enough || own < 1e-9) continue;
        } else {
          local.copy(centroid).applyMatrix4(piece.inverse);
          const bx = piece.box;
          if (local.x < bx.min.x - slack || local.x > bx.max.x + slack
           || local.y < bx.min.y - slack || local.y > bx.max.y + slack
           || local.z < bx.min.z - slack || local.z > bx.max.z + slack) continue;
        }
      }

      // Every vertex, not the centroid: a facet lying across a curve has its centroid pulled
      // inside, and on a tangent that is exactly what made it look like part of the plane.
      let fits = true;
      for (const p of [a, b, c]) {
        const sign = face.inward ? -1 : 1;
        if (face.kind === 'plane') {
          // Signed: a neighbour flush against this face shares the plane with the opposite normal.
          if (normal.dot(face.normal) * sign < 0.995) { fits = false; break; }
          if (Math.abs(offset.copy(p).sub(face.point).dot(face.normal)) > 0.02) { fits = false; break; }
        } else if (face.kind === 'cone') {
          // On the cone: at the axial distance s from the apex the radius is s·tan; and facing
          // the right way — outward radially for a piece's face, at the axis for a bore or cut.
          offset.copy(p).sub(face.point);
          const along = offset.dot(face.axis);
          if (along < face.from - 0.05 || along > face.to + 0.05) { fits = false; break; }
          const radial = offset.addScaledVector(face.axis, -along);
          const r = radial.length();
          if (Math.abs(r - along * face.tan) > Math.max(0.05, r * 0.005)) { fits = false; break; }
          if (r > 1e-6 && normal.dot(radial.normalize()) * sign < 0.3) { fits = false; break; }
        } else if (face.kind === 'torus') {
          offset.copy(p).sub(face.point);
          const along = offset.dot(face.axis);
          const radial = offset.clone().addScaledVector(face.axis, -along);
          const d = radial.length();
          // Distance from the tube's core circle, and the position round the tube.
          const dr = d - face.major;
          if (Math.abs(Math.hypot(dr, along) - face.rho) > Math.max(0.05, face.rho * 0.005)) { fits = false; break; }
          if (face.phi && !withinPhi(face.phi, Math.atan2(along, dr))) { fits = false; break; }
          // Facing out of the tube for a bead, into it for a fillet.
          const tubeNormal = radial.normalize().multiplyScalar(dr).addScaledVector(face.axis, along).normalize();
          if (normal.dot(tubeNormal) * sign < 0.3) { fits = false; break; }
        } else if (face.kind === 'sphere') {
          // Every vertex at the radius, facing outward — OpenSCAD's sphere vertices lie exactly
          // on it, so the tolerance is for arithmetic only.
          offset.copy(p).sub(face.point);
          if (Math.abs(offset.length() - face.radius) > Math.max(0.05, face.radius * 0.002)) { fits = false; break; }
          if (normal.dot(offset.normalize()) * sign < 0.5) { fits = false; break; }
        } else {
          if (Math.abs(normal.dot(face.axis)) > 0.05) { fits = false; break; }
          offset.copy(p).sub(face.point);
          offset.addScaledVector(face.axis, -offset.dot(face.axis));
          if (Math.abs(offset.length() - face.radius) > 0.05) { fits = false; break; }
          // Radial direction agrees too: a hole's wall faces its axis, a boss's faces away.
          if (normal.dot(offset.normalize()) * sign < 0.5) { fits = false; break; }
        }
      }
      if (!fits) continue;
      if (face.dividers?.length) {
        const key = face.dividers
          .map((d) => (offset.copy(centroid).sub(d.point).dot(d.across) >= 0 ? '+' : '-')).join('');
        groups.get(regionFace(face, key)).push(t);
      } else {
        groups.get(face).push(t);
      }
      // A curved face owns its triangle outright; a plane's triangle may span into the next
      // piece's coplanar face as well, so the search goes on.
      if (face.kind !== 'plane') break;
    }
  }
  return groups;
}

/// Area of the part of triangle abc (world) that lies inside `box` (in the space `inverse` maps
/// into) — the triangle clipped to the box's six half-spaces, then measured.
export function clippedArea(a, b, c, box, inverse, shift = null) {
  let poly = [a, b, c].map((p) => (shift ? p.clone().add(shift) : p.clone()).applyMatrix4(inverse));
  for (const axis of ['x', 'y', 'z']) {
    for (const side of [-1, 1]) {
      const limit = side < 0 ? box.min[axis] : box.max[axis];
      const inside = (p) => (side < 0 ? p[axis] >= limit : p[axis] <= limit);
      const next = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const pin = inside(p), qin = inside(q);
        if (pin) next.push(p);
        if (pin !== qin) {
          const t = (limit - p[axis]) / (q[axis] - p[axis]);
          next.push(p.clone().lerp(q, t));
        }
      }
      poly = next;
      if (poly.length < 3) return 0;
    }
  }
  const sum = new THREE.Vector3();
  for (let i = 1; i + 1 < poly.length; i++) {
    sum.add(poly[i].clone().sub(poly[0]).cross(poly[i + 1].clone().sub(poly[0])));
  }
  return sum.length() / 2;
}

/// Pickable features, grouped per piece.
///
/// Built one piece at a time on purpose: a feature then cannot span two pieces, which is what
/// the mesh-crease version had to be patched against after the fact.
export function pieceFeatures(pieces) {
  const out = [];
  for (const piece of pieces) {
    const edges = [];
    const o = piece.outline;
    for (let i = 0; i < o.length; i += 6) {
      const a = new THREE.Vector3(o[i], o[i + 1], o[i + 2]);
      const b = new THREE.Vector3(o[i + 3], o[i + 4], o[i + 5]);
      if (a.distanceTo(b) > 1e-6) edges.push({ a, b });
    }
    for (const f of buildFeatures(edges)) out.push({ ...f, piece });
  }
  return out;
}

/// A box from the CSG, prepared for hit-testing and clipping.
export function prepareBox(b) {
  const matrix = new THREE.Matrix4().set(...b.matrix);
  const [sx, sy, sz] = b.size;
  const min = b.centered
    ? new THREE.Vector3(-sx / 2, -sy / 2, -sz / 2)
    : new THREE.Vector3(0, 0, 0);
  return {
    size: b.size,
    matrix,
    inverse: matrix.clone().invert(),
    min,
    max: min.clone().add(new THREE.Vector3(sx, sy, sz)),
  };
}

/// Removes [s, e] from a set of ascending, disjoint spans.
function subtractSpan(spans, s, e) {
  const out = [];
  for (const [a, b] of spans) {
    if (e <= a || s >= b) { out.push([a, b]); continue; }
    if (s > a) out.push([a, s]);
    if (e < b) out.push([e, b]);
  }
  return out;
}

/// The parts of segment a→b that survive every cut, as spans of t in [0, 1].
///
/// Works in the piece's own coordinates against overlaps already reduced to it, so each bound
/// is known to be either a pocket wall inside the piece or flush with the piece's surface.
/// That distinction decides how a segment lying exactly on the bound is treated:
///
///   - on a pocket wall it survives — the wall is a real face and the edge along it is real;
///   - on a flush bound it does not — the cut reaches the piece's surface there, so the
///     material behind the edge is gone. A groove milled right out to the end of a board used
///     to leave the board's original top edge drawn across the removed strip.
function surviving(a, b, cutters) {
  let spans = [[0, 1]];
  for (const cutter of cutters) {
    const span = cutter.profile ? insidePrism(a, b, cutter) : insideOverlap(a, b, cutter.overlap);
    if (span) spans = subtractSpan(spans, Math.max(span[0], 0), Math.min(span[1], 1));
    if (!spans.length) break;
  }
  return spans;
}

/// The span of a segment inside a shaped cut — an extruded convex profile.
///
/// The bounding box will not do here: a cylinder of radius half the side has a box the size of
/// the whole cube, and clipping against that erases every edge the cube has. So the segment is
/// taken into the cutter's own space and clipped against the depth range and then against each
/// edge of the profile as a half-plane.
function insidePrism(a, b, cutter) {
  const p = a.clone().applyMatrix4(cutter.fromPiece);
  const q = b.clone().applyMatrix4(cutter.fromPiece);
  const d = q.clone().sub(p);
  const eps = 1e-6;
  let t0 = 0, t1 = 1;

  // Depth first.
  if (Math.abs(d.z) < 1e-12) {
    if (p.z < cutter.min.z - eps || p.z > cutter.max.z + eps) return null;
  } else {
    let ta = (cutter.min.z - p.z) / d.z;
    let tb = (cutter.max.z - p.z) / d.z;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 >= t1) return null;
  }

  // Then the profile, as one half-plane per edge. Counter-clockwise, so inside is to the left.
  const n = cutter.profile.length;
  for (let i = 0; i < n; i++) {
    const [px, py] = cutter.profile[i];
    const [qx, qy] = cutter.profile[(i + 1) % n];
    const nx = -(qy - py);
    const ny = qx - px;
    const da = nx * (p.x - px) + ny * (p.y - py);
    const db = nx * (q.x - px) + ny * (q.y - py);
    if (da < eps && db < eps) return null;             // wholly outside this edge
    if (Math.abs(db - da) < 1e-12) continue;           // parallel and inside
    const t = da / (da - db);
    if (da < db) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}

/// The span inside a plain box cut, worked out in the piece's own coordinates.
///
/// Each bound is known to be either a pocket wall inside the piece or flush with its surface,
/// and that decides how a segment lying exactly on the bound is treated: on a pocket wall it
/// survives, because the wall is a real face; on a flush bound it does not, because the cut
/// reaches the surface there and the material behind the edge is gone. A groove milled right out
/// to the end of a board otherwise left the board's original top edge drawn across the strip
/// that had been removed.
function insideOverlap(a, b, overlap) {
  if (!overlap) return null;
  const { box, lo, hi } = overlap;
  const eps = 1e-6;
  const axes = ['x', 'y', 'z'];
  const d = b.clone().sub(a);
  let t0 = 0, t1 = 1;

  for (let i = 0; i < 3; i++) {
    const axis = axes[i];
    const min = box.min[axis] + (lo[i] ? -eps : eps);
    const max = box.max[axis] + (hi[i] ? eps : -eps);
    if (Math.abs(d[axis]) < 1e-12) {
      if (a[axis] < min || a[axis] > max) return null;
    } else {
      let ta = (min - a[axis]) / d[axis];
      let tb = (max - a[axis]) / d[axis];
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 >= t1) return null;
    }
  }
  return [t0, t1];
}

/// Mesh vertices into a piece's own coordinates.
///
/// A piece's box comes from the CSG and lives in model space (Z up); a mesh sits in the scene
/// (Y up). Skipping MODEL_TO_WORLD here puts every vertex outside every box — silently, since
/// the result is simply "nothing matched".
function meshToPiece(mesh, box) {
  const worldToModel = new THREE.Matrix4().copy(MODEL_TO_WORLD).invert();
  return new THREE.Matrix4()
    .multiplyMatrices(box.inverse, new THREE.Matrix4().multiplyMatrices(worldToModel, mesh.matrixWorld));
}

/// Clips world-space triangles to a piece's box, as a flat array of positions.
///
/// Needed because CGAL welds coplanar faces: the whole right side of kniznica.scad — the
/// chest's side panel, the board between, and the cabinet's panel above — comes out as one
/// rectangle of two triangles, 2020 mm tall. Highlighting it whole is faithful to the mesh but
/// not to the question being asked, which is about the piece under the cursor.
///
/// Sutherland–Hodgman against the box's six planes, in the piece's own coordinates.
export function clipToBox(mesh, triangles, component, slack = 0.5) {
  const box = prepareBox(component);
  const toPiece = meshToPiece(mesh, box);
  const toWorld = new THREE.Matrix4().multiplyMatrices(MODEL_TO_WORLD, box.matrix);
  const position = mesh.geometry.attributes.position;
  const out = [];

  const planes = [
    { axis: 'x', sign: 1, at: box.min.x - slack }, { axis: 'x', sign: -1, at: box.max.x + slack },
    { axis: 'y', sign: 1, at: box.min.y - slack }, { axis: 'y', sign: -1, at: box.max.y + slack },
    { axis: 'z', sign: 1, at: box.min.z - slack }, { axis: 'z', sign: -1, at: box.max.z + slack },
  ];

  for (const t of triangles) {
    let polygon = [0, 1, 2].map((k) =>
      new THREE.Vector3().fromBufferAttribute(position, t * 3 + k).applyMatrix4(toPiece));

    for (const plane of planes) {
      if (!polygon.length) break;
      const inside = (p) => plane.sign * (p[plane.axis] - plane.at) >= 0;
      const clipped = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const aIn = inside(a);
        const bIn = inside(b);
        if (aIn) clipped.push(a);
        if (aIn !== bIn) {
          const d = b[plane.axis] - a[plane.axis];
          if (Math.abs(d) > 1e-12) {
            clipped.push(a.clone().lerp(b, (plane.at - a[plane.axis]) / d));
          }
        }
      }
      polygon = clipped;
    }

    for (let i = 1; i + 1 < polygon.length; i++) {
      for (const p of [polygon[0], polygon[i], polygon[i + 1]]) {
        const w = p.clone().applyMatrix4(toWorld);
        out.push(w.x, w.y, w.z);
      }
    }
  }
  return out;
}

/// Triangles of `mesh` that reach into a piece's box at all.
///
/// For *showing* a piece, unlike hiding it. CGAL welds coplanar faces, so a triangle can cover
/// this piece and the board flush beside it at once; demanding it lie wholly inside leaves a
/// grey stripe across the highlight wherever that happens. Paired with `clipToBox`, which cuts
/// those triangles back to the piece, the highlight is exact.
const touchingCache = new WeakMap();

export function trianglesTouchingBox(mesh, component) {
  // Cached like `trianglesInBox`: hovering a group asks for every piece in it, and without this
  // that is a full scan of the mesh per piece per pointer move.
  let byPiece = touchingCache.get(mesh);
  if (!byPiece) { byPiece = new Map(); touchingCache.set(mesh, byPiece); }
  const cached = byPiece.get(component);
  if (cached) return cached;

  const box = prepareBox(component);
  const toPiece = meshToPiece(mesh, box);
  const position = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  const slack = 0.5;
  const found = [];

  for (let i = 0; i < position.count / 3; i++) {
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(position, i * 3 + k).applyMatrix4(toPiece);
      const p = [v.x, v.y, v.z];
      for (let a = 0; a < 3; a++) {
        low[a] = Math.min(low[a], p[a]);
        high[a] = Math.max(high[a], p[a]);
      }
    }
    const min = [box.min.x, box.min.y, box.min.z];
    const max = [box.max.x, box.max.y, box.max.z];
    if ([0, 1, 2].every((a) => high[a] >= min[a] - slack && low[a] <= max[a] + slack)) {
      found.push(i);
    }
  }

  byPiece.set(component, found);
  return found;
}

/// Triangles of `mesh` that lie wholly inside a piece's box.
///
/// The union welds panels into one solid, so a piece owns no triangles; this recovers them
/// well enough to light its surfaces and to take it out of the view.
///
/// Every vertex must be inside, not just the centroid: the welded mesh has triangles spanning
/// several panels, and a centroid test handed those to whichever box held their middle — hiding
/// one panel then tore a wedge out of its neighbours. Erring this way leaves a sliver of a
/// piece behind at worst, instead of damaging something else.
///
/// Cached per mesh and piece, since a hover would otherwise rescan on every frame.
const triangleCache = new WeakMap();

export function trianglesInBox(mesh, component) {
  let byPiece = triangleCache.get(mesh);
  if (!byPiece) { byPiece = new Map(); triangleCache.set(mesh, byPiece); }
  const cached = byPiece.get(component);
  if (cached) return cached;

  const box = prepareBox(component);
  const toPiece = meshToPiece(mesh, box);
  const position = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  const slack = 0.5;
  const found = [];

  for (let i = 0; i < position.count / 3; i++) {
    let inside = true;
    for (let k = 0; k < 3 && inside; k++) {
      v.fromBufferAttribute(position, i * 3 + k).applyMatrix4(toPiece);
      inside = v.x >= box.min.x - slack && v.x <= box.max.x + slack
            && v.y >= box.min.y - slack && v.y <= box.max.y + slack
            && v.z >= box.min.z - slack && v.z <= box.max.z + slack;
    }
    if (inside) found.push(i);
  }

  byPiece.set(component, found);
  return found;
}

/// The outline of an extruded piece: the profile at top and bottom, joined at its corners.
///
/// Verticals only where the profile actually turns — a tessellated arc is a smooth surface with
/// no edges along it, so joining every point would draw a fence around every rounded corner.
function profileEdges(profile, box) {
  return profileRims(profile, box.min.z, box.max.z);
}

/// A profile drawn at two depths, with a vertical at every run boundary between them — a corner
/// or the tangent where a flat blends into an arc — and none along an arc, which is one smooth
/// face however it was tessellated.
function profileRims(profile, zLow, zHigh) {
  const at = (p, z) => new THREE.Vector3(p[0], p[1], z);
  const edges = [];
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    edges.push([at(a, zLow), at(b, zLow)], [at(a, zHigh), at(b, zHigh)]);
  }
  const { runs, at: vertex } = profileRuns(profile);
  if (runs.length > 1) {
    for (const run of runs) {
      const v = vertex(run.start);
      edges.push([new THREE.Vector3(v.x, v.y, zLow), new THREE.Vector3(v.x, v.y, zHigh)]);
    }
  }
  return edges;
}

/// Where a cutter overlaps the piece, in the piece's own coordinates.
///
/// The cutter's corners are transformed into piece space and bounded — exact while both are
/// axis-aligned, which is every cut in practice, and a safe over-estimate if one is rotated.
function overlapInPieceSpace(piece, cutter) {
  const toPiece = new THREE.Matrix4().multiplyMatrices(piece.inverse, cutter.matrix);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const x of [cutter.min.x, cutter.max.x]) {
    for (const y of [cutter.min.y, cutter.max.y]) {
      for (const z of [cutter.min.z, cutter.max.z]) {
        box.expandByPoint(v.set(x, y, z).applyMatrix4(toPiece));
      }
    }
  }

  // Which bounds had to be pulled in to the piece: those faces of the overlap lie on the
  // piece's own surface rather than being a wall the cut left behind. The distinction is
  // what tells a real pocket edge from a phantom one — see `overlapEdges`.
  const eps = 1e-6;
  const lo = ['x', 'y', 'z'].map((k) => box.min[k] <= piece.min[k] + eps);
  const hi = ['x', 'y', 'z'].map((k) => box.max[k] >= piece.max[k] - eps);
  box.min.max(piece.min);
  box.max.min(piece.max);
  return box.isEmpty() ? null : { box, lo, hi };
}

/// Edges of the overlap that are genuinely edges of the cut piece.
///
/// An edge runs along one axis and is fixed at a bound on the other two. Each of those bounds
/// is either a wall the cut left inside the piece, or the piece's own surface. If *both* are
/// the piece's own surface the edge is a stretch of the piece's original edge — and that
/// stretch is exactly the material the cut removed, so drawing it puts back a line through
/// empty space.
function overlapEdges({ box, lo, hi }, matrix) {
  const min = [box.min.x, box.min.y, box.min.z];
  const max = [box.max.x, box.max.y, box.max.z];
  const flush = (axis, side) => (side === 0 ? lo[axis] : hi[axis]);

  const edges = [];
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    for (const sb of [0, 1]) {
      for (const sc of [0, 1]) {
        if (flush(b, sb) && flush(c, sc)) continue;
        const from = [], to = [];
        from[b] = to[b] = sb ? max[b] : min[b];
        from[c] = to[c] = sc ? max[c] : min[c];
        from[a] = min[a];
        to[a] = max[a];
        edges.push([
          new THREE.Vector3(...from).applyMatrix4(matrix),
          new THREE.Vector3(...to).applyMatrix4(matrix),
        ]);
      }
    }
  }
  return edges;
}

/// The outline of one piece, in model space, with the material removed by `difference()`
/// clipped away. Without the clipping an edge is drawn straight across a milled groove —
/// that edge belongs to the original box, not to the object the CSG produced.
///
/// Clipping alone is not enough, though: a cut also *creates* edges, around the pocket it
/// leaves behind. Without them an outline arrives at a groove and simply stops, instead of
/// running around the milled shape and rejoining the rest of the piece. So the overlap
/// between piece and cutter contributes its own edges too.
export function pieceOutline(component) {
  const box = prepareBox(component);
  const cutters = (component.cutters ?? []).map((c) => {
    const cut = prepareBox(c);
    cut.profile = c.profile ?? null;
    cut.revolve = c.revolve ?? null;
    cut.fragments = c.fragments ?? 32;
    cut.approximate = c.approximate === true;
    // Piece space into this cutter's own space, so a profile can be honoured where it exists.
    cut.fromPiece = new THREE.Matrix4().multiplyMatrices(cut.inverse, box.matrix);
    cut.toPiece = new THREE.Matrix4().copy(cut.fromPiece).invert();
    cut.overlap = overlapInPieceSpace(box, cut);
    return cut;
  });

  const points = [];
  // Edges are built in the piece's coordinates, clipped there, and only then placed in the
  // world — one transform at the end instead of one per cutter per segment.
  const emit = (segments, against) => {
    for (const [a, b] of segments) {
      for (const [t0, t1] of against.length ? surviving(a, b, against) : [[0, 1]]) {
        if (t1 - t0 < 1e-9) continue;
        const from = a.clone().lerp(b, t0).applyMatrix4(box.matrix);
        const to = a.clone().lerp(b, t1).applyMatrix4(box.matrix);
        points.push(from.x, from.y, from.z, to.x, to.y, to.z);
      }
    }
  };

  const identity = new THREE.Matrix4();

  // The piece's own edges, with the cut-away spans removed. A board with a rounded corner
  // follows its extruded profile; anything else is a box.
  if (component.sphere) return [];       // no edge anywhere on a sphere; its silhouette is drawn per frame
  if (component.revolve) {
    emit(revolveRims(component, box, component.fragments ?? 32), cutters);
    return points;
  }
  emit(component.edges ? component.edges.map(([ax, ay, az, bx, by, bz]) =>
         [new THREE.Vector3(box.min.x + ax, box.min.y + ay, box.min.z + az),
          new THREE.Vector3(box.min.x + bx, box.min.y + by, box.min.z + bz)])
       : component.profile ? profileEdges(component.profile, box) : boxEdges(box.min, box.max, identity),
       cutters);

  // Anything derived from a cut must be kept to the piece. The piece's own edges lie inside its
  // box by construction, but a cut's do not: a handle recess deliberately reaches above the top
  // of the drawer front so the grip is open, and its rim was being drawn up there in the air —
  // 34 of a front's 150 outline segments, and the same for a groove running past a shelf.
  const withinPiece = (edges) => {
    const kept = [];
    for (const [a, b] of edges) {
      const span = clipToBoxSpan(a, b, box, 0.01);
      if (!span) continue;
      const from = a.clone().lerp(b, span[0]);
      const to = a.clone().lerp(b, span[1]);
      if (from.distanceTo(to) > 1e-6) kept.push([from, to]);
    }
    return kept;
  };

  // What each cut leaves behind.
  cutters.forEach((cutter, index) => {
    const others = cutters.filter((_, i) => i !== index);
    if (cutter.profile) {
      emit(withinPiece(holeEdges(cutter, box)), others);
    } else if (cutter.revolve) {
      // A conical cut (a countersink): its rims where the piece begins and ends along its axis,
      // and at every corner of its profile in between — in the cutter's own space, then placed.
      const zLow = Math.max(cutter.min.z, depthLimit(cutter, box, false));
      const zHigh = Math.min(cutter.max.z, depthLimit(cutter, box, true));
      if (zHigh > zLow) {
        // Cloned: neighbouring rim segments share their common point, and transforming in place
        // would move it twice.
        const rims = revolveRims(cutter, cutter, cutter.fragments ?? 32, zLow, zHigh)
          .map(([a, b]) => [a.clone().applyMatrix4(cutter.toPiece), b.clone().applyMatrix4(cutter.toPiece)]);
        emit(withinPiece(rims), others);
      }
    } else if (cutter.overlap && !cutter.approximate) {
      emit(overlapEdges(cutter.overlap, identity), others);
    }
  });

  // Where a cut only touches a face: the tangent is an edge in its own right, and a warning.
  // A box piece only, for now — its faces are the six planes of the box.
  // Clipped against the *other* cuts, never against its own: the tangent lies on that cut's own
  // surface and would be taken for inside. On a wall that another cut passes through, the
  // tangent then runs from the wall's edge to the rim of the hole and stops — as Fusion draws
  // it — rather than across the empty hole.
  if (!component.profile) {
    cutters.forEach((cutter, index) => {
      emit(withinPiece(tangentEdges(cutter, box)), cutters.filter((_, i) => i !== index));
    });
  }

  // And where two cuts meet each other. Each pair once, and clipped against neither of them:
  // the curve lies on both surfaces, so either would clip it away entirely.
  for (let i = 0; i < cutters.length; i++) {
    for (let j = i + 1; j < cutters.length; j++) {
      const rest = cutters.filter((_, k) => k !== i && k !== j);
      emit(withinPiece(cutIntersectionEdges(cutters[i], cutters[j], box)), rest);
    }
  }

  return points;
}

/// The 12 edges of a box, as pairs of points in whatever space `matrix` maps into.
function boxEdges(min, max, matrix) {
  const c = [min, max];
  const at = (i, j, k) => new THREE.Vector3(c[i].x, c[j].y, c[k].z).applyMatrix4(matrix);
  const out = [];
  for (const [f, t] of [
    [[0, 0, 0], [1, 0, 0]], [[1, 0, 0], [1, 1, 0]], [[1, 1, 0], [0, 1, 0]], [[0, 1, 0], [0, 0, 0]],
    [[0, 0, 1], [1, 0, 1]], [[1, 0, 1], [1, 1, 1]], [[1, 1, 1], [0, 1, 1]], [[0, 1, 1], [0, 0, 1]],
    [[0, 0, 0], [0, 0, 1]], [[1, 0, 0], [1, 0, 1]], [[1, 1, 0], [1, 1, 1]], [[0, 1, 0], [0, 1, 1]],
  ]) out.push([at(...f), at(...t)]);
  return out;
}

/// Where a shaped cut merely touches a face of the piece, without passing through it.
///
/// A cylinder of radius half the side drilled through a cube is tangent to every wall it runs
/// between. Along that line the material behind the wall is cut down to nothing, and at the point
/// where two such lines cross the wall has zero thickness — which cannot be made. A B-rep kernel
/// treats the tangent as an edge regardless: two faces meet there, the wall and the cylinder,
/// and an edge is the boundary between faces, not a crease. Fusion goes on to split the wall into
/// the four quadrants those edges bound, so the pinch is visible as topology.
///
/// This is deliberately *not* done for the blend where a rounded corner of a board meets its
/// straight side. That tangent is intended design and drawing it would fence in every rounded
/// corner; this one is a warning.
///
/// A tangent shows up as a profile vertex whose whole ruling lies in one of the piece's faces.
function tangentEdges(cutter, box) {
  if (!cutter.profile) return [];
  const eps = 0.02;
  const edges = [];

  const planes = [
    { axis: 'x', at: box.min.x }, { axis: 'x', at: box.max.x },
    { axis: 'y', at: box.min.y }, { axis: 'y', at: box.max.y },
    { axis: 'z', at: box.min.z }, { axis: 'z', at: box.max.z },
  ];

  for (const [px, py] of cutter.profile) {
    const a = new THREE.Vector3(px, py, cutter.min.z).applyMatrix4(cutter.toPiece);
    const b = new THREE.Vector3(px, py, cutter.max.z).applyMatrix4(cutter.toPiece);

    for (const plane of planes) {
      if (Math.abs(a[plane.axis] - plane.at) > eps || Math.abs(b[plane.axis] - plane.at) > eps) continue;
      // The ruling lies in this face. Keep the part within the face's own extent.
      const span = clipToBoxSpan(a, b, box, eps);
      if (!span) continue;
      const from = a.clone().lerp(b, span[0]);
      const to = a.clone().lerp(b, span[1]);
      if (from.distanceTo(to) > 1e-6) edges.push([from, to]);
    }
  }
  return edges;
}

/// The part of a→b inside an axis-aligned box in the same space, as [t0, t1] or null.
function clipToBoxSpan(a, b, box, slack) {
  const d = b.clone().sub(a);
  let t0 = 0, t1 = 1;
  for (const axis of ['x', 'y', 'z']) {
    const min = box.min[axis] - slack;
    const max = box.max[axis] + slack;
    if (Math.abs(d[axis]) < 1e-12) {
      if (a[axis] < min || a[axis] > max) return null;
    } else {
      let ta = (min - a[axis]) / d[axis];
      let tb = (max - a[axis]) / d[axis];
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 >= t1) return null;
    }
  }
  return [t0, t1];
}

/// Where two shaped cuts meet each other inside the piece.
///
/// Two cylinders drilled through a cube meet along a curve, and that curve is a crease of the
/// resulting solid — the mesh-crease reader found it for free, and reading edges from the CSG
/// instead means it has to be reconstructed. It is not the rim of either cut, nor an edge of the
/// piece: it belongs to the pair.
///
/// Sampled rather than solved. Each cut is a prism, so take the rulings of one — the straight
/// lines through its profile points, along its axis — and clip each against the other prism. The
/// ends of what survives lie on both surfaces at once, which is the definition of the curve.
/// Following the profile in order threads those points into polylines. This works for any pair of
/// prisms, so two crossing grooves get their intersection as readily as two cylinders.
function cutIntersectionEdges(a, b, box) {
  if (!a.profile || !b.profile) return [];

  const aToB = new THREE.Matrix4().multiplyMatrices(b.inverse, a.matrix);
  const entering = [];
  const leaving = [];

  for (const [px, py] of a.profile) {
    // The ruling as a segment spanning the cut's depth, taken into the other cut's space.
    const p = new THREE.Vector3(px, py, a.min.z).applyMatrix4(aToB);
    const q = new THREE.Vector3(px, py, a.max.z).applyMatrix4(aToB);
    const span = clipToPrism(p, q, b) ?? grazeOfPrism(p, q, b);
    if (!span) { entering.push(null); leaving.push(null); continue; }

    // Back into the piece's coordinates, where every other edge lives.
    const low = new THREE.Vector3(px, py, a.min.z + (a.max.z - a.min.z) * span[0]);
    const high = new THREE.Vector3(px, py, a.min.z + (a.max.z - a.min.z) * span[1]);
    entering.push(low.applyMatrix4(a.toPiece));
    leaving.push(high.applyMatrix4(a.toPiece));
  }

  const edges = [];
  for (const curve of [entering, leaving]) {
    for (let i = 0; i < curve.length; i++) {
      const from = curve[i];
      const to = curve[(i + 1) % curve.length];
      // A gap means the ruling missed the other cut; the curve simply is not there.
      if (!from || !to) continue;
      if (from.distanceTo(to) < 1e-6) continue;
      edges.push([from, to]);
    }
  }
  return edges;
}

/// Where a ruling only grazes a prism: the point at which it crosses one of the prism's own
/// rulings, as a zero-length [t, t], or null when it does not touch.
///
/// Two equal cylinders crossing meet in two ellipses, and the ellipses meet each other exactly
/// where each cylinder touches the wall — the point the wall is divided at. There the ruling of
/// one lies along the tangent plane of the other and clipping finds nothing inside, so the curve
/// used to jump from the vertex before that point to the vertex after and stop 3 mm short of the
/// rim. The polyhedral intersection has a vertex there: the two rulings cross.
function grazeOfPrism(p, q, prism) {
  const dx = q.x - p.x, dy = q.y - p.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const eps = 1e-4;
  for (const [vx, vy] of prism.profile) {
    // Distance from the vertex to the ruling's line in the profile plane, and where along it.
    const t = ((vx - p.x) * dx + (vy - p.y) * dy) / (len * len);
    if (t < -eps || t > 1 + eps) continue;
    const cx = p.x + dx * t, cy = p.y + dy * t;
    if (Math.hypot(cx - vx, cy - vy) > eps) continue;
    const z = p.z + (q.z - p.z) * t;
    if (z < prism.min.z - eps || z > prism.max.z + eps) continue;
    const tt = Math.min(1, Math.max(0, t));
    return [tt, tt];
  }
  return null;
}

/// The part of segment p→q inside a prism, as [t0, t1] in the segment's own parameter, or null.
/// Depth first, then one half-plane per profile edge; the profile is convex here.
function clipToPrism(p, q, prism) {
  const d = q.clone().sub(p);
  const eps = 1e-6;
  let t0 = 0, t1 = 1;

  if (Math.abs(d.z) < 1e-12) {
    if (p.z < prism.min.z - eps || p.z > prism.max.z + eps) return null;
  } else {
    let ta = (prism.min.z - p.z) / d.z;
    let tb = (prism.max.z - p.z) / d.z;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 >= t1) return null;
  }

  const n = prism.profile.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = prism.profile[i];
    const [bx, by] = prism.profile[(i + 1) % n];
    const nx = -(by - ay);
    const ny = bx - ax;
    const da = nx * (p.x - ax) + ny * (p.y - ay);
    const db = nx * (q.x - ax) + ny * (q.y - ay);
    if (da < eps && db < eps) return null;
    if (Math.abs(db - da) < 1e-12) continue;
    const t = da / (da - db);
    if (da < db) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}

/// The rim a shaped cut leaves where it enters and leaves the piece.
///
/// A hole drilled through a board is bounded by two circles, one on each face — and they are its
/// only edges, because the cylindrical wall is smooth and a tangent line is not a crease. Those
/// circles are the cutter's own profile, drawn at the depths where the piece actually stops it.
function holeEdges(cutter, box) {
  const zLow = Math.max(cutter.min.z, depthLimit(cutter, box, false));
  const zHigh = Math.min(cutter.max.z, depthLimit(cutter, box, true));
  if (!(zHigh > zLow)) return [];

  // Rims at both depths, and down the wall of the cut a line wherever its profile changes run —
  // a handle recess has an edge where its flat bottom blends into each rounded end.
  return profileRims(cutter.profile, zLow, zHigh).map(([a, b]) =>
    [a.applyMatrix4(cutter.toPiece), b.applyMatrix4(cutter.toPiece)]);
}

/// How deep into the cutter the piece reaches, along the cutter's own extrusion axis.
///
/// The piece's eight corners bound it: exact while both are axis-aligned, which is every cut in
/// practice, and a safe over-estimate when one is turned.
function depthLimit(cutter, box, upper) {
  const v = new THREE.Vector3();
  let bound = upper ? -Infinity : Infinity;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        v.set(x, y, z).applyMatrix4(cutter.fromPiece);
        bound = upper ? Math.max(bound, v.z) : Math.min(bound, v.z);
      }
    }
  }
  return bound;
}

// --- features: lines and arcs ---

const vertexKey = (v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;

/// Circle through three points in 3D, or null if they are collinear.
function circleThrough(a, b, c) {
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const n = new THREE.Vector3().crossVectors(ab, ac);
  const n2 = n.lengthSq();
  if (n2 < 1e-12) return null;

  const toCentre = new THREE.Vector3()
    .addScaledVector(new THREE.Vector3().crossVectors(n, ab), ac.lengthSq())
    .addScaledVector(new THREE.Vector3().crossVectors(ac, n), ab.lengthSq())
    .divideScalar(2 * n2);
  return { centre: a.clone().add(toCentre), radius: toCentre.length(), normal: n.normalize() };
}

/// Groups the raw edge segments into things a person would call one edge.
///
/// A rounded corner reaches us as a run of short chords — OpenSCAD tessellates the arc and
/// the mesh has no idea it was ever a circle. Walking the chains and fitting a circle to a
/// run of constant turn recovers it, so the corner can be picked once and reports its radius.
///
/// Chains stop wherever a vertex has other edges meeting it (a corner, a T-junction), so
/// separate edges never merge across a junction.
/// The part of segment a→b inside a piece's box, as [t0, t1], or null.
function insideBox(a, b, piece, slack = 0.5) {
  const p = a.clone().applyMatrix4(piece.inverse);
  const q = b.clone().applyMatrix4(piece.inverse);
  const d = q.clone().sub(p);
  let t0 = 0, t1 = 1;

  for (const axis of ['x', 'y', 'z']) {
    const min = piece.box.min[axis] - slack;
    const max = piece.box.max[axis] + slack;
    if (Math.abs(d[axis]) < 1e-12) {
      if (p[axis] < min || p[axis] > max) return null;
    } else {
      let ta = (min - p[axis]) / d[axis];
      let tb = (max - p[axis]) / d[axis];
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 >= t1) return null;
    }
  }
  return [t0, t1];
}

/// A feature limited to one piece — but only when it actually runs past it.
///
/// CGAL welds coplanar faces, so the front edges of boards flush with one another come out as a
/// single segment: measured on kniznica.scad, two of them 2020 mm long, spanning the chest panel,
/// the board between and the cabinet panel. Hovering any of the three lit up all 2020 mm and
/// reported that as the edge's length.
///
/// Returned unchanged when every segment already lies inside the piece, which is the normal case:
/// trimming otherwise would round arc endpoints and report lengths a hair short for no reason.
export function clipFeatureToPiece(feature, piece) {
  if (!piece) return feature;

  // Two different tolerances on purpose. Deciding whether an edge belongs to this piece needs
  // slack, since mesh vertices do not land exactly on a CSG box. Trimming must not: the slack
  // would end up in the reported length, and 1220.5 mm for a 1220 mm panel is a wrong number on
  // screen in a tool whose whole job is dimensions.
  const loose = feature.segments.map((seg) => insideBox(seg.a, seg.b, piece));
  const outside = loose.some((span) => !span || span[0] > 1e-6 || span[1] < 1 - 1e-6);
  if (!outside) return feature;

  // Not zero. The mesh arrives through ASCII STL, so a coordinate near 1850 mm carries error in
  // the thousandths, and an edge lying *on* a box face can fall outside it. A straight edge of a
  // board lies on two faces at once and so has two chances to be dropped, while an arc rim lies
  // on one — which is exactly how a zero tolerance left only arc rims pickable. At 0.01 mm the
  // length is off by at most a fiftieth of a millimetre, below what the readout shows.
  const spans = feature.segments.map((seg) => insideBox(seg.a, seg.b, piece, 0.01));
  const segments = [];
  let length = 0;
  for (const [i, span] of spans.entries()) {
    if (!span) continue;
    const { a, b } = feature.segments[i];
    const from = a.clone().lerp(b, span[0]);
    const to = a.clone().lerp(b, span[1]);
    if (from.distanceTo(to) < 1e-6) continue;
    segments.push({ a: from, b: to });
    length += from.distanceTo(to);
  }
  if (!segments.length) return feature;

  return { ...feature, segments, length, clipped: true,
           a: segments[0].a, b: segments[segments.length - 1].b };
}

export function buildFeatures(edges) {
  const byVertex = new Map();
  edges.forEach((e, i) => {
    for (const v of [e.a, e.b]) {
      const k = vertexKey(v);
      const list = byVertex.get(k);
      if (list) list.push(i); else byVertex.set(k, [i]);
    }
  });

  const used = new Array(edges.length).fill(false);
  const chains = [];

  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const points = [edges[i].a.clone(), edges[i].b.clone()];

    const extend = (atEnd) => {
      for (;;) {
        const tip = atEnd ? points[points.length - 1] : points[0];
        const k = vertexKey(tip);
        const incident = byVertex.get(k) ?? [];
        if (incident.length !== 2) break;                    // corner or junction: stop
        const next = incident.find((j) => !used[j]);
        if (next === undefined) break;
        used[next] = true;
        const e = edges[next];
        const far = vertexKey(e.a) === k ? e.b : e.a;
        if (atEnd) points.push(far.clone()); else points.unshift(far.clone());
      }
    };
    extend(true);
    extend(false);
    chains.push(points);
  }

  const features = [];
  // Below this a turn is just tessellation noise on a straight run. A genuine arc from
  // OpenSCAD turns by $fa (12° by default) per segment, so the gap is wide.
  const STRAIGHT = 1.5 * Math.PI / 180;
  const CORNER = 30 * Math.PI / 180;

  const turnAt = (p, i) => {
    const u = p[i].clone().sub(p[i - 1]).normalize();
    const v = p[i + 1].clone().sub(p[i]).normalize();
    return Math.acos(Math.max(-1, Math.min(1, u.dot(v))));
  };

  for (const points of chains) {
    if (points.length === 2) { features.push(makeFeature(points, false)); continue; }

    // Segments, not turns, are what lie on an arc. Segment k runs from point k to k+1; it is a
    // step of an arc when the turn at each of its ends is a curved one (or the end is the end
    // of the chain — a corner, which the chain already stopped at) and it is as long as a
    // neighbouring step, because OpenSCAD samples an arc in equal steps. The length matters:
    // the flat between two rounded corners meets each arc at a tangent, so the turns at both
    // its ends are small but curved, and by turns alone the two arcs and the flat became one
    // arc with a radius of 642 mm.
    // A turn of 30° or more is a corner, never a step: three sides of a welded-in board, whose
    // corners have no vertical edge to stop the chain, are as cocircular as any square's
    // vertices and came out as an arc of radius 316.
    const segments = points.length - 1;
    const turnCurved = (i) => {
      if (i <= 0 || i >= points.length - 1) return true;
      const t = turnAt(points, i);
      return t > STRAIGHT && t < CORNER;
    };
    const length = (k) => points[k].distanceTo(points[k + 1]);
    const similar = (a, b) => Math.abs(a - b) <= 0.2 * Math.max(a, b);
    const isStep = (k) => turnCurved(k) && turnCurved(k + 1)
      && ((k > 0 && similar(length(k), length(k - 1))) || (k < segments - 1 && similar(length(k), length(k + 1))));

    // Segments `from` up to `to` that are not arc steps: one straight edge per run between
    // turns, since an edge ends at a vertex and any turn beyond tessellation noise is one.
    const straight = (from, to) => {
      let start = from;
      for (let i = from + 1; i < to; i++) {
        if (turnAt(points, i) > STRAIGHT) { features.push(makeFeature(points.slice(start, i + 1), false)); start = i; }
      }
      features.push(makeFeature(points.slice(start, to + 1), false));
    };

    let cursor = 0;
    let k = 0;
    while (k < segments) {
      if (!isStep(k)) { k++; continue; }
      let to = k;
      while (to + 1 < segments && isStep(to + 1)) to++;
      if (k > cursor) straight(cursor, k);
      features.push(makeFeature(points.slice(k, to + 2), true));
      cursor = to + 1;
      k = to + 1;
    }
    if (cursor < segments) straight(cursor, segments);
  }

  return mergeCircles(features.filter(Boolean));
}

/// Joins arcs of one and the same circle that meet end to end.
///
/// Two rims crossing on a face genuinely divide each other, so chaining is right to stop where
/// four edges meet — but the two halves are still one circle, and selecting the rim of a hole
/// should give the rim rather than half of it. Only arcs sharing a centre, a radius and a plane
/// are joined, so two distinct circles that happen to touch stay apart.
function mergeCircles(features) {
  const arcs = features.filter((f) => (f.type === 'arc' && f.centre && f.radius) || f.type === 'ellipse');
  if (arcs.length < 2) return features;

  const ends = (f) => [f.segments[0].a, f.segments[f.segments.length - 1].b];
  const touching = (a, b) => ends(a).some((p) => ends(b).some((q) => p.distanceTo(q) < 0.05));
  // The same circle, or the same ellipse: the cube's crossing curves are cut into quarters by
  // the four points where the cuts touch the walls, and are still each one ellipse.
  const coCircular = (a, b) =>
    a.type === b.type
    && (a.type === 'arc' ? Math.abs(a.radius - b.radius) < 0.05
                         : Math.abs(a.a - b.a) < 0.05 && Math.abs(a.b - b.b) < 0.05)
    && a.centre.distanceTo(b.centre) < 0.05
    && (!a.normal || !b.normal || Math.abs(a.normal.dot(b.normal)) > 0.999);

  const used = new Set();
  const groups = [];
  for (const arc of arcs) {
    if (used.has(arc)) continue;
    const group = [arc];
    used.add(arc);
    for (;;) {
      const next = arcs.find((other) => !used.has(other) && coCircular(arc, other)
                                     && group.some((g) => touching(g, other)));
      if (!next) break;
      used.add(next);
      group.push(next);
    }
    if (group.length > 1) groups.push(group);
  }
  if (!groups.length) return features;

  const joined = groups.map((group) => ({
    ...group[0],
    segments: group.flatMap((g) => g.segments),
    length: group.reduce((n, g) => n + (g.length ?? 0), 0),
    sweep: Math.min(group.reduce((n, g) => n + (g.sweep ?? 0), 0), 2 * Math.PI),
  }));
  const consumed = new Set(groups.flat());
  return features.filter((f) => !consumed.has(f)).concat(joined);
}

function makeFeature(points, curved) {
  if (points.length < 2) return null;
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) segments.push({ a: points[i], b: points[i + 1] });

  if (curved && points.length >= 4) {
    // A closed loop — the rim of a hole — ends where it starts, so its two ends cannot both be
    // fit points; three points a third of the way round each are. (The same trap as in the
    // face runs: a circle came out as a "line" of 48 segments.)
    const closed = points[0].distanceTo(points[points.length - 1]) < 0.05;
    const third = Math.floor(points.length / 3);
    const fit = closed
      ? circleThrough(points[0], points[third], points[2 * third])
      : circleThrough(points[0], points[Math.floor(points.length / 2)], points[points.length - 1]);
    if (fit) {
      const tolerance = Math.max(0.05, fit.radius * 0.005);
      const onCircle = points.every((p) => Math.abs(p.distanceTo(fit.centre) - fit.radius) < tolerance);
      if (onCircle) {
        let sweep = 0;
        for (let i = 0; i < points.length - 1; i++) {
          const u = points[i].clone().sub(fit.centre);
          const v = points[i + 1].clone().sub(fit.centre);
          sweep += u.angleTo(v);
        }
        // Triangulation noise fits tiny circles too: sub-millimetre runs came out as
        // "R 2.4 mm / 15°" arcs. A fillet worth picking is orders of magnitude longer —
        // the real corner here is R150 over 226 mm — so the cut is unambiguous.
        if (fit.radius * sweep >= 5) return {
          type: 'arc', segments, points,
          radius: fit.radius, centre: fit.centre, normal: fit.normal,
          sweep, length: fit.radius * sweep,
        };
      }
    }
  }

  const length = segments.reduce((n, s) => n + s.a.distanceTo(s.b), 0);

  // Not a circle, but still a curve: two cylinders crossing meet in an ellipse, and the mesh
  // has no other way to say so than a run of equal-ish steps that no circle fits.
  if (curved && points.length >= 6) {
    const ellipse = ellipseThrough(points);
    if (ellipse && length >= 5) return { type: 'ellipse', segments, points, length, ...ellipse };
  }

  return { type: 'line', segments, points, length, a: points[0], b: points[points.length - 1] };
}

/// The ellipse a planar run of points lies on — centre, semi-axes and their directions — or null.
///
/// The conic is fitted by least squares in the run's own plane (Ax² + Bxy + Cy² + Dx + Ey = 1,
/// after centring and scaling so the system is well conditioned), then read back as centre and
/// axes. Every point must then lie on it within half a percent of the major axis: the fit is
/// only accepted as an ellipse when the points genuinely are one, not merely nearest to one.
function ellipseThrough(points) {
  const n = points.length;
  const centroid = points.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(n);
  const extent = points.reduce((m, p) => Math.max(m, p.distanceTo(centroid)), 0);
  if (extent < 1e-6) return null;
  const planeTolerance = Math.max(0.05, extent * 0.005);

  // The plane: normal from the two most spread directions, then every point checked against it.
  const first = points[0].clone().sub(centroid);
  let normal = null;
  for (let i = 1; i < n && !normal; i++) {
    const cross = first.clone().cross(points[i].clone().sub(centroid));
    if (cross.length() > extent * extent * 0.05) normal = cross.normalize();
  }
  if (!normal) return null;
  if (!points.every((p) => Math.abs(p.clone().sub(centroid).dot(normal)) < planeTolerance)) return null;

  const u = first.clone().normalize();
  const v = normal.clone().cross(u).normalize();
  const flat = points.map((p) => {
    const d = p.clone().sub(centroid);
    return [d.dot(u) / extent, d.dot(v) / extent];
  });

  // Normal equations for the five conic coefficients.
  const rows = flat.map(([x, y]) => [x * x, x * y, y * y, x, y]);
  const m = Array.from({ length: 5 }, () => new Array(6).fill(0));
  for (const r of rows) {
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) m[i][j] += r[i] * r[j];
      m[i][5] += r[i];
    }
  }
  const coefficients = solveLinear(m);
  if (!coefficients) return null;
  const [A, B, C, D, E] = coefficients;
  if (B * B - 4 * A * C >= -1e-9) return null;                       // not an ellipse

  // Centre, and the quadratic about it.
  const det = 4 * A * C - B * B;
  const cx = (B * E - 2 * C * D) / det;
  const cy = (B * D - 2 * A * E) / det;
  const k = 1 - (A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy);
  if (k <= 0) return null;
  // Eigenvalues of [[A, B/2], [B/2, C]]: the semi-axes are sqrt(k / λ).
  const half = (A + C) / 2;
  const diff = Math.sqrt(((A - C) / 2) ** 2 + (B / 2) ** 2);
  const l1 = half - diff, l2 = half + diff;                          // l1 ≤ l2 → major axis first
  if (l1 <= 0) return null;
  const a = Math.sqrt(k / l1) * extent;
  const b = Math.sqrt(k / l2) * extent;
  if (a / b > 50) return null;
  const angle = Math.abs(B) < 1e-12 ? (A <= C ? 0 : Math.PI / 2) : Math.atan2(l1 - A, B / 2);

  // Every point on the curve: algebraic residual over gradient is the distance to first order.
  const tolerance = Math.max(0.05, a * 0.005) / extent;
  for (const [x, y] of flat) {
    const q = A * x * x + B * x * y + C * y * y + D * x + E * y - 1;
    const gx = 2 * A * x + B * y + D, gy = B * x + 2 * C * y + E;
    const grad = Math.hypot(gx, gy);
    if (grad < 1e-12 || Math.abs(q) / grad > tolerance) return null;
  }

  const centre = centroid.clone().addScaledVector(u, cx * extent).addScaledVector(v, cy * extent);
  const major = u.clone().multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle)).normalize();
  return { centre, normal, a, b, major };
}

/// Gaussian elimination with partial pivoting on an augmented n × (n+1) matrix, or null when
/// singular.
function solveLinear(m) {
  const n = m.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/// Nearest feature to the cursor, honouring occlusion the same way `edgeUnderCursor` does.
/// The vertex — an end of some edge — nearest the cursor within `threshold` pixels, honouring
/// occlusion like `featureUnderCursor`. A vertex is where a distance is often wanted from: the
/// corner of a board, the end of a groove.
export function vertexUnderCursor(px, features, camera, canvas, threshold = 6, occluders = null) {
  const candidates = [];
  const seen = new Set();
  for (const f of features) {
    const first = f.segments[0].a, last = f.segments[f.segments.length - 1].b;
    if (first.distanceTo(last) < 0.05) continue;       // a closed circle: its seam is no vertex
    for (const v of [first, last]) {
      const key = `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const d = toScreen(v, camera, canvas).distanceTo(px);
      if (d < threshold) candidates.push({ distance: d, point: v.clone() });
    }
  }
  candidates.sort((x, y) => x.distance - y.distance);
  if (!occluders?.length) return candidates[0]?.point ?? null;
  const raycaster = new THREE.Raycaster();
  for (const c of candidates) {
    if (isVisible(c.point, camera, canvas, raycaster, occluders)) return c.point;
  }
  return null;
}

export function featureUnderCursor(px, features, camera, canvas, threshold = 14, occluders = null) {
  const candidates = [];
  for (const f of features) {
    let best = null;
    for (const s of f.segments) {
      const a = toScreen(s.a, camera, canvas);
      const b = toScreen(s.b, camera, canvas);
      const { distance, t } = pointToSegment2D(px, a, b);
      if (!best || distance < best.distance) best = { distance, point: s.a.clone().lerp(s.b, t) };
    }
    if (best && best.distance < threshold) candidates.push({ feature: f, ...best });
  }
  candidates.sort((x, y) => x.distance - y.distance);
  if (!occluders?.length) return candidates[0]?.feature ?? null;

  const raycaster = new THREE.Raycaster();
  for (const c of candidates) {
    if (isVisible(c.point, camera, canvas, raycaster, occluders)) return c.feature;
  }
  return null;
}
