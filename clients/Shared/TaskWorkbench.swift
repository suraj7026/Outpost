import SwiftUI
import UniformTypeIdentifiers

struct TaskWorkbench: View {
    @Environment(Connection.self) private var connection
    let taskID: String
    @State private var reply = ""
    @State private var pane = "Conversation"
    @State private var confirmCancel = false
    @State private var importing = false
    private var task: ServerRecord? { connection.records("task").first { $0.id == taskID } }
    private var policy: ServerRecord? { connection.records("policy").first { $0.id == taskID } }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let task {
                VStack(alignment: .leading, spacing: 12) {
                    Text(task.text("profile").capitalized + " / Agent workspace").font(.caption).foregroundStyle(.secondary)
                    Text(task.title).font(Studio.heading).textSelection(.enabled)
                    ViewThatFits {
                        HStack { policyControl; Spacer(); taskControls(task) }
                        VStack(alignment: .leading, spacing: 12) { policyControl; taskControls(task) }
                    }
                }
                GeometryReader { geometry in
                    if geometry.size.width >= 830 {
                        HStack(alignment: .top, spacing: 16) { conversation; evidence.frame(width: min(400, geometry.size.width*0.38)) }
                    } else {
                        VStack(spacing: 12) {
                            Picker("Task Pane", selection: $pane) { Text("Conversation").tag("Conversation"); Text("Evidence").tag("Evidence") }.pickerStyle(.segmented)
                            if pane == "Conversation" { conversation } else { evidence }
                        }
                    }
                }
            }
        }.padding(24).navigationTitle("Task")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
            switch result {
            case .success(let url): Task { await connection.upload(url, taskID: taskID) }
            case .failure(let error): connection.error = error.localizedDescription
            }
        }
        .confirmationDialog("Cancel this task? Already completed external effects cannot be undone.", isPresented: $confirmCancel) {
            Button("Cancel Task", role: .destructive) { if let task { Task { await connection.send("task.cancel", id: taskID, revision: task.revision) } } }
        }
    }
    private var policyControl: some View {
        Group {
            if let policy {
                ModePicker(mode: Binding(get: { policy.text("mode") }, set: { mode in Task { await connection.send("policy.change", id: taskID, revision: policy.revision, payload: ["mode": .string(mode)], authenticate: true) } })).fixedSize().disabled(!connection.connected || connection.busy)
            }
        }
    }
    private func taskControls(_ task: ServerRecord) -> some View {
        HStack {
            Text(task.text("state").replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.secondary)
            if !["completed", "cancelled"].contains(task.text("state")) {
                let resumable = ["paused", "failed", "interrupted", "waiting_for_capacity"].contains(task.text("state"))
                Button(resumable ? "Resume" : "Pause", systemImage: resumable ? "play" : "pause") { Task { await connection.send(resumable ? "task.resume" : "task.pause", id: taskID, revision: task.revision) } }
                Button("Cancel", role: .destructive) { confirmCancel = true }
            }
        }.buttonStyle(.bordered).disabled(!connection.connected || connection.busy)
    }
    private var conversation: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    ForEach(connection.records("message", taskID: taskID)) { message in
                        VStack(alignment: .leading, spacing: 10) {
                            Label(message.text("author") == "owner" ? "You" : "Outpost · AI Agent", systemImage: message.text("author") == "owner" ? "person.crop.circle" : "square.stack.3d.up").font(.headline)
                            Text(message.text("text")).lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    if let task, !task.text("blocker").isEmpty {
                        Label(task.text("blocker"), systemImage: "pause.circle").foregroundStyle(.secondary).padding(16).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                    }
                }.padding(24)
            }
            VStack(alignment: .leading, spacing: 12) {
                TextField("Reply or give Outpost a next step…", text: $reply, axis: .vertical).lineLimit(2...6).textFieldStyle(.plain).accessibilityLabel("Steer this task")
                HStack {
                    Button { importing = true } label: { Label("Attach File", systemImage: "paperclip") }.buttonStyle(.borderless).disabled(!connection.connected || connection.busy)
                    Text("Server execution").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button { let text = reply; Task { if let task { await connection.send("task.steer", id: taskID, revision: task.revision, payload: ["text": .string(text)]); if connection.error == nil { reply = "" } } } } label: { Label("Send", systemImage: "arrow.up") }.buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command).disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || connection.busy || !connection.connected)
                }
            }.padding(18).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 22)).padding(16)
        }.studioPanel()
    }
    private var evidence: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Evidence & Decisions").font(.headline)
                Text("Exact actions and observed results. Approval is not completion.").font(.callout).foregroundStyle(.secondary)
                ForEach(connection.records("action", taskID: taskID)) { action in ActionCard(action: action); Divider() }
                ForEach(connection.records("operation", taskID: taskID).filter { $0.text("state") == "unknown" }) { operation in
                    Label(operation.text("error") + ". Check the recorded action before retrying.", systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
                }
                if connection.records("action", taskID: taskID).isEmpty { Text("No tool actions yet.").foregroundStyle(.secondary) }
                Button("Inspect Machine", systemImage: "server.rack") { Task { await connection.send("action.propose", id: taskID, revision: task?.revision ?? 0, payload: ["tool": .string("system.inspect"), "arguments": .object([:])]) } }.buttonStyle(.bordered).disabled(!connection.connected || connection.busy)
                Text("Creates a real, read-only action under this task’s current control mode.").font(.caption).foregroundStyle(.secondary)
                OutputList(taskID: taskID)
            }.padding(22)
        }.studioPanel()
    }
}
struct ActionCard: View {
    @Environment(Connection.self) private var connection
    let action: ServerRecord
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(action.text("tool"), systemImage: "checkmark.shield").font(.headline)
            Text(action.text("state").replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.secondary)
            Text("Target: " + action.text("target")).font(.callout).textSelection(.enabled)
            Text("Identity: " + action.text("identityRef")).font(.caption).foregroundStyle(.secondary)
            Text(action.data["arguments"]?.pretty ?? "{}").font(.system(.callout, design: .monospaced)).textSelection(.enabled)
            Text(action.text("review")).font(.callout).foregroundStyle(.secondary)
            if action.text("state") == "pending" {
                ViewThatFits {
                    HStack { deny; approve }
                    VStack(alignment: .leading) { deny; approve }
                }.disabled(connection.busy || !connection.connected)
            } else if action.text("state") == "authorized" {
                Button("Run Approved Action") { Task { await connection.send("action.dispatch", id: action.id, revision: action.revision) } }.buttonStyle(.borderedProminent).disabled(!connection.connected || connection.busy)
            }
            if let result = action.data["result"], result != .null {
                DisclosureGroup("Observed Result") { Text(result.pretty).font(.system(.callout, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            }
        }.padding(.vertical, 6)
    }
    private var deny: some View { Button("Deny") { decide("deny") }.buttonStyle(.bordered).controlSize(.large) }
    private var approve: some View { Button("Approve Once") { decide("approve") }.buttonStyle(.borderedProminent).controlSize(.large) }
    private func decide(_ decision: String) { Task { await connection.send("approval.decide", id: action.id, revision: action.revision, payload: ["nonce": .string(action.text("nonce")), "actionDigest": .string(action.text("actionDigest")), "decision": .string(decision)], authenticate: true) } }
}
struct DecisionList: View {
    @Environment(Connection.self) private var connection
    var body: some View {
        ScrollView { LazyVStack(alignment: .leading, spacing: 24) {
            Text("Decisions").font(Studio.heading)
            if connection.records("action").filter({ $0.text("state") == "pending" }).isEmpty { ContentUnavailableView("Nothing Waiting on You", systemImage: "checkmark.shield", description: Text("Pending actions appear here even if a push notification is missed.")) }
            ForEach(connection.records("action").filter { $0.text("state") == "pending" }) { action in ActionCard(action: action).padding(24).studioPanel() }
        }.padding(28) }.navigationTitle("Decisions")
    }
}
struct OutputList: View {
    @Environment(Connection.self) private var connection
    var taskID: String? = nil
    @State private var downloads: [String: URL] = [:]
    var body: some View {
        ScrollView { LazyVStack(alignment: .leading, spacing: 16) {
            Text("Outputs").font(.headline)
            if connection.records("artifact", taskID: taskID).isEmpty { Text("Verified deliverables will appear here.").foregroundStyle(.secondary) }
            ForEach(connection.records("artifact", taskID: taskID)) { artifact in
                VStack(alignment: .leading, spacing: 8) {
                    Label(artifact.title, systemImage: "doc"); Text(artifact.text("mime")).font(.caption).foregroundStyle(.secondary)
                    if let url = downloads[artifact.id] { ShareLink(item: url) { Label("Share Verified File", systemImage: "square.and.arrow.up") } }
                    else { Button("Download & Verify") { Task { do { downloads[artifact.id] = try await connection.download(artifact) } catch { connection.error = error.localizedDescription } } }.disabled(!connection.connected) }
                }.padding(.vertical, 8)
            }
        }.padding(16) }
    }
}
