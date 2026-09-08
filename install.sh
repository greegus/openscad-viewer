#!/bin/bash
# Installs the app into /Applications and registers the helper LaunchAgent and the QL extensions.
set -euo pipefail
cd "$(dirname "$0")"

APP=/Applications/OpenSCADViewer.app
LABEL=com.greegus.OpenSCADViewer.Renderer
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Nothing goes into /Applications unchecked: the viewer is measured on the test designs first
# (Tests/check.sh — faces claimed, edges, names, a pixel comparison of hover and selection).
# SKIP_CHECKS=1 skips them, for when a check itself is what is being worked on.
#
# The checks need more than the app does: python3, swiftc and OpenSCAD. Someone installing from
# a fresh clone has no reason to have all three, and refusing to install because a *test*
# prerequisite is missing would be absurd — so they are skipped with a word about why, and only
# a genuine failure stops the install.
if [ "${SKIP_CHECKS:-0}" != 1 ]; then
  missing=""
  command -v python3 >/dev/null 2>&1 || missing="$missing python3"
  xcrun --find swiftc >/dev/null 2>&1 || missing="$missing swiftc"
  Tools/find-openscad.sh >/dev/null 2>&1 || missing="$missing openscad"
  if [ -n "$missing" ]; then
    echo "skipping checks — not installed:$missing"
  else
    Tests/check.sh || { echo "not installed: checks failed"; exit 1; }
  fi
fi

if [ ! -d build/OpenSCADViewer.app ]; then
  echo "nothing to install: run ./build.sh first" >&2
  exit 1
fi

rm -rf "$APP"
cp -R build/OpenSCADViewer.app /Applications/

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/ScadRenderHelper</string></array>
  <!-- started on demand, when an extension connects to the mach service -->
  <key>MachServices</key><dict><key>$LABEL</key><true/></dict>
  <key>ProcessType</key><string>Adaptive</string>
</dict>
</plist>
PL

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
pluginkit -a "$APP/Contents/PlugIns/ScadThumbnail.appex" || true
pluginkit -a "$APP/Contents/PlugIns/ScadPreview.appex" || true

# After rm -rf of the bundle three processes survive holding the old copy:
#   quicklookd         – shows "Extension failed during preview of this document"
#   QuickLookUIService – hosts the panel and keeps the old remote view
#   ScadPreview        – our own appex from the previous build
# Without killing them you keep seeing the old version after reinstalling.
killall quicklookd QuickLookUIService ScadPreview ScadThumbnail 2>/dev/null || true

echo "installed; helper: $(launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 && echo OK || echo MISSING)"

# The one prerequisite the app itself cannot do without. Said here rather than left for the
# first blank preview: rendering is OpenSCAD's job, and the viewer only draws the result.
if ! Tools/find-openscad.sh >/dev/null 2>&1; then
  echo
  echo "WARNING: OpenSCAD was not found. The viewer renders through it and can do nothing"
  echo "without it. Install it from https://openscad.org/downloads.html (or 'brew install"
  echo "--cask openscad'), or point the viewer at a copy in the app's Settings window."
fi
