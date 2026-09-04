// Every kind of solid the reader knows, side by side: a cube, a wedge (polyhedron), a ball
// (sphere), and the solids of revolution — a cone, a frustum, a tube, a countersunk hole.
//
// The wedge and the ball once had no outline the CSG reader could describe, and a piece it could
// not describe used to vanish: absent from the parts list, unpickable, and — since names are
// matched to geometry by order — shifting every name after it by one. The wedge now states its
// faces and edges, the ball is one spherical face drawn by its silhouette, and a cylinder with
// two radii or a rotate_extrude is the revolution of a profile: each straight run one face, the
// rims between them the edges, a cone's grazing lines following the camera.

// @group Test
    // @name Cube
    cube([40, 40, 40]);
    // @name Wedge
    translate([60, 0, 0])
        polyhedron(points = [[0,0,0], [40,0,0], [40,40,0], [0,40,0], [0,0,30], [0,40,30]],
                   faces = [[0,1,2,3], [0,3,5,4], [1,0,4], [2,1,4,5], [3,2,5]]);
    // @name Ball
    translate([20, 80, 20]) sphere(r = 20, $fn = 48);
    // @name Second cube
    translate([60, 80, 0]) cube([40, 40, 20]);
// @endgroup

$fn = 48;

// @group Revolved
    // @name Cone
    translate([0, 200, 0]) cylinder(h = 50, r1 = 30, r2 = 0);
    // @name Frustum
    translate([80, 200, 0]) cylinder(h = 40, r1 = 30, r2 = 10);
    // @name Tube
    translate([160, 200, 0]) rotate_extrude() translate([20, 0]) square([10, 30]);
    // @name Countersunk board
    translate([0, 280, 0]) difference() {
        cube([100, 60, 15]);
        translate([50, 30, 5]) cylinder(h = 11, r1 = 4, r2 = 12);
    }
    // @name Ring
    translate([160, 280, 0]) rotate_extrude() translate([30, 0]) circle(10);
    // @name Knob
    translate([240, 200, 0]) rotate_extrude() hull() { square([30, 20]); translate([20, 20]) circle(10); }
    // @name Quarter ring
    translate([240, 280, 0]) rotate_extrude(angle = 90) translate([20, 0]) square([10, 30]);
// @endgroup
