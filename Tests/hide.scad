// Hiding a piece whose face is welded to its neighbours'.
//
// A bottom board, a back panel and a top board, flush at the rear the way a "board on board"
// carcass is. The union welds their three rear faces into one rectangle spanning all three
// pieces, so a triangle of it lies wholly inside no piece's box. Hiding used to drop only
// whole triangles, so with the whole group hidden that rectangle stayed behind as a grey plane
// belonging to nothing. Hiding must cut each piece's box out of such triangles instead.
//
// Written in the one-line form: `// @group X   @name Y` names the piece under it and says
// which group it belongs to, without opening a block.

hr = 15;

// @group Unit   @name Bottom
cube([400, 400, hr]);
// @group Unit   @name Back
translate([0, 400 - hr, hr]) cube([400, hr, 700 - 2*hr]);
// @group Unit   @name Top
translate([0, 0, 700 - hr]) cube([400, 400, hr]);

// A board of another group, flush with the unit's right side: hiding the unit must leave it
// whole, and hiding it must leave the unit whole.
// @group Neighbour   @name Side board
translate([400, 0, 0]) cube([hr, 400, 700]);

// A block of another colour standing on the top board. Different colours are different
// meshes, so the top board's upper face runs on under the block and the block's underside lies
// on it, face to face in the same plane. Hiding the block must leave that face whole, and
// hiding the unit must leave the block's underside: a face on a hidden piece's boundary that
// looks into the piece is the neighbour's, not the piece's.
// @group Neighbour   @name Red block
color("red") translate([100, 100, 700]) cube([200, 200, 100]);
