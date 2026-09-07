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
// Section: a click on the lower shelf's top cuts there, keeping what is below.
const section = (() => {
  setTool('section'); window.debug.snapshot();
  const m = [300, 200, 300];
  const px = window.debug.worldToScreen([m[0], m[2], -m[1]]);
  for (const t of ['pointerdown', 'pointerup']) {
    canvas.dispatchEvent(new PointerEvent(t, { clientX: rect.left + px[0], clientY: rect.top + px[1], bubbles: true, pointerId: 1 }));
  }
  window.debug.snapshot();
  const d = window.debug.section();
  setTool('inspect');
  return `${d.stage} ${d.axis}=${Math.round(d.offset)} keeping ${d.flipped ? '-' : '+'} caps=${d.capVisible}`;
})();
// The view cube: a click on its TOP face aims the camera straight down; a drag on it orbits.
const cube = (() => {
  setView('3d'); window.debug.snapshot();
  const vc = window.debug.viewCube();
  const cx = canvas.clientWidth - vc.margin - vc.size / 2, cy = vc.margin + vc.size / 2;
  const ev = (type, x, y) => new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, pointerId: 1 });
  const topRegion = vc.regionAt(cx, cy - vc.size * 0.35);
  canvas.dispatchEvent(ev('pointerdown', cx, cy - vc.size * 0.35));
  canvas.dispatchEvent(ev('pointerup', cx, cy - vc.size * 0.35));
  window.debug.settleCamera();
  const afterClick = `${window.debug.state().activeView} ${window.debug.cameraDirection()}`;
  canvas.dispatchEvent(ev('pointerdown', cx, cy));
  canvas.dispatchEvent(ev('pointermove', cx + 40, cy));
  canvas.dispatchEvent(ev('pointerup', cx + 40, cy));
  const afterDrag = window.debug.state().activeView;
  // Home: the framing the file opened with, from wherever the camera was.
  document.getElementById('home').click();
  window.debug.settleCamera(); window.debug.snapshot();
  const home = window.debug.cameraDirection().join(',');
  return { topRegion, afterClick, afterDrag, home };
})();
// The display and projection pills under the cube follow the state and drive it; home is
// animated and lands on the framing the file opened with, from any mode and projection.
const pills = (() => {
  const lit = (sel) => [...document.querySelectorAll(sel + ' button.is-on')].map((b) => b.dataset.mode ?? b.dataset.projection).join(',');
  const start = `${lit('#mode-pill')} ${lit('#projection-pill')}`;
  document.querySelector('#mode-pill button[data-mode="xray"]').click();
  document.querySelector('#projection-pill button[data-projection="perspective"]').click();
  const switched = `${lit('#mode-pill')} ${lit('#projection-pill')} ${window.debug.state().mode} ${window.debug.state().projection}`;
  setView('top'); window.debug.snapshot();
  document.getElementById('home').click();
  const animating = window.debug.state().tweening;
  window.debug.settleCamera(); window.debug.snapshot();
  const home = window.debug.cameraDirection().join(',');
  document.querySelector('#mode-pill button[data-mode="normal"]').click();
  document.querySelector('#projection-pill button[data-projection="isometric"]').click();
  return { start, switched, animating, home };
})();
const c = window.debug.components();
const cov = window.debug.pieceCoverage();
return {
  names: c.map((x) => `${(x.groups || []).join('/')}: ${x.name}`),
  covered: cov.every((r) => r.faces >= r.inside),
  pitch,
  section,
  cube,
  pills,
  // The left side's inner face is whole although two shelves rest on it: the mesh has holes
  // there, the face has patches: 2 shelves × 18 × 360 and the bottom × 18 × 400.
  shelfPatches: (window.debug.patches(1) || []).filter((p) => p.normal[0] === 1).reduce((n, p) => n + p.area, 0),
};
