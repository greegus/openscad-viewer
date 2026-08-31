import * as THREE from 'three';
import { toScreen, cursorPx, buildEdgeList, buildFeatures, featureUnderCursor, axisName, pieceOutline, MODEL_TO_WORLD } from './picking.js';
import { createStroke } from './strokes.js';

/// Inspect: hover highlights what is under the cursor, a click selects it.
///
/// Granularity follows the modifier key:
///   - default                    → the edge under the cursor, otherwise the face
///   - platform modifier held     → the whole part (Command on Apple, Ctrl elsewhere)
///
/// A "face" is not a triangle. The mesh is a triangle soup, so faces are reconstructed once
/// per part by welding triangles that share an edge and lie in the same plane — otherwise
/// clicking a panel would select one half of a rectangle.
///
/// A "part" cannot come from the mesh at all: the union has already welded the panels into
/// one body. Parts come from the CSG components, same as the Parts overlay.
export function createInspect({ scene, view, renderer, readout }) {

  const canvas = renderer.domElement;
  const state = { enabled: false, features: [], pieces: [], meshes: [], groups: new Map(), occlude: true };

  /// The platform's own modifier — Command on Apple, Ctrl elsewhere — because that is what
  /// "hold the modifier" means to a person. Deliberately not `metaKey || ctrlKey` on both:
  /// on macOS Ctrl-click is a synthesised secondary click, so accepting it would collide.
  /// Declared up here because `hint()` above reads it.
  const APPLE = /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);

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

  function setTargets({ parts, components }) {
    state.meshes = parts.map((p) => p.mesh);
    state.features = buildFeatures(
      buildEdgeList(parts.map((p) => ({ mesh: p.mesh, edgesGeometry: p.edges.geometry }))));
    state.groups = new Map();
    for (const mesh of state.meshes) {
      mesh.updateMatrixWorld(true);
      state.groups.set(mesh, buildFaceGroups(mesh));
    }

    state.pieces = (components ?? []).map((c) => {
      const local = new THREE.Matrix4().set(...c.matrix);
      const world = new THREE.Matrix4().multiplyMatrices(MODEL_TO_WORLD, local);
      const [sx, sy, sz] = c.size;
      const min = c.centered ? new THREE.Vector3(-sx / 2, -sy / 2, -sz / 2) : new THREE.Vector3(0, 0, 0);
      // The same clipped outline the Parts overlay uses, so the two never disagree.
      const outline = pieceOutline(c).slice();
      for (let i = 0; i < outline.length; i += 3) {
        const p = new THREE.Vector3(outline[i], outline[i + 1], outline[i + 2]).applyMatrix4(MODEL_TO_WORLD);
        outline[i] = p.x; outline[i + 1] = p.y; outline[i + 2] = p.z;
      }
      // Model-space corner: the coordinate you can search for in the .scad source.
      const origin = [c.matrix[3], c.matrix[7], c.matrix[11]];
      const corner = c.centered ? origin.map((v, i) => v - c.size[i] / 2) : origin;
      return {
        id: c.id, corner,
        size: c.size, world, inverse: world.clone().invert(), outline,
        box: new THREE.Box3(min, min.clone().add(new THREE.Vector3(sx, sy, sz))),
      };
    });
    clear();
  }

  // --- picking ---

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

  function faceGeometry(mesh, triangles) {
    const pos = mesh.geometry.attributes.position;
    const points = [];
    const v = new THREE.Vector3();
    for (const t of triangles) {
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, t * 3 + k).applyMatrix4(mesh.matrixWorld);
        points.push(v.x, v.y, v.z);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return geometry;
  }

  /// Area, in-plane size and orientation of a planar face.
  function faceInfo(mesh, triangles, normal) {
    const pos = mesh.geometry.attributes.position;
    const verts = [];
    const v = new THREE.Vector3();
    let area = 0;
    for (const t of triangles) {
      const tri = [];
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, t * 3 + k).applyMatrix4(mesh.matrixWorld);
        tri.push(v.clone());
        verts.push(v.clone());
      }
      area += new THREE.Vector3().subVectors(tri[1], tri[0])
        .cross(new THREE.Vector3().subVectors(tri[2], tri[0])).length() / 2;
    }

    // In-plane axes: take the longest edge as u, so a rectangle reports its true sides.
    let u = null, best = 0;
    for (const t of triangles) {
      for (let k = 0; k < 3; k++) {
        const a = new THREE.Vector3().fromBufferAttribute(pos, t * 3 + k).applyMatrix4(mesh.matrixWorld);
        const b = new THREE.Vector3().fromBufferAttribute(pos, t * 3 + (k + 1) % 3).applyMatrix4(mesh.matrixWorld);
        const d = b.sub(a);
        if (d.length() > best) { best = d.length(); u = d.normalize(); }
      }
    }
    if (!u) return { area, width: 0, height: 0 };
    const w = new THREE.Vector3().crossVectors(normal, u).normalize();

    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (const p of verts) {
      const a = p.dot(u), b = p.dot(w);
      u0 = Math.min(u0, a); u1 = Math.max(u1, a);
      w0 = Math.min(w0, b); w1 = Math.max(w1, b);
    }
    return { area, width: u1 - u0, height: w1 - w0 };
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
      const points = [];
      for (let i = 0; i < target.piece.outline.length; i += 3) {
        points.push(new THREE.Vector3(target.piece.outline[i], target.piece.outline[i + 1],
                                      target.piece.outline[i + 2]));
      }
      lines.setPoints(points);
      const centre = new THREE.Vector3(
        (target.piece.box.min.x + target.piece.box.max.x) / 2,
        (target.piece.box.min.y + target.piece.box.max.y) / 2,
        (target.piece.box.min.z + target.piece.box.max.z) / 2);
      return centre.applyMatrix4(target.piece.world);
    }
    face.geometry.dispose();
    face.geometry = faceGeometry(target.mesh, target.triangles);
    face.visible = true;
    return target.point.clone();   // 'face' and 'body' are both triangle sets
  }

  function targetAt(px, wholePart) {
    if (wholePart) {
      const h = hit(px);
      if (!h) return null;
      const piece = pieceAt(h.point);
      if (piece) return { type: 'part', piece };
      // No CSG box here — an extruded piece, for instance. Fall back to the welded solid.
      const info = state.groups.get(h.object);
      const triangles = info?.bodies.get(info.findBody(h.faceIndex));
      return triangles
        ? { type: 'body', mesh: h.object, triangles, point: h.point }
        : null;
    }

    // Only edges you can actually see, unless x-ray is on — there, seeing through is the point.
    const feature = featureUnderCursor(px, state.features, view.camera, canvas, 6,
                                       state.occlude ? state.meshes : null);
    if (feature) return { type: 'edge', feature };

    const h = hit(px);
    if (!h) return null;
    const info = state.groups.get(h.object);
    if (!info) return null;
    const triangles = info.groups.get(info.find(h.faceIndex)) ?? [h.faceIndex];
    return { type: 'face', mesh: h.object, triangles, point: h.point, normal: info.planes[h.faceIndex].normal };
  }

  function describe(target) {
    if (!target) return '';
    if (target.type === 'edge') {
      const f = target.feature;
      if (f.type === 'arc') {
        const axis = axisName(f.normal);
        return `Arc · R ${mm(f.radius)} mm · ${(f.sweep * 180 / Math.PI).toFixed(1)}° · `
             + `length ${mm(f.length)} mm${axis ? ` · around ${axis}` : ''}`;
      }
      const axis = axisName(f.b.clone().sub(f.a).normalize());
      return `Edge · ${mm(f.length)} mm${axis ? ` · along ${axis}` : ''}`;
    }
    if (target.type === 'part') {
      const p = target.piece;
      const [sx, sy, sz] = p.size;
      const at = p.corner.map((v) => Math.round(v)).join(', ');
      return `Part #${p.id ?? '?'} · ${mm(sx)} × ${mm(sy)} × ${mm(sz)} mm (w × d × h) · `
           + `${((sx * sy * sz) / 1e6).toFixed(2)} dm³ · at (${at})`;
    }
    if (target.type === 'body') {
      const b = bodyBox(target.mesh, target.triangles);
      return `Body · ${mm(b.x)} × ${mm(b.y)} × ${mm(b.z)} mm · `
           + `${target.triangles.length} triangles (no CSG box — extruded shape)`;
    }
    const f = faceInfo(target.mesh, target.triangles, target.normal);
    const axis = axisName(target.normal);
    return `Face · ${mm(f.width)} × ${mm(f.height)} mm · ${(f.area / 100).toFixed(1)} cm²`
         + `${axis ? ` · facing ${axis}` : ''}`;
  }

  function shortLabel(target) {
    if (!target) return '';
    if (target.type === 'edge') {
      const f = target.feature;
      return f.type === 'arc' ? `R ${mm(f.radius)} mm` : `${mm(f.length)} mm`;
    }
    if (target.type === 'part') {
      const [sx, sy, sz] = target.piece.size;
      return `#${target.piece.id ?? '?'} · ${mm(sx)} × ${mm(sy)} × ${mm(sz)} mm`;
    }
    if (target.type === 'body') {
      const b = bodyBox(target.mesh, target.triangles);
      return `${mm(b.x)} × ${mm(b.y)} × ${mm(b.z)} mm`;
    }
    const f = faceInfo(target.mesh, target.triangles, target.normal);
    return `${mm(f.width)} × ${mm(f.height)} mm`;
  }

  /// Diagnostic: modifier flags of the last real pointer event, to tell a logic problem from
  /// a modifier that never reaches the page.
  let lastEvent = null;

  let selected = null;
  let hovered = null;
  let lastPx = null;
  let modifier = false;

  function refreshHover() {
    if (!state.enabled || !lastPx) return;
    hovered = targetAt(lastPx, modifier);
    show(hovered, hoverLines, hoverFace);
    canvas.style.cursor = hovered ? 'crosshair' : 'default';
    if (!selected) readout(hovered ? describe(hovered) : hint());
  }

  const hint = () => `Click an edge or a face · hold ${APPLE ? '⌘' : 'Ctrl'} for the whole part`;

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
      if (event.key !== 'Meta' && event.key !== 'Control' && event.key !== 'Escape') return;
      if (event.key === 'Escape') { if (state.enabled) clear(); return; }
      modifier = type === 'keydown';
      refreshHover();
    });
  }

  const wantsWholePart = (e) => (APPLE ? e.metaKey : e.ctrlKey);

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
      readout(describe(selected));
    } else {
      label.hidden = true;
      readout(hint());
    }
  });

  function clear() {
    selected = null;
    hovered = null;
    anchor = null;
    for (const o of [hoverLines, hoverFace, selectLines, selectFace]) o.visible = false;
    label.hidden = true;
    if (state.enabled) readout(hint());
  }

  /// The label lives in the DOM, so it has to follow the view.camera.
  function update() {
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

  const debug = () => ({
    lastEvent,
    hovered: hovered ? { type: hovered.type, segments: hovered.feature?.segments.length ?? null } : null,
    selected: selected ? { type: selected.type, segments: selected.feature?.segments.length ?? null } : null,
    drawnHover: hoverLines.segmentCount,
    drawnSelect: selectLines.segmentCount,
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

  const arcs = () => state.features.filter((f) => f.type === 'arc').map((f) => ({
    radius: Math.round(f.radius * 10) / 10,
    sweep: Math.round(f.sweep * 180 / Math.PI * 10) / 10,
    segments: f.segments.length,
    centre: [f.centre.x, f.centre.y, f.centre.z].map((v) => Math.round(v)),
  }));

  return { setTargets, setEnabled, setOcclusion, arcs, debug, probeModifier, arcPoint, clear, update };
}
