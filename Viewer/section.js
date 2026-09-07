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
    new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
  const ghostEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
    new THREE.LineBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.8, depthTest: false }));
  ghostFill.renderOrder = 18;
  ghostEdge.renderOrder = 19;
  ghost.add(ghostFill, ghostEdge);
  scene.add(ghost);

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

  return {
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
      // A little larger than the model, so the sheet shows past its edges.
      const size = { [u]: (b.max[u] - b.min[u]) * 1.06, [v]: (b.max[v] - b.min[v]) * 1.06 };
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

    get stage() { return state.stage; },
    get debug() {
      return { ...state, capChildren: capGroup.children.length, capVisible: capGroup.visible,
               ghost: ghost.visible ? { position: new THREE.Vector3().setFromMatrixPosition(ghost.matrix).toArray().map(Math.round), scale: ghostFill.scale.toArray().map(Math.round) } : null };
    },
  };
}
