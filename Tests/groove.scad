// Test fixture: a horizontal board with a groove milled into it with difference().
//
// What it is here to exercise:
//   - the groove is a CSG *subtrahend*, so `Parts` must draw one box (the board), not two;
//     an earlier version outlined cutting tools as if they were pieces
//   - the groove walls are real geometry, so `Edges` must show them
//   - Inspect on the board must report the board's full extent, not the cut shape
//   - two cutters on one piece: the outline must be clipped against both

board_width  = 600;
board_depth  = 300;
board_thick  = 18;

groove_width = 20;
groove_depth = 8;
groove_from_front = 120;   // distance from the front edge to the near side of the groove

// Second groove: in the left end face, running across the board — perpendicular to the
// first one. Shallow (3 mm), so it crosses the first groove without meeting its floor.
edge_groove_width = 6;     // across the board's thickness
edge_groove_depth = 3;     // into the end face

color("BurlyWood")
difference() {
    cube([board_width, board_depth, board_thick]);

    // Through groove along the length of the board, milled into the top face.
    // Overhangs on purpose (-1 / +2) so the cut leaves no zero-thickness skin.
    translate([-1, groove_from_front, board_thick - groove_depth])
        cube([board_width + 2, groove_width, groove_depth + 1]);

    // Groove in the left end face, running the full depth of the board and centred in its
    // thickness. Perpendicular to the first groove and only 3 mm deep, so where the two
    // meet the material between them is what is left of the board.
    translate([-1, -1, (board_thick - edge_groove_width) / 2])
        cube([edge_groove_depth + 1, board_depth + 2, edge_groove_width]);
}

echo(str("board ", board_width, " x ", board_depth, " x ", board_thick, " mm"));
echo(str("groove ", groove_width, " mm wide, ", groove_depth, " mm deep, ",
         groove_from_front, " mm from the front edge"));
echo(str("edge groove ", edge_groove_width, " mm wide, ", edge_groove_depth,
         " mm deep, in the left end face, perpendicular to the first"));
