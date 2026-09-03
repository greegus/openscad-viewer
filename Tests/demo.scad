// A small cabinet to try the viewer on by hand — every measurement here has a known answer.
//
//   Inspect: hover the left side with ⌘ — one whole board, 18 × 400 × 782, no hole where the
//            shelves rest on it. The top sits on the sides with a 20 mm overhang at the front
//            and both ends, and its rounded corner is in the overhang. Hover the back panel: 4 mm, in grooves. Hover the rounded corner
//            of the top: one round face, R 60. Hover a shelf-pin hole: round face, R 2.5.
//   Measure: shelf top to shelf top ....... 305.0 mm   (parallel faces)
//            pin hole to pin hole .......... 32.0 mm    (two rims → centre to centre)
//            inside of side to inside of side  564.0 mm (clear width: 600 − 2·18)
//            top of bottom to underside of top  764.0 mm
//            front corner of a shelf to the side's inside face  0.0 (it rests on it)
//            recess rim centre to the top edge of the door ... 40.0 mm
//   Edges:   the top's rounded corner draws its two verticals (tangents) and, as you orbit, a
//            grazing line that travels round the curve. Pin holes draw two grazing lines each.

$fn = 96;
t = 18;          // board thickness
W = 600; D = 400; H = 800;
over = 20;       // the top's overhang at the front and both ends
back = 4;        // back panel
pitch = 305;     // shelf pitch, top face to top face

module board(size) { cube(size); }

// @group Corpus
    // @name Left side
    difference() {
        board([t, D, H - t]);
        translate([-1, D - 20 - back, t - 9]) cube([t + 2, back, H - 2 * t + 9]);     // groove for the back, up to the top's underside
        // a row of shelf-pin holes, 32 mm system
        for (i = [0 : 5]) translate([t + 1, 60, 200 + 32 * i]) rotate([0, -90, 0]) cylinder(h = 12, r = 2.5);
    }
    // @name Right side
    translate([W - t, 0, 0]) difference() {
        board([t, D, H - t]);
        translate([-1, D - 20 - back, t - 9]) cube([t + 2, back, H - 2 * t + 9]);
        for (i = [0 : 5]) translate([-1, 60, 200 + 32 * i]) rotate([0, 90, 0]) cylinder(h = 12, r = 2.5);
    }
    // @name Bottom
    translate([t, 0, 0]) board([W - 2 * t, D, t]);
    // @name Top
    translate([-over, -over, H - t]) linear_extrude(t)
        hull() {                                   // front-left corner rounded, R 60
            translate([60, 60]) circle(60);
            translate([60, 0]) square([W + 2 * over - 60, D + over]);
            translate([0, 60]) square([W + 2 * over, D + over - 60]);
        }
    // @name Back panel
    color("burlywood") translate([t - 8, D - 20 - back + 0.5, t - 8 + 0.5]) board([W - 2 * t + 16, back - 1, H - 2 * t + 8 - 1]);
// @endgroup

// @group Shelves
    // @name Lower shelf
    translate([t, 20, 300 - t]) board([W - 2 * t, D - 40, t]);
    // @name Upper shelf
    translate([t, 20, 300 - t + pitch]) board([W - 2 * t, D - 40, t]);
// @endgroup

// @group Door
    // @name Door
    color("tan") translate([t + 2, -t, t + 2]) difference() {
        board([W - 2 * t - 4, t, 300 - 2 * t]);
        // a recessed grip 120 wide, rounded ends, 40 mm below the top edge
        // (rotate([90, 0, 0]) sends the extrusion toward −y, so it starts at y = 7 to end 1 mm
        // in front of the face)
        translate([(W - 2 * t - 4) / 2, 7, 300 - 2 * t - 40]) rotate([90, 0, 0])
            linear_extrude(8) hull() { translate([-50, 0]) circle(10); translate([50, 0]) circle(10); }
        // two countersunk screw holes for the hinge side, the countersink at the front
        for (z = [40, 200]) translate([20, t + 1, z]) rotate([90, 0, 0]) cylinder(h = t + 2, r1 = 2, r2 = 6);
    }
// @endgroup
