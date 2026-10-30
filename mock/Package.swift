// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OutpostMock",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "OutpostMock", targets: ["OutpostMock"])],
    targets: [.executableTarget(name: "OutpostMock", resources: [.process("Resources")])],
    swiftLanguageModes: [.v5]
)
