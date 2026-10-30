import SwiftUI
import AppKit
import CoreText

enum Ink {
    static func color(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255, alpha: 1)
        })
    }
    static let bg = color(0xFAFAF9, 0x0F1011)
    static let surface = color(0xFFFFFF, 0x16171A)
    static let raised = color(0xF4F4F2, 0x1C1D21)
    static let border = color(0xE6E6E3, 0x26282C)
    static let strong = color(0xD4D4D0, 0x34363B)
    static let control = color(0x8A8C88, 0x686B72)
    static let text = color(0x111113, 0xEDEDEF)
    static let secondary = color(0x5C5E63, 0xA1A3A8)
    static let tertiary = color(0x717379, 0x7C7F86)
    static let inverse = color(0xFFFFFF, 0x0F1011)
    static let danger = color(0xC42636, 0xF2555A)
    static let add = color(0x1F7A4D, 0x7FD1A8)
    static let del = color(0xB4232F, 0xF2888C)
    static func font(_ size: CGFloat = 14, _ weight: Font.Weight = .regular) -> Font {
        .custom(weight == .semibold ? "Geist-SemiBold" : weight == .medium ? "Geist-Medium" : "Geist-Regular", size: size)
    }
    static func mono(_ size: CGFloat = 12) -> Font { .custom("GeistMono-Regular", size: size) }
    static func registerFonts() {
        for name in ["Geist-Regular", "Geist-Medium", "Geist-Semibold", "GeistMono-Regular"] {
            if let url = Bundle.module.url(forResource: name, withExtension: "ttf") {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
    }
}

struct InkButtonStyle: ButtonStyle {
    var primary = false
    var danger = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(Ink.font(13, .medium))
            .padding(.horizontal, 13).frame(minHeight: 34)
            .foregroundStyle(primary ? Ink.inverse : danger ? Ink.danger : Ink.text)
            .background(primary ? Ink.text : Ink.raised.opacity(configuration.isPressed ? 0.9 : 0.35))
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(primary ? Color.clear : Ink.border, lineWidth: 1))
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.4)
            .contentShape(RoundedRectangle(cornerRadius: 6))
    }
}

struct Glyph: View {
    let name: String
    var size: CGFloat = 15
    var body: some View { Image(systemName: name).font(.system(size: size, weight: .regular)).frame(width: size + 3, height: size + 3).accessibilityHidden(true) }
}

struct IconButton: View {
    let icon: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) { Glyph(name: icon).frame(width: 30, height: 30).contentShape(Rectangle()) }
            .buttonStyle(.plain).foregroundStyle(Ink.secondary).help(label).accessibilityLabel(label)
    }
}

struct Tag: View {
    var text: String
    var inverted = false
    var icon: String? = nil
    var body: some View {
        HStack(spacing: 5) {
            if let icon { Glyph(name: icon, size: 10) }
            Text(text).lineLimit(1)
        }.font(Ink.font(11, .medium)).padding(.horizontal, 7).padding(.vertical, 4)
            .foregroundStyle(inverted ? Ink.inverse : Ink.secondary)
            .background(inverted ? Ink.text : Ink.raised.opacity(0.65))
            .clipShape(RoundedRectangle(cornerRadius: 5))
    }
}

struct StatusBadge: View {
    var status: String
    var body: some View {
        HStack(spacing: 6) {
            Glyph(name: status == "Needs you" ? "circle.fill" : status == "Running" ? "circle.dashed" : status == "Failed" ? "exclamationmark.circle" : status == "Paused" ? "pause.circle" : "checkmark", size: status == "Needs you" ? 6 : 11)
            Text(status)
        }.font(Ink.font(11, .medium)).padding(.horizontal, 8).padding(.vertical, 5)
            .foregroundStyle(status == "Needs you" ? Ink.inverse : status == "Failed" ? Ink.danger : Ink.secondary)
            .background(status == "Needs you" ? Ink.text : Color.clear).clipShape(Capsule())
            .accessibilityElement(children: .combine)
    }
}

struct Panel<Content: View>: View {
    var title: String? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title { Text(title).font(Ink.font(13, .medium)).padding(.horizontal, 20).padding(.vertical, 17); Divider().overlay(Ink.border.opacity(0.7)) }
            content
        }.background(Ink.surface).clipShape(RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(Ink.border.opacity(0.8), lineWidth: 1))
    }
}

struct PageHeader<Actions: View>: View {
    var title: String
    var subtitle: String
    @ViewBuilder var actions: Actions
    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(Ink.font(30, .semibold)).tracking(-0.7).foregroundStyle(Ink.text)
                Text(subtitle).font(Ink.font(14)).foregroundStyle(Ink.secondary).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            actions
        }.padding(.bottom, 20)
    }
}

struct EmptyNotice: View {
    var icon: String
    var title: String
    var detail: String
    var body: some View {
        VStack(spacing: 12) {
            Glyph(name: icon, size: 26).foregroundStyle(Ink.secondary)
            Text(title).font(Ink.font(20, .semibold))
            Text(detail).font(Ink.font(13)).foregroundStyle(Ink.secondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity).padding(48)
    }
}

extension View {
    func inkField() -> some View {
        self.textFieldStyle(.plain).font(Ink.font(13)).padding(10).background(Ink.surface)
            .clipShape(RoundedRectangle(cornerRadius: 7)).overlay(RoundedRectangle(cornerRadius: 7).stroke(Ink.strong, lineWidth: 1))
    }
    func pageBody() -> some View { self.padding(.horizontal, 38).padding(.top, 34).padding(.bottom, 36).frame(maxWidth: 1180).frame(maxWidth: .infinity, alignment: .top).foregroundStyle(Ink.text) }
}
