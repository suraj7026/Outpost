import SwiftUI

struct HomeView: View {
    @Environment(MockStore.self) private var store
    private var active: [DemoTask] { store.tasks.filter { $0.status != "Done" }.prefix(4).map { $0 } }
    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("Tuesday, 27 October").font(Ink.font(12)).foregroundStyle(Ink.tertiary)
                        Spacer()
                        Button { store.detail("Your workspace", icon: "server.rack", "Pi and every tool live on your Ubuntu server. Only model inference goes to Ollama Cloud.", fields: [("Machine", "outpost-01 / Ubuntu 24.04"), ("Harness", "Pi"), ("Inference", "Ollama Cloud"), ("Tools", "Self-hosted on this server")]) } label: { HStack(spacing: 6) { Glyph(name: "server.rack", size: 12); Text("Your setup") }.font(Ink.font(12)) }.buttonStyle(.plain).foregroundStyle(Ink.secondary)
                    }.padding(.bottom, 30)
                    Text("What should we work on?").font(Ink.font(34, .semibold)).tracking(-1.1)
                    Text("A task, a question, or something you’ve been meaning to get to.").font(Ink.font(14)).foregroundStyle(Ink.secondary).padding(.top, 11).padding(.bottom, 24)
                    ComposerView(home: true)
                    HStack(spacing: 24) {
                        suggestion("Fix a coding issue", "chevron.left.forwardslash.chevron.right", "Find and fix the filter chip sync bug", mode: "Code")
                        suggestion("Research an idea", "magnifyingglass", "Compare self-hosted search tools", mode: "Research")
                        suggestion("Check the server", "server.rack", "Check the health of outpost-01", mode: "Operations")
                    }.padding(.top, 16).padding(.bottom, 36)
                    Rectangle().fill(Ink.border).frame(height: 1).padding(.bottom, 28)
                    if geometry.size.width > 1020 {
                        HStack(alignment: .top, spacing: 36) {
                            workList.frame(maxWidth: .infinity)
                            Rectangle().fill(Ink.border).frame(width: 1, height: 312)
                            decisionList.frame(width: 310)
                        }
                    } else { VStack(alignment: .leading, spacing: 32) { workList; decisionList } }
                    HStack(spacing: 7) { Glyph(name: "checkmark.shield", size: 11); Text("Tools and files stay on your server."); Text("Only inference goes to Ollama Cloud.").foregroundStyle(Ink.tertiary) }.font(Ink.font(11)).foregroundStyle(Ink.secondary).padding(.top, 32)
                }.pageBody()
            }
        }
    }
    private var workList: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text("Pick up your work").font(Ink.font(16, .semibold)); Spacer(); Button("All tasks") { store.destination = .tasks }.font(Ink.font(12)).foregroundStyle(Ink.secondary).buttonStyle(.plain) }
            VStack(spacing: 0) {
                ForEach(active) { task in
                    Button { store.openTask(task.id) } label: {
                        HStack(alignment: .top, spacing: 13) {
                            Glyph(name: task.icon, size: 16).foregroundStyle(Ink.secondary).frame(width: 28, height: 33)
                            VStack(alignment: .leading, spacing: 7) { Text(task.title).font(Ink.font(13, .medium)).lineLimit(1); Text(task.project).font(Ink.font(11)).foregroundStyle(Ink.tertiary) }
                            Spacer(minLength: 6)
                            VStack(alignment: .trailing, spacing: 6) { StatusBadge(status: task.status); Text(task.time).font(Ink.font(10)).foregroundStyle(Ink.tertiary) }
                        }.padding(.vertical, 15).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    Rectangle().fill(Ink.border.opacity(0.7)).frame(height: 1).padding(.leading, 41)
                }
            }
        }
    }
    private var decisionList: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) { Text("A moment of your attention").font(Ink.font(16, .semibold)); Spacer(); if !store.pending.isEmpty { Text("\(store.pending.count)").font(Ink.font(11, .medium)).foregroundStyle(Ink.inverse).frame(width: 21, height: 21).background(Ink.text).clipShape(Circle()) } }
            if store.pending.isEmpty { Text("You’re all caught up. Your agent has what it needs.").font(Ink.font(13)).foregroundStyle(Ink.secondary).lineSpacing(5).padding(.top, 16) }
            ForEach(store.pending.prefix(3)) { approval in
                Button { store.destination = approval.type == "Purchase" ? .spending : .approvals } label: {
                    HStack(alignment: .top, spacing: 11) {
                        Glyph(name: approval.icon, size: 14).foregroundStyle(Ink.secondary).padding(.top, 2)
                        VStack(alignment: .leading, spacing: 7) { Text(approval.title).font(Ink.font(13, .medium)); Text(approval.type == "Command" ? "Ready to publish · 3 files changed" : approval.type == "Administration" ? "Scoped access · 18.2 GB cache" : approval.type == "Account" ? "Your sign-in is needed" : "One-time payment · ₹1,249").font(Ink.font(11)).foregroundStyle(Ink.tertiary) }
                        Spacer(minLength: 0); Glyph(name: "chevron.right", size: 9).foregroundStyle(Ink.tertiary).padding(.top, 4)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 14).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            Button { store.destination = .approvals } label: { HStack(spacing: 6) { Text("Review decisions"); Glyph(name: "arrow.right", size: 11) }.font(Ink.font(12, .medium)) }.buttonStyle(.plain).padding(.top, 4)
        }
    }
    private func suggestion(_ title: String, _ icon: String, _ prompt: String, mode: String) -> some View {
        Button { store.mode = mode; store.composer = prompt } label: { HStack(spacing: 7) { Glyph(name: icon, size: 12); Text(title).font(Ink.font(12)) }.foregroundStyle(Ink.secondary) }.buttonStyle(.plain)
    }
}

struct ComposerView: View {
    @Environment(MockStore.self) private var store
    var home = false
    var body: some View {
        @Bindable var store = store
        VStack(alignment:.leading,spacing:14) {
            TextField(home ? "Ask Outpost to do something…" : "Reply, steer the task, or add a follow-up…",text:$store.composer,axis:.vertical).textFieldStyle(.plain).font(Ink.font(14)).lineLimit(3...6).onSubmit { store.send() }.padding(.top,3)
            HStack(spacing:10) {
                IconButton(icon:"paperclip",label:"Attach sample files") { store.detail("Attach files",icon:"paperclip","Choose a sample file to add to this mock task.",fields:[("Sample files","october.csv · infrastructure.pdf · screenshot.png")],confirm:"Attach sample",action:{store.notify("october.csv attached to the preview task.")}) }
                Menu { ForEach(["Chat","Cowork","Code","Browser","Operations","Research"],id:\.self) { name in Button(name) { store.mode = name } } } label:{ HStack(spacing:5) { Glyph(name:"square.stack",size:12); Text(store.mode); Glyph(name:"chevron.down",size:8) }.font(Ink.font(11)) }.menuStyle(.borderlessButton).fixedSize()
                Text("outpost-01").font(Ink.mono(10)).foregroundStyle(Ink.tertiary)
                Spacer(minLength:4)
                Menu { Button("Qwen Coder / Ollama Cloud") { store.notify("Qwen Coder selected in the mock.") }; Button("Vision / Ollama Cloud") { store.notify("Vision role selected in the mock.") }; Button("Model settings") { store.settingsTab = "Models"; store.destination = .settings } } label:{ Text("Ollama Cloud").font(Ink.mono(10)).foregroundStyle(Ink.secondary) }.menuStyle(.borderlessButton).fixedSize()
                Button { store.send() } label:{ Glyph(name:"arrow.up",size:14).frame(width:30,height:30).foregroundStyle(Ink.inverse).background(Ink.text).clipShape(RoundedRectangle(cornerRadius:6)) }.buttonStyle(.plain).disabled(store.composer.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty).opacity(store.composer.isEmpty ? 0.4 : 1).help("Send mock task").accessibilityLabel("Send mock task")
            }
        }.padding(18).background(Ink.surface).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(Ink.strong.opacity(0.85))).shadow(color: .black.opacity(home ? 0.06 : 0), radius: 14, y: 5)
    }
}

struct TaskRow: View {
    @Environment(MockStore.self) private var store
    var task: DemoTask
    var body: some View {
        Button { store.openTask(task.id) } label: {
            HStack(spacing:14) {
                Glyph(name:task.icon,size:16).foregroundStyle(Ink.secondary)
                VStack(alignment:.leading,spacing:5) { Text(task.title).font(Ink.font(13,.medium)).lineLimit(1); HStack(spacing:8) { Text(task.project).font(Ink.mono(11)); Text(task.summary).font(Ink.font(11)).lineLimit(1) }.foregroundStyle(Ink.tertiary) }
                Spacer(minLength:8); Text(task.time).font(Ink.font(11)).foregroundStyle(Ink.tertiary); StatusBadge(status:task.status).frame(width:95,alignment:.trailing)
            }.padding(.horizontal,18).frame(minHeight:66).contentShape(Rectangle())
        }.buttonStyle(.plain).overlay(alignment:.bottom){ Rectangle().fill(Ink.border).frame(height:1).padding(.leading,48) }
    }
}

struct TasksView: View {
    @Environment(MockStore.self) private var store
    var filtered:[DemoTask] { store.tasks.filter { (store.taskFilter == "All tasks" || $0.status == store.taskFilter) && (store.taskSearch.isEmpty || ($0.title + $0.project + $0.mode).localizedCaseInsensitiveContains(store.taskSearch)) } }
    var body: some View {
        @Bindable var store = store
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                PageHeader(title:"Tasks",subtitle:"A single place for everything your agent is working on.") { Button("New task") { store.destination = .home }.buttonStyle(InkButtonStyle(primary:true)) }
                HStack(spacing:5) { ForEach(["All tasks","Running","Needs you","Done","Failed"],id:\.self) { filter in Button(filter) { store.taskFilter = filter }.buttonStyle(InkButtonStyle(primary:store.taskFilter == filter)) }; Spacer(); TextField("Search tasks",text:$store.taskSearch).inkField().frame(width:220) }
                if filtered.isEmpty { EmptyNotice(icon:"magnifyingglass",title:"No matching tasks",detail:"Try another title, project or status.") }
                else { Panel { VStack(spacing:0) { ForEach(filtered) { TaskRow(task:$0) } } } }
                Text("Tasks keep their files, browser state and history on outpost-01.").font(Ink.font(12)).foregroundStyle(Ink.tertiary)
            }.pageBody()
        }
    }
}

struct WorkbenchView: View {
    @Environment(MockStore.self) private var store
    var task:DemoTask { store.currentTask }
    var body: some View {
        GeometryReader { geometry in
            VStack(spacing:0) {
                HStack(spacing:10) {
                    Glyph(name:task.icon); Text(task.title).font(Ink.font(14,.semibold)).lineLimit(1); Spacer(minLength:8)
                    StatusBadge(status:task.status)
                    Button { store.detail("Restore turn 3?",icon:"arrow.uturn.backward","Restore both the task files and conversation to the checkpoint before the last change. This only changes preview data.",fields:[("Checkpoint","Before turn 3"),("Files","3 files in fix/filter-sync")],confirm:"Restore checkpoint",action:{store.notify("Checkpoint restored in the preview.")}) } label:{ Label("Undo turn",systemImage:"arrow.uturn.backward") }.buttonStyle(InkButtonStyle())
                    IconButton(icon:"pause",label:"Pause task") { store.setStatus(task.id,"Paused"); store.notify("Task paused in the preview.") }
                }.padding(.horizontal,22).frame(height:58).background(Ink.surface)
                Rectangle().fill(Ink.border).frame(height:1)
                HStack(spacing:0) {
                    VStack(spacing:0) {
                        ScrollView {
                            VStack(alignment:.leading,spacing:20) {
                                HStack(spacing:7) { Glyph(name:"desktopcomputer",size:11); Text("Shared task history · running on outpost-01").font(Ink.font(10)).foregroundStyle(Ink.tertiary); Spacer() }.padding(.bottom,4)
                                Text(userRequest).font(Ink.font(13)).lineSpacing(5).padding(14).frame(maxWidth:.infinity,alignment:.leading).background(Ink.raised).clipShape(RoundedRectangle(cornerRadius:10))
                                HStack(spacing:7) { Glyph(name:"square.inset.filled",size:13); Text("Outpost").font(Ink.font(12,.medium)); Text("Pi / Ollama Cloud").font(Ink.mono(10)).foregroundStyle(Ink.tertiary) }
                                Text(intro).font(Ink.font(13)).lineSpacing(6).fixedSize(horizontal:false,vertical:true)
                                toolRows
                                Text(explanation).font(Ink.font(13)).lineSpacing(6).fixedSize(horizontal:false,vertical:true)
                                if task.mode == "Code" {
                                    ToolRow(icon:"square.and.pencil",title:"Edited",target:"3 files",result:"+146 −27",detail:"FilterBar.tsx\nuseProductFilters.ts\nFilterBar.test.tsx")
                                    ToolRow(icon:"terminal",title:"Ran",target:"pnpm test",result:"11 / 11 passed",detail:"PASS FilterBar.test.tsx\n✓ removes filters from the URL\n✓ clear all updates search parameters\n✓ back and forward restore the correct state\n\nTest files  3 passed\nTests       11 passed")
                                    Text("All 11 tests pass, including the three new regression cases. The branch is ready for review.").font(Ink.font(13)).lineSpacing(6)
                                }
                                if let approval = store.approvals.first(where: { $0.task == task.id && $0.type != "Purchase" }) { InlineApproval(approval:approval) }
                                if let messages = store.messages[task.id] { ForEach(Array(messages.enumerated()),id:\.offset) { _,text in Text(text).font(Ink.font(13)).padding(14).frame(maxWidth:.infinity,alignment:.leading).background(Ink.raised).clipShape(RoundedRectangle(cornerRadius:10)); Text("Added to the task plan. This preview uses sample responses.").font(Ink.font(12)).foregroundStyle(Ink.secondary) } }
                                HStack(spacing:10) { Text("\(task.time) elapsed"); Text("12 tool calls"); Text("1 checkpoint") }.font(Ink.font(10)).foregroundStyle(Ink.tertiary).padding(.top,8)
                            }.padding(24)
                        }
                        ComposerView().padding(.horizontal,20).padding(.bottom,8)
                        Text("Control mode is shared · Files and history live on your server").font(Ink.font(10)).foregroundStyle(Ink.tertiary).padding(.bottom,14)
                    }.frame(maxWidth:.infinity)
                    Rectangle().fill(Ink.border).frame(width:1)
                    WorkPane().frame(width:max(365,min(510,geometry.size.width * 0.45)))
                }
            }
        }
    }
    private var userRequest:String { switch task.id { case "filter": "The filter chips on /products get out of sync with the URL. Removing “In stock” doesn’t remove ?stock=in, and a refresh brings it back. Fix it and add a test."; case "report": "Prepare the October operations report from the CSVs and infrastructure notes. Include the calculations and a clean PDF."; case "invoice": "Collect this month’s hosting invoices, organize them by provider and give me a summary."; case "server": "Check why the server is using so much disk space. Propose a cleanup without touching active projects."; default: task.title } }
    private var intro:String { task.mode == "Code" ? "I’ll trace how the chips and query parameters are connected, then reproduce the failure." : "I’ll check the available sources, work through the task and keep the results alongside the original evidence." }
    private var explanation:String { task.mode == "Code" ? "Found it. FilterBar keeps its own copy of the active filters. Removing a chip updates that local state, but never writes back to the URL. I’ve made the URL the single source of truth so navigation and refresh stay in sync." : task.summary }
    @ViewBuilder private var toolRows:some View {
        if task.mode == "Code" {
            VStack(spacing:2) { ToolRow(icon:"doc.text.magnifyingglass",title:"Read",target:"src/components/FilterBar.tsx",result:"",detail:"Read 148 lines from the task worktree."); ToolRow(icon:"doc.text.magnifyingglass",title:"Read",target:"src/hooks/useProductFilters.ts",result:"",detail:"Read 86 lines from the shared filters hook."); ToolRow(icon:"magnifyingglass",title:"Searched",target:"setSearchParams",result:"6 matches",detail:"Found six references in src/hooks and src/components.") }
        } else {
            VStack(spacing:2) { ToolRow(icon:"folder",title:"Opened",target:task.project,result:"Workspace ready",detail:"/home/agent/workspaces/\(task.project.lowercased())"); ToolRow(icon:task.icon,title:"Checked",target:task.mode == "Operations" ? "disk usage and system logs" : "source files and account access",result:"3 sources",detail:"The mock tool has returned its sample result. Nothing was read from a live server.") }
        }
    }
}

struct ToolRow: View {
    var icon:String; var title:String; var target:String; var result:String; var detail:String
    @State private var expanded = false
    var body: some View {
        VStack(alignment:.leading,spacing:6) {
            Button { expanded.toggle() } label:{ HStack(spacing:7) { Glyph(name:icon,size:12).foregroundStyle(Ink.tertiary); Text(title).font(Ink.font(11)).foregroundStyle(Ink.secondary); Text(target).font(Ink.mono(10)).lineLimit(1); Spacer(minLength:3); Text(result).font(Ink.font(10)).foregroundStyle(Ink.secondary); Glyph(name:expanded ? "chevron.down" : "chevron.right",size:8).foregroundStyle(Ink.tertiary) }.frame(height:27).contentShape(Rectangle()) }.buttonStyle(.plain)
            if expanded { Text(detail).font(Ink.mono(11)).lineSpacing(4).textSelection(.enabled).padding(12).frame(maxWidth:.infinity,alignment:.leading).background(Ink.raised).clipShape(RoundedRectangle(cornerRadius:6)) }
        }
    }
}

struct InlineApproval: View {
    @Environment(MockStore.self) private var store
    var approval:Approval
    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            if approval.resolved { HStack { Glyph(name:approval.decision.hasPrefix("Denied") ? "xmark" : "checkmark",size:12); Text(approval.decision).font(Ink.font(12)); Spacer(); Text("21:16").font(Ink.mono(10)).foregroundStyle(Ink.tertiary) } }
            else {
                HStack { Tag(text:"Needs you",inverted:true,icon:"circle.fill"); Text(approval.type == "Account" ? "Account access" : "Approval needed").font(Ink.font(12,.medium)); Spacer() }
                Text(approval.target).font(Ink.mono(11)).textSelection(.enabled).padding(12).frame(maxWidth:.infinity,alignment:.leading).background(Ink.bg).clipShape(RoundedRectangle(cornerRadius:6))
                Text(approval.detail).font(Ink.font(11)).foregroundStyle(Ink.secondary).lineSpacing(4)
                HStack { Button("Deny") { store.decide(approval.id,allow:false) }.buttonStyle(InkButtonStyle()); Button(approval.type == "Account" ? "Take over browser" : "Approve once") { store.decide(approval.id,allow:true) }.buttonStyle(InkButtonStyle(primary:true)); Spacer() }
                Text("This action only · Also visible on iPhone").font(Ink.font(10)).foregroundStyle(Ink.secondary)
            }
        }.padding(16).background(Ink.raised).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(Ink.strong))
    }
}

struct WorkPane: View {
    @Environment(MockStore.self) private var store
    var body: some View {
        VStack(spacing:0) {
            ScrollView(.horizontal) { HStack(spacing:0) { ForEach(["Plan","Files","Diff","Browser","Activity","Outputs"],id:\.self) { tab in Button { store.workTab = tab } label:{ Text(tab).font(Ink.font(11,store.workTab == tab ? .medium : .regular)).foregroundStyle(store.workTab == tab ? Ink.text : Ink.tertiary).padding(.horizontal,13).frame(height:43).overlay(alignment:.bottom){ if store.workTab == tab { Rectangle().fill(Ink.text).frame(height:2) } } }.buttonStyle(.plain) } }.padding(.horizontal,4) }.scrollIndicators(.hidden)
            Rectangle().fill(Ink.border).frame(height:1)
            Group {
                switch store.workTab { case "Files": FilePane(); case "Browser": BrowserCanvas(compact:true); case "Activity": ActivityPane(); case "Outputs": OutputPane(); case "Plan": PlanPane(); default: DiffPane() }
            }.frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
        }.background(Ink.surface)
    }
}

struct DiffPane: View {
    @State private var split = false
    let lines:[(String,String)] = [
        ("context","import { useSearchParams } from 'react-router-dom';"),("context",""),("context","export function FilterBar() {"),("remove","  const [filters, setFilters] = useState(initialFilters);"),("add","  const [searchParams, setSearchParams] = useSearchParams();"),("add","  const filters = readFilters(searchParams);"),("context",""),("context","  function removeFilter(key: string) {"),("remove","    setFilters(current => omit(current, key));"),("add","    const next = new URLSearchParams(searchParams);"),("add","    next.delete(key);"),("add","    setSearchParams(next, { replace: true });"),("context","  }"),("context",""),("context","  return ("),("context","    <FilterChips"),("context","      filters={filters}"),("context","      onRemove={removeFilter}"),("context","    />"),("context","  );"),("context","}")]
    var body: some View {
        VStack(spacing:0) {
            HStack(spacing:7) { Text("3 files changed").font(Ink.font(10)); Text("+146").foregroundStyle(Ink.add); Text("−27").foregroundStyle(Ink.del); Spacer(); Button(split ? "Split" : "Unified") { split.toggle() }.buttonStyle(.plain).font(Ink.font(10)).padding(5).overlay(RoundedRectangle(cornerRadius:4).stroke(Ink.border)) }.font(Ink.mono(10)).padding(12).foregroundStyle(Ink.secondary)
            ScrollView([.vertical,.horizontal]) {
                VStack(alignment:.leading,spacing:0) {
                    fileHeader("src/components/FilterBar.tsx","+58 −21")
                    Text(split ? "Old / New · Side-by-side preview" : "@@ -24,12 +24,15 @@").font(Ink.mono(10)).foregroundStyle(Ink.tertiary).padding(.horizontal,12).frame(height:31)
                    ForEach(Array(lines.enumerated()),id:\.offset) { i,line in
                        HStack(spacing:0) { Text("\(i + 24)").frame(width:32,alignment:.trailing).foregroundStyle(Ink.tertiary); Text(line.0 == "add" ? "+" : line.0 == "remove" ? "−" : " ").frame(width:23); Text(line.1).frame(maxWidth:.infinity,alignment:.leading) }.font(Ink.mono(10)).frame(minWidth:440,minHeight:23).padding(.trailing,16).foregroundStyle(line.0 == "add" ? Ink.add : line.0 == "remove" ? Ink.del : Ink.secondary).background(line.0 == "add" ? Ink.add.opacity(0.08) : line.0 == "remove" ? Ink.del.opacity(0.08) : .clear)
                    }
                    fileHeader("src/hooks/useProductFilters.ts","+41 −6").padding(.top,16)
                    Text("  Derive active filters from URLSearchParams").font(Ink.mono(10)).foregroundStyle(Ink.secondary).padding(12)
                    fileHeader("src/components/FilterBar.test.tsx","+47 −0")
                    Text("  3 regression cases · All tests pass").font(Ink.mono(10)).foregroundStyle(Ink.secondary).padding(12)
                }
            }
            Spacer(minLength:0)
            HStack { Glyph(name:"arrow.triangle.branch",size:11); Text("fix/filter-sync"); Spacer(); Text("Checkpoint 3") }.font(Ink.mono(10)).foregroundStyle(Ink.tertiary).padding(12).overlay(alignment:.top){ Rectangle().fill(Ink.border).frame(height:1) }
        }
    }
    private func fileHeader(_ path:String,_ counts:String) -> some View { HStack { Glyph(name:"chevron.down",size:9); Text(path); Spacer(); Text(counts).foregroundStyle(Ink.secondary) }.font(Ink.mono(10)).padding(12).background(Ink.raised).overlay(alignment:.bottom){ Rectangle().fill(Ink.border).frame(height:1) } }
}

struct ActivityPane: View {
    @Environment(MockStore.self) private var store
    private var lines: [String] {
        if store.currentTask.id == "server" {
            return ["outpost-01 / disk investigation", "", "Inspected storage usage", "  Workspace data     24.6 GB", "  Retained outputs    2.1 GB", "  Old build cache    18.2 GB", "", "Checked active worktrees and running builds", "  Active files excluded from the cleanup proposal", "  Proposed age threshold: 14 days", "", "Prepared scoped maintenance request", "  outpost-maintenance prune-build-cache --older-than 14d", "", "No cleanup has run in this preview."]
        }
        return ["outpost-01 / storefront-web", "", "Ran pnpm test", "  FilterBar: 5 checks passed", "  Filter hooks: 4 checks passed", "  Products route: 2 checks passed", "", "Tests: 11 passed / 11", "Duration: 2.84 seconds", "", "Changed files", "  src/components/FilterBar.tsx", "  src/hooks/useProductFilters.ts", "  src/components/FilterBar.test.tsx", "", "Captured sample evidence only. No command runs from this view."]
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 9) {
                HStack { Text("Action evidence").font(Ink.font(14, .medium)); Spacer(); Tag(text: "Read only") }.padding(.bottom, 18)
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in Text(line).font(Ink.mono(11)).foregroundStyle(Ink.secondary).textSelection(.enabled) }
                Button("Copy sample log") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string); store.notify("Sample evidence copied.") }.buttonStyle(InkButtonStyle()).padding(.top, 20)
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct PlanPane: View {
    var body:some View { ScrollView { VStack(alignment:.leading,spacing:24) { Text("Task plan").font(Ink.font(16,.semibold)); ForEach(Array([("Reproduce the filter issue","Confirmed URL and chip state drift.",true),("Make the URL the source of truth","Updated the shared hook and FilterBar.",true),("Add tests and verify the preview","11 tests pass. No lint errors.",true),("Publish the branch","Waiting for your approval.",false)].enumerated()),id:\.offset) { i,item in HStack(alignment:.top,spacing:12) { Glyph(name:item.2 ? "checkmark.circle" : "circle",size:17).foregroundStyle(item.2 ? Ink.secondary : Ink.text); VStack(alignment:.leading,spacing:7) { Text(item.0).font(Ink.font(13,.medium)); Text(item.1).font(Ink.font(11)).foregroundStyle(Ink.secondary) } } }; Divider(); Text("Authority").font(Ink.font(12,.medium)); Text("Read and edit this worktree, run tests, use the public browser. Ask before publishing or changing accounts.").font(Ink.font(12)).foregroundStyle(Ink.secondary).lineSpacing(5); Tag(text:"No protected credentials in context",icon:"lock") }.padding(22) } }
}

struct FilePane: View {
    @Environment(MockStore.self) private var store
    var body:some View { ScrollView { VStack(alignment:.leading,spacing:4) { HStack { Text("storefront-web").font(Ink.mono(12)); Spacer(); Tag(text:"Worktree") }.padding(.bottom,18); ForEach(["▾ src","    ▾ components","        FilterBar.tsx","        FilterBar.test.tsx","        ProductCard.tsx","    ▾ hooks","        useProductFilters.ts","    ▾ routes","        products.tsx","▸ public","▸ tests","  package.json","  pnpm-lock.yaml","  README.md"],id:\.self) { file in Button { store.detail(file.trimmingCharacters(in:.whitespaces),icon:"doc.text","Sample file in the storefront-web worktree.",fields:[("Location","/home/agent/workspaces/storefront-web"),("State",file.contains("Filter") ? "Modified in turn 3" : "Unchanged")],confirm:"View diff",action:{store.workTab = "Diff"}) } label:{ HStack { Text(file).font(Ink.mono(11)); Spacer(); if file.contains("Filter") { Text("M").font(Ink.mono(10)).foregroundStyle(Ink.tertiary) } }.foregroundStyle(Ink.secondary).frame(height:29).contentShape(Rectangle()) }.buttonStyle(.plain) } }.padding(18) } }
}

struct OutputPane: View {
    @Environment(MockStore.self) private var store
    var body:some View { ScrollView { VStack(alignment:.leading,spacing:12) { Text("Task outputs").font(Ink.font(16,.semibold)).padding(.bottom,8); ForEach([("October_operations.pdf","PDF · 12 pages · 1.4 MB"),("pipeline_reconciled.xlsx","Spreadsheet · 482 records · 284 KB"),("sources_and_calculations.md","Markdown · 8 sources · 12 KB")],id:\.0) { item in Button { store.detail(item.0,icon:"doc.text","A sample deliverable with linked sources and verification notes.",fields:[("File",item.1),("Checks","Rendered and inspected"),("Storage","outpost-01 / outputs")],confirm:"Open preview",action:{store.destination = .library}) } label:{ HStack(spacing:12) { Glyph(name:"doc.text",size:24).foregroundStyle(Ink.secondary); VStack(alignment:.leading,spacing:6) { Text(item.0).font(Ink.font(12,.medium)); Text(item.1).font(Ink.font(10)).foregroundStyle(Ink.tertiary) }; Spacer(); Glyph(name:"arrow.up.right",size:11) }.padding(14).background(Ink.raised).clipShape(RoundedRectangle(cornerRadius:8)) }.buttonStyle(.plain) }; Text("Originals and intermediate files are retained alongside the final outputs.").font(Ink.font(11)).foregroundStyle(Ink.secondary).lineSpacing(4).padding(.top,10) }.padding(20) } }
}
