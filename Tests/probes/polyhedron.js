// Tests/polyhedron.scad: cube, wedge (polyhedron), ball (sphere), cube — four pieces, in order.
const c = window.debug.components();
const cov = window.debug.pieceCoverage();
return {
  names: c.map((x) => x.name),
  wedge: { faces: (c[1].faces || []).length, edges: (c[1].edges || []).length, claimed: `${cov[1].faces}/${cov[1].inside}` },
  ballBoundsOnly: c[2].approximate === true,
};
