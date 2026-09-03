// Two boards flush in one plane, and a panel passing through a groove.
//
// The union welds the side faces of the two boards into one 800 mm polygon, and a triangle of
// that polygon can span both boards. Each board's face must still claim its own part of it and
// report its own height. The panel's end lies in the plane of the wall's end, inside the groove:
// that region is not the wall's material, so the wall's end face must not claim it.

// @group Flush
    // @name Lower board
    cube([100, 20, 300]);
    // @name Upper board
    translate([0, 0, 300]) cube([100, 20, 500]);
// @endgroup

// @group Groove
    // @name Wall
    translate([200, 0, 0]) difference() {
        cube([300, 15, 200]);
        translate([-1, 10, 50]) cube([302, 6, 6]);   // groove along the wall, open at both ends
    }
    // @name Panel
    color("tan") translate([200, 10.5, 50.5]) cube([300, 100, 5]);
// @endgroup
