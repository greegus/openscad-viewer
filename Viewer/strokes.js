import * as THREE from 'three';
import { LineSegments2 } from './vendor/lines/LineSegments2.js';
import { LineSegmentsGeometry } from './vendor/lines/LineSegmentsGeometry.js';
import { LineMaterial } from './vendor/lines/LineMaterial.js';

/// Highlight strokes: a 2 px coloured line with a 1 px white outline around it.
///
/// This needs three.js "fat lines" rather than LineBasicMaterial: WebGL ignores `linewidth`
/// and always draws 1 px, so thickness has to be built from screen-space quads. The outline
/// is the same geometry drawn underneath, two pixels wider — one pixel proud on each side.

const materials = new Set();

/// LineMaterial converts world units to pixels itself, so it has to know the canvas size.
/// The last size is remembered because strokes are created lazily, after the first resize:
/// a material left at the default (1, 1) draws a 2 px line across the whole viewport.
const resolution = new THREE.Vector2(1, 1);

export function updateStrokeResolution(width, height) {
  resolution.set(width, height);
  for (const m of materials) m.resolution.copy(resolution);
}

function lineMaterial(options) {
  const material = new LineMaterial({ depthTest: false, transparent: true, ...options });
  material.resolution.copy(resolution);
  materials.add(material);
  return material;
}

export function createStroke({ scene, color, width = 2, outline = 1, renderOrder = 20 }) {
  const geometry = new LineSegmentsGeometry();

  const halo = new LineSegments2(geometry, lineMaterial({
    color: 0xffffff, linewidth: width + outline * 2, opacity: 0.9,
  }));
  const core = new LineSegments2(geometry, lineMaterial({ color, linewidth: width }));

  halo.renderOrder = renderOrder;
  core.renderOrder = renderOrder + 1;   // the outline sits under the stroke
  halo.visible = false;
  core.visible = false;
  scene.add(halo, core);

  return {
    /// `points` is a flat list of segment endpoints: [a, b, a, b, …]
    setPoints(points) {
      const flat = [];
      for (const p of points) flat.push(p.x, p.y, p.z);
      geometry.setPositions(flat);
      // Fat lines are instanced; without this the bounds stay empty and it can be culled.
      geometry.computeBoundingSphere();
      halo.visible = true;
      core.visible = true;
    },
    set visible(on) { halo.visible = on; core.visible = on; },
    /// Diagnostic: how many segments are actually in the buffer.
    get segmentCount() { return geometry.attributes.instanceStart?.count ?? 0; },
    get visible() { return core.visible; },
    setColor(value) { core.material.color.set(value); },
  };
}
