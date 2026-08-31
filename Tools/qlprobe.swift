import Foundation
import QuickLookThumbnailing
import AppKit

// Calls the same API Finder uses — verifies our extension is actually picked.
let path = CommandLine.arguments[1]
let out = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "probe.png"
let url = URL(fileURLWithPath: path)

let req = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 512, height: 512),
                                       scale: 2, representationTypes: .all)
let sem = DispatchSemaphore(value: 0)
QLThumbnailGenerator.shared.generateBestRepresentation(for: req) { rep, err in
    if let err { print("ERROR: \(err)") }
    if let rep {
        print("representation: \(rep.type.rawValue)  size: \(rep.cgImage.width)x\(rep.cgImage.height)")
        let bitmap = NSBitmapImageRep(cgImage: rep.cgImage)
        try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out))
        print("saved: \(out)")
    }
    sem.signal()
}
sem.wait()
