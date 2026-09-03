#!/bin/bash
# The viewer's regression checks, measured in the real viewer rather than eyeballed.
#     Tests/check.sh            # the test files in Tests/
#     Tests/check.sh design.scad  # plus a design of your own: coverage, names, arcs
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
expect() {   # expect <label> <actual> <wanted>
  if [ "$2" = "$3" ]; then echo "  ok   $1 = $2"; else echo "  FAIL $1 = $2 (wanted $3)"; fail=1; fi
}
field() { python3 -c "import json,sys; d=json.load(sys.stdin)$1; print(d if isinstance(d,str) else json.dumps(d, sort_keys=True))"; }

echo "Tests/cylinder.scad"
out=$(Tests/probe.sh Tests/cylinder.scad Tests/probes/cylinder.js) || { echo "  probe failed: $out"; exit 1; }
expect "triangles claimed by faces" "$(echo "$out" | field "['trianglesClaimed']")" "1152/1152"
expect "full circles r=50"          "$(echo "$out" | field "['circles']")"          "4"
expect "ellipses"                   "$(echo "$out" | field "['ellipses']")"         '["70.7x50/96", "70.7x50/96"]'
expect "hover/select overlap"       "$(echo "$out" | field "['highlightOverlap']")" "1"

echo "Tests/polyhedron.scad"
out=$(Tests/probe.sh Tests/polyhedron.scad Tests/probes/polyhedron.js) || { echo "  probe failed: $out"; exit 1; }
expect "names in order"  "$(echo "$out" | field "['names']")" '["Cube", "Wedge", "Ball", "Second cube"]'
expect "wedge"           "$(echo "$out" | field "['wedge']")" '{"claimed": "8/8", "edges": 9, "faces": 5}'
expect "ball"            "$(echo "$out" | field "['ball']")" '{"claimed": "2300/2300", "faces": ["sphere:2300/r20"], "silhouetteRadius": 20, "silhouetteSegments": 96, "staticEdges": 0}'

echo "Tests/flush.scad"
out=$(Tests/probe.sh Tests/flush.scad Tests/probes/flush.js) || { echo "  probe failed: $out"; exit 1; }
expect "names in order"         "$(echo "$out" | field "['names']")"           '["Lower board", "Upper board", "Wall", "Panel"]'
expect "welded side claimed by both" "$(echo "$out" | field "['sideClaims']")" '[true, true]'
expect "upper board front reads its own size" "$(echo "$out" | field "['upperFrontSize']")" "100 × 500 mm"
expect "every piece fully covered" "$(echo "$out" | field "['coverage']")"     '["#1 full", "#2 full", "#3 full", "#4 full"]'
expect "wall ends without the panel" "$(echo "$out" | field "['wallEndTriangles']")" "[6, 6]"
expect "lower board's covered top is still a face" "$(echo "$out" | field "['lowerTopPatch']")" "2000"
expect "pieces in several meshes" "$(echo "$out" | field "['inSeveralMeshes']")" "0"

echo "Tests/cone.scad"
out=$(Tests/probe.sh Tests/cone.scad Tests/probes/cone.js) || { echo "  probe failed: $out"; exit 1; }
expect "names in order"  "$(echo "$out" | field "['names']")"    '["Cone", "Frustum", "Tube", "Countersunk board"]'
expect "every triangle claimed" "$(echo "$out" | field "['coverage']")" '["94/94", "188/188", "384/384", "300/300"]'
expect "cone"    "$(echo "$out" | field "['cone']")"    '{"faces": ["plane:bottom", "cone:cone"], "rimSegments": 48, "silhouetteLines": 2}'
expect "frustum" "$(echo "$out" | field "['frustum']")" '{"faces": ["plane:bottom", "cone:cone", "plane:top"], "rimSegments": 96, "silhouetteLines": 2}'
expect "tube"    "$(echo "$out" | field "['tube']")"    '{"faces": ["plane:bottom", "cylinder:side", "plane:top", "cylinder:bore"], "rimSegments": 192, "silhouetteLines": 0}'
expect "countersunk board" "$(echo "$out" | field "['board']['rimSegments']")" "108"
expect "measure board top to frustum top" "$(echo "$out" | field "['measured']")" "Parallel faces · distance 25.0 mm"

if [ $# -ge 1 ]; then
  echo "$1"
  cat > build/design-probe.js <<'JS'
const rows = window.debug.pieceCoverage();
const arcs = window.debug.arcs();
const c = window.debug.components();
return {
  pieces: rows.length,
  withoutFaces: rows.filter((r) => !r.faces).length,
  inSeveralMeshes: rows.filter((r) => r.meshes > 1).length,
  named: c.filter((x) => x.name).length,
  radii: [...new Set(arcs.map((a) => a.radius))].sort((a, b) => a - b),
  bentLines: window.debug.features().filter((f) => f.type === 'line' && f.segments > 1).length,
};
JS
  out=$(Tests/probe.sh "$1" build/design-probe.js) || { echo "  probe failed: $out"; exit 1; }
  echo "  $out"
  expect "pieces without faces"     "$(echo "$out" | field "['withoutFaces']")"    "0"
  expect "pieces in several meshes" "$(echo "$out" | field "['inSeveralMeshes']")" "0"
  expect "bent lines"               "$(echo "$out" | field "['bentLines']")"       "0"
fi

[ $fail = 0 ] && echo "all checks passed" || { echo "CHECKS FAILED"; exit 1; }
