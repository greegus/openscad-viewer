// Tests/flush.scad: flush boards sharing a welded plane, and a panel in a groove.
const c = window.debug.components();
const cov = window.debug.pieceCoverage();
const byName = (n) => c.find((x) => x.name === n);
// The y = 0 side of each board: how many triangles it claims (the welded polygon spans both).
const side = (id) => window.debug.facesOf(id).find((f) => f.label === 'face' && f.normal && f.normal[2] === 1);
const lower = byName('Lower board'), upper = byName('Upper board'), wall = byName('Wall'), panel = byName('Panel');
// The wall's ends (x min / x max) must not take the panel's ends, which lie in the same planes
// but inside the groove — another material, so another mesh, as in the real design.
const wallEnds = window.debug.facesOf(wall.id).filter((f) => f.label === 'face' && f.normal && Math.abs(f.normal[0]) === 1).map((f) => f.triangles);
// Hover the upper board's front face: it must read as its own 100 × 500, not the welded 800.
const readout = (() => {
  setTool('inspect');
  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const m = [upper.matrix[3] + 50, upper.matrix[7], upper.matrix[11] + 250];        // model, on y = 0
  const px = window.debug.worldToScreen([m[0], m[2], -m[1]]);
  if (!px) return 'off screen';
  canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + px[0], clientY: rect.top + px[1], bubbles: true, pointerId: 1 }));
  window.debug.snapshot();
  // The thin space after an axis letter becomes a plain one here, so the expectation in
  // check.sh can stay ASCII (bash 3.2 has no $'\u2009').
  const text = document.getElementById('readout').innerText.replace(/\u2009/g, ' ');
  return (text.match(/Size\s+([^\n]+)/) || [])[1] ?? text;
})();
// The lower board's top is entirely under the upper board: the mesh has none of it, the face
// is still there, and the contact patch is exactly the board's 100 × 20.
const lowerTopPatch = (window.debug.patches(lower.id) || []).find((p) => p.normal[1] === 1)?.area ?? 0;
// The panel sits in the wall's groove, not on the wall: no patch for it on the wall's inner face.
const wallInnerPatches = (window.debug.patches(wall.id) || []).filter((p) => p.normal[2] === -1).length;
return {
  lowerTopPatch, wallInnerPatches,
  upperFrontSize: readout,
  names: c.map((x) => x.name),
  sideClaims: [side(lower.id).triangles > 0, side(upper.id).triangles > 0],
  coverage: cov.map((r) => `#${r.id} ${r.faces >= r.inside ? 'full' : r.faces + '/' + r.inside}`),
  wallEndTriangles: wallEnds,
  inSeveralMeshes: cov.filter((r) => r.meshes > 1).length,
};
