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
  // The ghost: aimed low at the model, the pointer meets the door's front (over the cap there
  // is no ghost — the cap is the cut itself), so the sheet stands in the door's plane, the
  // model's size across.
  const gp = window.debug.worldToScreen([150, 18, -100]);
  canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + gp[0], clientY: rect.top + gp[1], bubbles: true, pointerId: 1 }));
  window.debug.snapshot();
  const g = window.debug.section().ghost;
  // The handle: dragging it up on screen slides the plane up the z axis; the flip button swaps
  // the kept side.
  const h = window.debug.worldToScreen(window.debug.section().gizmo);
  for (const [t, dy] of [['pointerdown', 0], ['pointermove', -60], ['pointerup', -60]]) {
    canvas.dispatchEvent(new PointerEvent(t, { clientX: rect.left + h[0], clientY: rect.top + h[1] + dy, bubbles: true, pointerId: 1 }));
  }
  const dragged = Math.round(window.debug.section().offset);
  document.querySelector('.section-flip:not(.section-ghost)').click();
  const flipped = window.debug.section().flipped;
  // The other button shows the cut-away half as a ghost; off again, the x-ray meshes go back to the mode.
  document.querySelector('.section-ghost').click();
  const ghostHalf = window.debug.section().ghostHalf && window.debug.state().parts[0].xray === true;
  document.querySelector('.section-ghost').click();
  const restored = window.debug.state().parts[0].xray === false;
  // The cut outlives the tool: in Inspect it is still there, and the cut-away half is out of
  // reach — flipped, the kept side is above the plane, and hovering the bottom board's front
  // finds nothing. Back in Section, Escape takes the cut back and keeps the tool; a second
  // Escape leaves it.
  const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  key('v');
  const kept = window.debug.section().stage;
  const tp = window.debug.worldToScreen([300, 9, 0]);
  canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + tp[0], clientY: rect.top + tp[1], bubbles: true, pointerId: 1 }));
  window.debug.snapshot();
  const overCutAway = window.debug.inspect().hoverPiece;
  key('s');
  key('Escape'); const afterEscape = `${window.debug.state().tool}/${window.debug.section().stage}`;
  key('Escape'); const afterSecond = window.debug.state().tool;
  return `${d.stage} ${d.axis}=${Math.round(d.offset)} keeping ${d.flipped ? '-' : '+'} caps=${d.capVisible} ghost=${g ? g.position.join(',') + '/' + g.scale.slice(0, 2).join('x') : 'none'} dragged=${dragged > d.offset} flipped=${flipped} ghostHalf=${ghostHalf}/${restored} inspect:${kept}/${overCutAway} esc:${afterEscape}/${afterSecond}`;
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
// Keys: V/M/S pick a tool, Escape leaves it for Inspect, P hides the parts list; arrows walk
// the list with the row's pieces lit in the scene, Enter selects, Left folds a group.
const keys = (() => {
  const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const tool = () => window.debug.state().tool;
  key('m'); const m = tool(); key('s'); const s = tool(); key('Escape'); const esc = tool();
  setView('top'); key('h'); window.debug.settleCamera(); window.debug.snapshot(); const h = window.debug.cameraDirection().join(',');
  key('p'); const hidden = document.querySelectorAll('#parts-tree .tree-row').length; key('p');   // folded: the header alone, no rows
  key('ArrowDown'); key('ArrowDown'); key('ArrowDown'); window.debug.snapshot();
  const cursor = `${document.querySelector('.tree-row.is-cursor .tree-name')?.textContent} lit #${window.debug.inspect().hoverPiece}`;
  key('Enter'); const selected = window.debug.inspect().selectPiece;
  key('ArrowLeft'); key('ArrowLeft'); const folded = document.querySelectorAll('.tree-row').length;
  key('ArrowRight'); key('Escape'); key('Escape');
  // A double click on the upper shelf's top selects the whole shelf.
  setTool('inspect'); window.debug.snapshot();
  const px = window.debug.worldToScreen([300, 605, -200]);
  canvas.dispatchEvent(new PointerEvent('dblclick', { clientX: rect.left + px[0], clientY: rect.top + px[1], bubbles: true, pointerId: 1 }));
  const dbl = `${window.debug.inspect().selectType} #${window.debug.inspect().selectPiece}`;
  key('Escape');
  // Shift + T turns to the top view; Shift + X switches to x-ray and back.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', shiftKey: true, bubbles: true }));
  window.debug.settleCamera(); window.debug.snapshot();
  const shift = `${window.debug.state().activeView},${window.debug.cameraDirection()}`;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', shiftKey: true, bubbles: true }));
  const xray = window.debug.state().mode;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', shiftKey: true, bubbles: true }));
  setView('3d');
  return `${m} ${s} ${esc} h:${h} p:${hidden} ${cursor} enter:#${selected} folded:${folded} dblclick:${dbl} shift:${shift} ${xray}`;
})();
// The palette finds X-ray by "xray", the orthographic projection by "parallel", and has Home.
const palette = (() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  const input = document.querySelector('.palette-input');
  const first = (text) => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); return document.querySelector('.palette-row')?.textContent.replace(/\s+/g, ' ').trim() ?? ''; };
  const r = [first('xray'), first('parallel'), first('home')].join(' / ');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return r;
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
  keys,
  palette,
  // The left side's inner face is whole although two shelves rest on it: the mesh has holes
  // there, the face has patches: 2 shelves × 18 × 360 and the bottom × 18 × 400.
  shelfPatches: (window.debug.patches(1) || []).filter((p) => p.normal[0] === 1).reduce((n, p) => n + p.area, 0),
};
