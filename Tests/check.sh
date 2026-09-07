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
expect "grazing lines in the two holes" "$(echo "$out" | field "['silhouetteLines']")" "4"

echo "Tests/polyhedron.scad"
out=$(Tests/probe.sh Tests/polyhedron.scad Tests/probes/polyhedron.js) || { echo "  probe failed: $out"; exit 1; }
expect "names in order"  "$(echo "$out" | field "['names']")" '["Cube", "Wedge", "Ball", "Second cube", "Cone", "Frustum", "Tube", "Countersunk board", "Ring", "Knob", "Quarter ring"]'
expect "wedge"           "$(echo "$out" | field "['wedge']")" '{"claimed": "8/8", "edges": 9, "faces": 5}'
expect "ball"            "$(echo "$out" | field "['ball']")" '{"claimed": "2300/2292", "faces": ["sphere:2300/r20"], "silhouetteRadius": 20, "silhouetteSegments": 96, "staticEdges": 0}'
expect "every triangle of the revolved solids claimed" "$(echo "$out" | field "['revolvedCoverage']")" '["94/94", "188/188", "384/384", "300/300", "4608/4608", "1726/1726", "100/100"]'
expect "ring: one torus, no rim, a silhouette" "$(echo "$out" | field "['ring']")" '{"faces": ["torus:round"], "rimSegments": 0, "silhouetteSegments": true}'
expect "knob: bottom, side, rounded edge, dish" "$(echo "$out" | field "['knob']")" '{"faces": ["plane:bottom", "cylinder:side", "torus:round", "cone:cone"], "rimSegments": 144}'
expect "quarter ring: two flat ends, arcs and profile edges" "$(echo "$out" | field "['quarter']")" '{"faces": ["plane:end", "plane:end", "plane:bottom", "cylinder:side", "plane:top", "cylinder:bore"], "rimSegments": 56, "silhouetteSegments": 2}'
expect "cone"    "$(echo "$out" | field "['cone']")"    '{"faces": ["plane:bottom", "cone:cone"], "rimSegments": 48, "silhouetteLines": 2}'
expect "frustum" "$(echo "$out" | field "['frustum']")" '{"faces": ["plane:bottom", "cone:cone", "plane:top"], "rimSegments": 96, "silhouetteLines": 2}'
expect "tube"    "$(echo "$out" | field "['tube']")"    '{"faces": ["plane:bottom", "cylinder:side", "plane:top", "cylinder:bore"], "rimSegments": 192, "silhouetteLines": 4}'
expect "countersunk board rims" "$(echo "$out" | field "['boardRimSegments']")" "108"
expect "measure board top to cube top"    "$(echo "$out" | field "['measured']['faces']")" "Parallel faces · distance 25.0 mm"
expect "measure corner to corner"          "$(echo "$out" | field "['measured']['vertices']")" "Vertex to vertex · distance 102.0 mm"
expect "measure rim centre to rim centre"  "$(echo "$out" | field "['measured']['centres']")" "Centre to centre · distance 80.6 mm"
expect "measure corner to face"            "$(echo "$out" | field "['measured']['vertexFace']")" "Vertex to face · distance 25.0 mm"
expect "axis dots on the cube's dimensions" "$(echo "$out" | field "['dots']['piece']")" "Dimensions [x]40 × [y]40 × [z]40 mm Volume 0.06 dm³ Corner [x]0 [y]0 [z]0 mm"
expect "the cube's top faces Z, in the model's axes" "$(echo "$out" | field "['dots']['face']")" "Size [x]40 × [y]40 mm Area 16.0 cm² Facing Z"
expect "an edge names its ends, with axis dots" "$(echo "$out" | field "['dots']['edge']")" "Length 40 mm Along X Start [x]0 [y]0 [z]40 mm End [x]40 [y]0 [z]40 mm"
expect "the panel is hidden over empty space" "$(echo "$out" | field "['dots']['emptyHidden']")" "true"

echo "Tests/flush.scad"
out=$(Tests/probe.sh Tests/flush.scad Tests/probes/flush.js) || { echo "  probe failed: $out"; exit 1; }
expect "names in order"         "$(echo "$out" | field "['names']")"           '["Lower board", "Upper board", "Wall", "Panel"]'
expect "welded side claimed by both" "$(echo "$out" | field "['sideClaims']")" '[true, true]'
expect "upper board front reads its own size" "$(echo "$out" | field "['upperFrontSize']")" "100 × 500 mm"
expect "every piece fully covered" "$(echo "$out" | field "['coverage']")"     '["#1 full", "#2 full", "#3 full", "#4 full"]'
expect "wall ends without the panel" "$(echo "$out" | field "['wallEndTriangles']")" "[6, 6]"
expect "lower board's covered top is still a face" "$(echo "$out" | field "['lowerTopPatch']")" "2000"
expect "pieces in several meshes" "$(echo "$out" | field "['inSeveralMeshes']")" "0"

echo "Tests/hide.scad"
out=$(Tests/probe.sh Tests/hide.scad Tests/probes/hide.js) || { echo "  probe failed: $out"; exit 1; }
expect "one-line @group/@name form: names"  "$(echo "$out" | field "['names']")"  '["Bottom", "Back", "Top", "Side board"]'
expect "one-line @group/@name form: groups" "$(echo "$out" | field "['groups']")" '["Unit", "Unit", "Unit", "Neighbour"]'
expect "welded rear plane present before hiding" "$(echo "$out" | field "['rearBefore']")" "true"
expect "unit hidden: nothing left, rear plane gone, neighbour intact" "$(echo "$out" | field "['unitHidden']")" '{"leftInUnit": 0, "rearPlane": 0, "sideIntact": true}'
expect "back alone hidden: boards keep their strips of the welded face" "$(echo "$out" | field "['backHidden']")" '{"bottomRearStrip": true, "leftInBack": 0, "topRearStrip": true}'
expect "neighbour hidden: unit's rear untouched" "$(echo "$out" | field "['sideHidden']")" '{"leftOnSideFace": 0, "unitRearIntact": true}'
expect "restore brings every triangle back" "$(echo "$out" | field "['restored']")" "true"

echo "Tests/demo.scad"
out=$(Tests/probe.sh Tests/demo.scad Tests/probes/demo.js) || { echo "  probe failed: $out"; exit 1; }
expect "names in order" "$(echo "$out" | field "['names']")" '["Corpus: Left side", "Corpus: Right side", "Corpus: Bottom", "Corpus: Top", "Corpus: Back panel", "Shelves: Lower shelf", "Shelves: Upper shelf", "Door: Door"]'
expect "every piece covered by its faces" "$(echo "$out" | field "['covered']")" "true"
expect "shelf pitch"     "$(echo "$out" | field "['pitch']")" "Parallel faces · distance 305.0 mm"
expect "section by clicking a face" "$(echo "$out" | field "['section']")" "ready z=300 keeping - caps=true ghost=300,300,-190/678x445"
expect "view cube: click TOP, drag, home" "$(echo "$out" | field "['cube']")" '{"afterClick": "top 0,0,1", "afterDrag": null, "home": "0.54,-0.73,0.41", "topRegion": [0, 0, 1]}'
expect "pills follow state; home animates to the opening framing" "$(echo "$out" | field "['pills']")" '{"animating": true, "home": "0.54,-0.73,0.41", "start": "normal isometric", "switched": "xray perspective xray perspective"}'
expect "keys: tools, parts list, list cursor" "$(echo "$out" | field "['keys']")" "measure section inspect h:0.54,-0.73,0.41 p:0 Right side lit #2 enter:#2 folded:5 dblclick:part #7 shift:top,0,0,1 xray"
expect "palette: xray, parallel, home" "$(echo "$out" | field "['palette']")" "Mode X-ray view / View Orthographic projection / View Home view H"
expect "shelves and bottom resting on the side patch it" "$(echo "$out" | field "['shelfPatches']")" "20160"

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
