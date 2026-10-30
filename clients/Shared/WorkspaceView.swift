import SwiftUI

public struct WorkspaceView: View {
    @Environment(Connection.self) private var connection
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var phase
    @State private var selection: String? = "home"
    @State private var newTask = false
    public init() {}
    public var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Label("Home", systemImage: "square.grid.2x2").tag("home")
                Label("Decisions", systemImage: "checkmark.shield").badge(connection.records("action").filter { $0.text("state") == "pending" }.count).tag("decisions")
                Label("Capabilities", systemImage: "square.stack.3d.up").tag("capabilities")
                Label("Outputs", systemImage: "doc.on.doc").tag("outputs")
                Label("Automations", systemImage: "clock").tag("automations")
                Label("Memory", systemImage: "text.book.closed").tag("memory")
                Section("Recent Tasks") {
                    ForEach(connection.records("task").reversed()) { task in
                        VStack(alignment: .leading, spacing: 5) { Text(task.title).lineLimit(2); Text(task.text("state").replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.secondary) }.padding(.vertical, 6).tag(task.id)
                    }
                }
                Label("Connection", systemImage: "network").tag("connection").accessibilityIdentifier("nav.connection")
            }
            .navigationTitle("Outpost").navigationSplitViewColumnWidth(min: 205, ideal: 230, max: 300)
            .toolbar { Button { newTask = true } label: { Label("New Task", systemImage: "plus") }.keyboardShortcut("n").accessibilityIdentifier("new-task").disabled(!connection.connected) }
        } detail: {
            VStack(spacing: 0) {
                status
                Group {
                    if let task = connection.records("task").first(where: { $0.id == selection }) { TaskWorkbench(taskID: task.id) }
                    else {
                        switch selection {
                        case "decisions": DecisionList()
                        case "capabilities": CatalogueView()
                        case "outputs": OutputList()
                        case "automations": RecordsView(kind: "automation", title: "Automations", empty: "No scheduled work. Create a schedule when its scope and timing are ready.")
                        case "memory": RecordsView(kind: "memory", title: "Memory", empty: "No saved memories. Preferences never grant authority.")
                        case "connection": ConnectionView()
                        default: home
                        }
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(scheme == .dark ? Studio.hex(0x0f1011) : Studio.hex(0xefefed))
            .toolbar { Button { Task { await connection.connect() } } label: { Label("Reconnect", systemImage: "arrow.clockwise") }.keyboardShortcut("r").disabled(connection.busy) }
        }
        .font(Studio.body).tint(.primary)
        .sheet(isPresented: $newTask) { NewTaskView { selection = $0 } }
        .task(id: phase) {
            guard phase == .active else { return }
            await connection.connect()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { break }
                if connection.connected { await connection.sync() } else { await connection.connect() }
            }
        }
    }
    private var status: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(connection.connected ? "Connected · server-owned history" : "Disconnected · last-known history", systemImage: connection.connected ? "network" : "wifi.slash")
                Spacer()
                if connection.busy { ProgressView().controlSize(.small) }
                if let sync = connection.lastSync { Text(sync, style: .relative).foregroundStyle(.secondary) }
            }.font(.caption)
            if let error = connection.error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            if connection.hasPendingCommand { HStack { Text(connection.commandStatus).font(.caption); Button("Retry Same Command") { Task { await connection.retryPending() } } } }
        }.padding(.horizontal, 24).padding(.vertical, 12)
    }
    private var home: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Your work, in good hands.").font(Studio.heading)
                    Text("A persistent workspace for code, personal work, and your server.").foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 18) {
                    Text("What would you like to get done?").font(.title3)
                    Text("Describe an outcome. Outpost keeps the instructions, decisions, and evidence together.").foregroundStyle(.secondary)
                    Button("Start a Task", systemImage: "arrow.up") { newTask = true }.buttonStyle(.borderedProminent).controlSize(.large).disabled(!connection.connected)
                }.padding(28).frame(maxWidth: .infinity, alignment: .leading).studioPanel()
                HStack { Text("Ongoing Work").font(.headline); Spacer(); Text("\(connection.records("task").count) tasks").foregroundStyle(.secondary) }
                if connection.records("task").isEmpty {
                    ContentUnavailableView("A Clear Workspace", systemImage: "tray", description: Text("Connect your server and start your first task. No sample outcomes are presented as real work."))
                }
                ForEach(connection.records("task").reversed()) { task in
                    Button { selection = task.id } label: {
                        HStack(alignment: .top, spacing: 16) {
                            Image(systemName: task.text("profile") == "code" ? "chevron.left.forwardslash.chevron.right" : task.text("profile") == "operations" ? "server.rack" : "globe")
                            VStack(alignment: .leading, spacing: 6) { Text(task.title).foregroundStyle(.primary); Text(task.text("blocker").isEmpty ? task.text("state").replacingOccurrences(of: "_", with: " ") : task.text("blocker")).foregroundStyle(.secondary).font(.callout) }
                            Spacer(); Image(systemName: "chevron.right").foregroundStyle(.secondary)
                        }.padding(.vertical, 14).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    Divider()
                }
                Text("Private agent workspace · Review recorded actions and evidence.").font(.caption).foregroundStyle(.secondary)
            }.padding(32).frame(maxWidth: 1040, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
        }.navigationTitle("Workspace")
    }
}

struct NewTaskView: View {
    @Environment(Connection.self) private var connection
    @Environment(\.dismiss) private var dismiss
    @State private var goal = ""
    @State private var profile = "code"
    @State private var mode = "full_control"
    @State private var model = ""
    let onCreate: (String) -> Void
    var body: some View {
        NavigationStack {
            Form {
                Section("Outcome") { TextField("What should Outpost accomplish?", text: $goal, axis: .vertical).lineLimit(4...10).accessibilityIdentifier("task-goal") }
                Picker("Starting Profile", selection: $profile) { ForEach(["code", "browser", "operations", "research", "cowork", "chat"], id: \.self) { Text($0.capitalized).tag($0) } }
                ModePicker(mode: $mode)
                TextField("Ollama model (blank uses server default)", text: $model)
                Text("Full Control executes without individual approvals, including root commands on connected hosts when host administration is enabled. Ask Permission pauses before each action.").font(.callout).foregroundStyle(.secondary)
            }
            .navigationTitle("New Task").toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create Task") {
                        let key = UUID().uuidString.lowercased()
                        Task { await connection.send("task.create", id: key, revision: 0, payload: ["goal": .string(goal), "profile": .string(profile), "mode": .string(mode)].merging(model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [:] : ["model": .string(model.trimmingCharacters(in: .whitespacesAndNewlines))], uniquingKeysWith: { _, new in new })); if connection.error == nil { onCreate(key); dismiss() } }
                    }.accessibilityIdentifier("create-task").disabled(goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || connection.busy)
                }
            }
        }.frame(minWidth: 300, idealWidth: 520, minHeight: 380)
    }
}
struct ModePicker: View {
    @Binding var mode: String
    var body: some View { Picker("Control Mode", selection: $mode) { Text("Full Control").tag("full_control"); Text("Auto").tag("auto"); Text("Ask Permission").tag("ask_permission") } }
}
