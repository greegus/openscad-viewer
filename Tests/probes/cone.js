// Tests/cone.scad: cone, frustum, tube, countersunk board.
const c = window.debug.components();
const cov = window.debug.pieceCoverage();
const faces = (id) => window.debug.facesOf(id).filter((f) => f.triangles).map((f) => f.kind + ':' + f.label);
const rims = (id) => window.debug.pieceOutline(id).length / 6;
const sil = (id) => window.debug.silhouette(id)?.segments ?? 0;
return {
  names: c.map((x) => x.name),
  coverage: cov.map((r) => `${r.faces}/${r.inside}`),
  cone: { faces: faces(1), rimSegments: rims(1), silhouetteLines: sil(1) },
  frustum: { faces: faces(2), rimSegments: rims(2), silhouetteLines: sil(2) },
  tube: { faces: faces(3), rimSegments: rims(3), silhouetteLines: sil(3) },
  board: { faces: faces(4), rimSegments: rims(4) },
};
