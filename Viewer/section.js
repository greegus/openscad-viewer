import * as THREE from 'three';
import { MODEL_TO_WORLD, modelVector, worldToModelVector } from './picking.js';

/// Cross-section: cut the model with a plane and look inside.
///
/// Three states, in the order you work in: pick the plane, pick which half goes, then slide it
/// along its normal until you can see what you came for. The last state stays live, so the
/// slider is the tool rather than a step on the way to it.
///
/// The cut face is drawn, not left open. Clipping a mesh removes triangles and leaves a shell —
/// panels turn into paper. Filling it needs the stencil buffer: render back faces incrementing
/// and front faces decrementing where the plane is, and whatever the count says is inside gets
/// painted. That is the bulk of this file and the reason the tool is not two lines of
/// `clippingPlanes`.
export function createSection({ scene, renderer, view, readout }) {

  const AXES = {
    x: { label: 'X', dir: [1, 0, 0] },
    y: { label: 'Y', dir: [0, 1, 0] },
    z: { label: 'Z', dir: [0, 0, 1] },
  };

  const state = {
    stage: 'off',          // off | plane | side | ready
    axis: null,
    flipped: false,
    offset: 0,             // in model units, along the axis
    bounds: null,          // { min, max } along the axis, in model units
  };

  const plane = new THREE.Plane();
  const capGroup = new THREE.Group();
  capGroup.renderOrder = 2;
  scene.add(capGroup);

  let targets = [];        // { mesh, xray, colour }
  let overlays = [];       // the edge overlay and the silhouettes, one object each

  // The ghost: where the cut would go from the face under the pointer — a translucent sheet the
  // size of the whole model in that plane, with its outline — so a click is not a guess.
  const ghost = new THREE.Group();
  ghost.visible = false;
  const ghostFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }));
  const ghostEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthTest: false }));
  ghostFill.renderOrder = 18;
  ghostEdge.renderOrder = 19;
  ghost.add(ghostFill, ghostEdge);
  scene.add(ghost);

  // The handle on a live cut: a two-headed arrow along the plane's normal at the model's centre,
  // dragged to slide the plane; and beside it, in the page, a button that swaps the kept side.
  const gizmo = new THREE.Group();
  gizmo.visible = false;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12),
    new THREE.MeshBasicMaterial({ color: 0x0a84ff, depthTest: false, transparent: true, opacity: 0.95 }));
  const headA = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 16), shaft.material);
  const headB = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 16), shaft.material);
  for (const m of [shaft, headA, headB]) { m.renderOrder = 30; gizmo.add(m); }
  scene.add(gizmo);
  const flipButton = document.createElement('button');
  flipButton.className = 'section-flip';
  flipButton.title = 'Swap the kept side (Tab)';
  flipButton.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5h8.5M9 3l2.5 2.5L9 8" /><path d="M13 10.5H4.5M7 8l-2.5 2.5L7 13" /></svg>';
  flipButton.hidden = true;
  renderer.domElement.parentElement.appendChild(flipButton);
  flipButton.addEventListener('click', (e) => { e.stopPropagation(); api.flip(); });

  /// The handle's place and size: at the model's centre in the plane, its length a fraction of
  /// the model's span so it reads the same at any zoom of the model.
  function updateGizmo() {
    const live = !!state.axis && state.stage !== 'off' && state.stage !== 'plane' && state.bounds;
    gizmo.visible = live;
    flipButton.hidden = !live;
    if (!live) return;
    const b = state.bounds;
    const centre = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
    centre[state.axis] = state.offset;
    const at = new THREE.Vector3(centre.x, centre.y, centre.z).applyMatrix4(MODEL_TO_WORLD);
    const dir = modelVector(AXES[state.axis].dir);
    const span = b.span ?? 1000;
    const length = span * 0.12, radius = span * 0.006, head = span * 0.03;
    gizmo.position.copy(at);
    gizmo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    shaft.scale.set(radius, length, radius);
    headA.scale.set(head, head * 1.6, head); headA.position.set(0, length / 2 + head * 0.8, 0);
    headB.scale.set(head, head * 1.6, head); headB.position.set(0, -length / 2 - head * 0.8, 0); headB.rotation.z = Math.PI;
  }

  /// The flip button follows the handle on screen, every frame.
  function update() {
    if (flipButton.hidden) return;
    const p = gizmo.position.clone().project(view.camera);
    const canvas = renderer.domElement;
    const x = (p.x * 0.5 + 0.5) * canvas.clientWidth, y = (-p.y * 0.5 + 0.5) * canvas.clientHeight;
    flipButton.style.left = `${x + 22}px`;
    flipButton.style.top = `${y - 14}px`;
  }

  // Dragging the handle slides the plane: the pointer's ray is matched against the normal line
  // through the handle, and the plane goes to the closest point on that line.
  const raycaster = new THREE.Raycaster();
  let dragging = null;
  const canvas = renderer.domElement;
  const ndc = (e) => { const r = canvas.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
  function alongAxis(e) {
    raycaster.setFromCamera(ndc(e), view.camera);
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(MODEL_TO_WORLD);
    const dir = modelVector(AXES[state.axis].dir);
    // Closest point between the ray and the axis line through the world origin.
    const r0 = raycaster.ray.origin, rd = raycaster.ray.direction;
    const w = r0.clone().sub(origin);
    const a = rd.dot(rd), bb = rd.dot(dir), c = dir.dot(dir), d = rd.dot(w), ee = dir.dot(w);
    const den = a * c - bb * bb;
    if (Math.abs(den) < 1e-9) return null;
    const t = (a * ee - bb * d) / den;           // along the axis line
    return t;                                    // model offset along the axis (line through origin)
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!gizmo.visible) return;
    raycaster.setFromCamera(ndc(e), view.camera);
    if (!raycaster.intersectObjects([shaft, headA, headB], false).length) return;
    const start = alongAxis(e);
    if (start === null) return;
    dragging = { start, offset: state.offset };
    canvas.setPointerCapture?.(e.pointerId);
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) {
      if (gizmo.visible) {
        raycaster.setFromCamera(ndc(e), view.camera);
        const over = raycaster.intersectObjects([shaft, headA, headB], false).length > 0;
        shaft.material.color.set(over ? 0x5ac8fa : 0x0a84ff);
        if (over) { canvas.style.cursor = 'grab'; e.stopImmediatePropagation(); }
      }
      return;
    }
    const now = alongAxis(e);
    if (now !== null) api.moveTo(dragging.offset + (now - dragging.start));
    e.stopImmediatePropagation();
  }, true);
  canvas.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = null;
    canvas.releasePointerCapture?.(e.pointerId);
    e.stopImmediatePropagation();
  }, true);

  /// Stencil pair per material: back faces add, front faces subtract. What remains set is
  /// solid where the plane cuts, and the cap quad is painted through that mask.
  function buildCaps() {
    capGroup.clear();
    if (!targets.length) return;

    for (const [index, target] of targets.entries()) {
      const geometry = target.mesh.geometry;

      const back = new THREE.Mesh(geometry, stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp));
      const front = new THREE.Mesh(geometry, stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp));
      for (const m of [back, front]) {
        m.matrixAutoUpdate = false;
        m.matrix.copy(target.mesh.matrix);
        m.renderOrder = index * 3 + 1;
        capGroup.add(m);
      }

      // One quad, big enough to cover the section wherever the plane sits; the stencil decides
      // which of it survives.
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capMaterial(target.colour, index));
      quad.renderOrder = index * 3 + 2;
      quad.onBeforeRender = () => fitQuad(quad);
      capGroup.add(quad);
    }
  }

  function stencilMaterial(side, op) {
    return new THREE.MeshBasicMaterial({
      depthWrite: false, depthTest: false, colorWrite: false,
      stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
      side, stencilFail: op, stencilZFail: op, stencilZPass: op,
      clippingPlanes: [plane],
    });
  }

  function capMaterial(colour, index) {
    return new THREE.MeshBasicMaterial({
      color: colour,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
      side: THREE.DoubleSide,
    });
  }

  /// The quad has to face the plane and cover everything the camera can see of it.
  function fitQuad(quad) {
    quad.position.copy(plane.normal).multiplyScalar(-plane.constant);
    quad.lookAt(quad.position.clone().add(plane.normal));
    const size = (state.bounds?.span ?? 1000) * 3;
    quad.scale.set(size, size, 1);
    quad.updateMatrixWorld(true);
  }

  /// The clipping plane in world space, for the axis and offset picked.
  ///
  /// Must run with no axis too — that is how the planes come *off* when the tool stops. An early
  /// return there left the model cut after the tool was switched away from.
  function updatePlane() {
    if (state.axis) {
      const normal = modelVector(AXES[state.axis].dir).multiplyScalar(state.flipped ? -1 : 1);
      const point = modelVector(AXES[state.axis].dir).multiplyScalar(state.offset);
      plane.setFromNormalAndCoplanarPoint(normal, point);
    }

    const active = !!state.axis && (state.stage === 'ready' || state.stage === 'side');
    renderer.localClippingEnabled = active;
    for (const target of targets) {
      for (const material of [target.mesh.material, target.xray.material]) {
        material.clippingPlanes = active ? [plane] : [];
        material.needsUpdate = true;
      }
    }
    // The edge overlay and the silhouettes are one object each for the whole model, not one per
    // material, so they take the plane here rather than in the loop above. Missing one would
    // leave lines hanging in the cut.
    for (const overlay of overlays) {
      if (!overlay) continue;
      overlay.material.clippingPlanes = active ? [plane] : [];
      overlay.material.needsUpdate = true;
    }
    capGroup.visible = active;
    updateGizmo();
    report();
  }

  function report() {
    if (state.stage === 'off') return;
    if (state.stage === 'plane') return readout('Section · click a face, or pick an axis');
    const axis = AXES[state.axis].label;
    const side = state.flipped ? '−' : '+';
    readout(`Section · ${axis} = ${Math.round(state.offset)} mm · keeping ${side}`
          + ' · ↑↓ to move (⇧ ×10), ⇥ to flip, click a face to cut there');
  }

  const api = {
    /// The pieces to cut, and the extent to slide within.
    setTargets(parts, bounds) {
      targets = parts.map((p) => ({
        mesh: p.mesh, xray: p.xray,
        colour: new THREE.Color(p.rgba[0], p.rgba[1], p.rgba[2]),
      }));
      state.bounds = bounds;
      buildCaps();
      updatePlane();
    },

    /// The line overlays — edges, silhouettes — rebuilt whenever pieces are hidden or the
    /// camera moves, so they are handed over each time.
    setOverlays(list) {
      overlays = list;
      updatePlane();
    },

    setAxis(axis) {
      if (!AXES[axis]) return;
      state.axis = axis;
      state.stage = 'side';
      // Start in the middle: a plane at the very edge cuts nothing and looks broken.
      state.offset = state.bounds ? (state.bounds.min[axis] + state.bounds.max[axis]) / 2 : 0;
      updatePlane();
    },

    flip() {
      state.flipped = !state.flipped;
      if (state.stage === 'side') state.stage = 'ready';
      updatePlane();
    },

    /// Puts the plane at an offset along its axis, within the model.
    moveTo(offset) {
      if (!state.axis) return;
      state.offset = offset;
      if (state.bounds) {
        state.offset = Math.max(state.bounds.min[state.axis],
                                Math.min(state.bounds.max[state.axis], state.offset));
      }
      state.stage = 'ready';
      updatePlane();
    },

    /// Slides the plane along its normal, in model millimetres.
    move(delta) {
      if (!state.axis) return;
      state.offset += delta;
      if (state.bounds) {
        state.offset = Math.max(state.bounds.min[state.axis],
                                Math.min(state.bounds.max[state.axis], state.offset));
      }
      state.stage = 'ready';
      updatePlane();
    },

    /// Shows the ghost for a face under the pointer: the plane of the cut a click there would
    /// make, sized to the model's extent in that plane. Null hides it.
    showGhost(worldNormal, worldPoint) {
      if (!worldNormal || !state.bounds) { ghost.visible = false; return; }
      const n = worldToModelVector(worldNormal);
      const axis = ['x', 'y', 'z'].reduce((best, k) => Math.abs(n[k]) > Math.abs(n[best]) ? k : best, 'x');
      const p = worldToModelVector(worldPoint);
      const [u, v] = ['x', 'y', 'z'].filter((k) => k !== axis);
      const b = state.bounds;
      const centre = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
      centre[axis] = p[axis];
      // A little larger than the model, so the sheet shows past its edges: the same margin all
      // round, 5% of the longer side, rather than a percentage of each side separately.
      const margin = Math.max(b.max[u] - b.min[u], b.max[v] - b.min[v]) * 0.05;
      const size = { [u]: (b.max[u] - b.min[u]) + 2 * margin, [v]: (b.max[v] - b.min[v]) + 2 * margin };
      // The sheet's own x and y run along the two other model axes, its z along the cut's axis:
      // a basis built from those, placed in the world like everything else.
      const unit = (k) => modelVector([k === 'x' ? 1 : 0, k === 'y' ? 1 : 0, k === 'z' ? 1 : 0]);
      ghost.matrixAutoUpdate = false;
      // A point, not a direction: modelVector() normalises, being for directions.
      ghost.matrix.makeBasis(unit(u), unit(v), unit(axis)).setPosition(new THREE.Vector3(centre.x, centre.y, centre.z).applyMatrix4(MODEL_TO_WORLD));
      ghostFill.scale.set(size[u], size[v], 1);
      ghostEdge.scale.copy(ghostFill.scale);
      ghost.visible = true;
    },
    hideGhost() { ghost.visible = false; },

    /// Cuts at the face clicked: the plane through the hit point, along the model axis nearest
    /// the face's normal — every cut worth making in furniture is axis-aligned — with the half
    /// toward the camera removed, since the point of a section is to look inside.
    setFromHit(worldNormal, worldPoint, worldViewDir) {
      const n = worldToModelVector(worldNormal);
      const axis = ['x', 'y', 'z'].reduce((best, k) =>
        Math.abs(n[k]) > Math.abs(n[best]) ? k : best, 'x');
      const p = worldToModelVector(worldPoint);
      const look = worldToModelVector(worldViewDir);
      state.axis = axis;
      state.offset = p[axis];
      // The kept side is the plane's normal side; pointing it along the view keeps what is
      // behind the plane and removes what is in front.
      state.flipped = look[axis] < 0;
      // Half a millimetre into the material: on the face itself the face's own skin and the
      // cap coincide and fight for the pixels.
      state.offset += state.flipped ? -0.5 : 0.5;
      state.stage = 'ready';
      updatePlane();
    },

    start() { state.stage = 'plane'; report(); },

    stop() {
      state.stage = 'off';
      state.axis = null;
      state.flipped = false;
      ghost.visible = false;
      updatePlane();
    },

    update,
    get stage() { return state.stage; },
    get debug() {
      return { ...state, capChildren: capGroup.children.length, capVisible: capGroup.visible,
               gizmo: gizmo.visible ? gizmo.position.toArray().map(Math.round) : null, flipButton: !flipButton.hidden,
               ghost: ghost.visible ? { position: new THREE.Vector3().setFromMatrixPosition(ghost.matrix).toArray().map(Math.round), scale: ghostFill.scale.toArray().map(Math.round) } : null };
    },
  };
  return api;
}
