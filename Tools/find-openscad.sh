#!/bin/bash
# Prints the OpenSCAD binary the viewer would use, or exits 1. The same order as
# ScadRenderer.locateOpenSCAD() — kept here so install.sh can warn about a missing
# prerequisite without building anything first.
set -uo pipefail

if [ -n "${OPENSCAD_PATH:-}" ] && [ -x "$OPENSCAD_PATH" ]; then echo "$OPENSCAD_PATH"; exit 0; fi

setting=$(defaults read com.greegus.OpenSCADViewer openscadPath 2>/dev/null || true)
if [ -n "$setting" ] && [ -x "$setting" ]; then echo "$setting"; exit 0; fi

for dir in /Applications "$HOME/Applications"; do
  for app in "$dir"/OpenSCAD*.app; do
    case "$app" in *OpenSCADViewer.app) continue;; esac
    [ -x "$app/Contents/MacOS/OpenSCAD" ] && { echo "$app/Contents/MacOS/OpenSCAD"; exit 0; }
  done
done

for p in /opt/homebrew/bin/openscad /usr/local/bin/openscad; do
  [ -x "$p" ] && { echo "$p"; exit 0; }
done

exit 1
