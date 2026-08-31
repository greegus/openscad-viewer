import Foundation

/// Shared identity: the preferences domain and the cache directory name.
/// Lives in Core because the renderer needs it and the XPC contract does not own it.
public enum Config {
    /// Shared domain for both preferences and the cache directory name.
    public static let suiteName = "com.greegus.OpenSCADViewer"
}
