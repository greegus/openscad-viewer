// Tests/polyhedron.scad: cube, wedge (polyhedron), ball (sphere), cube — four pieces, in order.
const c = window.debug.components();
const cov = window.debug.pieceCoverage();
return {
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
