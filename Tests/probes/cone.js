// Tests/cone.scad: cone, frustum, tube, countersunk board.
const c = window.debug.components();
const cov = window.debug.pieceCoverage();
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
  click([25, 110, 15]);
  const text = click([80, 0, 40]);
  setTool('inspect');
  return text;
})();
return {
  measured,
  names: c.map((x) => x.name),
  coverage: cov.map((r) => `${r.faces}/${r.inside}`),
  cone: { faces: faces(1), rimSegments: rims(1), silhouetteLines: sil(1) },
  frustum: { faces: faces(2), rimSegments: rims(2), silhouetteLines: sil(2) },
  tube: { faces: faces(3), rimSegments: rims(3), silhouetteLines: sil(3) },
  board: { faces: faces(4), rimSegments: rims(4) },
};
