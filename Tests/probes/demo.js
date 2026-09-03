// Tests/demo.scad: the cabinet the viewer is tried on by hand — the checks that can be made
// at whole-model zoom. The rest of the numbers in its header are for a person with a mouse.
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
click([300, 200, 300]);                         // lower shelf top
const pitch = click([300, 200, 605]);           // upper shelf top
esc();
setTool('inspect');
const c = window.debug.components();
const cov = window.debug.pieceCoverage();
return {
  names: c.map((x) => `${(x.groups || []).join('/')}: ${x.name}`),
  covered: cov.every((r) => r.faces >= r.inside),
  pitch,
  // The left side's inner face is whole although two shelves rest on it: the mesh has holes
  // there, the face has patches: 2 shelves × 18 × 360 and the bottom × 18 × 400.
  shelfPatches: (window.debug.patches(1) || []).filter((p) => p.normal[0] === 1).reduce((n, p) => n + p.area, 0),
};
