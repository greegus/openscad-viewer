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
  click([25, 310, 15]);
  const text = click([80, 200, 40]);
  setTool('inspect');
  return text;
})();
return {
  revolvedCoverage: cov.slice(4).map((r) => `${r.faces}/${r.inside}`),
  cone: { faces: faces(5), rimSegments: rims(5), silhouetteLines: sil(5) },
  frustum: { faces: faces(6), rimSegments: rims(6), silhouetteLines: sil(6) },
  tube: { faces: faces(7), rimSegments: rims(7), silhouetteLines: sil(7) },
  boardRimSegments: rims(8),
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
