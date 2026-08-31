#!/bin/bash
# Removes the app, the LaunchAgent and the cache.
set -u
LABEL=com.greegus.OpenSCADViewer.Renderer
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
pluginkit -r /Applications/OpenSCADViewer.app/Contents/PlugIns/ScadThumbnail.appex 2>/dev/null || true
pluginkit -r /Applications/OpenSCADViewer.app/Contents/PlugIns/ScadPreview.appex 2>/dev/null || true
rm -rf /Applications/OpenSCADViewer.app
rm -rf "$HOME/Library/Caches/com.greegus.OpenSCADViewer"
qlmanage -r cache >/dev/null 2>&1
echo "uninstalled"
