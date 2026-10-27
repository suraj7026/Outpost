import SwiftUI
#if os(iOS)
import UIKit
import UserNotifications
#endif

public struct ConnectionView: View {
    @Environment(Connection.self) private var connection
    @State private var token = ""
    public init() {}
    public var body: some View {
        @Bindable var connection = connection
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Your Server. Your Workspace.").font(Studio.heading)
                Text("Pair this device with the coordinator. History and execution stay on your server; the device signing key stays in Keychain.").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 16) {
                    TextField("Server URL", text: $connection.serverURL).textFieldStyle(.roundedBorder).accessibilityLabel("Server URL")
                    SecureField("One-time bootstrap token", text: $token).textFieldStyle(.roundedBorder)
                    HStack {
                        Button("Pair First Device") { let value = token; token = ""; Task { await connection.pair(token: value) } }.buttonStyle(.borderedProminent).disabled(token.isEmpty || connection.busy)
                        Button("Reconnect") { Task { await connection.connect() } }.buttonStyle(.bordered).disabled(connection.busy)
                    }
                    Text("Bootstrap pairing closes after the first device. Additional devices must be enrolled by an already trusted device. Remote connections require HTTPS.").font(.callout).foregroundStyle(.secondary)
                }.padding(24).studioPanel()
                LabeledContent("Device", value: connection.deviceID).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                DisclosureGroup("Public Pairing Key") { Text(connection.publicKey).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                #if os(iOS)
                Button("Enable Apple Notifications") {
                    Task {
                        do { if try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { UIApplication.shared.registerForRemoteNotifications() } }
                        catch { connection.error = error.localizedDescription }
                    }
                }.buttonStyle(.bordered).disabled(!connection.connected)
                #endif
                Text("Development boundary").font(.headline)
                Text("The local server is bound to loopback. Host isolation, APNs provisioning, account connectors, payments, and Cloud model qualification are not enabled by pairing.").foregroundStyle(.secondary)
                if let error = connection.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }.padding(32).frame(maxWidth: 760, alignment: .leading)
        }.navigationTitle("Connection")
    }
}
struct CatalogueView: View {
    @State private var query = ""
    private var features: [Feature] { FeatureCatalogue.all.filter { query.isEmpty || "\($0.id) \($0.name) \($0.module)".localizedCaseInsensitiveContains(query) } }
    var body: some View {
        List {
            Section {
                Text("Capability Roadmap").font(Studio.heading)
                Text("All 270 specification entries are indexed below. Catalogue coverage is not implementation completion. Backend slices and qualification gaps are recorded in docs/implementation.").foregroundStyle(.secondary)
            }
            ForEach(Array(Set(features.map(\.module))).sorted(), id: \.self) { module in
                Section(module) {
                    ForEach(features.filter { $0.module == module }) { feature in
                        DisclosureGroup {
                            Text(feature.requirement).padding(.vertical, 8).textSelection(.enabled)
                            Text("Specification requirement · production acceptance pending").font(.caption).foregroundStyle(.secondary)
                        } label: {
                            VStack(alignment: .leading, spacing: 5) { Text(feature.name); Text(feature.id).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary) }.padding(.vertical, 6)
                        }
                    }
                }
            }
        }.searchable(text: $query, prompt: "Find a capability or feature ID").navigationTitle("Capabilities")
    }
}
struct RecordsView: View {
    @Environment(Connection.self) private var connection
    let kind: String; let title: String; let empty: String
    @State private var editing = false
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 24) {
            HStack { Text(title).font(Studio.heading); Spacer(); Button("Add", systemImage: "plus") { editing = true }.disabled(!connection.connected) }
            if connection.records(kind).isEmpty { Text(empty).foregroundStyle(.secondary) }
            ForEach(connection.records(kind)) { record in
                VStack(alignment: .leading, spacing: 12) {
                    Text(record.title).font(.headline)
                    if kind == "memory" {
                        Text("Source: " + record.text("source")).font(.caption).foregroundStyle(.secondary)
                        Button("Forget", role: .destructive) { Task { await connection.send("memory.forget", id: record.id, revision: record.revision) } }
                    } else {
                        Text(record.data["paused"] == .bool(true) ? "Paused" : "Active").foregroundStyle(.secondary)
                        Button(record.data["paused"] == .bool(true) ? "Resume Schedule" : "Pause Schedule") { var payload = record.data; payload["paused"] = .bool(record.data["paused"] != .bool(true)); Task { await connection.send("automation.save", id: record.id, revision: record.revision, payload: payload) } }
                    }
                }.padding(22).frame(maxWidth: .infinity, alignment: .leading).studioPanel()
            }
        }.padding(28) }.navigationTitle(title).sheet(isPresented: $editing) { RecordEditor(kind: kind) }
    }
}
struct RecordEditor: View {
    @Environment(Connection.self) private var connection
    @Environment(\.dismiss) private var dismiss
    let kind: String
    @State private var text = ""
    @State private var date = Date().addingTimeInterval(3600)
    @State private var repeatDaily = false
    var body: some View {
        NavigationStack {
            Form {
                TextField(kind == "memory" ? "Preference or project fact" : "Scheduled task outcome", text: $text, axis: .vertical).lineLimit(3...8)
                if kind == "automation" { DatePicker("First Run", selection: $date); Toggle("Repeat Every 24 Hours", isOn: $repeatDaily); Text("Timezone: \(TimeZone.current.identifier). Missed runs coalesce into one task. Runs use Ask permission.").font(.caption) }
                else { Text("Saved as an owner-confirmed personal note. This cannot authorize any action. Forgetting removes current retrieval, not retained audit or backups.").font(.caption) }
            }.navigationTitle(kind == "memory" ? "Remember" : "Schedule Work").toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task {
                    let payload: [String: JSONValue] = kind == "memory" ? ["text": .string(text), "project": .string("personal"), "identityId": .string("agent-local"), "source": .string("Owner native client"), "provenance": .string("owner")] : ["name": .string(text), "timezone": .string(TimeZone.current.identifier), "nextAt": .number(floor(date.timeIntervalSince1970*1000)), "intervalMs": repeatDaily ? .number(86_400_000) : .null, "missed": .string("coalesce"), "paused": .bool(false), "task": .object(["goal": .string(text), "profile": .string("cowork"), "mode": .string("ask_permission")])]
                    await connection.send(kind == "memory" ? "memory.save" : "automation.save", id: UUID().uuidString.lowercased(), revision: 0, payload: payload)
                    if connection.error == nil { dismiss() }
                } }.disabled(text.isEmpty || connection.busy) }
            }
        }.frame(minWidth: 300, idealWidth: 500, minHeight: 360)
    }
}
