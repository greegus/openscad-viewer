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
    picks: [],        // at most 2 features
  };

  // --- visuals ---
  const group = new THREE.Group();
  group.renderOrder = 10;
  scene.add(group);

  const hoverLine = createStroke({ scene, color: 0xffd60a, width: 2, outline: 1, renderOrder: 20 });
  const pickLines = [0, 1].map(() =>
    createStroke({ scene, color: 0x22dd77, width: 2, outline: 1, renderOrder: 22 }));

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

  const pick = (px) => featureUnderCursor(px, state.features, view.camera, canvas, 14,
                                          state.occlude ? state.meshes : null);

  const drawFeature = (line, feature) => {
    const points = [];
    for (const s of feature.segments) points.push(s.a, s.b);
    line.setPoints(points);
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

  function describe() {
    if (state.picks.length === 0) {
      readout('Click an edge. A second click measures the distance.');
      dimLine.visible = false; label.hidden = true;
      return;
    }
    if (state.picks.length === 1) {
      const f = state.picks[0];
      readout(f.type === 'arc'
        ? `Arc: R ${mm(f.radius)} — pick a second edge`
        : `Edge: ${mm(f.length)} — pick a second edge`);
      dimLine.visible = false; label.hidden = true;
      return;
    }

    const [x, y] = state.picks;
    const r = featureDistance(x, y);

    // Parallel edges are the common case in furniture (shelf pitch) — worth saying so.
    // An arc has no single direction, so the comparison only applies to straight edges.
    const straight = x.type === 'line' && y.type === 'line';
    const angle = straight ? THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(
      x.b.clone().sub(x.a).normalize().dot(y.b.clone().sub(y.a).normalize()))))) : null;
    const parallel = straight && angle < 0.5;

    dimLine.geometry.setFromPoints([r.from, r.to]);
    dimLine.computeLineDistances();
    dimLine.visible = true;

    const mid = toScreen(r.from.clone().add(r.to).multiplyScalar(0.5), view.camera, canvas);
    label.textContent = mm(r.distance);
    label.style.left = `${mid.x}px`;
    label.style.top = `${mid.y}px`;
    label.hidden = false;

    readout(parallel ? `Parallel edges · distance ${mm(r.distance)}`
      : straight ? `Distance ${mm(r.distance)} · angle ${angle.toFixed(1)}°`
      : `Distance ${mm(r.distance)}`);
  }

  function clear() {
    state.picks = [];
    for (const l of pickLines) l.visible = false;
    dimLine.visible = false;
    label.hidden = true;
    hoverLine.visible = false;
    if (state.enabled) describe();
  }

  // --- input ---

  const canvas = renderer.domElement;

  canvas.addEventListener('pointermove', (event) => {
    if (!state.enabled) return;
    const feature = pick(cursorPx(event, canvas));
    if (feature) {
      drawFeature(hoverLine, feature);
      canvas.style.cursor = 'crosshair';
    } else {
      hoverLine.visible = false;
      canvas.style.cursor = '';
    }
    // Describe what is under the cursor, as Inspect does — but never overwrite a pick in
    // progress, where the readout is telling you what it is still waiting for.
    if (state.picks.length === 0) {
      readout(feature
        ? (feature.type === 'arc'
            ? `Arc · R ${mm(feature.radius)} · ${(feature.sweep * 180 / Math.PI).toFixed(1)}°`
            : `Edge · ${mm(feature.length)}`)
        : 'Click an edge. A second click measures the distance.');
    }
  });

  makeClickDetector(canvas, (px) => {
    if (!state.enabled) return;
    const feature = pick(px);
    if (!feature) { clear(); return; }
    if (state.picks.length >= 2) { state.picks = []; for (const l of pickLines) l.visible = false; }
    state.picks.push(feature);
    drawFeature(pickLines[state.picks.length - 1], feature);
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
      dimLine.visible = false;
      label.hidden = true;
      canvas.style.cursor = '';
      readout('');
    } else {
      describe();
    }
  }

  return {
    setTargets, setOccluders, setEnabled, setOcclusion, clear, update,
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
