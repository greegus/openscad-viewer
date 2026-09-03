// Solids of revolution: a cone, a frustum, a tube, and a countersunk hole.
//
// A cylinder with two radii is the revolution of a trapezoid, a rotate_extrude the revolution of
// its outline. Each straight run of the profile is one face — a cylinder, a cone, or an annulus
// — the rims between them are the edges, and a cone's grazing lines follow the camera.

$fn = 48;

// @group Revolved
    // @name Cone
    cylinder(h = 50, r1 = 30, r2 = 0);
    // @name Frustum
    translate([80, 0, 0]) cylinder(h = 40, r1 = 30, r2 = 10);
    // @name Tube
    translate([160, 0, 0]) rotate_extrude() translate([20, 0]) square([10, 30]);
    // @name Countersunk board
    translate([0, 80, 0]) difference() {
        cube([100, 60, 15]);
        translate([50, 30, 5]) cylinder(h = 11, r1 = 4, r2 = 12);
    }
// @endgroup
