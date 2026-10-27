import SwiftUI
import CoreText

public enum Studio {
    public static func registerFonts() {
        for name in ["Geist-Regular", "Geist-Medium", "Geist-Semibold", "GeistMono-Regular"] {
            if let url = Bundle.module.url(forResource: name, withExtension: "ttf") { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
        }
    }
    public static let body = Font.custom("Geist-Regular", size: 17, relativeTo: .body)
    public static let heading = Font.custom("Geist-Semibold", size: 28, relativeTo: .title)
    static func hex(_ value: UInt32) -> Color { Color(.sRGB, red: Double((value >> 16)&255)/255, green: Double((value >> 8)&255)/255, blue: Double(value&255)/255, opacity: 1) }
}
struct StudioPanel: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        content.background(scheme == .dark ? Studio.hex(0x16171a) : .white, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(contrast == .increased ? Color.primary : (scheme == .dark ? Studio.hex(0x26282c) : Studio.hex(0xe6e6e3)), lineWidth: 1))
    }
}
extension View { func studioPanel() -> some View { modifier(StudioPanel()) } }
public struct Feature: Decodable, Identifiable { public let id: String; public let name: String; public let requirement: String; public let module: String; public let stage: String }
public enum FeatureCatalogue {
    public static var all: [Feature] {
        guard let url = Bundle.module.url(forResource: "features", withExtension: "json"), let data = try? Data(contentsOf: url), let features = try? JSONDecoder().decode([Feature].self, from: data) else { return [] }
        return features
    }
}
