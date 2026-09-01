// Two perpendicular cylindrical cuts through a cube.
//
// A deliberate stress test for the CSG reader: cuts here are cylinders, not boxes, and the
// resulting surfaces are curved, so there is no crease along them and nothing for an
// angle-threshold edge rule to find. The radius equals half the side, so each cylinder just
// touches all four walls it passes between.

$fn = 96;

side = 100;
r    = side / 2;
over = 2;          // so the cuts pass cleanly through, leaving no skin

// @group Cube
    // @name Drilled cube
    difference() {
        cube([side, side, side]);

        // Vertical, through the centre.
        translate([side / 2, side / 2, -over / 2])
            cylinder(h = side + over, r = r);

        // Horizontal, perpendicular to the first, through the centre.
        translate([side / 2, -over / 2, side / 2])
            rotate([-90, 0, 0])
                cylinder(h = side + over, r = r);
    }
// @endgroup
