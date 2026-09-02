// A wedge as a polyhedron beside a cube, plus a sphere.
//
// None of these has an outline the CSG reader can describe, and a piece it cannot describe used
// to vanish: absent from the parts list, unpickable, and — since names are matched to geometry
// by order — shifting every name after it by one. Each is now a piece bounded by its box and
// marked approximate, so the list stays complete and the names stay on the right pieces.

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
