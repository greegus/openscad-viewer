import * as THREE from 'three';
import { toScreen, cursorPx, pointToSegment2D, pieceFeatures, featureUnderCursor, sphereSilhouette, contactPatches,
         axisName, pieceFaces, assignTriangles, trianglesTouchingBox, trianglesInBox, clipToBox,
         MODEL_TO_WORLD } from './picking.js';
import { createStroke } from './strokes.js';

/// Inspect: hover highlights what is under the cursor, a click selects it.
///
/// Granularity follows the modifier key:
///   - default          → the edge under the cursor, otherwise the face
///   - Command held     → the whole part
///
/// A "face" is not a triangle. The mesh is a triangle soup, so faces are reconstructed once
/// per part by welding triangles that share an edge and lie in the same plane — otherwise
/// clicking a panel would select one half of a rectangle.
///
/// A "part" cannot come from the mesh at all: the union has already welded the panels into
/// one body. Parts come from the CSG components, same as the Parts overlay.
export function createInspect({ scene, view, renderer, readout, onSelect }) {

  const canvas = renderer.domElement;
  const state = {
    enabled: false, features: [], pieces: [], meshes: [], groups: new Map(), occlude: true,
  };

  const HOVER = 0xffd60a;
  const SELECT = 0xff9f0a;

  const makeLines = (color) => createStroke({ scene, color, width: 2, outline: 1, renderOrder: 20 });
  const makeFace = (color, opacity) => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide }));
    m.renderOrder = 19;
    m.visible = false;
    scene.add(m);
    return m;
  };

  const hoverLines = makeLines(HOVER);
  const hoverFace = makeFace(HOVER, 0.28);
  const selectLines = makeLines(SELECT);
  const selectFace = makeFace(SELECT, 0.4);

  const label = document.createElement('div');
  label.className = 'inspect-label';
  label.hidden = true;
  canvas.parentElement.appendChild(label);

  const mm = (v) => (Math.round(v * 10) / 10).toString();
  const key = (x, y, z) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;

  // --- face reconstruction ---

  /// Welds triangles into planar faces: same plane, and sharing an edge.
  function buildFaceGroups(mesh) {
    const pos = mesh.geometry.attributes.position;
    const count = pos.count / 3;
    const parent = new Int32Array(count).map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

    const planes = [];
    const byEdge = new Map();
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

    for (let t = 0; t < count; t++) {
      for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, t * 3 + k).applyMatrix4(mesh.matrixWorld);
      const normal = new THREE.Vector3().subVectors(v[1], v[0]).cross(
        new THREE.Vector3().subVectors(v[2], v[0])).normalize();
      planes.push({ normal, d: normal.dot(v[0]) });

      for (let k = 0; k < 3; k++) {
        const a = key(v[k].x, v[k].y, v[k].z);
        const b = key(v[(k + 1) % 3].x, v[(k + 1) % 3].y, v[(k + 1) % 3].z);
        const e = a < b ? `${a}|${b}` : `${b}|${a}`;
        const list = byEdge.get(e);
        if (list) list.push(t); else byEdge.set(e, [t]);
      }
    }

    // A second union-find over the same adjacency, without the plane test, gives the
    // connected solids — needed because a piece that came from `linear_extrude` has no CSG
    // box, so there is nothing else to select when the modifier is held.
    const bodyParent = new Int32Array(count).map((_, i) => i);
    const findBody = (i) => { while (bodyParent[i] !== i) { bodyParent[i] = bodyParent[bodyParent[i]]; i = bodyParent[i]; } return i; };
    const unionBody = (a, b) => { a = findBody(a); b = findBody(b); if (a !== b) bodyParent[b] = a; };

    for (const tris of byEdge.values()) {
      for (let i = 1; i < tris.length; i++) {
        unionBody(tris[0], tris[i]);
        const p = planes[tris[0]], q = planes[tris[i]];
        if (Math.abs(p.normal.dot(q.normal)) > 0.9999 && Math.abs(Math.abs(p.d) - Math.abs(q.d)) < 0.01) {
          union(tris[0], tris[i]);
        }
      }
    }

    const groups = new Map();
    const bodies = new Map();
    for (let t = 0; t < count; t++) {
      const g = groups.get(find(t));
      if (g) g.push(t); else groups.set(find(t), [t]);
      const b = bodies.get(findBody(t));
      if (b) b.push(t); else bodies.set(findBody(t), [t]);
    }
    return { find, groups, planes, findBody, bodies };
  }

  function setTargets({ parts, pieces }) {
    state.meshes = parts.map((p) => p.mesh);
    state.groups = new Map();
    for (const mesh of state.meshes) {
      mesh.updateMatrixWorld(true);
      state.groups.set(mesh, buildFaceGroups(mesh));
    }

    // Pieces are handed in already built, and the features come from their outlines — so a
    // feature belongs to exactly one piece by construction rather than by being trimmed later.
    state.pieces = pieces ?? [];
    state.features = pieceFeatures(state.pieces);

    // Faces come from the CSG and the mesh is asked only which triangles cover each one. The
    // other way round — grouping triangles by coplanarity — cannot say that a cylindrical wall
    // is one face rather than 96 strips, nor that two boards welded flush do not share a face.
    state.faceOf = new Map();       // mesh -> (triangle index -> face)
    state.faceTriangles = new Map(); // face -> { mesh, triangles }
    for (const mesh of state.meshes) state.faceOf.set(mesh, new Map());

    // Triangles per piece, per mesh — the union of its faces. This is what a whole-piece
    // highlight draws from. The box test cannot do this job: it admits a neighbour's triangles
    // wherever they brush the box, and on kniznica.scad that is 48 of 65 pieces.
    state.pieceTriangles = new Map();

    // Where another piece rests against a face, the mesh has a hole the size of the contact; the
    // face is still whole, so the contact is kept on it as patches — see `contactPatches`.
    state.piecePatches = new Map();

    for (const piece of state.pieces) {
      const faces = pieceFaces(piece);
      const mine = new Map();
      state.pieceTriangles.set(piece, mine);
      const patches = [];
      for (const face of faces) {
        face.patches = contactPatches(piece, face, state.pieces);
        patches.push(...face.patches);
      }
      state.piecePatches.set(piece, patches);
      for (const mesh of state.meshes) {
        const near = trianglesTouchingBox(mesh, piece.source ?? piece);
        if (!near.length) continue;
        const groups = assignTriangles(mesh, faces, near);
        for (const [face, triangles] of groups) {
          if (!triangles.length) continue;
          const already = state.faceTriangles.get(face);
          if (already) already.triangles.push(...triangles);
          else state.faceTriangles.set(face, { mesh, triangles });
          const lookup = state.faceOf.get(mesh);
          // A triangle can belong to two pieces' coplanar faces (one welded polygon spanning
          // both); the hit point decides which at pick time.
          for (const t of triangles) { const owners = lookup.get(t); if (owners) owners.push(face); else lookup.set(t, [face]); }
          const own = mine.get(mesh);
          if (own) own.push(...triangles); else mine.set(mesh, [...triangles]);
        }
      }
    }
    clear();
  }

  // --- picking ---

  /// Whether a world point lies within a piece's box (a little slack for the surface itself).
  function insidePiece(piece, point) {
    if (!piece?.inverse || !piece.box) return false;
    const p = point.clone().applyMatrix4(piece.inverse);
    const s = 0.5;
    return p.x >= piece.box.min.x - s && p.x <= piece.box.max.x + s
        && p.y >= piece.box.min.y - s && p.y <= piece.box.max.y + s
        && p.z >= piece.box.min.z - s && p.z <= piece.box.max.z + s;
  }

  const raycaster = new THREE.Raycaster();

  function hit(px) {
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2((px.x / r.width) * 2 - 1, -(px.y / r.height) * 2 + 1), view.camera);
    return raycaster.intersectObjects(state.meshes, false)[0] ?? null;
  }

  /// The smallest piece whose box contains the point — panels sit inside carcasses, so the
  /// tight one is the piece actually under the cursor.
  function pieceAt(point) {
    const local = new THREE.Vector3();
    let best = null;
    for (const piece of state.pieces) {
      local.copy(point).applyMatrix4(piece.inverse);
      const t = 0.5;
      if (local.x < piece.box.min.x - t || local.x > piece.box.max.x + t
       || local.y < piece.box.min.y - t || local.y > piece.box.max.y + t
       || local.z < piece.box.min.z - t || local.z > piece.box.max.z + t) continue;
      const volume = piece.size[0] * piece.size[1] * piece.size[2];
      if (!best || volume < best.volume) best = { piece, volume };
    }
    return best?.piece ?? null;
  }

  /// `piece` limits the face to one piece — see `clipToBox`. Without it, a face welded across
  /// several pieces lights all of them up.
  function faceGeometry(mesh, triangles, piece, patches = []) {
    let points;
    if (piece) {
      points = clipToBox(mesh, triangles, piece.source ?? piece);
      for (const tri of patches) for (const w of tri) points.push(w.x, w.y, w.z);
    } else {
      const pos = mesh.geometry.attributes.position;
      points = [];
      const v = new THREE.Vector3();
      for (const t of triangles) {
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, t * 3 + k).applyMatrix4(mesh.matrixWorld);
          points.push(v.x, v.y, v.z);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return geometry;
  }

  /// Area, in-plane size and orientation of a planar face.
  function faceInfo(mesh, triangles, normal, piece = null, patches = []) {
    const pos = mesh.geometry.attributes.position;
    const verts = [];
    const v = new THREE.Vector3();
    let area = 0;
    for (const tri of patches) {
      verts.push(...tri.map((w) => w.clone()));
      area += tri[1].clone().sub(tri[0]).cross(tri[2].clone().sub(tri[0])).length() / 2;
    }
    // Measured on the part within the piece: a triangle of a face can span into the next
    // piece's coplanar face (the cabinet's side above the chest's, welded into one polygon by
    // the union), and unclipped it reported the height of both — 2020 mm for a 1220 mm wall.
    const soup = piece ? clipToBox(mesh, triangles, piece.source ?? piece, 0.01) : null;   // a hair of slack: a face lies exactly on the box, and this is a measurement
    const tris = soup ? soup.length / 9 : triangles.length;
    for (let i = 0; i < tris; i++) {
      const tri = [];
      for (let k = 0; k < 3; k++) {
        if (soup) v.set(soup[i * 9 + k * 3], soup[i * 9 + k * 3 + 1], soup[i * 9 + k * 3 + 2]);
        else v.fromBufferAttribute(pos, triangles[i] * 3 + k).applyMatrix4(mesh.matrixWorld);
        tri.push(v.clone());
        verts.push(v.clone());
      }
      area += new THREE.Vector3().subVectors(tri[1], tri[0])
        .cross(new THREE.Vector3().subVectors(tri[2], tri[0])).length() / 2;
    }

    // In-plane axes: the pair giving the *smallest* box, not the longest edge.
    //
    // The longest edge of a square split into two triangles is its diagonal, so a 100 mm face
    // measured 141.4 x 141.4 — its own diagonal, twice. Candidates are the model's axes and the
    // face's own edge directions, projected into the plane; the smallest enclosing box is the
    // one a joiner would call the size.
    const candidates = [];
    for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
                        new THREE.Vector3(0, 0, 1)]) {
      const d = axis.clone().addScaledVector(normal, -axis.dot(normal));
      if (d.lengthSq() > 1e-6) candidates.push(d.normalize());
    }
    for (let i = 0; i < Math.min(verts.length, 192); i += 3) {
      for (let k = 0; k < 3; k++) {
        const d = verts[i + (k + 1) % 3].clone().sub(verts[i + k]);
        if (d.lengthSq() > 1e-6) candidates.push(d.normalize());
      }
    }
    if (!candidates.length) return { area, width: 0, height: 0 };

    let bestBox = null;
    for (const u of candidates) {
      const w = new THREE.Vector3().crossVectors(normal, u).normalize();
      if (w.lengthSq() < 1e-9) continue;
      let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
      for (const p of verts) {
        const a = p.dot(u), b = p.dot(w);
        u0 = Math.min(u0, a); u1 = Math.max(u1, a);
        w0 = Math.min(w0, b); w1 = Math.max(w1, b);
      }
      const box = { width: u1 - u0, height: w1 - w0 };
      if (!bestBox || box.width * box.height < bestBox.width * bestBox.height) bestBox = box;
    }
    return { area, width: bestBox.width, height: bestBox.height };
  }

  /// Extent of a set of triangles, reported in the model's own axes (Z-up).
  function bodyBox(mesh, triangles) {
    const pos = mesh.geometry.attributes.position;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const t of triangles) {
      for (let k = 0; k < 3; k++) box.expandByPoint(v.fromBufferAttribute(pos, t * 3 + k));
    }
    const size = box.getSize(new THREE.Vector3());
    return { x: size.x, y: size.y, z: size.z };
  }

  // --- selection ---

  let anchor = null;

  // Diagnostic: with fills off only the strokes are drawn, so a pixel comparison of two
  // highlights measures their edges rather than the tint over the whole piece.
  let fills = true;
  const setFills = (on) => { fills = on; if (!on) { hoverFace.visible = false; selectFace.visible = false; } };

  /// The outline a whole piece is drawn with. A sphere has no outline, only a silhouette, which
  /// follows the camera — `update` redraws it every frame it is highlighted.
  function pieceStrokePoints(piece) {
    if (piece.sphere) return sphereSilhouette(piece, view.camera);
    const points = [];
    for (let i = 0; i < piece.outline.length; i += 3) {
      points.push(new THREE.Vector3(piece.outline[i], piece.outline[i + 1], piece.outline[i + 2]));
    }
    return points;
  }

  function show(target, lines, face) {
    lines.visible = false;
    face.visible = false;
    if (!target) return null;

    if (target.type === 'edge') {
      const points = [];
      for (const s of target.feature.segments) points.push(s.a, s.b);
      lines.setPoints(points);
      const mid = target.feature.segments[Math.floor(target.feature.segments.length / 2)];
      return mid.a.clone().add(mid.b).multiplyScalar(0.5);
    }
    if (target.type === 'part') {
      lines.setPoints(pieceStrokePoints(target.piece));
      const groups = target.groups ?? (target.triangles?.length ? [{ mesh: target.mesh, triangles: target.triangles }] : []);
      if (groups.length) {
        // Every material the piece has triangles in, clipped to the piece and merged into one fill.
        const positions = [];
        for (const g of groups) {
          for (const v of clipToBox(g.mesh, g.triangles, target.piece.source ?? target.piece)) positions.push(v);
        }
        for (const tri of state.piecePatches?.get(target.piece) ?? []) for (const w of tri) positions.push(w.x, w.y, w.z);
        face.geometry.dispose();
        face.geometry = new THREE.BufferGeometry();
        face.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        face.visible = fills && positions.length > 0;
      }
      const centre = new THREE.Vector3(
        (target.piece.box.min.x + target.piece.box.max.x) / 2,
        (target.piece.box.min.y + target.piece.box.max.y) / 2,
        (target.piece.box.min.z + target.piece.box.max.z) / 2);
      return centre.applyMatrix4(target.piece.world);
    }
    face.geometry.dispose();
    // A face is limited to the piece it belongs to; a body is the whole solid by definition.
    face.geometry = faceGeometry(target.mesh, target.triangles,
                                 target.type === 'face' ? target.piece : null, target.face?.patches ?? []);
    face.visible = fills;
    return target.point.clone();   // 'face' and 'body' are both triangle sets
  }

  function targetAt(px, wholePart) {
    if (wholePart) {
      const h = hit(px);
      if (!h) return null;
      const piece = pieceAt(h.point);
      // One way to build a piece target, shared with the parts list. Building it here from the
      // mesh the ray happened to hit meant a hover in the scene and a click in the list could
      // light up different geometry for the same piece — the hit mesh might be a neighbouring
      // material merely brushing the box. Same target, four routes to it; only the stroke style
      // differs, and that lives in show().
      if (piece) return pieceTarget(piece.id);
      // No CSG box here. Fall back to the welded solid — but only if it is actually a piece:
      // after the union most of a design is one connected body, and offering "the whole model"
      // as a selection is never what the modifier is for.
      const info = state.groups.get(h.object);
      const triangles = info?.bodies.get(info.findBody(h.faceIndex));
      if (!triangles) return null;
      const share = triangles.length / (h.object.geometry.attributes.position.count / 3);
      return share < 0.5
        ? { type: 'body', mesh: h.object, triangles, point: h.point }
        : null;
    }

    // Only edges you can actually see, unless x-ray is on — there, seeing through is the point.
    const feature = featureUnderCursor(px, state.features, view.camera, canvas, 6,
                                       state.occlude ? state.meshes : null);
    // A feature already belongs to one piece, so there is nothing left to trim.
    if (feature) return { type: 'edge', feature, piece: feature.piece };

    const h = hit(px);
    if (!h) return null;
    const info = state.groups.get(h.object);
    if (!info) return null;
    const triangles = info.groups.get(info.find(h.faceIndex)) ?? [h.faceIndex];
    // The CSG face this triangle belongs to, when there is one. It carries its own identity, so
    // a curved wall arrives whole and a plane stops where the piece stops.
    const owners = state.faceOf.get(h.object)?.get(h.faceIndex);
    const face = owners && (owners.length === 1 ? owners[0] : owners.find((f) => insidePiece(f.piece, h.point)) ?? owners[0]);
    if (face) {
      const group = state.faceTriangles.get(face);
      return { type: 'face', face, mesh: group.mesh, triangles: group.triangles,
               point: h.point, piece: face.piece,
               normal: face.kind === 'plane' ? face.normal : info.planes[h.faceIndex].normal };
    }
    return { type: 'face', mesh: h.object, triangles, point: h.point,
             piece: pieceAt(h.point), normal: info.planes[h.faceIndex].normal };
  }

  /// Heading for the details panel: the piece's own name where it has one, its size where it
  /// does not, and the id beside it — the same pairing the parts list shows, so the two read as
  /// the same thing.
  function heading(target) {
    if (!target) return null;
    if (target.type === 'part') {
      const p = target.piece;
      const [sx, sy, sz] = p.size;
      // A solid the reader could only bound (a polyhedron, a sphere) is marked, since its faces
      // and edges are those of its box, not its own.
      const name = p.source?.name ?? `${mm(sx)} × ${mm(sy)} × ${mm(sz)} mm`;
      return { name: p.source?.approximate ? `${name} (bounds only)` : name, id: p.id ?? null };
    }
    if (target.type === 'edge') {
      const kind = { arc: 'Arc', ellipse: 'Ellipse' }[target.feature.type] ?? 'Edge';
      return { name: kind, id: null };
    }
    if (target.type === 'body') return { name: 'Body', id: null };
    const kind = target.face?.kind;
    const name = kind === 'cylinder' ? 'Round face' : kind === 'sphere' ? 'Spherical face' : 'Face';
    return { name, id: target.face?.piece?.id ?? null };
  }

  /// Description as label/value pairs, listed one per line under the heading. A single run-on
  /// line was fine while there were two numbers; there are now six, and they need scanning
  /// rather than reading.
  function describe(target) {
    if (!target) return [];
    if (target.type === 'edge') {
      const f = target.feature;
      if (f.type === 'arc') {
        const axis = axisName(f.normal);
        return [
          ['Radius', `${mm(f.radius)} mm`],
          ['Sweep', `${(f.sweep * 180 / Math.PI).toFixed(1)}°`],
          ['Length', `${mm(f.length)} mm`],
          ...(axis ? [['Around', axis]] : []),
        ];
      }
      if (f.type === 'ellipse') {
        return [
          ['Semi-axes', `${mm(f.a)} × ${mm(f.b)} mm`],
          ['Length', `${mm(f.length)} mm`],
        ];
      }
      const axis = axisName(f.b.clone().sub(f.a).normalize());
      return [['Length', `${mm(f.length)} mm`], ...(axis ? [['Along', axis]] : [])];
    }
    if (target.type === 'part') {
      const p = target.piece;
      const [sx, sy, sz] = p.size;
      const at = p.corner.map((v) => Math.round(v)).join(', ');
      // The size is in the heading when the piece is named; otherwise it *is* the heading, so
      // repeating it here would say the same thing twice.
      // Once only. The heading carries the piece's name when it has one and its size when it
      // does not, so adding a size row on top of this one printed the same numbers twice.
      return [
        ['Width × depth × height', `${mm(sx)} × ${mm(sy)} × ${mm(sz)} mm`],
        ['Volume', `${((sx * sy * sz) / 1e6).toFixed(2)} dm³`],
        ['Corner', at],
      ];
    }
    if (target.type === 'body') {
      const b = bodyBox(target.mesh, target.triangles);
      return [
        ['Size', `${mm(b.x)} × ${mm(b.y)} × ${mm(b.z)} mm`],
        ['Triangles', String(target.triangles.length)],
        ['Note', 'no CSG box — extruded shape'],
      ];
    }
    if (target.face?.kind === 'sphere') {
      return [
        ['Surface', 'spherical'],
        ['Radius', `${mm(target.face.radius)} mm`],
        ['Triangles', String(target.triangles.length)],
      ];
    }
    if (target.face?.kind === 'cylinder') {
      // One surface, however many strips it was tessellated into.
      return [
        ['Surface', 'cylindrical'],
        ['Radius', `${mm(target.face.radius)} mm`],
        ['Triangles', String(target.triangles.length)],
      ];
    }
    const f = faceInfo(target.mesh, target.triangles, target.normal, target.type === 'face' ? target.piece : null, target.face?.patches ?? []);
    const axis = axisName(target.normal);
    return [
      ['Size', `${mm(f.width)} × ${mm(f.height)} mm`],
      ['Area', `${(f.area / 100).toFixed(1)} cm²`],
      ...(axis ? [['Facing', axis]] : []),
    ];
  }

  function shortLabel(target) {
    if (!target) return '';
    if (target.type === 'edge') {
      const f = target.feature;
      if (f.type === 'arc') return `R ${mm(f.radius)} mm`;
      if (f.type === 'ellipse') return `${mm(f.a)} × ${mm(f.b)} mm`;
      return `${mm(f.length)} mm`;
    }
    if (target.type === 'part') {
      const [sx, sy, sz] = target.piece.size;
      return `#${target.piece.id ?? '?'} · ${mm(sx)} × ${mm(sy)} × ${mm(sz)} mm`;
    }
    if (target.type === 'body') {
      const b = bodyBox(target.mesh, target.triangles);
      return `${mm(b.x)} × ${mm(b.y)} × ${mm(b.z)} mm`;
    }
    const f = faceInfo(target.mesh, target.triangles, target.normal, target.type === 'face' ? target.piece : null, target.face?.patches ?? []);
    return `${mm(f.width)} × ${mm(f.height)} mm`;
  }

  /// Diagnostic: modifier flags of the last real pointer event, to tell a logic problem from
  /// a modifier that never reaches the page.
  let lastEvent = null;

  let selected = null;
  let hovered = null;
  let lastPx = null;
  let modifier = false;
  let external = null;         // piece highlighted from the parts list

  function refreshHover() {
    // A piece pointed at from the parts list wins: the cursor is over the list, not the model.
    if (external) return;
    if (!state.enabled || !lastPx) return;
    hovered = targetAt(lastPx, modifier);
    show(hovered, hoverLines, hoverFace);
    canvas.style.cursor = hovered ? 'crosshair' : 'default';
    if (!selected) readout(hovered ? describe(hovered) : hint(), heading(hovered));
  }

  const hint = () => 'Click an edge or a face · hold ⌘ for the whole part';

  /// Selects a piece named from outside — a click in the parts list.
  ///
  /// Goes through the same `show` and the same readout as a click in the scene, so a piece
  /// selected from the list is indistinguishable from one picked with the cursor.
  function selectPiece(id) {
    const target = pieceTarget(id);
    if (!target) return;
    selected = target;
    external = null;
    anchor = show(selected, selectLines, selectFace);
    label.textContent = shortLabel(selected);
    label.hidden = false;
    readout(describe(selected), heading(selected));
  }

  /// A piece as an inspect target, with the triangles the union welded into some mesh.
  function pieceTarget(id) {
    const piece = state.pieces.find((p) => p.id === id);
    if (!piece) return null;

    // The piece's own triangles, from its faces: exact, and naturally spread across whatever
    // meshes its materials live in. A piece spanning wood and glass highlights as both.
    const byMesh = state.pieceTriangles?.get(piece);
    const groups = byMesh
      ? [...byMesh.entries()].filter(([, t]) => t.length).map(([mesh, triangles]) => ({ mesh, triangles }))
      : [];
    if (groups.length) return { type: 'part', piece, groups, ...primary(groups) };

    // No face claimed anything — a shape the face model does not describe yet. Fall back to
    // the box test on the mesh holding most of it, so the piece still lights up.
    let best = null;
    for (const mesh of state.meshes ?? []) {
      const triangles = trianglesTouchingBox(mesh, piece.source ?? piece);
      if (!best || triangles.length > best.triangles.length) best = { mesh, triangles };
    }
    return best?.triangles.length
      ? { type: 'part', piece, groups: [best], mesh: best.mesh, triangles: best.triangles }
      : { type: 'part', piece, groups: [] };
  }

  /// The largest group, kept on the target as `mesh`/`triangles` for the code paths that still
  /// think of a piece as living in one mesh.
  function primary(groups) {
    const top = groups.reduce((a, b) => (b.triangles.length > a.triangles.length ? b : a));
    return { mesh: top.mesh, triangles: top.triangles };
  }

  /// Highlights pieces named from outside — the parts list pointing at a row, which may be a
  /// whole group.
  ///
  /// One piece goes through the same `show` as a real hover, so the two cannot drift apart in
  /// how a piece is drawn. A group cannot: `show` draws a single target, so the outlines and
  /// the clipped faces of every piece in the group are combined into one pair of overlays here.
  /// An empty list hands the highlight back to the cursor rather than merely clearing it, or
  /// stepping off the list would blank a piece the pointer is genuinely over.
  function highlightPieces(ids, label) {
    if (!ids?.length) {
      external = null;
      // Cleared first, then offered back to the cursor: refreshHover can only redraw once the
      // pointer has been over the canvas, so without this a highlight lingers after the pointer
      // leaves the list for anywhere else.
      hoverLines.visible = false;
      hoverFace.visible = false;
      hovered = null;
      refreshHover();
      return;
    }

    if (ids.length === 1) {
      const target = pieceTarget(ids[0]);
      if (!target) return;
      external = target;
      hovered = target;
      show(target, hoverLines, hoverFace);
      if (!selected) readout(describe(target), heading(target));
      return;
    }

    const points = [];
    const positions = [];
    let shown = 0;

    for (const id of ids) {
      const target = pieceTarget(id);
      if (!target) continue;
      shown += 1;
      const outline = target.piece.outline;
      for (let i = 0; i < outline.length; i += 3) {
        points.push(new THREE.Vector3(outline[i], outline[i + 1], outline[i + 2]));
      }
      for (const g of target.groups ?? []) {
        for (const v of clipToBox(g.mesh, g.triangles, target.piece.source ?? target.piece)) {
          positions.push(v);
        }
      }
    }

    hoverLines.setPoints(points);
    hoverFace.geometry.dispose();
    hoverFace.geometry = new THREE.BufferGeometry();
    hoverFace.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    hoverFace.visible = positions.length > 0;

    external = { type: 'group', count: shown };
    hovered = null;
    if (!selected) readout([['Pieces', String(shown)]], { name: label ?? 'Group', id: null });
  }

  const highlightPiece = (id) =>
    highlightPieces(id === null || id === undefined ? [] : [id]);

  canvas.addEventListener('pointermove', (event) => {
    lastPx = cursorPx(event, canvas);
    modifier = wantsWholePart(event);
    lastEvent = { type: 'pointermove', meta: event.metaKey, ctrl: event.ctrlKey,
                  alt: event.altKey, shift: event.shiftKey };
    refreshHover();
  });

  // The modifier can change without the pointer moving, so track the key too.
  for (const type of ['keydown', 'keyup']) {
    window.addEventListener(type, (event) => {
      if (event.key !== 'Meta' && event.key !== 'Escape') return;
      if (event.key === 'Escape') { if (state.enabled) clear(); return; }
      modifier = type === 'keydown';
      refreshHover();
    });
  }

  /// Command. Not Ctrl as well: on macOS Ctrl-click is a synthesised secondary click, so
  /// accepting it would collide with the context menu.
  const wantsWholePart = (e) => e.metaKey;

  let down = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { px: cursorPx(e, canvas), time: performance.now(), modifier: wantsWholePart(e) };
    lastEvent = { type: 'pointerdown', meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!state.enabled || !down) return;
    const px = cursorPx(e, canvas);
    const moved = px.distanceTo(down.px);
    const held = performance.now() - down.time;
    if (moved > 4 || held > 400) { down = null; return; }   // a drag: that is OrbitControls'

    lastEvent = { type: 'pointerup', meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
    // Either end of the click counts: the flag can be present on the press and gone by the
    // release, and a key held for the whole gesture is the same intent either way.
    selected = targetAt(px, down.modifier || wantsWholePart(e) || modifier);
    down = null;
    anchor = show(selected, selectLines, selectFace);
    if (selected) {
      label.textContent = shortLabel(selected);
      label.hidden = false;
      readout(describe(selected), heading(selected));
    } else {
      label.hidden = true;
      readout(hint());
    }
    // The parts list follows the scene, so a piece picked here is findable there.
    onSelect?.(selected?.piece?.id ?? null);
  });

  function clear() {
    if (selected) onSelect?.(null);
    selected = null;
    hovered = null;
    anchor = null;
    for (const o of [hoverLines, hoverFace, selectLines, selectFace]) o.visible = false;
    label.hidden = true;
    if (state.enabled) readout(hint());
  }

  /// The label lives in the DOM, so it has to follow the view.camera.
  let cameraKey = '';
  function update() {
    // A highlighted sphere's silhouette moves with the camera.
    const key = view.camera.matrixWorld.elements.join(',') + view.camera.zoom;
    if (key !== cameraKey) {
      cameraKey = key;
      if (hovered?.type === 'part' && hovered.piece.sphere && hoverLines.visible) hoverLines.setPoints(pieceStrokePoints(hovered.piece));
      if (selected?.type === 'part' && selected.piece.sphere && selectLines.visible) selectLines.setPoints(pieceStrokePoints(selected.piece));
    }
    if (!state.enabled || label.hidden || !anchor) return;
    const p = toScreen(anchor, view.camera, canvas);
    label.style.left = `${p.x}px`;
    label.style.top = `${p.y}px`;
  }

  function setEnabled(on) {
    state.enabled = on;
    if (!on) {
      for (const o of [hoverLines, hoverFace, selectLines, selectFace]) o.visible = false;
      label.hidden = true;
      canvas.style.cursor = '';
      readout('');
    } else {
      readout(hint());
    }
  }

  /// In x-ray the whole point is to reach what is behind, so occlusion is dropped there.
  function setOcclusion(on) { state.occlude = on; }

  /// Diagnostic: every arc the feature builder recovered.
  /// Diagnostic: where the modifier path gives up.
  const probeModifier = (px) => {
    const point = new THREE.Vector2(px[0], px[1]);
    const h = hit(point);
    if (!h) return 'no ray hit';
    const info = state.groups.get(h.object);
    if (!info) return 'no face groups for mesh';
    const piece = pieceAt(h.point);
    if (piece) return 'part';
    const tris = info.bodies.get(info.findBody(h.faceIndex));
    return tris ? 'body' : 'no body group';
  };

  /// What is selected, in the terms hiding needs: which mesh, which triangles, and which CSG
  /// components go with it. Null for an edge or a single face — taking those out would leave a
  /// hole rather than remove a piece.
  const selection = () => {
    if (!selected) return null;
    if (selected.type === 'part') {
      return {
        label: shortLabel(selected),
        mesh: selected.mesh,
        triangles: selected.triangles ?? [],
        componentIds: [selected.piece.id].filter((id) => id !== undefined),
      };
    }
    if (selected.type === 'body') {
      // Every component inside the body's extent goes with it.
      const box = new THREE.Box3();
      const pos = selected.mesh.geometry.attributes.position;
      const v = new THREE.Vector3();
      for (const t of selected.triangles) {
        for (let k = 0; k < 3; k++) {
          box.expandByPoint(v.fromBufferAttribute(pos, t * 3 + k).applyMatrix4(selected.mesh.matrixWorld));
        }
      }
      const inside = state.pieces.filter((piece) => {
        const centre = new THREE.Vector3(
          (piece.box.min.x + piece.box.max.x) / 2,
          (piece.box.min.y + piece.box.max.y) / 2,
          (piece.box.min.z + piece.box.max.z) / 2).applyMatrix4(piece.world);
        return box.containsPoint(centre);
      });
      return {
        label: shortLabel(selected),
        mesh: selected.mesh,
        triangles: selected.triangles,
        componentIds: inside.map((p) => p.id).filter((id) => id !== undefined),
      };
    }
    return null;
  };

  /// Every feature the picker can offer, with the extent it covers — for finding the ones that
  /// run across more than one piece.
  const features = () => state.features.map((f) => {
    const box = new THREE.Box3();
    for (const seg of f.segments) { box.expandByPoint(seg.a); box.expandByPoint(seg.b); }
    const size = box.getSize(new THREE.Vector3());
    return {
      type: f.type,
      segments: f.segments.length,
      length: Math.round(f.length ?? 0),
      extent: [size.x, size.y, size.z].map(Math.round),
    };
  });

  /// The longest feature, with a screen position on it — so a test can point at exactly the
  /// welded run it means to test instead of hunting the grid for any edge at all.
  const longestFeature = () => {
    let best = null;
    for (const f of state.features) {
      if (!best || (f.length ?? 0) > (best.length ?? 0)) best = f;
    }
    if (!best) return null;
    const seg = best.segments[Math.floor(best.segments.length / 2)];
    const mid = seg.a.clone().add(seg.b).multiplyScalar(0.5);
    const px = toScreen(mid, view.camera, canvas);
    return { length: Math.round(best.length), segments: best.segments.length,
             px: [Math.round(px.x), Math.round(px.y)] };
  };

  /// How many mesh creases fall inside a piece's box. Tells apart "the picker cannot find this
  /// piece's edges" from "this piece has no creases, because it is welded flush to its
  /// neighbours and no crease exists there to find".
  const edgesInPiece = (id) => {
    const piece = state.pieces.find((p) => p.id === id);
    if (!piece) return null;
    const v = new THREE.Vector3();
    const slack = 1;
    let segments = 0;
    for (const f of state.features) {
      for (const seg of f.segments) {
        v.copy(seg.a).add(seg.b).multiplyScalar(0.5).applyMatrix4(piece.inverse);
        if (v.x >= piece.box.min.x - slack && v.x <= piece.box.max.x + slack
         && v.y >= piece.box.min.y - slack && v.y <= piece.box.max.y + slack
         && v.z >= piece.box.min.z - slack && v.z <= piece.box.max.z + slack) segments++;
      }
    }
    return segments;
  };

  const pieceCoverage = () => state.pieces.map((piece) => {
    const byMesh = state.pieceTriangles?.get(piece);
    const fromFaces = byMesh ? [...byMesh.values()].reduce((n, t) => n + t.length, 0) : 0;
    const meshes = byMesh ? [...byMesh.values()].filter((t) => t.length).length : 0;
    // Two yardsticks. "Touching" is inflated by neighbours brushing the box, so a ratio against
    // it says little; "wholly inside" is certainly the piece's own, so faces must cover at least
    // that or something is missing.
    let touching = 0, inside = 0;
    for (const mesh of state.meshes) {
      touching = Math.max(touching, trianglesTouchingBox(mesh, piece.source ?? piece).length);
      inside = Math.max(inside, trianglesInBox(mesh, piece.source ?? piece).length);
    }
    return { id: piece.id, faces: fromFaces, meshes, box: touching, inside };
  });

  const debug = () => ({
    lastEvent,
    hovered: hovered ? {
      type: hovered.type,
      faceKind: hovered.face?.kind ?? null,
      faceLabel: hovered.face?.label ?? null,
      segments: hovered.feature?.segments.length ?? null,
      triangles: hovered.triangles?.length ?? null,
    } : null,
    selected: selected ? { type: selected.type, segments: selected.feature?.segments.length ?? null } : null,
    // Visibility included on purpose: the buffer keeps its segments after a stroke is hidden,
    // so a bare count answers "what was last built", not "what is on screen".
    drawnHover: hoverLines.visible ? hoverLines.segmentCount : 0,
    hoverPositions: hoverLines.positions(), selectPositions: selectLines.positions(),
    hoverType: hovered?.type ?? null, selectType: selected?.type ?? null, hoverPiece: hovered?.piece?.id ?? null, selectPiece: selected?.piece?.id ?? null,
    // Extent of the face actually drawn, not of the triangles it came from: the two differ
    // once the highlight is clipped to a piece, which is the whole point of the clipping.
    selectedFace: (() => {
      if (!selectFace.visible) return null;
      selectFace.geometry.computeBoundingBox();
      const b = selectFace.geometry.boundingBox;
      return b ? [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((n) => Math.round(n)) : null;
    })(),
    drawnFace: (() => {
      if (!hoverFace.visible) return null;
      hoverFace.geometry.computeBoundingBox();
      const b = hoverFace.geometry.boundingBox;
      return b ? [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((n) => Math.round(n)) : null;
    })(),
    drawnSelect: selectLines.visible ? selectLines.segmentCount : 0,
  });

  /// Screen position of a point along the first arc, for driving tests. `t` in [0,1].
  const arcPoint = (t = 0.5) => {
    const arc = state.features.find((f) => f.type === 'arc');
    if (!arc) return null;
    const i = Math.min(arc.segments.length - 1, Math.floor(t * arc.segments.length));
    const seg = arc.segments[i];
    const p = toScreen(seg.a.clone().add(seg.b).multiplyScalar(0.5), view.camera, canvas);
    return [p.x, p.y, arc.segments.length];
  };

  /// Diagnostic: contact patches per face of a piece — where neighbours rest on it.
  const patches = (id) => {
    const piece = state.pieces.find((p) => p.id === id);
    if (!piece) return null;
    const out = [];
    for (const [face, group] of state.faceTriangles) {
      if (face.piece !== piece || !face.patches?.length) continue;
      let area = 0;
      for (const tri of face.patches) area += tri[1].clone().sub(tri[0]).cross(tri[2].clone().sub(tri[0])).length() / 2;
      out.push({ label: face.label, normal: [face.normal.x, face.normal.y, face.normal.z].map(Math.round), area: Math.round(area) });
    }
    // Faces the mesh gave nothing to still carry patches; list those too.
    const seen = new Set(out.map((o) => o.label + o.normal.join()));
    for (const face of pieceFaces(piece)) {
      const p = contactPatches(piece, face, state.pieces);
      if (!p.length) continue;
      const key = face.label + [face.normal.x, face.normal.y, face.normal.z].map(Math.round).join();
      if (seen.has(key)) continue;
      let area = 0;
      for (const tri of p) area += tri[1].clone().sub(tri[0]).cross(tri[2].clone().sub(tri[0])).length() / 2;
      out.push({ label: face.label, normal: [face.normal.x, face.normal.y, face.normal.z].map(Math.round), area: Math.round(area) });
    }
    return out;
  };
  const ellipses = () => state.features.filter((f) => f.type === 'ellipse').map((f) => ({
    a: Math.round(f.a * 10) / 10, b: Math.round(f.b * 10) / 10, segments: f.segments.length,
    length: Math.round(f.length), centre: [f.centre.x, f.centre.y, f.centre.z].map((v) => Math.round(v)),
  }));
  const arcs = () => state.features.filter((f) => f.type === 'arc').map((f) => ({
    radius: Math.round(f.radius * 10) / 10,
    sweep: Math.round(f.sweep * 180 / Math.PI * 10) / 10,
    segments: f.segments.length,
    centre: [f.centre.x, f.centre.y, f.centre.z].map((v) => Math.round(v)),
    points: f.points.map((q) => [q.x, q.y, q.z].map((v) => Math.round(v))),
  }));

  return { setTargets, setEnabled, setOcclusion, arcs, debug, probeModifier, arcPoint, selection, highlightPiece, highlightPieces, selectPiece, features, longestFeature, edgesInPiece, pieceCoverage, ellipses, patches,
           clear, update, setFills };
}
