// Tests/cylinder.scad: a cube with two crossing cylindrical cuts.
setTool('inspect');
const cov = window.debug.pieceCoverage()[0];
const arcs = window.debug.arcs();
const ellipses = window.debug.ellipses();
const parity = window.debug.highlightParity(1);
return {
  // Every triangle of the cube belongs to one of its faces: six planes and two cylinders.
  trianglesClaimed: `${cov.faces}/${cov.inside}`,
  // Four rims of r = 50 and the two crossing curves as whole ellipses of 50√2 × 50.
  circles: arcs.filter((a) => Math.abs(a.radius - 50) < 0.1 && a.sweep > 359).length,
  ellipses: ellipses.map((e) => `${e.a}x${e.b}/${e.segments}`),
  // Hover and selection of the whole piece paint the same strokes, pixel for pixel — after
  // the hover stroke has already been used on an edge, as in real use.
  highlightOverlap: parity.overlap,
  // Each hole's wall shows its two grazing lines, clipped to the cube.
  silhouetteLines: window.debug.silhouette(1)?.segments ?? 0,
};
