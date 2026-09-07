// Tests/polyhedron.scad: cube, wedge (polyhedron), ball (sphere), cube — four pieces, in order.
const c = window.debug.components();
const cov = window.debug.pieceCoverage();
// The solids of revolution: faces per piece, rim segments, grazing lines.
const faces = (id) => window.debug.facesOf(id).filter((f) => f.triangles).map((f) => f.kind + ':' + f.label);
const rims = (id) => window.debug.pieceOutline(id).length / 6;
const sil = (id) => window.debug.silhouette(id)?.segments ?? 0;
// Measure two parallel faces: the board's top and the frustum's top, 25 mm apart.
const measured = (() => {
  setTool('measure'); window.debug.snapshot();
  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const click = (m) => {
    const px = window.debug.worldToScreen([m[0], m[2], -m[1]]);
    if (!px) return 'off screen';
    for (const t of ['pointermove', 'pointerdown', 'pointerup']) {
      canvas.dispatchEvent(new PointerEvent(t, { clientX: rect.left + px[0], clientY: rect.top + px[1], bubbles: true, pointerId: 1 }));
    }
    window.debug.snapshot();
    return document.getElementById('readout').innerText.replace(/\s+/g, ' ').trim();
  };
  const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  // The board's top and the cube's top, 25 mm apart (the frustum's top is too small a target
  // at this zoom: its rim lies within the edge snap of its centre).
  click([25, 310, 15]);
  const faces = click([20, 20, 40]);
  esc();
  // Two corners: (40, 0, 40) of the cube and (100, 80, 20) of the second — √(60² + 80² + 20²).
  click([40, 0, 40]);
  const vertices = click([100, 80, 20]);
  esc();
  // Two rims stand for their centres: the tube's (160, 200, 30) and the frustum's (80, 200, 40).
  click([160, 170, 30]);
  const centres = click([80, 190, 40]);
  esc();
  // A corner to a face: the cube's top corner above the board's top, 40 − 15.
  click([40, 0, 40]);
  const vertexFace = click([25, 310, 15]);
  setTool('inspect');
  return { faces, vertices, centres, vertexFace };
})();
// The panel's dimensions carry an axis dot per number, in the model's axes; a face says which
// axis it faces in the same terms (the cube's top faces Z, not the scene's Y).
const dots = (() => {
  setTool('inspect'); setView('3d'); window.debug.snapshot();
  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const hover = (m, meta) => {
    const px = window.debug.worldToScreen([m[0], m[2], -m[1]]);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + px[0], clientY: rect.top + px[1], metaKey: meta, bubbles: true, pointerId: 1 }));
    window.debug.snapshot();
    return [...document.querySelectorAll('.readout-table span')].map((s) => s.innerHTML.replace(/<span class="axis-dot axis-(.)"><\/span>/g, '[$1]')).filter(Boolean).join(' ');
  };
  const piece = hover([20, 20, 40], true), face = hover([20, 20, 40], false);
  // An edge names its ends; over empty space the panel is not shown at all.
  const edge = hover([20, 0, 40], false);
  const px = window.debug.worldToScreen([-60, 60, 60]);
  canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 5, clientY: rect.top + 5, bubbles: true, pointerId: 1 }));
  window.debug.snapshot();
  const emptyHidden = getComputedStyle(document.getElementById('readout')).display === 'none';
  return { piece, face, edge, emptyHidden };
})();
return {
  dots,
  revolvedCoverage: cov.slice(4).map((r) => `${r.faces}/${r.inside}`),
  cone: { faces: faces(5), rimSegments: rims(5), silhouetteLines: sil(5) },
  frustum: { faces: faces(6), rimSegments: rims(6), silhouetteLines: sil(6) },
  tube: { faces: faces(7), rimSegments: rims(7), silhouetteLines: sil(7) },
  boardRimSegments: rims(8),
  // A plain torus: one face, no rim at all, a silhouette. A knob: its rounded edge is a quarter of a torus.
  ring: { faces: faces(9), rimSegments: rims(9), silhouetteSegments: sil(9) > 0 },
  knob: { faces: faces(10), rimSegments: rims(10) },
  // A quarter turn: the tube's four faces plus two flat ends, arcs for rims and the profile's edges on the ends.
  quarter: { faces: faces(11), rimSegments: rims(11), silhouetteSegments: sil(11) },
  measured,
  names: c.map((x) => x.name),
  wedge: { faces: (c[1].faces || []).length, edges: (c[1].edges || []).length, claimed: `${cov[1].faces}/${cov[1].inside}` },
  // The ball is one spherical face claiming every triangle, with no static edge and a
  // silhouette that follows the camera: a full circle of its radius under an orthographic view.
  ball: (() => {
    const faces = window.debug.facesOf(3);
    const outline = window.debug.pieceOutline(3).length / 6;
    const before = window.debug.silhouette(3);
    return { faces: faces.map((f) => f.kind + ':' + f.triangles + '/r' + f.radius), claimed: `${cov[2].faces}/${cov[2].inside}`,
             staticEdges: outline, silhouetteSegments: before.segments, silhouetteRadius: before.radius };
  })(),
};
