import AppKit

/// The Quick Look panel's entry point. All it adds to the shared viewer is where geometry
/// comes from: an extension may not spawn OpenSCAD, so it renders through the XPC helper.
final class PreviewViewController: ViewerViewController {

    override func loadView() {
        super.loadView()
        geometryProvider = XPCGeometryProvider()
    }
}
