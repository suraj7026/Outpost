// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "OutpostClients",
    // macOS is retained only to run the shared library tests on the host.
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "OutpostKit", targets: ["OutpostKit"])],
    targets: [
        .target(name: "OutpostKit", path: "Shared", resources: [.process("Resources")]),
        .testTarget(name: "OutpostKitTests", dependencies: ["OutpostKit"], path: "Tests")
    ], swiftLanguageModes: [.v5]
)
