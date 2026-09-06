import * as THREE from 'three';
import { MODEL_TO_WORLD, worldToModelVector } from './picking.js';

/// The view cube: a small cube in the top right corner that shows which way the model faces and
/// turns the camera when clicked or dragged.
///
/// It is drawn in the model's own axes — Top is the model's +z, Front its −y — so it reads the
/// same way the standard views do. Its 26 regions are the six faces, the twelve edges and the
/// eight corners; clicking one aims the camera along that direction (a face gives a standard
/// view, an edge or corner a three-quarter one), dragging on it orbits the scene as dragging on
/// the model does. It renders into a scissored viewport after the main scene, with its own
/// orthographic camera that copies the main camera's orientation every frame.
export function createViewCube({ renderer, canvas, view, controls, onAim, onOrbit }) {
  const SIZE = 118;          // px, square
  const MARGIN = 12;

  const cubeScene = new THREE.Scene();
  const cubeCamera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 100);
  cubeScene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const light = new THREE.DirectionalLight(0xffffff, 0.9);
  light.position.set(1, 2, 1.5);
  cubeScene.add(light);

  // The cube stands in the model's axes, so region directions can be written in them.
  const root = new THREE.Group();
  root.applyMatrix4(MODEL_TO_WORLD);
  cubeScene.add(root);

  const FACE = 0.62;         // half-size of a face's centre region; the rest is edge and corner
  const LABELS = { '0,-1,0': 'FRONT', '0,1,0': 'BACK', '-1,0,0': 'LEFT', '1,0,0': 'RIGHT', '0,0,1': 'TOP', '0,0,-1': 'BOTTOM' };
  // Screen-up of each face's standard view, so its label reads upright from there: z for the
  // sides, and for top and bottom the same as the Top and Bottom views use.
  const UPS = { '0,0,1': [0, 1, 0], '0,0,-1': [0, 1, 0] };
  /// In-plane basis of a face: `a` is screen-right in its standard view, `b` screen-up.
  function basis(n) {
    const up = new THREE.Vector3(...(UPS[n.toArray().join(',')] ?? [0, 0, 1]));
    const a = new THREE.Vector3().crossVectors(up, n).normalize();
    return [a, up];
  }
  const BASE = 0xd7d9dd, HOVER = 0x0a84ff;
  const regions = new Map();     // key → { dir, meshes: [] }

  function label(text) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#d7d9dd';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#2b2e33';
    ctx.font = '600 58px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 132);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /// One quad of a face: `u`, `v` span [−1, 1] in the face's plane; `dir` is the region it belongs to.
  function quad(normal, u0, u1, v0, v1, dir, map = null) {
    const key = dir.join(',');
    const n = new THREE.Vector3(...normal);
    const [a, b] = basis(n);
    const corner = (uu, vv) => n.clone().addScaledVector(a, uu).addScaledVector(b, vv);
    const p = [corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(p.flatMap((q) => [q.x, q.y, q.z]), 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(p.flatMap(() => [n.x, n.y, n.z]), 3));
    // UVs so a label reads upright: v along the face's "up" (model +z, or −y on the top/bottom).
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv.flat(), 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    // A labelled quad is drawn as its texture is; the tint is only for the plain ones.
    const material = new THREE.MeshLambertMaterial({ color: map ? 0xffffff : BASE, map });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.key = key;
    root.add(mesh);
    let region = regions.get(key);
    if (!region) { region = { dir: new THREE.Vector3(...dir).normalize(), meshes: [] }; regions.set(key, region); }
    region.meshes.push(mesh);
  }

  // Six faces, each a 3 × 3 grid: the centre is the face, the sides belong to the edges shared
  // with the neighbouring faces, the corners to the corners.
  for (const normal of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const n = new THREE.Vector3(...normal);
    const [a, b] = basis(n);
    const spans = [[-1, -FACE], [-FACE, FACE], [FACE, 1]];
    for (const [ui, [u0, u1]] of spans.entries()) {
      for (const [vi, [v0, v1]] of spans.entries()) {
        const dir = n.clone();
        if (ui !== 1) dir.addScaledVector(a, ui === 2 ? 1 : -1);
        if (vi !== 1) dir.addScaledVector(b, vi === 2 ? 1 : -1);
        const key = dir.toArray().map(Math.round);
        const isCentre = ui === 1 && vi === 1;
        quad(normal, u0, u1, v0, v1, key, isCentre ? label(LABELS[normal.join(',')]) : null);
      }
    }
  }
  // Crisp edges over the quads.
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(2.002, 2.002, 2.002)),
    new THREE.LineBasicMaterial({ color: 0x5a5e66 }));
  root.add(outline);

  // --- viewport ---

  /// Where the cube sits, in CSS pixels from the top left.
  function rect() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    return { x: w - SIZE - MARGIN, y: MARGIN, w: SIZE, h: SIZE, canvasW: w, canvasH: h };
  }
  const inside = (px, py) => { const r = rect(); return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; };

  function render() {
    const r = rect();
    // Viewport and scissor take CSS pixels; the renderer applies the pixel ratio itself. (Given
    // device pixels, on a Retina screen the main viewport came back twice too large.)
    // The cube's camera looks at the origin from the main camera's direction, with its up.
    const dir = view.camera.position.clone().sub(controls.target).normalize();
    markActive(worldToModelVector(dir).normalize());
    cubeCamera.position.copy(dir).multiplyScalar(6);
    cubeCamera.up.copy(view.camera.up);
    cubeCamera.lookAt(0, 0, 0);
    cubeCamera.updateProjectionMatrix();

    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.setScissorTest(true);
    renderer.setViewport(r.x, r.canvasH - r.y - r.h, r.w, r.h);
    renderer.setScissor(r.x, r.canvasH - r.y - r.h, r.w, r.h);
    renderer.render(cubeScene, cubeCamera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, r.canvasW, r.canvasH);
    renderer.autoClear = true;
  }

  // --- picking ---

  const raycaster = new THREE.Raycaster();
  function regionAt(px, py) {
    const r = rect();
    const ndc = new THREE.Vector2(((px - r.x) / r.w) * 2 - 1, -((py - r.y) / r.h) * 2 + 1);
    raycaster.setFromCamera(ndc, cubeCamera);
    const hit = raycaster.intersectObjects(root.children.filter((m) => m.isMesh), false)[0];
    return hit ? regions.get(hit.object.userData.key) : null;
  }

  // Two tints: the region the camera is looking along (the current view) and the one under the
  // pointer. Hover wins where they meet; the plain colour returns when neither applies.
  const ACTIVE = 0x4f8fd8, ACTIVE_LABEL = 0xbcd6f5;
  let hovered = null, active = null;
  function paint(region) {
    const state = region === hovered ? 'hover' : region === active ? 'active' : 'base';
    for (const m of region.meshes) {
      const labelled = !!m.material.map;
      m.material.color.set(state === 'hover' ? (labelled ? 0x9ec9ff : HOVER)
                         : state === 'active' ? (labelled ? ACTIVE_LABEL : ACTIVE)
                         : (labelled ? 0xffffff : BASE));
    }
  }
  function highlight(region) {
    if (hovered === region) return;
    const was = hovered;
    hovered = region;
    if (was) paint(was);
    if (hovered) paint(hovered);
  }
  /// The region the camera looks along, if it is within half a degree of one — lit so the cube
  /// says which standard or three-quarter view is on, not only which way is up.
  function markActive(dirModel) {
    let found = null;
    for (const region of regions.values()) if (region.dir.dot(dirModel) > Math.cos(0.5 * Math.PI / 180)) { found = region; break; }
    if (found === active) return;
    const was = active;
    active = found;
    if (was) paint(was);
    if (active) paint(active);
  }

  // --- input, ahead of everything else on the canvas ---

  let drag = null;
  const px = (e) => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };

  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = px(e);
    if (!inside(x, y)) return;
    drag = { x, y, moved: false };
    e.stopImmediatePropagation();
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
  }, true);

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = px(e);
    if (drag) {
      const dx = x - drag.x, dy = y - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      drag.x = x; drag.y = y;
      if (drag.moved) onOrbit(dx, dy);
      e.stopImmediatePropagation();
      return;
    }
    if (inside(x, y)) {
      highlight(regionAt(x, y));
      canvas.style.cursor = hovered ? 'pointer' : '';
      e.stopImmediatePropagation();
    } else if (hovered) {
      highlight(null);
    }
  }, true);

  canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const [x, y] = px(e);
    const wasClick = !drag.moved;
    drag = null;
    canvas.releasePointerCapture?.(e.pointerId);
    e.stopImmediatePropagation();
    if (wasClick) {
      const region = regionAt(x, y);
      if (region) onAim(region.dir.clone());
    }
  }, true);

  return { render, regionAt, get size() { return SIZE; } };
}
