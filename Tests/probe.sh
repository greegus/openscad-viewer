#!/bin/bash
# Runs a JavaScript probe against a .scad file in the real viewer, headlessly.
#     Tests/probe.sh <file.scad> <probe.js>
# The probe binary is rebuilt when any source it links is newer than it.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=build/probe
SOURCES=(Core/ScadRenderer.swift Core/CSGSplitter.swift Core/Annotations.swift Core/Fingerprint.swift
         Core/Config.swift Core/GeometryProvider.swift ViewerKit/ViewerViewController.swift
         ViewerKit/ScadWebView.swift ViewerKit/WebGLProbe.swift Tests/probe/main.swift)
[ -f Core/Fingerprint.swift ] || ./build.sh >/dev/null
stale=0
for f in "${SOURCES[@]}"; do [ ! -f "$BIN" ] || [ "$f" -nt "$BIN" ] && stale=1; done
if [ "$stale" = 1 ]; then
  mkdir -p build
  swiftc -O -sdk "$(xcrun --show-sdk-path)" -module-name OpenSCADViewer "${SOURCES[@]}" \
    -framework AppKit -framework Quartz -framework WebKit -o "$BIN"
fi
SCAD_WEB_DIR="$PWD/Viewer" "$BIN" "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")" "$2" 2>/dev/null
