// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "OutpostClients",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "OutpostKit", targets: ["OutpostKit"]), .executable(name: "Outpost", targets: ["OutpostMac"])],
    targets: [
        .target(name: "OutpostKit", path: "Shared", resources: [.process("Resources")]),
        .executableTarget(name: "OutpostMac", dependencies: ["OutpostKit"], path: "macOS"),
        .testTarget(name: "OutpostKitTests", dependencies: ["OutpostKit"], path: "Tests")
    ], swiftLanguageModes: [.v5]
)
