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

  let targets = [];        // { mesh, xray, edges, pieces }

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
      for (const material of [target.mesh.material, target.xray.material, target.edges.material]) {
        material.clippingPlanes = active ? [plane] : [];
        material.needsUpdate = true;
      }
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
          + ' · drag or ↑↓ to move, ⇥ to flip');
  }

  return {
    /// The pieces to cut, and the extent to slide within.
    setTargets(parts, bounds) {
      targets = parts.map((p) => ({
        mesh: p.mesh, xray: p.xray, edges: p.edges,
        colour: new THREE.Color(p.rgba[0], p.rgba[1], p.rgba[2]),
      }));
      state.bounds = bounds;
      buildCaps();
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

    /// Puts the plane on the face under the cursor, snapped to the nearest model axis — the
    /// quickest way in, and every cut worth making in furniture is axis-aligned anyway.
    setFromNormal(worldNormal) {
      const n = worldToModelVector(worldNormal);
      const axis = ['x', 'y', 'z'].reduce((best, k) =>
        Math.abs(n[k]) > Math.abs(n[best]) ? k : best, 'x');
      this.setAxis(axis);
    },

    start() { state.stage = 'plane'; report(); },

    stop() {
      state.stage = 'off';
      state.axis = null;
      state.flipped = false;
      updatePlane();
    },

    get stage() { return state.stage; },
    get debug() {
      return { ...state, capChildren: capGroup.children.length, capVisible: capGroup.visible };
    },
  };
}
