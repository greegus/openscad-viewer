// Tests/hide.scad: hiding pieces whose faces are welded to their neighbours'.
const c = window.debug.components();
const byName = (n) => c.find((x) => x.name === n);
const ids = (...names) => names.map((n) => byName(n).id);
const HR = 15;
// Model-space regions, shrunk 1 mm so a face lying exactly on a region's boundary is not
// mistaken for a neighbour's.
const unit  = [[1, 1, 1], [399, 399, 699]];                // inside the unit's extent
const back  = [[1, 400 - HR + 1, HR + 1], [399, 399, 700 - HR - 1]];
// The side board's outer face, x = 415 — a plane, since a piece's interior has no triangles.
const sideFace = [[400 + HR - 0.01, -1, -1], [400 + HR + 0.01, 401, 701]];
const total = window.debug.triangles();

// The rear plane y = 400 over the unit's width: three flush faces welded into one (and welded
// on to the side board's rear face beyond x = 400, which is why the region stops there).
// Before anything is hidden it is there in full; with the whole unit hidden nothing may remain.
const rear = [[-1, 400 - 0.01, -1], [400 - 0.01, 400 + 0.01, 701]];
// Whole width here: welded, the polygon runs on to x = 415 and no triangle of it stops at 400.
const rearBefore = window.debug.trianglesWithin([-1, 400 - 0.01, -1], [416, 400 + 0.01, 701], 0.02);

window.debug.setHidden(ids('Bottom', 'Back', 'Top'), false);
const unitHidden = {
  leftInUnit: window.debug.trianglesWithin(unit[0], unit[1]),
  rearPlane: window.debug.trianglesWithin(rear[0], rear[1], 0.02),
  sideIntact: window.debug.trianglesWithin(sideFace[0], sideFace[1], 0.02) > 0,
};
window.debug.restore();

// Hiding the back alone: its share of the welded rear face goes, the boards' strips stay.
window.debug.setHidden(ids('Back'), false);
const backHidden = {
  leftInBack: window.debug.trianglesWithin(back[0], back[1]),
  bottomRearStrip: window.debug.trianglesWithin([-1, 400 - 0.01, -1], [401, 400 + 0.01, HR + 0.01], 0.02) > 0,
  topRearStrip: window.debug.trianglesWithin([-1, 400 - 0.01, 700 - HR - 0.01], [401, 400 + 0.01, 701], 0.02) > 0,
  // The bottom board's upper face, z = 15, runs on under the back panel that stood on it. In
  // the union that strip is welded away — neither board has a face where they touch — so the
  // board must come back closed: its whole 400 x 400, not 400 x 385 and a hole.
  bottomTopArea: window.debug.areaWithin([-1, -1, HR - 0.01], [401, 401, HR + 0.01], 0.02),
};
window.debug.restore();

// The neighbour's rear face is welded on to the unit's (same plane y = 400): hiding the side
// board must leave the unit's rear whole, and restoring must bring every triangle back.
window.debug.setHidden(ids('Side board'), false);
const sideHidden = {
  leftOnSideFace: window.debug.trianglesWithin(sideFace[0], sideFace[1], 0.02),
  unitRearIntact: window.debug.trianglesWithin(rear[0], rear[1], 0.02) > 0,
};
window.debug.restore();

// The plane z = 700 holds the top board's upper face (400 x 400) and, in another mesh, the
// red block's underside (200 x 200) lying on it. Areas rather than counts: a face with a hole
// cut in it still has triangles.
// Out to x = 416: the side board's top is welded on to the top board's, so the polygon runs on.
const topPlane = [[-1, -1, 700 - 0.01], [416, 401, 700 + 0.01]];
const topPlaneArea = window.debug.areaWithin(topPlane[0], topPlane[1], 0.02);
window.debug.setHidden(ids('Red block'), false);
const blockHidden = {
  // The board's face it stood on stays whole: 400 x 400.
  planeArea: window.debug.areaWithin(topPlane[0], topPlane[1], 0.02),
  leftInBlock: window.debug.trianglesWithin([101, 101, 701], [299, 299, 799]),
};
window.debug.restore();
window.debug.setHidden(ids('Bottom', 'Back', 'Top'), false);
const unitHiddenUnderBlock = {
  // Only the block's underside may remain in that plane: 200 x 200.
  planeArea: window.debug.areaWithin(topPlane[0], topPlane[1], 0.02),
};
window.debug.restore();

// Delete hides what is selected, and, with the list's cursor on a row, that row instead.
const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key }));
window.debug.selectPiece(byName('Back').id);
press('Backspace');
const deleteKey = { selected: window.debug.hidden().sort(), selectionCleared: window.debug.selection() === null };
window.debug.restore();
press('ArrowDown');                    // the cursor onto the first row: the Unit group
press('Delete');
deleteKey.cursorGroup = window.debug.hidden().sort();
press('Escape');
window.debug.restore();

return {
  solids: window.debug.solids(),
  deleteKey: { selected: deleteKey.selected.join() === ids('Back').join(), selectionCleared: deleteKey.selectionCleared,
               cursorGroup: deleteKey.cursorGroup.join() === ids('Bottom', 'Back', 'Top').sort().join() },
  names: c.map((x) => x.name),
  topPlaneArea, blockHidden, unitHiddenUnderBlock,
  groups: c.map((x) => (x.groups ?? []).join('/')),
  rearBefore: rearBefore > 0,
  unitHidden, backHidden, sideHidden,
  restored: window.debug.triangles() === total,
};
