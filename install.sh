#!/bin/bash
# Installs the app into /Applications and registers the helper LaunchAgent and the QL extensions.
set -euo pipefail
cd "$(dirname "$0")"

APP=/Applications/ScadQuickLook.app
LABEL=com.greegus.ScadQuickLook.Renderer
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

rm -rf "$APP"
cp -R build/ScadQuickLook.app /Applications/

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
