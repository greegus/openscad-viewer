import * as THREE from 'three';
import { orientToWorld } from './picking.js';

/// Ground grid and axes, drawn on the model's z = 0 plane.
///
/// Procedural rather than a GridHelper: the lines are computed in the fragment shader, so
/// they stay one pixel wide at any zoom, antialias themselves through `fwidth`, and — the
/// point of it — can fade out radially from the origin instead of ending in a hard edge.
export function createGrid({ scene }) {

  const uniforms = {
    fine:     { value: 100 },     // mm
    coarse:   { value: 1000 },
    inner:    { value: 1000 },    // fully visible up to here
    outer:    { value: 3000 },    // gone by here
    lineColor:{ value: new THREE.Color(0x8a8f98) },
    axisX:    { value: new THREE.Color(0xd9544d) },
    axisY:    { value: new THREE.Color(0x4c9a52) },
    strength: { value: 0.5 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      uniform float fine, coarse, inner, outer, strength;
      uniform vec3 lineColor, axisX, axisY;
      varying vec3 vWorld;

      // Coverage of a grid of the given pitch, one pixel wide whatever the zoom.
      float grid(vec2 p, float pitch) {
        vec2 c = p / pitch;
        vec2 d = abs(fract(c - 0.5) - 0.5) / fwidth(c);
        return 1.0 - min(min(d.x, d.y), 1.0);
      }

      float axis(float v, float scale) {
        return 1.0 - min(abs(v) / (fwidth(v) * scale), 1.0);
      }

      void main() {
        vec2 p = vWorld.xz;
        float fadeOut = 1.0 - smoothstep(inner, outer, length(p));
        if (fadeOut <= 0.0) discard;

        float lines = max(grid(p, fine) * 0.45, grid(p, coarse) * 0.9);

        // three.js X is the model's X; three.js Z is the model's −Y.
        float ax = axis(p.y, 1.5);
        float ay = axis(p.x, 1.5);

        vec3 color = lineColor;
        float alpha = lines;
        if (ay > 0.0) { color = axisX; alpha = max(alpha, ay); }
        if (ax > 0.0) { color = axisY; alpha = max(alpha, ax); }

        gl_FragColor = vec4(color, alpha * fadeOut * strength);
        if (gl_FragColor.a < 0.003) discard;
      }`,
  });

  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  orientToWorld(plane);                // model z = 0 becomes the ground plane
  plane.renderOrder = -1;              // behind everything else
  plane.position.y = -0.2;             // a hair below the model's own floor, no z-fighting
  scene.add(plane);

  // The vertical axis cannot live on the ground plane, so it gets its own line.
  const vertical = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]),
    new THREE.LineBasicMaterial({ color: 0x4a86c8, transparent: true, opacity: 0.35, depthWrite: false }));
  scene.add(vertical);

  return {
    /// Sizes the grid to the model: fully visible around it, gone a bit further out.
    fitTo(radius) {
      const inner = Math.max(radius * 0.9, 200);
      const outer = inner * 3;
      uniforms.inner.value = inner;
      uniforms.outer.value = outer;
      plane.scale.set(outer * 2.1, outer * 2.1, 1);
      vertical.scale.set(1, inner * 0.8, 1);
    },
    set visible(on) { plane.visible = on; vertical.visible = on; },
    get visible() { return plane.visible; },
  };
}
