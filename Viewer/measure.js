import * as THREE from 'three';
import { toScreen, cursorPx, pieceFeatures, featureUnderCursor, makeClickDetector } from './picking.js';
import { createStroke } from './strokes.js';

/// Geometry inspection: snapping to edges and measuring the distance between them.
/// The model is in millimetres, so that is what gets printed.
///
/// Snapping happens in screen pixels, not in 3D — that is the only thing that behaves
/// predictably under perspective (a nearby edge must not win over the one under the cursor).
export function createMeasure({ scene, view, renderer, readout }) {

  const state = {
    enabled: false,
    features: [],     // lines and arcs, in world coordinates
    meshes: [],       // occluders, so only visible geometry responds
    occlude: true,
    picks: [],        // at most 2: { kind: 'edge', feature } or { kind: 'face', target }
    faceAt: null,     // the CSG face under a pixel, lent by Inspect
    faceFill: null,
  };

  // --- visuals ---
  const group = new THREE.Group();
  group.renderOrder = 10;
  scene.add(group);

  const hoverLine = createStroke({ scene, color: 0xffd60a, width: 2, outline: 1, renderOrder: 20 });
  const pickLines = [0, 1].map(() =>
    createStroke({ scene, color: 0x22dd77, width: 2, outline: 1, renderOrder: 22 }));
  // Faces are picked as well as edges, so they need a fill of their own — the same kind
  // Inspect draws, in Measure's colours.
  const makeFace = (color, opacity) => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide }));
    m.renderOrder = 19;
    m.visible = false;
    scene.add(m);
    return m;
  };
  const hoverFace = makeFace(0xffd60a, 0.28);
  const pickFaces = [0, 1].map(() => makeFace(0x22dd77, 0.35));

  const dimLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineDashedMaterial({ color: 0xff4d6d, dashSize: 12, gapSize: 8, depthTest: false }));
  dimLine.visible = false;
  group.add(dimLine);

  const label = document.createElement('div');
  label.className = 'measure-label';
  label.hidden = true;
  renderer.domElement.parentElement.appendChild(label);

  // --- geometry ---

  /// Edges come from the pieces, the same source Inspect and the overlay use — so what you can
  /// measure is exactly what you can see and select. A tessellated rounded corner arrives as one
  /// arc, and an edge belongs to one piece rather than running across everything welded to it.
  function setTargets(pieces) {
    state.features = pieceFeatures(pieces ?? []);
    clear();
  }

  /// The meshes are needed separately, only to decide what hides an edge from view.
  function setOccluders(meshes) {
    state.meshes = meshes ?? [];
  }

  /// In x-ray the whole point is to reach what is behind, so occlusion is dropped there.
  function setOcclusion(on) { state.occlude = on; }

  /// Inspect lends its face model, so a face measured is the face inspected — the same plane,
  /// the same boundary, the same patches where a neighbour rests on it.
  function setFacePicker(faceAt, faceFill) { state.faceAt = faceAt; state.faceFill = faceFill; }

  /// An edge if one is near the cursor, else the face under it. Edges first: they are thin and
  /// always lie on a face, so the face would otherwise swallow them.
  const pick = (px) => {
    // Six pixels, as Inspect: a wider reach for edges used to make sense when edges were all
    // there was to pick; now it would take the face's rim wherever a face was meant.
    const feature = featureUnderCursor(px, state.features, view.camera, canvas, 6,
                                       state.occlude ? state.meshes : null);
    if (feature) return { kind: 'edge', feature };
    const target = state.faceAt?.(px);
    return target ? { kind: 'face', target } : null;
  };

  const drawFeature = (line, feature) => {
    const points = [];
    for (const s of feature.segments) points.push(s.a, s.b);
    line.setPoints(points);
  };
  const draw = (line, face, item) => {
    line.visible = false;
    face.visible = false;
    if (!item) return;
    if (item.kind === 'edge') { drawFeature(line, item.feature); return; }
    face.geometry.dispose();
    face.geometry = state.faceFill(item.target);
    face.visible = true;
  };

  // --- face geometry, for distances ---

  /// A face as the world-space triangles of its fill: what a distance to it is measured against.
  const faceTriangles = (target) => {
    const pos = state.faceFill(target).attributes.position;
    const out = [];
    for (let i = 0; i + 8 < pos.count * 3; i += 9) {
      out.push([new THREE.Vector3(pos.array[i], pos.array[i + 1], pos.array[i + 2]),
                new THREE.Vector3(pos.array[i + 3], pos.array[i + 4], pos.array[i + 5]),
                new THREE.Vector3(pos.array[i + 6], pos.array[i + 7], pos.array[i + 8])]);
    }
    return out;
  };
  const closestOnTriangle = (p, [a, b, c]) => new THREE.Triangle(a, b, c).closestPointToPoint(p, new THREE.Vector3());

  /// Shortest connector from a set of points to a set of triangles.
  function pointsToTriangles(points, triangles) {
    let best = null;
    for (const p of points) {
      for (const tri of triangles) {
        const q = closestOnTriangle(p, tri);
        const d = p.distanceTo(q);
        if (!best || d < best.distance) best = { distance: d, from: p.clone(), to: q };
      }
    }
    return best;
  }

  /// Points along a feature: its vertices plus a few per segment, enough for a distance.
  const featurePoints = (f) => {
    const out = [];
    for (const seg of f.segments) for (const t of [0, 0.25, 0.5, 0.75]) out.push(seg.a.clone().lerp(seg.b, t));
    out.push(f.segments[f.segments.length - 1].b.clone());
    return out;
  };
  const trianglePoints = (tris) => {
    const out = [];
    for (const [a, b, c] of tris) out.push(a, b, c, a.clone().add(b).add(c).divideScalar(3));
    return out;
  };

  /// Shortest connector between two features: the best of their segment pairs.
  function featureDistance(x, y) {
    let best = null;
    for (const a of x.segments) {
      for (const b of y.segments) {
        const r = segmentDistance(a.a, a.b, b.a, b.b);
        if (!best || r.distance < best.distance) best = r;
      }
    }
    return best;
  }

  /// Shortest distance between two segments (not lines), plus the endpoints of the connector.
  function segmentDistance(p1, q1, p2, q2) {
    const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
    const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
    let s = 0, t = 0;
    if (a < 1e-9 && e < 1e-9) return { distance: r.length(), from: p1.clone(), to: p2.clone() };
    if (a < 1e-9) { t = Math.max(0, Math.min(1, f / e)); }
    else {
      const c = d1.dot(r);
      if (e < 1e-9) { s = Math.max(0, Math.min(1, -c / a)); }
      else {
        const b = d1.dot(d2), denom = a * e - b * b;
        s = denom > 1e-9 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
        else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
      }
    }
    const from = p1.clone().addScaledVector(d1, s);
    const to = p2.clone().addScaledVector(d2, t);
    return { distance: from.distanceTo(to), from, to };
  }

  const mm = (v) => `${v.toFixed(1)} mm`;

  const faceName = (t) => ({ cylinder: 'Round face', sphere: 'Spherical face', cone: 'Conical face' }[t.face.kind] ?? 'Face');
  const itemName = (item) => item.kind === 'edge'
    ? (item.feature.type === 'arc' ? `Arc: R ${mm(item.feature.radius)}` : `Edge: ${mm(item.feature.length)}`)
    : faceName(item.target);

  /// The measurement between two picks, as { distance, from, to, note }.
  ///
  /// The furniture cases first: two parallel planes (shelf pitch, the clear width between two
  /// sides) are the distance between the planes; two parallel cylinders (a row of holes) the
  /// distance between their axes; an edge parallel to a plane its height above it. Anything else
  /// is the shortest connector between the two, with the angle where both have a direction.
  function measurement(x, y) {
    const deg = (a, b) => THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(a.dot(b)))));
    if (x.kind === 'edge' && y.kind === 'edge') {
      const r = featureDistance(x.feature, y.feature);
      const straight = x.feature.type === 'line' && y.feature.type === 'line';
      const angle = straight ? deg(x.feature.b.clone().sub(x.feature.a).normalize(), y.feature.b.clone().sub(y.feature.a).normalize()) : null;
      const parallel = straight && angle < 0.5;
      return { ...r, note: parallel ? `Parallel edges · distance ${mm(r.distance)}`
        : straight ? `Distance ${mm(r.distance)} · angle ${angle.toFixed(1)}°` : `Distance ${mm(r.distance)}` };
    }
    const fx = x.kind === 'face' ? x.target.face : null;
    const fy = y.kind === 'face' ? y.target.face : null;
    if (fx && fy) {
      if (fx.kind === 'plane' && fy.kind === 'plane') {
        const angle = deg(fx.normal, fy.normal);
        if (angle < 0.5) {
          // Distance between the planes, drawn from the picked point on one straight to the other.
          const from = x.target.point.clone();
          const d = fy.point.clone().sub(from).dot(fy.normal);
          const to = from.clone().addScaledVector(fy.normal, d);
          return { distance: Math.abs(d), from, to, note: `Parallel faces · distance ${mm(Math.abs(d))}` };
        }
        const r = pointsToTriangles(trianglePoints(faceTriangles(x.target)), faceTriangles(y.target));
        return { ...r, note: `Faces at ${angle.toFixed(1)}° · closest ${mm(r.distance)}` };
      }
      if (fx.kind === 'cylinder' && fy.kind === 'cylinder' && deg(fx.axis, fy.axis) < 0.5) {
        // Parallel axes: the pitch of two holes, from axis to axis.
        const from = x.target.point.clone().sub(fx.point);
        from.addScaledVector(fx.axis, -from.dot(fx.axis)).add(fx.point);       // on x's axis, at the picked height
        const off = from.clone().sub(fy.point);
        const to = from.clone().sub(off.addScaledVector(fy.axis, -off.dot(fy.axis)));
        const d = from.distanceTo(to);
        return { distance: d, from, to, note: `Parallel axes · distance ${mm(d)} · radii ${mm(fx.radius)} / ${mm(fy.radius)}` };
      }
      if (fx.kind === 'cylinder' && fy.kind === 'plane' && Math.abs(fx.axis.dot(fy.normal)) < 0.01) {
        const from = x.target.point.clone().sub(fx.point);
        from.addScaledVector(fx.axis, -from.dot(fx.axis)).add(fx.point);
        const d = fy.point.clone().sub(from).dot(fy.normal);
        const to = from.clone().addScaledVector(fy.normal, d);
        return { distance: Math.abs(d), from, to, note: `Axis to face · distance ${mm(Math.abs(d))} · radius ${mm(fx.radius)}` };
      }
      if (fy.kind === 'cylinder' && fx.kind === 'plane') return measurement(y, x);
    }
    const one = fx ? y : x, face = fx ? x : y;      // exactly one of them is a face
    if (face.kind === 'face' && one.kind === 'edge' && face.target.face.kind === 'plane' && one.feature.type === 'line') {
      const dir = one.feature.b.clone().sub(one.feature.a).normalize();
      const n = face.target.face.normal;
      if (Math.abs(dir.dot(n)) < 0.01) {
        const from = one.feature.a.clone().lerp(one.feature.b, 0.5);
        const d = face.target.face.point.clone().sub(from).dot(n);
        const to = from.clone().addScaledVector(n, d);
        return { distance: Math.abs(d), from, to, note: `Edge parallel to face · distance ${mm(Math.abs(d))}` };
      }
    }
    // The general case: the closest pair of points.
    const pointsOf = (item) => item.kind === 'edge' ? featurePoints(item.feature) : trianglePoints(faceTriangles(item.target));
    const trisOf = (item) => item.kind === 'face' ? faceTriangles(item.target) : null;
    let r = null;
    if (trisOf(y)) r = pointsToTriangles(pointsOf(x), trisOf(y));
    else if (trisOf(x)) { const q = pointsToTriangles(pointsOf(y), trisOf(x)); r = q && { distance: q.distance, from: q.to, to: q.from }; }
    return { ...r, note: `Closest · distance ${mm(r.distance)}` };
  }

  function describe() {
    if (state.picks.length === 0) {
      readout('Click an edge or a face. A second click measures the distance.');
      dimLine.visible = false; label.hidden = true;
      return;
    }
    if (state.picks.length === 1) {
      readout(`${itemName(state.picks[0])} — pick a second edge or face`);
      dimLine.visible = false; label.hidden = true;
      return;
    }

    const [x, y] = state.picks;
    const r = measurement(x, y);

    dimLine.geometry.setFromPoints([r.from, r.to]);
    dimLine.computeLineDistances();
    dimLine.visible = true;

    const mid = toScreen(r.from.clone().add(r.to).multiplyScalar(0.5), view.camera, canvas);
    label.textContent = mm(r.distance);
    label.style.left = `${mid.x}px`;
    label.style.top = `${mid.y}px`;
    label.hidden = false;

    readout(r.note);
  }

  function clear() {
    state.picks = [];
    for (const l of pickLines) l.visible = false;
    for (const f of pickFaces) f.visible = false;
    dimLine.visible = false;
    label.hidden = true;
    hoverLine.visible = false;
    hoverFace.visible = false;
    if (state.enabled) describe();
  }

  // --- input ---

  const canvas = renderer.domElement;

  canvas.addEventListener('pointermove', (event) => {
    if (!state.enabled) return;
    const item = pick(cursorPx(event, canvas));
    draw(hoverLine, hoverFace, item);
    canvas.style.cursor = item ? 'crosshair' : '';
    // Describe what is under the cursor, as Inspect does — but never overwrite a pick in
    // progress, where the readout is telling you what it is still waiting for.
    if (state.picks.length === 0) {
      readout(item
        ? (item.kind === 'edge' && item.feature.type === 'arc'
            ? `Arc · R ${mm(item.feature.radius)} · ${(item.feature.sweep * 180 / Math.PI).toFixed(1)}°`
            : item.kind === 'edge' ? `Edge · ${mm(item.feature.length)}`
            : faceName(item.target))
        : 'Click an edge or a face. A second click measures the distance.');
    }
  });

  makeClickDetector(canvas, (px) => {
    if (!state.enabled) return;
    const item = pick(px);
    if (!item) { clear(); return; }
    if (state.picks.length >= 2) {
      state.picks = [];
      for (const l of pickLines) l.visible = false;
      for (const f of pickFaces) f.visible = false;
    }
    state.picks.push(item);
    draw(pickLines[state.picks.length - 1], pickFaces[state.picks.length - 1], item);
    describe();
  });

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') clear(); });

  /// The label lives in the DOM, so it has to follow the view.camera.
  function update() {
    if (!state.enabled || state.picks.length < 2 || label.hidden) return;
    const pts = dimLine.geometry.attributes.position;
    const from = new THREE.Vector3().fromBufferAttribute(pts, 0);
    const to = new THREE.Vector3().fromBufferAttribute(pts, 1);
    const mid = toScreen(from.add(to).multiplyScalar(0.5), view.camera, canvas);
    label.style.left = `${mid.x}px`;
    label.style.top = `${mid.y}px`;
  }

  function setEnabled(on) {
    state.enabled = on;
    group.visible = on;
    if (!on) {
      hoverLine.visible = false;
      hoverFace.visible = false;
      for (const f of pickFaces) f.visible = false;
      for (const l of pickLines) l.visible = false;
      dimLine.visible = false;
      label.hidden = true;
      canvas.style.cursor = '';
      readout('');
    } else {
      describe();
    }
  }

  return {
    setTargets, setOccluders, setEnabled, setOcclusion, setFacePicker, clear, update,
    // Diagnostic hooks: they let the maths be verified without simulating clicks.
    edges: () => state.features.flatMap((f) => f.segments).map((e, i) => ({
      i,
      a: [e.a.x, e.a.y, e.a.z],
      b: [e.b.x, e.b.y, e.b.z],
      length: e.a.distanceTo(e.b),
    })),
    /// Selects two edges programmatically — the same as two clicks (for tests and automation).
    select: (i, j) => {
      const all = state.features.flatMap((f) => f.segments);
      state.picks = [];
      for (const [n, idx] of [i, j].entries()) {
        const e = all[idx];
        if (!e) continue;
        state.picks.push({ type: 'line', segments: [e], a: e.a, b: e.b, length: e.a.distanceTo(e.b) });
        drawFeature(pickLines[n], state.picks[n]);
      }
      describe();
      return state.picks.length;
    },
    distanceBetween: (i, j) => {
      const all = state.features.flatMap((f) => f.segments);
      const x = all[i], y = all[j];
      if (!x || !y) return null;
      const r = segmentDistance(x.a, x.b, y.a, y.b);
      const u = x.b.clone().sub(x.a).normalize();
      const v = y.b.clone().sub(y.a).normalize();
      const angle = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(u.dot(v)))));
      return { distance: r.distance, angle, parallel: angle < 0.5 };
    },
  };
}
