import AppKit

/// The Quick Look panel's entry point. All it adds to the shared viewer is what belongs to
/// this host: where geometry comes from, and how big the panel should be.
final class PreviewViewController: ViewerViewController {

    override func loadView() {
        super.loadView()

        // An extension may not spawn OpenSCAD, so it renders through the XPC helper.
        geometryProvider = XPCGeometryProvider()

        // A preview is a look, not a workbench: the view cube, the home button and the two view
        // pills, and nothing else. Inspecting, measuring, cutting and hiding pieces all leave
        // the model in a state the panel has no room to explain or undo — and a Quick Look
        // panel is thrown away on the next arrow key.
        chrome = "preview"

        // Quick Look does not size the view it is handed, so we size ourselves to the panel.
        pinsToHostView = true

        // Quick Look ignores the root view's own frame — measured: the panel stayed 800×600
        // whatever we set — but it does honour this. 20 % above that default.
        //
        // Deliberately here and not in ViewerViewController: as a window's
        // contentViewController this pins the window to exactly this size, which silently
        // defeats zoom and therefore a double-click on the title bar.
        preferredContentSize = NSSize(width: 960, height: 720)
    }
}
