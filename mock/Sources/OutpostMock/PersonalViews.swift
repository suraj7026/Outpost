import SwiftUI

struct ApprovalsView: View {
    @Environment(MockStore.self) private var store
    @State private var tab = "Pending"
    @State private var selectedID = "push"
    private var items: [Approval] { store.approvals.filter { tab == "Pending" ? !$0.resolved : $0.resolved } }
    private var selected: Approval? { items.first { $0.id == selectedID } ?? items.first }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                PageHeader(title: "Needs you", subtitle: "A few decisions that belong to you. Your agent will wait.") {
                    Text("\(store.pending.count) pending").font(Ink.font(12)).foregroundStyle(Ink.secondary).padding(.top, 10)
                }
                tabStrip(["Pending", "History"], selection: $tab)
                if let approval = selected {
                    HStack(alignment: .top, spacing: 30) {
                        VStack(spacing: 6) {
                            ForEach(items) { item in
                                Button { selectedID = item.id } label: {
                                    HStack(alignment: .top, spacing: 11) {
                                        Glyph(name: item.icon, size: 16).foregroundStyle(Ink.secondary).padding(.top, 2)
                                        VStack(alignment: .leading, spacing: 8) {
                                            Text(item.title).font(Ink.font(13, .medium)).fixedSize(horizontal: false, vertical: true)
                                            Text(item.type == "Administration" ? "Server access" : item.type).font(Ink.font(11)).foregroundStyle(Ink.tertiary)
                                        }.frame(maxWidth: .infinity, alignment: .leading)
                                    }.foregroundStyle(Ink.text).padding(15).frame(maxWidth: .infinity, alignment: .leading).background(approval.id == item.id ? Ink.raised : .clear).clipShape(RoundedRectangle(cornerRadius: 8)).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                            }
                        }.frame(width: 254)
                        Rectangle().fill(Ink.border).frame(width: 1, height: 420)
                        VStack(alignment: .leading, spacing: 22) {
                            HStack(spacing: 8) { Glyph(name: approval.icon, size: 13); Text(approval.type == "Account" ? "Protected account" : approval.type == "Administration" ? "Scoped administration" : approval.type == "Purchase" ? "Purchase authorization" : "Publish changes").font(Ink.font(12)); Spacer(); Tag(text: approval.resolved ? "Resolved" : "This action only") }.foregroundStyle(Ink.secondary)
                            Text(approval.title).font(Ink.font(25, .semibold)).tracking(-0.5).fixedSize(horizontal: false, vertical: true)
                            Text(approval.detail).font(Ink.font(14)).foregroundStyle(Ink.secondary).lineSpacing(6).fixedSize(horizontal: false, vertical: true)
                            Text(approval.target).font(Ink.mono(12)).lineSpacing(6).textSelection(.enabled).padding(18).frame(maxWidth: .infinity, alignment: .leading).background(Ink.raised.opacity(0.7)).clipShape(RoundedRectangle(cornerRadius: 8))
                            HStack(alignment: .top, spacing: 10) { Glyph(name: "checkmark.shield", size: 14); Text(approval.consequence).font(Ink.font(12)).lineSpacing(5) }.foregroundStyle(Ink.secondary)
                            Rectangle().fill(Ink.border).frame(height: 1)
                            HStack(spacing: 10) {
                                if approval.resolved {
                                    Label(approval.decision, systemImage: approval.decision.hasPrefix("Denied") ? "xmark.circle" : "checkmark.circle").font(Ink.font(13))
                                } else {
                                    Button(approval.type == "Purchase" ? "Review purchase" : approval.type == "Account" ? "Take over browser" : "Approve once") {
                                        if approval.type == "Purchase" { store.destination = .spending }
                                        else { store.decide(approval.id, allow: true) }
                                    }.buttonStyle(InkButtonStyle(primary: true))
                                    Button("Deny") { store.decide(approval.id, allow: false) }.buttonStyle(InkButtonStyle())
                                }
                                Spacer()
                            }
                            Button { store.openTask(approval.task) } label: { HStack(spacing: 6) { Text("View the task and evidence"); Glyph(name: "arrow.up.right", size: 10) }.font(Ink.font(12)).foregroundStyle(Ink.secondary) }.buttonStyle(.plain)
                            Text("Nothing runs in this preview.").font(Ink.font(11)).foregroundStyle(Ink.tertiary).padding(.top, 6)
                        }.padding(.top, 12).frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(.top, 8)
                } else { EmptyNotice(icon: "checkmark.circle", title: "You’re all caught up", detail: "Resolved decisions stay in the task history and audit trail.") }
            }.pageBody()
        }
    }
}

struct AccountsView: View {
    @Environment(MockStore.self) private var store
    @State private var connected: Set<String> = ["GitHub", "Northstar billing", "Domain registrar"]
    let accounts = [
        ("GitHub", "Agent account · 3 repositories", "Read code · Ask before publishing", "chevron.left.forwardslash.chevron.right"),
        ("Northstar billing", "Owner account · Protected browser", "Read invoices · Sign-in needed", "doc.text"),
        ("Domain registrar", "Owner account · Protected browser", "Read domains · Ask before purchases", "globe"),
        ("Mail & calendar", "Agent account · OAuth", "Read and draft · Ask before sending", "envelope")
    ]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                PageHeader(title: "Accounts", subtitle: "Agent accounts by default. Your accounts, only when you choose.") {
                    Button("Connect account") {
                        store.detail("Connect an account", icon: "person.crop.square", "Review the requested access, then sign in through the protected browser. This is a sample connection flow.", fields: [("Service", "Mail & Calendar"), ("Scope", "Read mail · Create drafts"), ("Sending", "Always ask first"), ("Storage", "Local vault on outpost-01")], confirm: "Connect sample account", action: { connected.insert("Mail & calendar"); store.notify("Sample account connected. No credentials collected.") })
                    }.buttonStyle(InkButtonStyle(primary: true))
                }
                Panel(title: "Connected services") {
                    VStack(spacing: 0) {
                        ForEach(accounts, id: \.0) { item in
                            HStack(spacing: 16) {
                                Glyph(name: item.3, size: 21).foregroundStyle(Ink.secondary)
                                VStack(alignment: .leading, spacing: 6) { Text(item.0).font(Ink.font(14, .medium)); Text(item.1).font(Ink.font(11)).foregroundStyle(Ink.tertiary) }
                                Spacer()
                                Text(item.2).font(Ink.font(11)).foregroundStyle(Ink.secondary)
                                Tag(text: connected.contains(item.0) ? "Connected" : "Not connected")
                                Menu {
                                    Button("Review access") { store.detail(item.0, icon: "key", "Review the identity and scope available to Pi.", fields: [("Identity", item.1), ("Access", item.2), ("Secrets", "Protected server vault")]) }
                                    Button(connected.contains(item.0) ? "Disconnect" : "Connect sample") {
                                        if connected.contains(item.0) { connected.remove(item.0) } else { connected.insert(item.0) }
                                        store.notify("\(item.0) connection updated in the preview.")
                                    }
                                } label: { Glyph(name: "ellipsis", size: 14) }.menuStyle(.borderlessButton).frame(width: 25)
                            }.padding(18)
                            Divider()
                        }
                    }
                }
                HStack(alignment: .top, spacing: 20) {
                    accountOption("Bring an existing Chrome session", "desktopcomputer", "Use a selected browser session on your Mac, with your permission.", "A local bridge is visible, temporary and revocable. It does not copy your whole Chrome profile.", "Preview Chrome pairing") {
                        store.detail("Connect your Chrome session", icon: "desktopcomputer", "Select the session and review what the agent can access.", fields: [("Device", "This MacBook"), ("Scope", "Selected billing session"), ("Duration", "15 minutes"), ("Passwords", "Not exported")], confirm: "Pair sample session", action: { store.notify("Sample Chrome bridge paired for 15 minutes.") })
                    }
                    accountOption("Import selected credentials", "key", "Move only the accounts you choose into the local vault.", "Review the destination and purpose. Secrets are never conversation attachments.", "Review sample import") {
                        store.detail("Review credential import", icon: "key", "Only these sample entries would move to the protected server vault.", fields: [("Entries", "Hosting account · Domain registrar"), ("Destination", "outpost-01 / personal vault"), ("Access", "Ask on first sensitive use")], confirm: "Import 2 sample entries", action: { store.notify("Two placeholders imported. No real passwords used.") })
                    }
                }
            }.pageBody()
        }
    }
    private func accountOption(_ title: String, _ icon: String, _ lead: String, _ detail: String, _ actionTitle: String, action: @escaping () -> Void) -> some View {
        Panel(title: title) {
            VStack(alignment: .leading, spacing: 15) {
                Glyph(name: icon, size: 25)
                Text(lead).font(Ink.font(13)).lineSpacing(5)
                Text(detail).font(Ink.font(12)).foregroundStyle(Ink.secondary).lineSpacing(5)
                Button(actionTitle, action: action).buttonStyle(InkButtonStyle())
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }.frame(maxWidth: .infinity)
    }
}

struct SpendingView: View {
    @Environment(MockStore.self) private var store
    @State private var tab = "Overview"
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                PageHeader(title: "Spending", subtitle: "Prepared by your agent. Authorized by you. Every purchase has a receipt.") {
                    Button("Manage limits") {
                        store.detail("Spending limits", icon: "creditcard", "Limits belong to the local budget ledger and supported payment instruments.", fields: [("Per purchase", "₹2,500"), ("Monthly", "₹10,000"), ("Recurring", "Always ask"), ("Automatic", "Off")], confirm: "Save preview limits", action: { store.notify("Preview limits saved.") })
                    }.buttonStyle(InkButtonStyle())
                }
                HStack(spacing: 0) { amount("This month", "₹4,680.00", "3 completed purchases"); amount("Awaiting approval", store.approvals.first(where: { $0.id == "purchase" })?.resolved == true ? "₹0.00" : "₹1,249.00", "1 prepared order"); amount("Remaining allowance", "₹5,320.00", "Of ₹10,000 monthly") }.padding(.bottom, 12)
                tabStrip(["Overview", "Receipts", "Standing rules"], selection: $tab)
                if tab == "Standing rules" {
                    Panel(title: "Your purchase rules") {
                        VStack(alignment: .leading, spacing: 18) {
                            Text("Approve the workflow once").font(Ink.font(17, .semibold))
                            Text("Review the complete workflow on Mac or iPhone. Outpost can then carry out the included checkout, verification and receipt steps within your approved limits.").font(Ink.font(13)).foregroundStyle(Ink.secondary).lineSpacing(6)
                            Tag(text: "Whole-workflow approval in every mode", icon: "lock")
                            Button("Create a bounded rule") { store.detail("Create a purchase rule", icon: "lock", "Name a supplier, purpose, amount, frequency and expiry.", fields: [("Supplier", "Approved domain registrar"), ("Purpose", "One-year renewal"), ("Maximum", "₹1,500 / one order"), ("Expiry", "After the next use")], confirm: "Save sample rule", action: { store.notify("Sample rule saved for review.") }) }.buttonStyle(InkButtonStyle())
                        }.padding(22)
                    }
                } else {
                    if tab == "Overview", let order = store.approvals.first(where: { $0.id == "purchase" }) { purchase(order) }
                    Text("Recent receipts").font(Ink.font(16, .semibold)).padding(.top, 8)
                    Panel {
                        VStack(spacing: 0) {
                            ForEach([("Server storage upgrade", "24 Oct 2026", "₹2,400.00"), ("Domain registration", "19 Oct 2026", "₹1,280.00"), ("Document signing credits", "11 Oct 2026", "₹1,000.00")], id: \.0) { item in
                                Button {
                                    store.detail(item.0, icon: "doc.text", "Sample receipt retained with its order and authorization history.", fields: [("Date", item.1), ("Amount", item.2), ("State", "Settled · Receipt retained"), ("Order", "DEMO-2026-1048")], confirm: "Open sample receipt", action: { store.notify("Sample receipt preview opened.") })
                                } label: {
                                    HStack(spacing: 14) {
                                        Glyph(name: "doc.text", size: 18)
                                        VStack(alignment: .leading, spacing: 5) { Text(item.0).font(Ink.font(13, .medium)); Text(item.1).font(Ink.font(11)).foregroundStyle(Ink.tertiary) }
                                        Spacer(); Tag(text: "Settled"); Text(item.2).font(Ink.mono(12)).frame(width: 110, alignment: .trailing); Glyph(name: "arrow.up.right", size: 11)
                                    }.padding(18).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                                Divider()
                            }
                        }
                    }
                }
            }.pageBody()
        }
    }
    private func purchase(_ order: Approval) -> some View {
        Panel {
            VStack(alignment: .leading, spacing: 20) {
                HStack { Tag(text: order.resolved ? order.decision : "Needs you", inverted: !order.resolved); Spacer(); Text("Prepared 8 minutes ago").font(Ink.font(11)).foregroundStyle(Ink.tertiary) }
                HStack(alignment: .top) { VStack(alignment: .leading, spacing: 10) { Text("Renew outpost-lab.dev").font(Ink.font(21, .semibold)); Text("Domain renewal · One year").font(Ink.font(13)).foregroundStyle(Ink.secondary) }; Spacer(); Text("₹1,249.00").font(Ink.font(25, .medium)) }
                Divider()
                HStack(spacing: 36) { field("Merchant", "Domain registrar"); field("Auto-renew", "Off"); field("Payment", "Approved workflow"); field("Total includes", "Tax and fees") }
                Text("The local broker checks the exact cart. A changed amount needs a new approval.").font(Ink.font(12)).foregroundStyle(Ink.secondary).lineSpacing(5)
                HStack {
                    Button("Deny purchase") { store.decide("purchase", allow: false) }.buttonStyle(InkButtonStyle()).disabled(order.resolved)
                    Spacer()
                    Button("Approve payment workflow") {
                        store.detail("Approve this payment workflow?", icon: "creditcard", "Authorize checkout, payment verification and receipt collection for this exact order. The real app requires current device authentication. This records a mock decision only.", fields: [("Merchant", "Domain registrar"), ("Item", "outpost-lab.dev / 1 year"), ("Total", "₹1,249.00 including fees"), ("Recurring", "No automatic renewal"), ("Includes", "Checkout · Verify payment · Collect receipt"), ("Expiry", "15 minutes")], confirm: "Approve sample workflow", action: { store.decide("purchase", allow: true) })
                    }.buttonStyle(InkButtonStyle(primary: true)).disabled(order.resolved)
                }
            }.padding(24)
        }
    }
    private func amount(_ label: String, _ value: String, _ caption: String) -> some View {
        VStack(alignment: .leading, spacing: 10) { Text(label).font(Ink.font(12)).foregroundStyle(Ink.secondary); Text(value).font(Ink.font(27, .medium)); Text(caption).font(Ink.font(11)).foregroundStyle(Ink.tertiary) }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func field(_ label: String, _ value: String) -> some View { VStack(alignment: .leading, spacing: 7) { Text(label).font(Ink.font(10)).foregroundStyle(Ink.tertiary); Text(value).font(Ink.font(12, .medium)) } }
}

struct AutomationsView: View {
    @Environment(MockStore.self) private var store
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                PageHeader(title: "Automations", subtitle: "Give it a schedule. Your server takes it from there.") {
                    Button("New automation") {
                        store.detail("Create an automation", icon: "clock.arrow.circlepath", "A recurring task with a defined scope and quiet notification rules.", fields: [("Task", "Check the health of outpost-01"), ("Schedule", "Daily at 09:00 IST"), ("Authority", "Read health and logs only"), ("Notify", "Only meaningful changes")], confirm: "Create sample automation", action: {
                            store.automations.insert(.init(id: UUID().uuidString, name: "Daily workspace check", schedule: "Daily at 09:00 IST", last: "Not run yet", next: "Tomorrow at 09:00", active: true, icon: "checkmark.shield"), at: 0)
                            store.notify("Sample automation created.")
                        })
                    }.buttonStyle(InkButtonStyle(primary: true))
                }
                HStack { Tag(text: "Scheduler on outpost-01", icon: "server.rack"); Text("Asia/Kolkata · Quiet when nothing changes").font(Ink.font(12)).foregroundStyle(Ink.tertiary); Spacer() }
                Panel {
                    VStack(spacing: 0) {
                        ForEach(store.automations) { automation in
                            HStack(spacing: 16) {
                                Glyph(name: automation.icon, size: 21).foregroundStyle(Ink.secondary)
                                VStack(alignment: .leading, spacing: 7) { Text(automation.name).font(Ink.font(14, .medium)); Text(automation.schedule).font(Ink.mono(11)).foregroundStyle(Ink.tertiary) }.frame(maxWidth: .infinity, alignment: .leading)
                                VStack(alignment: .leading, spacing: 6) { Text(automation.last).font(Ink.font(11)).foregroundStyle(Ink.secondary); Text("Next: \(automation.active ? automation.next : "Paused")").font(Ink.font(11)).foregroundStyle(Ink.tertiary) }.frame(width: 200, alignment: .leading)
                                Button(automation.active ? "Pause" : "Resume") { if let i = store.automations.firstIndex(where: { $0.id == automation.id }) { store.automations[i].active.toggle() }; store.notify("Automation updated in the preview.") }.buttonStyle(InkButtonStyle())
                                IconButton(icon: "ellipsis", label: "Automation options") {
                                    store.detail(automation.name, icon: automation.icon, "Every occurrence keeps its permission scope across retries.", fields: [("Schedule", automation.schedule), ("Last run", automation.last), ("Notify", "Changes or required action only"), ("Permissions", "Read-only unless approved")], confirm: "Run sample now", action: { store.notify("Sample run added to task history.") })
                                }
                            }.padding(20)
                            Divider()
                        }
                    }
                }
                Panel(title: "A useful kind of proactive") {
                    HStack(alignment: .top, spacing: 18) { Glyph(name: "bell.slash", size: 23); VStack(alignment: .leading, spacing: 10) { Text("Updates when they matter").font(Ink.font(15, .semibold)); Text("Monitors stay quiet while things are healthy. An action that needs permission waits in your inbox. In this self-hosted setup, iPhone catches up when you open the app.").font(Ink.font(13)).foregroundStyle(Ink.secondary).lineSpacing(6) } }.padding(22)
                }
            }.pageBody()
        }
    }
}

struct LibraryView: View {
    @Environment(MockStore.self) private var store
    @State private var search = ""
    @State private var tab = "Outputs"
    let files = [("October_operations.pdf", "PDF document", "Today, 21:08", "12 pages · 1.4 MB"), ("pipeline_reconciled.xlsx", "Spreadsheet", "Today, 20:42", "482 records · 284 KB"), ("search_tools_comparison.md", "Research report", "Today, 19:32", "6 sources · 18 KB"), ("filter-sync-test-trace.zip", "Diagnostic trace", "Yesterday", "3 files · 4.2 MB"), ("invoice_october_2026.pdf", "Invoice", "Today, 18:14", "3 pages · 128 KB")]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeader(title: "Library", subtitle: "The useful things your agent made, with the evidence behind them.") {
                    Button("Upload files") { store.detail("Upload files", icon: "tray.and.arrow.up", "A sample upload into your server workspace.", fields: [("Destination", "outpost-01 / documents"), ("File", "october-source.csv"), ("Processing", "Local document tools")], confirm: "Add sample file", action: { store.notify("Sample source added to Library.") }) }.buttonStyle(InkButtonStyle())
                }
                HStack { tabStrip(["Outputs", "Sources", "Templates", "Procedures"], selection: $tab); TextField("Search files", text: $search).inkField().frame(width: 190) }
                if tab == "Outputs" || tab == "Sources" {
                    Panel {
                        VStack(spacing: 0) {
                            ForEach(files.filter { search.isEmpty || $0.0.localizedCaseInsensitiveContains(search) }, id: \.0) { file in
                                Button { preview(file) } label: {
                                    HStack(spacing: 16) {
                                        Glyph(name: file.0.hasSuffix("xlsx") ? "tablecells" : "doc.text", size: 23).foregroundStyle(Ink.secondary)
                                        VStack(alignment: .leading, spacing: 6) { Text(file.0).font(Ink.font(13, .medium)); Text(file.1).font(Ink.font(11)).foregroundStyle(Ink.tertiary) }
                                        Spacer()
                                        Text(file.3).font(Ink.font(11)).foregroundStyle(Ink.secondary).frame(width: 165, alignment: .leading)
                                        Text(file.2).font(Ink.font(11)).foregroundStyle(Ink.tertiary).frame(width: 145, alignment: .leading)
                                        Glyph(name: "arrow.up.right", size: 12)
                                    }.padding(19).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                                Divider()
                            }
                        }
                    }
                } else {
                    ForEach(tab == "Templates" ? ["Operations report", "Research comparison", "Invoice summary"] : ["Deploy and verify a web service", "Collect monthly invoices", "Reproduce and fix a failing test"], id: \.self) { name in
                        Panel {
                            HStack(spacing: 14) {
                                Glyph(name: tab == "Templates" ? "doc.on.doc" : "list.bullet.clipboard", size: 23)
                                VStack(alignment: .leading, spacing: 6) { Text(name).font(Ink.font(14, .medium)); Text("Versioned · Owner-reviewed · Stored on outpost-01").font(Ink.font(11)).foregroundStyle(Ink.tertiary) }
                                Spacer()
                                Button("Use in a task") { store.composer = "Use the \(name.lowercased())"; store.destination = .home }.buttonStyle(InkButtonStyle())
                            }.padding(20)
                        }
                    }
                }
            }.pageBody()
        }
    }
    private func preview(_ file: (String, String, String, String)) {
        store.detail(file.0, icon: "doc.text", "Sample preview\n\nThree source files were reconciled. Uptime was 99.96%, with one incident resolved in 14 minutes. Monthly infrastructure costs stayed within budget.\n\nSources and calculation notes are retained with the report.", fields: [("Type", file.1), ("Modified", file.2), ("Details", file.3), ("Checks", "Rendered · Totals reconciled · Sources retained")], confirm: "Close preview")
    }
}

struct MemoryView: View {
    @Environment(MockStore.self) private var store
    @State private var search = ""
    @State private var hidden: Set<String> = []
    let memories = [("Project convention", "Use pnpm in storefront-web.", "Owner instruction · 24 Oct", "Project"), ("Working preference", "Show the calculation and source behind a reported number.", "Owner instruction · 22 Oct", "Personal"), ("Server fact", "The workspace is an Ubuntu guest. Approval authority stays on the host.", "Observed setup · 27 Oct", "Machine"), ("Procedure", "Run filter regression tests after changing product navigation.", "Verified task · Today", "Project"), ("Decision", "Use Ollama Cloud for inference; self-host every work tool.", "Owner instruction · Today", "Personal")]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                PageHeader(title: "Memory", subtitle: "What your agent remembers, where it came from, and what you can change.") {
                    Button("Add a memory") { store.detail("Remember something", icon: "brain", "A memory records context. It never grants permission to spend, send or use sudo.", fields: [("Sample note", "Use source-backed explanations"), ("Scope", "Personal"), ("Source", "Owner instruction")], confirm: "Save sample memory", action: { store.notify("Sample preference saved in the preview.") }) }.buttonStyle(InkButtonStyle())
                }
                HStack { Tag(text: "Local search & embeddings", icon: "server.rack"); Spacer(); TextField("Search memories", text: $search).inkField().frame(width: 230) }
                ForEach(memories.filter { !hidden.contains($0.1) && (search.isEmpty || ($0.0 + $0.1).localizedCaseInsensitiveContains(search)) }, id: \.1) { item in
                    Panel {
                        VStack(alignment: .leading, spacing: 14) {
                            HStack { Tag(text: item.0); Spacer(); Text(item.3).font(Ink.font(11)).foregroundStyle(Ink.tertiary) }
                            Text(item.1).font(Ink.font(15, .medium)).lineSpacing(5)
                            HStack {
                                Text(item.2).font(Ink.font(11)).foregroundStyle(Ink.tertiary); Spacer()
                                Button(store.pinnedMemories.contains(item.1) ? "Unpin" : "Pin") { if store.pinnedMemories.contains(item.1) { store.pinnedMemories.remove(item.1) } else { store.pinnedMemories.insert(item.1) } }.buttonStyle(.plain).font(Ink.font(11))
                                Button("Forget") { store.detail("Forget this memory?", icon: "brain", "Remove the sample from active recall. Historical task evidence remains separate.", fields: [("Memory", item.1)], confirm: "Forget sample memory", action: { hidden.insert(item.1); store.notify("Memory removed from the preview.") }) }.buttonStyle(.plain).font(Ink.font(11)).foregroundStyle(Ink.secondary)
                            }
                        }.padding(20)
                    }
                }
                Text("Preferences and context are separate from live grants and approval rules.").font(Ink.font(12)).foregroundStyle(Ink.tertiary)
            }.pageBody()
        }
    }
}
