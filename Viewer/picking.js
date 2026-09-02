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
      id: c.id, name: c.name, groups: c.groups ?? [], source: c,
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

  const plane = (p0, n, label, tag = null) => faces.push({
    kind: 'plane', label, tag,
    point: p0.clone().applyMatrix4(toWorld),
    normal: n.clone().transformDirection(toWorld).normalize(),
    piece,
    dividers: [],       // tangent lines lying in this face, which split it — see below
  });
  const cylinder = (p0, axis, radius, label) => faces.push({
    kind: 'cylinder', label, radius,
    point: p0.clone().applyMatrix4(toWorld),
    axis: axis.clone().transformDirection(toWorld).normalize(),
    piece,
  });

  addSurfaces(source, piece.box, plane, cylinder, '');

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
  for (const cut of source.cutters ?? []) {
    const box = prepareBox(cut);
    // Cut space into the piece's own space. The cutter's matrix reaches model space, and
    // `piece.inverse` reaches back from the world, so MODEL_TO_WORLD sits between them —
    // leaving it out applies the piece's own transform twice.
    const cutToPiece = new THREE.Matrix4()
      .multiplyMatrices(piece.inverse, MODEL_TO_WORLD)
      .multiply(box.matrix);
    const place = (v) => v.clone().applyMatrix4(cutToPiece);
    const dir = (v) => v.clone().transformDirection(cutToPiece);
    addSurfaces(cut, box, (p0, n, label) => plane(place(p0), dir(n), label),
                (p0, axis, radius, label) => cylinder(place(p0), dir(axis), radius, label),
                'cut ');
  }
  return faces;
}

/// The surfaces of one primitive — a box, or a profile extruded along z.
function addSurfaces(source, box, plane, cylinder, prefix) {
  const { min, max } = box;

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
  // cylinder. Splitting on the same turn threshold the features use, so a face and the edge
  // bounding it always agree on where the curve begins.
  const profile = source.profile.map(([x, y]) => new THREE.Vector2(x, y));
  const n = profile.length;
  const turn = (i) => {
    const a = profile[(i - 1 + n) % n], b = profile[i], c = profile[(i + 1) % n];
    const u = b.clone().sub(a).normalize();
    const v = c.clone().sub(b).normalize();
    return Math.acos(Math.max(-1, Math.min(1, u.dot(v))));
  };
  const STRAIGHT = 1.5 * Math.PI / 180;

  let i = 0;
  while (i < n) {
    const curved = turn(i) > STRAIGHT;
    let j = i;
    while (j + 1 < n && (turn(j + 1) > STRAIGHT) === curved) j++;

    if (curved) {
      const a = profile[i], b = profile[Math.floor((i + j) / 2)], c = profile[j];
      const fit = circleThrough2D(a, b, c);
      if (fit) {
        cylinder(new THREE.Vector3(fit.centre.x, fit.centre.y, min.z),
                 new THREE.Vector3(0, 0, 1), fit.radius, prefix + 'round side');
      }
    } else {
      const a = profile[i], b = profile[(j + 1) % n];
      const edge = b.clone().sub(a);
      if (edge.lengthSq() > 1e-12) {
        const outward = new THREE.Vector2(edge.y, -edge.x).normalize();
        plane(new THREE.Vector3(a.x, a.y, min.z),
              new THREE.Vector3(outward.x, outward.y, 0), prefix + 'side');
      }
    }
    i = j + 1;
  }
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
  const ordered = [...faces].sort((a, b) => (a.kind === 'cylinder' ? -1 : 0) - (b.kind === 'cylinder' ? -1 : 0));

  for (const t of indices) {
    a.fromBufferAttribute(position, t * 3).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(position, t * 3 + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(position, t * 3 + 2).applyMatrix4(mesh.matrixWorld);
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    normal.copy(b).sub(a).cross(c.clone().sub(a));
    if (normal.lengthSq() < 1e-18) continue;
    normal.normalize();

    for (const face of ordered) {
      // Every vertex, not the centroid: a facet lying across a curve has its centroid pulled
      // inside, and on a tangent that is exactly what made it look like part of the plane.
      let fits = true;
      for (const p of [a, b, c]) {
        if (face.kind === 'plane') {
          if (Math.abs(normal.dot(face.normal)) < 0.995) { fits = false; break; }
          if (Math.abs(offset.copy(p).sub(face.point).dot(face.normal)) > 0.02) { fits = false; break; }
        } else {
          if (Math.abs(normal.dot(face.axis)) > 0.05) { fits = false; break; }
          offset.copy(p).sub(face.point);
          offset.addScaledVector(face.axis, -offset.dot(face.axis));
          if (Math.abs(offset.length() - face.radius) > 0.05) { fits = false; break; }
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
      break;
    }
  }
  return groups;
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
export function clipToBox(mesh, triangles, component) {
  const box = prepareBox(component);
  const toPiece = meshToPiece(mesh, box);
  const toWorld = new THREE.Matrix4().multiplyMatrices(MODEL_TO_WORLD, box.matrix);
  const position = mesh.geometry.attributes.position;
  const slack = 0.5;
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
  const turn = 15 * Math.PI / 180;
  const zLow = box.min.z;
  const zHigh = box.max.z;
  const at = (p, z) => new THREE.Vector3(p[0], p[1], z);
  const edges = [];

  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    edges.push([at(a, zLow), at(b, zLow)], [at(a, zHigh), at(b, zHigh)]);

    const previous = profile[(i - 1 + profile.length) % profile.length];
    const incoming = new THREE.Vector2(a[0] - previous[0], a[1] - previous[1]).normalize();
    const outgoing = new THREE.Vector2(b[0] - a[0], b[1] - a[1]).normalize();
    if (Math.acos(Math.max(-1, Math.min(1, incoming.dot(outgoing)))) > turn) {
      edges.push([at(a, zLow), at(a, zHigh)]);
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
  emit(component.profile ? profileEdges(component.profile, box) : boxEdges(box.min, box.max, identity),
       cutters);

  // What each cut leaves behind.
  cutters.forEach((cutter, index) => {
    const others = cutters.filter((_, i) => i !== index);
    if (cutter.profile) {
      emit(holeEdges(cutter, box), others);
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
      emit(tangentEdges(cutter, box), cutters.filter((_, i) => i !== index));
    });
  }

  // And where two cuts meet each other. Each pair once, and clipped against neither of them:
  // the curve lies on both surfaces, so either would clip it away entirely.
  for (let i = 0; i < cutters.length; i++) {
    for (let j = i + 1; j < cutters.length; j++) {
      const rest = cutters.filter((_, k) => k !== i && k !== j);
      emit(cutIntersectionEdges(cutters[i], cutters[j], box), rest);
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
    const span = clipToPrism(p, q, b);
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

  const edges = [];
  for (const z of [zLow, zHigh]) {
    for (let i = 0; i < cutter.profile.length; i++) {
      const p = cutter.profile[i];
      const q = cutter.profile[(i + 1) % cutter.profile.length];
      edges.push([
        new THREE.Vector3(p[0], p[1], z).applyMatrix4(cutter.toPiece),
        new THREE.Vector3(q[0], q[1], z).applyMatrix4(cutter.toPiece),
      ]);
    }
  }
  return edges;
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

  const turnAt = (p, i) => {
    const u = p[i].clone().sub(p[i - 1]).normalize();
    const v = p[i + 1].clone().sub(p[i]).normalize();
    return Math.acos(Math.max(-1, Math.min(1, u.dot(v))));
  };

  for (const points of chains) {
    if (points.length === 2) { features.push(makeFeature(points, false)); continue; }

    // turns[j] is the turn at point j+1, so a curved turn at j means point j+1 lies on the arc.
    const turns = [];
    for (let i = 1; i < points.length - 1; i++) turns.push(turnAt(points, i));

    // Runs of consecutive turns with the same classification.
    const runs = [];
    let a = 0;
    for (let j = 1; j <= turns.length; j++) {
      if (j < turns.length && (turns[j] > STRAIGHT) === (turns[a] > STRAIGHT)) continue;
      runs.push({ a, b: j - 1, curved: turns[a] > STRAIGHT });
      a = j;
    }

    // The points *on* the arc are the middle points of its curved turns: p[a+1] … p[b+1].
    // Taking a wider slice pulls in a point from the straight run, which then fails the
    // circle fit and used to leave a stray two-segment fragment at every transition.
    let cursor = 0;
    for (const run of runs) {
      if (!run.curved) continue;
      // A run at either end of the chain reaches the chain's own end point: there is no straight
      // stretch there for the circle fit to be protected from. Without this, an entirely curved
      // chain shed its first and last segment as one-segment "lines" — a circle came out as an
      // arc plus two stray stubs, and clicking the rim of a hole picked a stub.
      const from = run.a === 0 ? 0 : run.a + 1;
      const to = run.b === turns.length - 1 ? points.length - 1 : run.b + 1;
      if (from > cursor) features.push(makeFeature(points.slice(cursor, from + 1), false));
      features.push(makeFeature(points.slice(from, to + 1), true));
      cursor = to;
    }
    if (cursor < points.length - 1) features.push(makeFeature(points.slice(cursor), false));
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
  const arcs = features.filter((f) => f.type === 'arc' && f.centre && f.radius);
  if (arcs.length < 2) return features;

  const ends = (f) => [f.segments[0].a, f.segments[f.segments.length - 1].b];
  const touching = (a, b) => ends(a).some((p) => ends(b).some((q) => p.distanceTo(q) < 0.05));
  const coCircular = (a, b) =>
    Math.abs(a.radius - b.radius) < 0.05
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
    const fit = circleThrough(points[0], points[Math.floor(points.length / 2)], points[points.length - 1]);
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
  return { type: 'line', segments, points, length, a: points[0], b: points[points.length - 1] };
}

/// Nearest feature to the cursor, honouring occlusion the same way `edgeUnderCursor` does.
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
