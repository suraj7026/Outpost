import SwiftUI
import AppKit

@main struct OutpostMockApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @State private var store = MockStore()
    init() { Ink.registerFonts() }
    var body: some Scene {
        WindowGroup("Outpost") {
            RootView().environment(store).preferredColorScheme(store.dark ? .dark : .light)
                .frame(minWidth: 1080, minHeight: 700)
        }.defaultSize(width: 1440, height: 920).windowStyle(.hiddenTitleBar)
            .commands {
                CommandGroup(replacing: .newItem) {
                    Button("New task") { store.composer = ""; store.destination = .home }.keyboardShortcut("n")
                    Button("Search everything") { store.showCommand = true }.keyboardShortcut("k")
                }
                CommandMenu("Preview") {
                    Button("iPhone preview") { store.showPhone = true }.keyboardShortcut("i", modifiers: [.command,.shift])
                    Button("Toggle appearance") { store.dark.toggle() }.keyboardShortcut("t", modifiers: [.command,.shift])
                    Button("Feature catalogue") { store.destination = .catalogue }
                    Divider()
                    Button("Compact window") { NSApplication.shared.keyWindow?.setContentSize(NSSize(width: 1080, height: 760)) }
                    Button("Spacious window") { NSApplication.shared.keyWindow?.setContentSize(NSSize(width: 1440, height: 920)) }
                    Divider()
                    Button("Reset mock data") { store.reset() }
                }
            }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        for window in NSApplication.shared.windows {
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = false
            window.backgroundColor = .black
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

struct RootView: View {
    @Environment(MockStore.self) private var store
    var body: some View {
        @Bindable var store = store
        HStack(spacing: 0) {
            SidebarView().frame(width: 220)
            VStack(spacing: 0) {
                topBar
                Rectangle().fill(Ink.border).frame(height: 1)
                Group {
                    switch store.destination {
                    case .home: HomeView()
                    case .tasks: TasksView()
                    case .workbench: WorkbenchView()
                    case .approvals: ApprovalsView()
                    case .browser: BrowserPage()
                    case .machine: MachineView()
                    case .capabilities: CapabilitiesView()
                    case .automations: AutomationsView()
                    case .library: LibraryView()
                    case .accounts: AccountsView()
                    case .spending: SpendingView()
                    case .memory: MemoryView()
                    case .catalogue: CatalogueView()
                    case .settings: SettingsPage()
                    }
                }.frame(maxWidth:.infinity,maxHeight:.infinity).background(Ink.bg)
            }.clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Ink.border.opacity(0.9)))
                .padding(.top, 10).padding(.trailing, 10).padding(.bottom, 10)
        }.font(Ink.font()).foregroundStyle(Ink.text).background(Ink.bg).tint(Ink.text)
            .sheet(item: $store.sheet) { data in DetailSheetView(data:data).environment(store) }
            .sheet(isPresented:$store.showPhone) { PhonePreview().environment(store) }
            .sheet(isPresented:$store.showCommand) { CommandPalette().environment(store) }
            .overlay(alignment:.bottom) {
                if let message = store.toast {
                    HStack(spacing:10) { Glyph(name:"checkmark.circle"); Text(message); IconButton(icon:"xmark",label:"Dismiss notice") { store.toast = nil } }
                        .font(Ink.font(12)).padding(.leading,16).padding(.trailing,4).padding(.vertical,5).background(Ink.raised)
                        .clipShape(RoundedRectangle(cornerRadius:8)).overlay(RoundedRectangle(cornerRadius:8).stroke(Ink.strong))
                        .shadow(color:.black.opacity(0.15),radius:16,y:5).padding(.bottom,20)
                }
            }
    }
    private var topBar: some View {
        HStack(spacing:10) {
            Text("Workspace").font(Ink.font(12)).foregroundStyle(Ink.tertiary)
            Glyph(name:"chevron.right",size:8).foregroundStyle(Ink.tertiary)
            Text(store.destination == .home ? "Overview" : store.destination == .workbench ? store.currentTask.project : store.destination.rawValue).font(Ink.font(12, .medium))
            if store.destination == .workbench { Glyph(name:"chevron.right",size:9); Text(store.currentTask.mode).font(Ink.font(12)).foregroundStyle(Ink.secondary) }
            Spacer()
            Menu {
                ForEach(ControlMode.allCases) { value in Button(value.rawValue) { store.changeControlMode(value) } }
                Divider()
                Button("Control settings") { store.settingsTab = "Permissions"; store.destination = .settings }
            } label: { HStack(spacing: 5) { Glyph(name: "shield", size: 11); Text(store.controlMode.rawValue).font(Ink.font(11)) } }.menuStyle(.borderlessButton).fixedSize().padding(.trailing, 8).help("Mock control mode · shared with iPhone")
            HStack(spacing:6) { Circle().fill(store.serverConnected ? Ink.text : Ink.danger).frame(width:5,height:5); Text("outpost-01").font(Ink.mono(11)); Text(store.serverConnected ? "Connected" : "Offline").font(Ink.font(11)).foregroundStyle(Ink.secondary) }
                .padding(.horizontal,6).padding(.vertical,5)
            IconButton(icon:"iphone",label:"Open iPhone preview") { store.showPhone = true }
            IconButton(icon:store.dark ? "sun.max" : "moon",label:"Toggle appearance") { store.dark.toggle() }
        }.padding(.horizontal,22).frame(height:48).background(Ink.bg)
    }
}

struct SidebarView: View {
    @Environment(MockStore.self) private var store
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                ZStack { RoundedRectangle(cornerRadius: 5).stroke(Ink.text, lineWidth: 1.5).frame(width: 23, height: 23); RoundedRectangle(cornerRadius: 1.5).fill(Ink.text).frame(width: 8, height: 8) }
                Text("Outpost").font(Ink.font(17, .semibold)).tracking(-0.4)
                Spacer()
            }.padding(.horizontal, 21).padding(.top, 36).padding(.bottom, 20)
            Button { store.composer = ""; store.destination = .home } label: {
                HStack(spacing: 9) { Glyph(name: "plus", size: 14); Text("New task").font(Ink.font(12, .medium)); Spacer(); Text("⌘N").font(Ink.font(10)).foregroundStyle(Ink.tertiary) }.foregroundStyle(Ink.text).padding(.horizontal, 11).frame(height: 35).background(Ink.raised).clipShape(RoundedRectangle(cornerRadius: 7))
            }.buttonStyle(.plain).padding(.horizontal, 14)
            Button { store.showCommand = true } label: { HStack(spacing: 9) { Glyph(name: "magnifyingglass", size: 13); Text("Search").font(Ink.font(12)); Spacer(); Text("⌘K").font(Ink.font(10)) }.foregroundStyle(Ink.tertiary).padding(.horizontal, 11).frame(height: 35) }.buttonStyle(.plain).padding(.horizontal, 14).padding(.bottom, 14)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach([Destination.home, .tasks, .approvals]) { nav($0) }
                    label("Workspace")
                    ForEach([Destination.browser, .machine, .capabilities, .automations, .library]) { nav($0) }
                    label("Personal")
                    ForEach([Destination.accounts, .spending, .memory]) { nav($0) }
                    label("Recent")
                    ForEach(store.tasks.prefix(2)) { task in
                        Button { store.openTask(task.id) } label: {
                            HStack(spacing: 9) { Glyph(name: task.icon, size: 12); Text(task.title).font(Ink.font(11)).lineLimit(1); Spacer(minLength: 0) }.foregroundStyle(Ink.tertiary).padding(.horizontal, 11).frame(height: 31).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                }.padding(.horizontal, 14)
            }.scrollIndicators(.automatic)
            VStack(spacing: 3) { nav(.catalogue); nav(.settings) }.padding(.horizontal, 14).padding(.vertical, 12)
            Rectangle().fill(Ink.border).frame(height: 1).padding(.horizontal, 22)
            HStack(spacing: 10) {
                Glyph(name: "server.rack", size: 16).foregroundStyle(Ink.secondary)
                VStack(alignment: .leading, spacing: 5) { Text("outpost-01").font(Ink.font(12, .medium)); Text("Sample workspace").font(Ink.font(10)).foregroundStyle(Ink.tertiary) }
                Spacer(); Circle().fill(store.serverConnected ? Ink.secondary : Ink.danger).frame(width: 5, height: 5)
            }.padding(.horizontal, 23).padding(.vertical, 19)
        }.background(Ink.bg)
    }
    private func label(_ text: String) -> some View { Text(text).font(Ink.font(10, .medium)).foregroundStyle(Ink.tertiary).padding(.top, 14).padding(.bottom, 6).padding(.leading, 11) }
    private func nav(_ item: Destination) -> some View {
        let selected = store.destination == item
        return Button { store.destination = item } label: {
            HStack(spacing: 10) {
                Glyph(name: item.icon, size: 14)
                Text(item.rawValue).font(Ink.font(12, selected ? .medium : .regular))
                Spacer()
                if item == .approvals && !store.pending.isEmpty { Text("\(store.pending.count)").font(Ink.font(10, .medium)).foregroundStyle(selected ? Ink.text : Ink.secondary).frame(width: 19, height: 18).background(Ink.text.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: 4)) }
            }.foregroundStyle(selected ? Ink.text : Ink.secondary).padding(.horizontal, 11).frame(height: 31).background(selected ? Ink.raised : .clear).clipShape(RoundedRectangle(cornerRadius: 7)).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct DetailSheetView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(MockStore.self) private var store
    var data: DetailSheet
    var body: some View {
        VStack(alignment:.leading,spacing:22) {
            HStack { Glyph(name:data.icon,size:22); Spacer(); Tag(text:"Preview only"); IconButton(icon:"xmark",label:"Close dialog") { dismiss() } }
            Text(data.title).font(Ink.font(23,.semibold))
            Text(data.detail).font(Ink.font(14)).foregroundStyle(Ink.secondary).lineSpacing(5).fixedSize(horizontal:false,vertical:true)
            if !data.fields.isEmpty {
                Panel { VStack(spacing:0) { ForEach(Array(data.fields.enumerated()),id:\.offset) { i,field in HStack(alignment:.top) { Text(field.0).foregroundStyle(Ink.secondary).frame(width:110,alignment:.leading); Text(field.1).frame(maxWidth:.infinity,alignment:.leading).textSelection(.enabled) }.font(Ink.font(12)).padding(13); if i < data.fields.count - 1 { Divider().overlay(Ink.border) } } } }
            }
            HStack { Button("Cancel") { dismiss() }.buttonStyle(InkButtonStyle()); Spacer(); Button(data.confirm) { dismiss(); data.action?() }.buttonStyle(InkButtonStyle(primary:true)).keyboardShortcut(.defaultAction) }
        }.padding(28).frame(width:510).background(Ink.bg).foregroundStyle(Ink.text)
    }
}
