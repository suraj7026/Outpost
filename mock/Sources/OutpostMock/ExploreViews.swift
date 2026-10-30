import SwiftUI

struct CatalogueView: View {
    @Environment(MockStore.self) private var store
    @State private var stage = "All stages"
    var categories: [String] { Array(Set(store.features.map(\.category))).sorted() }
    var filtered: [Feature] { store.features.filter { (store.featureCategory == "All areas" || $0.category == store.featureCategory) && (stage == "All stages" || $0.stage == stage) && (store.featureSearch.isEmpty || ($0.id + $0.name + $0.detail + $0.category).localizedCaseInsensitiveContains(store.featureSearch)) } }
    var body: some View {
        @Bindable var store = store
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeader(title: "The full picture", subtitle: "270 planned capabilities. One personal operator with its own computer.") { Tag(text: "27 areas") }
                HStack(spacing: 12) {
                    TextField("Search features, tools or feature IDs", text: $store.featureSearch).inkField()
                    Menu { Button("All areas") { store.featureCategory = "All areas" }; Divider(); ForEach(categories, id: \.self) { category in Button(category) { store.featureCategory = category } } } label: { Label(store.featureCategory, systemImage: "line.3.horizontal.decrease") }.menuStyle(.borderlessButton).frame(width: 230)
                    Picker("Stage", selection: $stage) { ForEach(["All stages", "Core", "Expansion", "Advanced"], id: \.self) { Text($0).tag($0) } }.labelsHidden().frame(width: 115)
                }
                HStack { Text("\(filtered.count) features").font(Ink.font(12, .medium)); Spacer(); Text("Planning coverage, not connected functionality").font(Ink.font(11)).foregroundStyle(Ink.tertiary) }
                if filtered.isEmpty { EmptyNotice(icon: "magnifyingglass", title: "No matching features", detail: "Try a tool name, action or another area.") }
                LazyVStack(alignment: .leading, spacing: 24) {
                    ForEach(categories.filter { category in filtered.contains { $0.category == category } }, id: \.self) { category in
                        VStack(alignment: .leading, spacing: 12) {
                            Text(category).font(Ink.font(16, .semibold))
                            Panel {
                                VStack(spacing: 0) {
                                    ForEach(filtered.filter { $0.category == category }) { feature in
                                        Button { showFeature(feature, store: store) } label: {
                                            HStack(alignment: .top, spacing: 14) {
                                                Text(feature.id).font(Ink.mono(10)).foregroundStyle(Ink.tertiary).frame(width: 70, alignment: .leading).padding(.top, 3)
                                                VStack(alignment: .leading, spacing: 7) { Text(feature.name).font(Ink.font(13, .medium)); Text(feature.detail).font(Ink.font(11)).foregroundStyle(Ink.secondary).lineSpacing(4).lineLimit(2) }.frame(maxWidth: .infinity, alignment: .leading)
                                                Tag(text: feature.stage).frame(width: 85, alignment: .trailing)
                                                Glyph(name: "arrow.up.right", size: 10).foregroundStyle(Ink.tertiary).padding(.top, 5)
                                            }.padding(16).contentShape(Rectangle())
                                        }.buttonStyle(.plain)
                                        Divider()
                                    }
                                }
                            }
                        }
                    }
                }
            }.pageBody()
        }
    }
}

@MainActor func showFeature(_ feature: Feature, store: MockStore) {
    store.detail(feature.name, icon: "square.grid.2x2", feature.detail, fields: [("Feature", feature.id), ("Area", feature.category), ("Stage", feature.stage)], confirm: "Open related workflow", action: {
        switch feature.id.components(separatedBy: "-")[0] {
        case "TASK": store.destination = .tasks
        case "FS", "DOC", "DATA": store.destination = .library
        case "RUN", "SYS", "OPS", "TEAM": store.destination = .machine
        case "PKG", "EXT", "MEDIA": store.destination = .capabilities
        case "WEB", "CAP", "LIFE": store.destination = .browser; store.browserTab = "Billing portal"
        case "ID", "COM": store.destination = .accounts
        case "DEV", "GIT": store.openTask("filter")
        case "RES": store.openTask("research"); store.workTab = "Plan"
        case "PAY": store.destination = .spending
        case "AUTO": store.destination = .automations
        case "MEM": store.destination = .memory
        case "MODEL": store.settingsTab = "Models"; store.destination = .settings
        case "PHONE": store.showPhone = true
        case "TRUST": store.settingsTab = "Permissions"; store.destination = .settings
        case "REL": store.settingsTab = "Audit"; store.destination = .settings
        default: store.destination = .home
        }
    })
}

struct SettingsPage: View {
    @Environment(MockStore.self) private var store
    @State private var revoked: Set<String> = []
    var body: some View {
        @Bindable var store = store
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Settings", subtitle: "The model, devices and boundaries behind your workspace.") { EmptyView() }
                tabStrip(["Models", "Permissions", "Notifications", "Devices", "Audit", "Preview"], selection: $store.settingsTab)
                switch store.settingsTab {
                case "Permissions": permissions
                case "Notifications": notifications
                case "Devices": devices
                case "Audit": audit
                case "Preview": preview
                default: models
                }
            }.pageBody()
        }
    }
    private var models: some View {
        VStack(alignment: .leading, spacing: 22) {
            Panel {
                HStack(alignment: .top, spacing: 18) {
                    Glyph(name: "cloud", size: 29)
                    VStack(alignment: .leading, spacing: 10) {
                        HStack { Text("Ollama Cloud").font(Ink.font(20, .semibold)); Tag(text: "Primary provider", icon: "checkmark") }
                        Text("Hosted reasoning. Self-hosted execution.").font(Ink.font(13)).foregroundStyle(Ink.secondary)
                        Text("The key stays in your server’s vault. Selected task context and images go to inference; tools and files remain on Ubuntu.").font(Ink.font(12)).foregroundStyle(Ink.secondary).lineSpacing(5)
                    }
                    Spacer()
                    Button("Test connection") { store.notify("Sample connection healthy / 182 ms. No request was sent.") }.buttonStyle(InkButtonStyle())
                }.padding(24)
            }
            HStack(spacing: 22) {
                Panel(title: "Connection") { VStack(alignment: .leading, spacing: 16) { setting("Route", "Pi → local gateway → Ollama Cloud"); setting("API key", "••••••••••••••••   Stored on server"); setting("Cloud status", "Sample connection / 182 ms"); setting("Execution", "Ubuntu Server · No desktop required") }.padding(20) }.frame(maxWidth: .infinity)
                Panel(title: "Usage & capacity") { VStack(alignment: .leading, spacing: 16) { setting("Today", "124 requests / 8 tasks"); setting("Input / output", "184k / 26k tokens"); setting("Concurrency", "2 active / 3 queued"); setting("Recovery", "Bounded retry · Pause on quota") }.padding(20) }.frame(maxWidth: .infinity)
            }
            Text("Model roles").font(Ink.font(16, .semibold))
            ForEach([("Operator & code", "Qwen Coder", "Tools · Coding · Long tasks"), ("Auto reviewer", "Smaller Cloud model / to be qualified", "Proposed actions · Allow or ask"), ("Vision", "Cloud vision model", "Images · Browser grounding"), ("Retrieval", "Local embedding worker", "Self-hosted on outpost-01")], id: \.0) { role in
                Panel {
                    HStack(spacing: 16) {
                        Glyph(name: role.0 == "Vision" ? "eye" : "square.stack.3d.up", size: 20)
                        VStack(alignment: .leading, spacing: 6) { Text(role.0).font(Ink.font(12, .medium)); Text(role.1).font(Ink.mono(11)).foregroundStyle(Ink.secondary) }
                        Spacer()
                        Text(role.2).font(Ink.font(11)).foregroundStyle(Ink.tertiary)
                        Button("Change") { store.detail("Choose a model", icon: "cloud", "The real app lists qualified models available to your account. These are sample role labels.", fields: [("Role", role.0), ("Qualification", "Tools, images and context tested per model"), ("Fallback", "Approved models only")], confirm: "Keep sample selection", action: { store.notify("Sample model role saved.") }) }.buttonStyle(InkButtonStyle())
                    }.padding(18)
                }
            }
        }
    }
    private var permissions: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Choose how much control to give Outpost.").font(Ink.font(17, .medium))
            Text("The mode is shared by both clients. These controls change preview state only.").font(Ink.font(13)).foregroundStyle(Ink.secondary)
            ForEach(ControlMode.allCases) { value in
                Button { store.changeControlMode(value) } label: {
                    HStack(alignment: .top, spacing: 15) {
                        Glyph(name: store.controlMode == value ? "largecircle.fill.circle" : "circle", size: 19).padding(.top, 2)
                        VStack(alignment: .leading, spacing: 8) { Text(value.rawValue).font(Ink.font(16, .medium)); Text(value.detail).font(Ink.font(13)).foregroundStyle(Ink.secondary).lineSpacing(4) }.frame(maxWidth: .infinity, alignment: .leading)
                        if store.controlMode == value { Tag(text: "Selected") }
                    }.foregroundStyle(Ink.text).padding(21).frame(maxWidth: .infinity, alignment: .leading).background(store.controlMode == value ? Ink.raised : Ink.surface).clipShape(RoundedRectangle(cornerRadius: 9)).overlay(RoundedRectangle(cornerRadius: 9).stroke(store.controlMode == value ? Ink.strong : Ink.border)).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            Panel(title: "Auto reviewer") {
                VStack(alignment: .leading, spacing: 16) {
                    setting("Provider", "Smaller open model / Ollama Cloud")
                    setting("Model", "To be qualified · sample role")
                    setting("Fallback", "Ask you if the reviewer is unavailable or unsure")
                    Text("The reviewer cannot change modes, connect your accounts or authorize a payment workflow.").font(Ink.font(12)).foregroundStyle(Ink.secondary).lineSpacing(5)
                }.padding(20)
            }
            Panel(title: "Payment workflows and account access") {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Approve the whole payment workflow once, in any mode. A changed merchant, currency, item set, recurrence or amount above your limit needs a new approval.").font(Ink.font(13)).lineSpacing(5)
                    Text("Agent accounts are the default. Your accounts stay separately scoped; the agent never switches to them silently.").font(Ink.font(12)).foregroundStyle(Ink.secondary).lineSpacing(5)
                    Button("Revoke sample grant") { store.notify("Sample grant revoked. No real permissions changed.") }.buttonStyle(InkButtonStyle(danger: true))
                }.padding(20)
            }
        }
    }
    private var notifications: some View {
        Panel(title: "Apple push notifications") {
            VStack(alignment: .leading, spacing: 18) {
                HStack { Glyph(name: "bell", size: 24); Text("Keep up with your server").font(Ink.font(20, .semibold)); Spacer(); Tag(text: "Preview") }
                Text("Alerts for decisions, completed work and failures. Open either client to see the same server-owned history.").font(Ink.font(14)).foregroundStyle(Ink.secondary).lineSpacing(5)
                setting("Delivery", "Ubuntu server → Apple APNs → iPhone")
                setting("Privacy", "Minimal lock-screen text · Unlock for sensitive actions")
                setting("Recovery", "The inbox keeps requests even when a push is missed")
                setting("Status", "Sample configuration · APNs is not connected")
                Button("Preview notification") { store.detail("Outpost needs your attention", icon: "bell", "Review a pending decision on outpost-01. Sensitive details appear only inside the app.", fields: [("Delivery", "Apple push notification / sample"), ("Record", "Shared server inbox")], confirm: "Open inbox", action: { store.destination = .approvals }) }.buttonStyle(InkButtonStyle())
            }.padding(24)
        }
    }
    private var devices: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack { Text("Paired devices").font(Ink.font(16, .semibold)); Spacer(); Button("Pair new device") { store.detail("Pair a new device", icon: "qrcode", "Scan a short-lived code and compare the fingerprint. This preview uses a placeholder.", fields: [("Server", "outpost-01"), ("Fingerprint", "A7:24:8C:91:DE:04"), ("Token", "Sample / expires in 5 minutes")], confirm: "Simulate pairing", action: { store.notify("Sample device paired.") }) }.buttonStyle(InkButtonStyle()) }
            ForEach([("MacBook Pro", "desktopcomputer", "This device · Active now"), ("iPhone", "iphone", "Last seen 2 minutes ago")], id: \.0) { device in
                Panel { HStack(spacing: 18) { Glyph(name: device.1, size: 27); VStack(alignment: .leading, spacing: 7) { Text(device.0).font(Ink.font(15, .medium)); Text(revoked.contains(device.0) ? "Revoked" : device.2).font(Ink.font(12)).foregroundStyle(Ink.tertiary) }; Spacer(); Tag(text: revoked.contains(device.0) ? "Revoked" : "Paired"); Button("Revoke") { store.detail("Revoke this device?", icon: "lock", "It would lose future access and approval authority. This only changes the sample state.", confirm: "Revoke sample device", action: { revoked.insert(device.0); store.notify("Sample device revoked.") }) }.buttonStyle(InkButtonStyle()).disabled(revoked.contains(device.0)) }.padding(22) }
            }
            Text("Clients connect through your server’s private link. Keys can be revoked independently.").font(Ink.font(12)).foregroundStyle(Ink.secondary)
        }
    }
    private var audit: some View {
        Panel(title: "Protected activity history") {
            VStack(spacing: 0) {
                ForEach(Array(store.audit.enumerated()), id: \.offset) { _, event in HStack(spacing: 12) { Glyph(name: "checkmark.shield", size: 13).foregroundStyle(Ink.tertiary); Text(event).font(Ink.mono(11)).textSelection(.enabled); Spacer(); Tag(text: "Recorded") }.padding(17); Divider() }
                HStack { Text("Intent, approval, execution and verification are separate.").font(Ink.font(11)).foregroundStyle(Ink.secondary); Spacer(); Button("Export sample") { store.notify("Sample audit export prepared.") }.buttonStyle(InkButtonStyle()) }.padding(18)
            }
        }
    }
    private var preview: some View {
        Panel(title: "About this mock") {
            VStack(alignment: .leading, spacing: 18) {
                Text("Outpost / Ink").font(Ink.font(22, .semibold))
                Text("Native SwiftUI screens with in-memory sample data. No server, model, account, terminal or payment service is connected.").font(Ink.font(14)).foregroundStyle(Ink.secondary).lineSpacing(6)
                setting("Design", "Graphite / Ink · Geist / Geist Mono")
                setting("Coverage", "270 features / 27 areas")
                setting("Architecture", "Ubuntu server / Ollama Cloud inference")
                HStack { Button("iPhone preview") { store.showPhone = true }.buttonStyle(InkButtonStyle()); Button("Toggle appearance") { store.dark.toggle() }.buttonStyle(InkButtonStyle()); Spacer(); Button("Reset all mock data") { store.reset() }.buttonStyle(InkButtonStyle()) }
            }.padding(24)
        }
    }
    private func setting(_ label: String, _ value: String) -> some View { HStack(alignment: .top, spacing: 18) { Text(label).font(Ink.font(12)).foregroundStyle(Ink.tertiary).frame(width: 100, alignment: .leading); Text(value).font(Ink.font(12)).frame(maxWidth: .infinity, alignment: .leading) } }
}

struct CommandPalette: View {
    @Environment(MockStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) { Glyph(name: "magnifyingglass"); TextField("Search screens, tasks and features…", text: $query).textFieldStyle(.plain).font(Ink.font(16)); Text("esc").font(Ink.mono(10)).foregroundStyle(Ink.tertiary) }.padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Go to").font(Ink.font(11)).foregroundStyle(Ink.tertiary).padding(10)
                    ForEach(Destination.allCases.filter { $0 != .workbench && (query.isEmpty || $0.rawValue.localizedCaseInsensitiveContains(query)) }) { destination in
                        Button { store.destination = destination; dismiss() } label: { HStack(spacing: 12) { Glyph(name: destination.icon); Text(destination.rawValue); Spacer(); Glyph(name: "return", size: 10) }.font(Ink.font(13)).padding(10).contentShape(Rectangle()) }.buttonStyle(.plain)
                    }
                    if !query.isEmpty {
                        ForEach(store.tasks.filter { $0.title.localizedCaseInsensitiveContains(query) }.prefix(3)) { task in Button { store.openTask(task.id); dismiss() } label: { Label(task.title, systemImage: task.icon).font(Ink.font(12)).padding(10) }.buttonStyle(.plain) }
                        ForEach(store.features.filter { ($0.id + $0.name).localizedCaseInsensitiveContains(query) }.prefix(5)) { feature in Button { store.featureSearch = feature.name; store.featureCategory = "All areas"; store.destination = .catalogue; dismiss() } label: { HStack { Text(feature.id).font(Ink.mono(10)).foregroundStyle(Ink.tertiary); Text(feature.name).font(Ink.font(12)) }.padding(10) }.buttonStyle(.plain) }
                    }
                }.padding(10)
            }.frame(height: 410)
        }.frame(width: 580).background(Ink.bg).foregroundStyle(Ink.text)
    }
}

struct PhonePreview: View {
    @Environment(MockStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var tab = "Sessions"
    var body: some View {
        VStack(spacing: 18) {
            HStack { Text("Outpost on iPhone").font(Ink.font(18, .semibold)); Spacer(); Tag(text: "Shared mock state"); IconButton(icon: "xmark", label: "Close iPhone preview") { dismiss() } }
            HStack(alignment: .center, spacing: 36) {
                phone
                VStack(alignment: .leading, spacing: 22) {
                    Text("Pick up anywhere.").font(Ink.font(24, .semibold))
                    Text("The task stays on your Ubuntu server. Your phone is another window into it.").font(Ink.font(14)).foregroundStyle(Ink.secondary).lineSpacing(6)
                    Label("Read live progress", systemImage: "text.bubble")
                    Label("Review the exact action", systemImage: "checkmark.shield")
                    Label("Take over the browser", systemImage: "cursorarrow")
                    Label("Open returned files", systemImage: "doc.text")
                    Divider()
                    Text("One shared history").font(Ink.font(13, .medium))
                    Text("Chat, files, decisions and settings live on your server. Apple push alerts bring you back when needed.").font(Ink.font(12)).foregroundStyle(Ink.secondary).lineSpacing(5)
                }.font(Ink.font(13)).frame(width: 250)
            }
        }.padding(25).frame(width: 760).background(Ink.surface).foregroundStyle(Ink.text)
    }
    private var phone: some View {
        VStack(spacing: 0) {
            HStack { Text("9:41").font(Ink.font(13, .semibold)); Spacer(); Capsule().fill(Ink.text).frame(width: 90, height: 22); Spacer(); Glyph(name: "wifi", size: 12); Glyph(name: "battery.100", size: 17) }.padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 22)
            HStack { Text(tab == "Sessions" ? "Sessions" : tab == "Task" ? "Live task" : tab == "Decision" ? "Your decision" : tab == "New task" ? "New task" : "Browser").font(Ink.font(26, .semibold)); Spacer(); Button { tab = "New task" } label: { Glyph(name: "square.and.pencil", size: 19) }.buttonStyle(.plain).frame(width: 44, height: 44).accessibilityLabel("New phone task") }.padding(.horizontal, 22)
            HStack { Circle().fill(Ink.text).frame(width: 5, height: 5); Text("outpost-01").font(Ink.mono(10)); Text("Connected").font(Ink.font(10)).foregroundStyle(Ink.tertiary); Spacer(); Menu { ForEach(ControlMode.allCases) { value in Button(value.rawValue) { store.changeControlMode(value) } } } label: { Text(store.controlMode.rawValue).font(Ink.font(10)) }.menuStyle(.borderlessButton).fixedSize() }.padding(.horizontal, 22).padding(.vertical, 12)
            Divider()
            ScrollView { phoneContent.padding(.vertical, 18) }.frame(maxHeight: .infinity)
            Divider()
            HStack(spacing: 0) { ForEach([("Sessions", "square.stack"), ("Task", "text.bubble"), ("Decision", "circle.inset.filled"), ("Browser", "globe")], id: \.0) { item in Button { tab = item.0 } label: { VStack(spacing: 5) { Glyph(name: item.1, size: 19); Text(item.0).font(Ink.font(9)) }.frame(maxWidth: .infinity).frame(height: 55).foregroundStyle(tab == item.0 ? Ink.text : Ink.tertiary) }.buttonStyle(.plain) } }.padding(.horizontal, 10)
            Capsule().fill(Ink.text).frame(width: 120, height: 4).padding(.bottom, 12).padding(.top, 5)
        }.frame(width: 375, height: 704).background(Ink.bg).clipShape(RoundedRectangle(cornerRadius: 38)).overlay(RoundedRectangle(cornerRadius: 38).stroke(Ink.strong, lineWidth: 5))
    }
    @ViewBuilder private var phoneContent: some View {
        if tab == "New task" {
            VStack(alignment: .leading, spacing: 18) {
                Text("Start on your server").font(Ink.font(20, .semibold))
                Text("The same conversation will appear on Mac.").font(Ink.font(13)).foregroundStyle(Ink.secondary)
                PhoneTaskComposer { tab = "Task" }
            }.padding(.horizontal, 22)
        } else if tab == "Sessions" {
            VStack(alignment: .leading, spacing: 8) {
                Text("Needs you & running").font(Ink.font(12, .medium)).padding(.horizontal, 22)
                ForEach(store.tasks.prefix(4)) { task in
                    Button { store.selectedTask = task.id; tab = "Task" } label: { HStack(alignment: .top, spacing: 11) { Glyph(name: task.icon, size: 17).foregroundStyle(Ink.secondary); VStack(alignment: .leading, spacing: 7) { Text(task.title).font(Ink.font(14, .medium)).lineLimit(2); Text("\(task.project) · \(task.time)").font(Ink.font(10)).foregroundStyle(Ink.tertiary) }; Spacer(minLength: 3); if task.status == "Needs you" { Circle().fill(Ink.text).frame(width: 6, height: 6) } }.padding(.horizontal, 22).padding(.vertical, 14).contentShape(Rectangle()) }.buttonStyle(.plain)
                    Divider().padding(.leading, 50)
                }
            }
        } else if tab == "Decision" {
            VStack(alignment: .leading, spacing: 18) {
                if let approval = store.pending.first {
                    Tag(text: "Needs you", inverted: true)
                    Text(approval.title).font(Ink.font(21, .semibold))
                    Text(approval.detail).font(Ink.font(14)).foregroundStyle(Ink.secondary).lineSpacing(6)
                    Text(approval.target).font(Ink.mono(11)).padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Ink.raised).clipShape(RoundedRectangle(cornerRadius: 8))
                    Text("This action only · Mock decision").font(Ink.font(11)).foregroundStyle(Ink.tertiary)
                    if approval.type == "Purchase" {
                        Text("Merchant: Domain registrar\nMaximum: ₹1,249.00 · One year\nAuto-renew: Off · Expires in 15 minutes\nIncludes checkout, verification and receipt collection.").font(Ink.font(12)).foregroundStyle(Ink.secondary).lineSpacing(5)
                        Button("Approve payment workflow") { store.decide(approval.id, allow: true, device: "iPhone") }.buttonStyle(InkButtonStyle(primary: true)).frame(minHeight: 44)
                    } else {
                        Button(approval.type == "Account" ? "Take over browser" : "Approve once") { store.decide(approval.id, allow: true, device: "iPhone"); if approval.type == "Account" { tab = "Browser" } }.buttonStyle(InkButtonStyle(primary: true)).frame(minHeight: 44)
                    }
                    Button("Deny") { store.decide(approval.id, allow: false, device: "iPhone") }.buttonStyle(InkButtonStyle()).frame(minHeight: 44)
                } else { EmptyNotice(icon: "checkmark.circle", title: "All caught up", detail: "No pending sample decisions.") }
            }.padding(.horizontal, 22)
        } else if tab == "Browser" {
            VStack(alignment: .leading, spacing: 18) {
                Text("billing.northstar.example").font(Ink.mono(10)).padding(12).background(Ink.raised).clipShape(RoundedRectangle(cornerRadius: 6))
                Text(store.browserSignedIn ? "Invoices ready" : "Sign-in needed").font(Ink.font(23, .semibold))
                Text(store.browserSignedIn ? "The shared sample session is signed in. Pi can collect the monthly invoices." : "Take over this same browser session, sign in, then return control.").font(Ink.font(14)).foregroundStyle(Ink.secondary).lineSpacing(6)
                Button(store.browserHuman ? "Return control to Pi" : "Take control") { store.browserHuman.toggle() }.buttonStyle(InkButtonStyle(primary: true)).frame(minHeight: 44)
                if store.browserHuman && !store.browserSignedIn { Button("Simulate sign-in") { store.signIn(device: "iPhone") }.buttonStyle(InkButtonStyle()).frame(minHeight: 44) }
                Tag(text: store.browserHuman ? "You are in control" : store.browserSignedIn ? "Pi is in control" : "Waiting for owner")
            }.padding(.horizontal, 22)
        } else {
            VStack(alignment: .leading, spacing: 18) {
                Text(store.currentTask.title).font(Ink.font(21, .semibold))
                Text("Running on outpost-01 · \(store.currentTask.time)").font(Ink.font(11)).foregroundStyle(Ink.tertiary)
                Text(store.currentTask.summary).font(Ink.font(14)).lineSpacing(6)
                if store.currentTask.mode == "Code" { ToolRow(icon: "doc.text", title: "Edited", target: "3 files", result: "+146 −27", detail: "FilterBar.tsx · hooks · tests") }
                StatusBadge(status: store.currentTask.status)
                Button("Review pending action") { tab = "Decision" }.buttonStyle(InkButtonStyle(primary: true)).frame(minHeight: 44)
                Text("Files and results stay on your server.").font(Ink.font(11)).foregroundStyle(Ink.tertiary)
            }.padding(.horizontal, 22)
        }
    }
}

struct PhoneTaskComposer: View {
    @Environment(MockStore.self) private var store
    var sent: () -> Void
    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 18) {
            TextField("What should Outpost do?", text: $store.composer, axis: .vertical).textFieldStyle(.plain).font(Ink.font(14)).lineLimit(4...8).padding(14).background(Ink.raised).clipShape(RoundedRectangle(cornerRadius: 9))
            Button("Start sample task") { store.destination = .home; store.send(); sent() }.buttonStyle(InkButtonStyle(primary: true)).disabled(store.composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Text("Preview only · No work is executed").font(Ink.font(11)).foregroundStyle(Ink.tertiary)
        }
    }
}
