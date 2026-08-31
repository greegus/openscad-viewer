#!/bin/bash
# Builds OpenSCADViewer.app (container + sandboxed QL extensions + render helper) without an Xcode project.
set -euo pipefail
cd "$(dirname "$0")"

SDK=$(xcrun --show-sdk-path)
TARGET="$(uname -m)-apple-macos13.0"
OUT=build/OpenSCADViewer.app
APPEX=$OUT/Contents/PlugIns/ScadThumbnail.appex
PREVIEW=$OUT/Contents/PlugIns/ScadPreview.appex

rm -rf build
mkdir -p "$OUT/Contents/MacOS" "$APPEX/Contents/MacOS" "$PREVIEW/Contents/MacOS"

echo "→ container app"
swiftc -O -target "$TARGET" -sdk "$SDK" -module-name OpenSCADViewer \
  Core/ScadRenderer.swift Core/CSGSplitter.swift Core/Config.swift Core/GeometryProvider.swift App/main.swift \
  -framework AppKit -o "$OUT/Contents/MacOS/OpenSCADViewer"

echo "→ render helper (outside the sandbox, runs OpenSCAD)"
swiftc -O -target "$TARGET" -sdk "$SDK" -module-name ScadRenderHelper \
  Core/ScadRenderer.swift Core/CSGSplitter.swift Core/Config.swift Core/GeometryProvider.swift QuickLook/RenderService.swift QuickLook/Helper/main.swift \
  -framework AppKit -o "$OUT/Contents/MacOS/ScadRenderHelper"

echo "→ thumbnail extension (sandboxed)"
# an appex has no main(); the entry point is NSExtensionMain from Foundation
swiftc -O -target "$TARGET" -sdk "$SDK" -parse-as-library -module-name ScadThumbnail \
  Core/ScadRenderer.swift Core/CSGSplitter.swift Core/Config.swift Core/GeometryProvider.swift QuickLook/RenderService.swift QuickLook/XPCGeometryProvider.swift QuickLook/Thumbnail/ThumbnailProvider.swift \
  -framework AppKit -framework QuickLookThumbnailing \
  -Xlinker -e -Xlinker _NSExtensionMain \
  -o "$APPEX/Contents/MacOS/ScadThumbnail"

echo "→ preview extension (sandboxed)"
swiftc -O -target "$TARGET" -sdk "$SDK" -parse-as-library -module-name ScadPreview \
  Core/ScadRenderer.swift Core/CSGSplitter.swift Core/Config.swift Core/GeometryProvider.swift QuickLook/RenderService.swift QuickLook/XPCGeometryProvider.swift ViewerKit/ViewerViewController.swift ViewerKit/WebGLProbe.swift ViewerKit/ScadWebView.swift QuickLook/Preview/PreviewViewController.swift \
  -framework AppKit -framework Quartz -framework WebKit \
  -Xlinker -e -Xlinker _NSExtensionMain \
  -o "$PREVIEW/Contents/MacOS/ScadPreview"

mkdir -p "$PREVIEW/Contents/Resources/Web"
cp -R Viewer/ "$PREVIEW/Contents/Resources/Web/"
cp QuickLook/Preview/Info.plist "$PREVIEW/Contents/Info.plist"
cp App/Info.plist "$OUT/Contents/Info.plist"
cp QuickLook/Thumbnail/Info.plist "$APPEX/Contents/Info.plist"
printf 'APPL????' > "$OUT/Contents/PkgInfo"

echo "→ signing (ad-hoc)"
codesign --force --sign - --timestamp=none --entitlements QuickLook/Thumbnail/Thumbnail.entitlements "$APPEX"
codesign --force --sign - --timestamp=none --entitlements QuickLook/Thumbnail/Thumbnail.entitlements "$PREVIEW"
codesign --force --sign - --timestamp=none "$OUT/Contents/MacOS/ScadRenderHelper"
codesign --force --sign - --timestamp=none "$OUT"

echo "done: $PWD/$OUT"
