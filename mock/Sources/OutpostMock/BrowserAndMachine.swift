import SwiftUI

struct BrowserPage: View {
    @Environment(MockStore.self) private var store
    var body:some View {
        VStack(spacing:0) {
            HStack(alignment:.top) { VStack(alignment:.leading,spacing:7) { Text("Browser").font(Ink.font(24,.semibold)); Text("See what Pi sees. Step in when it needs you.").font(Ink.font(12)).foregroundStyle(Ink.secondary) }; Spacer(); Button { store.browserHuman.toggle(); store.notify(store.browserHuman ? "You have control of the sample browser." : "Control returned to Pi in the preview.") } label:{ Label(store.browserHuman ? "Return control to Pi" : "Take control",systemImage:store.browserHuman ? "arrow.uturn.backward" : "cursorarrow") }.buttonStyle(InkButtonStyle(primary:store.browserHuman)) }.padding(24)
            HStack(spacing:10) { Tag(text:store.browserHuman ? "You are in control" : "Pi is in control",inverted:store.browserHuman,icon:store.browserHuman ? "cursorarrow" : "circle.dashed"); Text("Headless Chromium on outpost-01").font(Ink.mono(10)).foregroundStyle(Ink.tertiary); Spacer(); Tag(text:"Protected identity",icon:"lock"); Button("Session details") { store.detail("Browser session",icon:"globe","A self-hosted browser with task-scoped account access.",fields:[("Worker","Protected browser / outpost-01"),("Account","Personal / billing"),("Grant","Read invoices · 30 minutes"),("State","Sample session")]) }.buttonStyle(.plain).font(Ink.font(11)).foregroundStyle(Ink.secondary) }.padding(.horizontal,24).padding(.bottom,16)
            BrowserCanvas().padding(.horizontal,24).padding(.bottom,24)
        }
    }
}

struct BrowserCanvas: View {
    @Environment(MockStore.self) private var store
    var compact = false
    var body:some View {
        VStack(spacing:0) {
            ScrollView(.horizontal) { HStack(spacing:3) { ForEach(["Pull request","Billing portal","Search results"],id:\.self) { tab in Button { store.browserTab = tab } label:{ HStack(spacing:6) { Glyph(name:"globe",size:10); Text(tab).font(Ink.font(10)); if tab == "Billing portal" && !store.browserSignedIn { Circle().fill(Ink.text).frame(width:4,height:4) } }.padding(.horizontal,12).frame(height:35).background(store.browserTab == tab ? Ink.surface : .clear).clipShape(UnevenRoundedRectangle(topLeadingRadius:6,topTrailingRadius:6)) }.buttonStyle(.plain) } }.padding(.horizontal,6).padding(.top,6) }.scrollIndicators(.hidden).background(Ink.raised)
            HStack(spacing:9) { IconButton(icon:"chevron.left",label:"Back in mock browser") { store.notify("This is the first page in the sample history.") }; IconButton(icon:"arrow.clockwise",label:"Reload sample page") { store.notify("Sample page refreshed.") }; HStack(spacing:8) { Glyph(name:"lock",size:10); Text(url).font(Ink.mono(10)).lineLimit(1); Spacer() }.foregroundStyle(Ink.secondary).padding(8).background(Ink.bg).clipShape(RoundedRectangle(cornerRadius:6)); IconButton(icon:"ellipsis",label:"Browser tools") { store.detail("Browser tools",icon:"globe","Available through Pi’s browser capability on the Ubuntu server.",fields:[("Observe","Page snapshot · screenshot · accessibility tree"),("Act","Navigate · click · type · upload · download"),("Diagnose","Console · network · browser trace")]) } }.padding(.horizontal,8).padding(.vertical,6).background(Ink.surface)
            Divider().overlay(Ink.border)
            ScrollView {
                VStack(alignment:.leading,spacing:20) {
                    switch store.browserTab {
                    case "Billing portal": billing
                    case "Search results": searchResults
                    default: pullRequest
                    }
                }.padding(compact ? 20 : 34).frame(maxWidth:900,alignment:.leading).frame(maxWidth:.infinity,alignment:.topLeading)
            }.background(Ink.bg)
            HStack(spacing:6) { Glyph(name:"checkmark.shield",size:10); Text("Rendered sample page"); Spacer(); Text(store.browserHuman ? "Owner input" : "Agent input"); Text("·  1440 × 900") }.font(Ink.mono(9)).foregroundStyle(Ink.tertiary).padding(10).background(Ink.surface).overlay(alignment:.top){ Rectangle().fill(Ink.border).frame(height:1) }
        }.clipShape(RoundedRectangle(cornerRadius:compact ? 0 : 10)).overlay(RoundedRectangle(cornerRadius:compact ? 0 : 10).stroke(Ink.border))
    }
    private var url:String { switch store.browserTab { case "Billing portal": "billing.northstar.example / invoices"; case "Search results": "search.outpost.local / self-hosted-search"; default: "github.com / storefront-web / pull / 48" } }
    private var pullRequest:some View {
        VStack(alignment:.leading,spacing:20) {
            HStack { Glyph(name:"chevron.left.forwardslash.chevron.right",size:18); Text("storefront-web").font(Ink.font(14,.semibold)); Spacer(); Tag(text:"Private") }
            HStack(spacing:20) { Text("Code"); Text("Issues  6"); Text("Pull requests  2") }.font(Ink.font(11)).foregroundStyle(Ink.secondary).padding(.vertical,8)
            Divider()
            Text("Fix filter chip sync on /products").font(Ink.font(compact ? 19 : 25,.semibold))
            HStack { Tag(text:"Open",icon:"arrow.triangle.pull"); Text("fix/filter-sync into main").font(Ink.mono(10)).foregroundStyle(Ink.secondary) }
            Panel(title:"Summary") { VStack(alignment:.leading,spacing:12) { Text("The URL is now the single source of truth for product filters.").font(Ink.font(12)); Text("• Removing a chip updates search parameters\n• Refresh and navigation preserve the correct filters\n• Adds three regression tests").font(Ink.font(12)).lineSpacing(7).foregroundStyle(Ink.secondary) }.padding(18) }
            HStack { Glyph(name:"checkmark.circle"); Text("All 11 checks passed").font(Ink.font(12,.medium)); Spacer(); Tag(text:"3 files changed") }.padding(16).background(Ink.raised).clipShape(RoundedRectangle(cornerRadius:8))
            Button("Inspect changed files") { store.openTask("filter"); store.workTab = "Diff" }.buttonStyle(InkButtonStyle())
        }
    }
    private var billing:some View {
        VStack(alignment:.leading,spacing:22) {
            HStack { Glyph(name:"square.stack.3d.up",size:20); Text("Northstar Cloud").font(Ink.font(17,.semibold)); Spacer(); Text("Billing").font(Ink.font(12)).foregroundStyle(Ink.secondary) }
            Divider()
            if !store.browserSignedIn {
                VStack(alignment:.leading,spacing:18) {
                    Tag(text:"Waiting for sign-in",inverted:true,icon:"key")
                    Text("Welcome back").font(Ink.font(25,.semibold))
                    Text("Sign in to view your invoices. This sample page does not collect credentials.").font(Ink.font(13)).foregroundStyle(Ink.secondary).lineSpacing(5)
                    Text("Personal account").font(Ink.font(12)).padding(12).frame(maxWidth:.infinity,alignment:.leading).overlay(RoundedRectangle(cornerRadius:6).stroke(Ink.control))
                    Button("Simulate sign-in") { store.signIn() }.buttonStyle(InkButtonStyle(primary:true))
                    Button("Preview CAPTCHA handoff") { store.detail("A quick verification is needed",icon:"hand.raised","The browser has paused on a sample challenge. In the real app, you would take over this same session.",fields:[("Browser","Protected account session"),("Page","Northstar billing"),("Agent state","Waiting for human assistance")],confirm:"Mark sample challenge resolved",action:{store.notify("Sample challenge resolved. Browser state preserved.")}) }.buttonStyle(.plain).font(Ink.font(12)).foregroundStyle(Ink.secondary)
                }.padding(25).background(Ink.surface).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(Ink.border)).frame(maxWidth:420).padding(.top,20)
            } else {
                Text("Invoices").font(Ink.font(25,.semibold)); Text("Your monthly infrastructure statements.").font(Ink.font(13)).foregroundStyle(Ink.secondary)
                ForEach([("October 2026","₹3,240.00"),("September 2026","₹3,180.00"),("August 2026","₹3,180.00")],id:\.0) { item in HStack { Glyph(name:"doc.text"); Text(item.0).font(Ink.font(12)); Spacer(); Text(item.1).font(Ink.mono(11)); Button("Download") { store.notify("Sample invoice added to Library.") }.buttonStyle(InkButtonStyle()) }.padding(.vertical,8); Divider() }
            }
        }
    }
    private var searchResults:some View { VStack(alignment:.leading,spacing:22) { HStack { Glyph(name:"magnifyingglass"); Text("self-hosted search for a personal agent").font(Ink.font(14)) }.padding(14).background(Ink.surface).clipShape(RoundedRectangle(cornerRadius:8)); Text("6 primary sources · Saved to the research task").font(Ink.font(11)).foregroundStyle(Ink.tertiary); ForEach([("SearXNG documentation","Private metasearch with locally hosted configuration and upstream search engines."),("Local browser and search architecture","A comparison of index ownership, reliability, resource use and extraction quality."),("Search adapters for Pi","Keep search implementation local and expose a focused tool interface.")],id:\.0) { item in VStack(alignment:.leading,spacing:8) { Text(item.0).font(Ink.font(16,.medium)); Text(item.1).font(Ink.font(12)).foregroundStyle(Ink.secondary).lineSpacing(5); Text("Saved source · October 27, 2026").font(Ink.mono(10)).foregroundStyle(Ink.tertiary) }; Divider() } } }
}

struct MachineView: View {
    @Environment(MockStore.self) private var store
    @State private var tab = "Overview"
    var body:some View {
        ScrollView {
            VStack(alignment:.leading,spacing:22) {
                PageHeader(title:"Your machine",subtitle:"The computer your agent works on. All tools and services are self-hosted here.") { Button { store.detail("Create a snapshot",icon:"externaldrive","Capture the workspace before a maintenance change. The snapshot belongs to the protected host.",fields:[("Machine","outpost-01"),("Includes","Workspace volumes · package inventory"),("Excludes","Ollama Cloud inference")],confirm:"Create sample snapshot",action:{store.notify("Snapshot workspace-2026-10-27 created in the preview.")}) } label:{ Label("Create snapshot",systemImage:"externaldrive") }.buttonStyle(InkButtonStyle()) }
                HStack(spacing:16) { Glyph(name:"server.rack",size:32).foregroundStyle(Ink.secondary); VStack(alignment:.leading,spacing:7) { HStack { Text("outpost-01").font(Ink.font(20,.semibold)); Tag(text:store.serverConnected ? "Healthy" : "Offline",icon:store.serverConnected ? "checkmark" : "xmark") }; Text("Ubuntu 24.04 LTS   /   8 vCPU   /   32 GB RAM   /   Uptime 18 days").font(Ink.mono(11)).foregroundStyle(Ink.secondary) }; Spacer(); Button("Connection") { store.serverConnected.toggle(); store.notify(store.serverConnected ? "Sample connection restored." : "Offline state preview enabled.") }.buttonStyle(InkButtonStyle()) }.padding(.bottom,10)
                HStack(spacing:30) { metric("CPU",value:"18%",fraction:0.18,detail:"2 active workers"); metric("Memory",value:"9.8 / 32 GB",fraction:0.31,detail:"22.2 GB available"); metric("Storage",value:"186 / 512 GB",fraction:0.36,detail:"18.2 GB cache can be reclaimed") }.padding(.vertical,20)
                tabStrip(["Overview","Processes","Services","Storage","Snapshots","Network"],selection:$tab)
                if tab == "Overview" {
                    HStack(alignment:.top,spacing:20) {
                        Panel(title:"Everything has a place") { VStack(spacing:0) { service("Pi harness","Agent workspace VM","Running"); service("Chromium / Steel","Self-hosted browser","Running"); service("Vault & approvals","Protected host services","Healthy"); service("Search & documents","Local tool workers","Ready"); service("Ollama Cloud","Model inference only","Connected") } }.frame(maxWidth:.infinity)
                        Panel(title:"Workspace authority") { VStack(alignment:.leading,spacing:16) { Tag(text:"Ask for privileged changes",icon:"lock"); Text("The agent can install tools and manage its workspace. Sudo requests appear in your approval inbox.").font(Ink.font(12)).foregroundStyle(Ink.secondary).lineSpacing(5); Text("Host / guest boundary").font(Ink.font(12,.medium)); Text("The vault, approval keys and audit remain outside guest root.").font(Ink.font(12)).foregroundStyle(Ink.secondary); Button("Review permissions") { store.settingsTab = "Permissions"; store.destination = .settings }.buttonStyle(InkButtonStyle()) }.padding(18) }.frame(width:300)
                    }
                } else { machineTable }
            }.pageBody()
        }
    }
    private func metric(_ title:String,value:String,fraction:CGFloat,detail:String) -> some View { VStack(alignment:.leading,spacing:10) { HStack { Text(title).font(Ink.font(12)).foregroundStyle(Ink.secondary); Spacer(); Text(value).font(Ink.mono(13)) }; GeometryReader { g in ZStack(alignment:.leading) { Capsule().fill(Ink.border); Capsule().fill(Ink.secondary).frame(width:g.size.width * fraction) } }.frame(height:4); Text(detail).font(Ink.font(11)).foregroundStyle(Ink.tertiary) }.frame(maxWidth:.infinity) }
    private func service(_ name:String,_ location:String,_ status:String) -> some View { HStack(spacing:10) { Glyph(name:"square.stack.3d.up",size:13).foregroundStyle(Ink.tertiary); VStack(alignment:.leading,spacing:5) { Text(name).font(Ink.font(12,.medium)); Text(location).font(Ink.font(10)).foregroundStyle(Ink.tertiary) }; Spacer(); Tag(text:status) }.padding(15).overlay(alignment:.bottom){ Rectangle().fill(Ink.border).frame(height:1) } }
    private var machineTable:some View {
        let rows: [[String]] = tab == "Processes" ? [["Pi / filter-sync","pid 2841","1.4% CPU","Running"],["Chromium / billing","pid 3012","312 MB","Waiting"],["LibreOffice renderer","pid 3244","188 MB","Running"]] : tab == "Services" ? [["outpost-coordinator","Protected host","2 days","Healthy"],["outpost-browser","Host worker","2 days","Healthy"],["searxng","Local service","18 days","Healthy"],["outpost-vault","Protected host","18 days","Healthy"]] : tab == "Storage" ? [["/home/agent/projects","7 projects","24.6 GB","Workspace"],["/home/agent/outputs","18 artifacts","2.1 GB","Retained"],["/var/cache/builds","Cache","18.2 GB","Review cleanup"]] : tab == "Snapshots" ? [["workspace-2026-10-27","Today, 20:58","4.2 GB","Available"],["workspace-2026-10-26","Yesterday","4.0 GB","Available"],["baseline-clean","21 October","2.6 GB","Pinned"]] : [["WireGuard","Private client connection","10.18.0.1","Connected"],["Outpost gateway","Authenticated local API","Port 7443","Healthy"],["Browser viewer","Local streaming","Private only","Ready"],["Ollama Cloud","Only hosted runtime","HTTPS","Connected"]]
        return Panel { VStack(spacing:0) { ForEach(Array(rows.enumerated()),id:\.offset) { _,row in Button { store.detail(row[0],icon:"server.rack","Sample machine resource. Administrative changes are always reviewable before they run.",fields:[("Location",row[1]),("Details",row[2]),("Status",row[3])],confirm:tab == "Snapshots" ? "Preview restore" : "Inspect",action:{store.notify("Resource inspection opened in the preview.")}) } label:{ HStack { Text(row[0]).font(Ink.mono(12)).frame(maxWidth:.infinity,alignment:.leading); Text(row[1]).font(Ink.font(11)).foregroundStyle(Ink.secondary).frame(width:180,alignment:.leading); Text(row[2]).font(Ink.mono(11)).foregroundStyle(Ink.tertiary).frame(width:120,alignment:.leading); Tag(text:row[3]).frame(width:100,alignment:.trailing) }.padding(17).contentShape(Rectangle()) }.buttonStyle(.plain); Divider() } } }
    }
}

func tabStrip(_ tabs:[String],selection:Binding<String>) -> some View {
    HStack(spacing:20) { ForEach(tabs,id:\.self) { tab in Button { selection.wrappedValue = tab } label:{ Text(tab).font(Ink.font(12,selection.wrappedValue == tab ? .medium : .regular)).foregroundStyle(selection.wrappedValue == tab ? Ink.text : Ink.tertiary).padding(.vertical,12).overlay(alignment:.bottom){ if selection.wrappedValue == tab { Rectangle().fill(Ink.text).frame(height:2) } } }.buttonStyle(.plain) }; Spacer() }.overlay(alignment:.bottom){ Rectangle().fill(Ink.border).frame(height:1) }
}

struct CapabilitiesView: View {
    @Environment(MockStore.self) private var store
    @State private var search = ""
    @State private var filter = "All capabilities"
    private var filtered: [Capability] { store.capabilities.filter { (filter == "All capabilities" || (filter == "Installed" ? $0.installed : !$0.installed)) && (search.isEmpty || ($0.name + $0.description + $0.tools).localizedCaseInsensitiveContains(search)) } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                PageHeader(title: "Capabilities", subtitle: "Install a tool once. Use it in any task.") {
                    Button("View feature catalogue") { store.destination = .catalogue }.buttonStyle(InkButtonStyle())
                }
                HStack(alignment: .center, spacing: 24) { tabStrip(["All capabilities", "Installed", "Available"], selection: $filter); TextField("Find a capability", text: $search).inkField().frame(width: 220) }
                HStack(spacing: 7) { Glyph(name: "server.rack", size: 12); Text("\(store.installedCount) packs installed on outpost-01").font(Ink.font(12)); Spacer(); Text("Available to Pi in every task").font(Ink.font(12)).foregroundStyle(Ink.tertiary) }.foregroundStyle(Ink.secondary).padding(.vertical, 3)
                if filtered.isEmpty { EmptyNotice(icon: "magnifyingglass", title: "No matching capabilities", detail: "Try a tool name or another category.") }
                LazyVStack(alignment: .leading, spacing: 28) {
                    ForEach(["Development", "Browser & accounts", "Knowledge work", "Infrastructure", "Personal"], id: \.self) { category in
                        let packs = filtered.filter { $0.category == category }
                        if !packs.isEmpty {
                            VStack(alignment: .leading, spacing: 9) {
                                Text(category).font(Ink.font(12, .medium)).foregroundStyle(Ink.tertiary)
                                ForEach(packs) { cap in
                                    HStack(alignment: .center, spacing: 16) {
                                        Glyph(name: cap.icon, size: 20).foregroundStyle(Ink.secondary).frame(width: 44, height: 44).background(Ink.raised.opacity(0.65)).clipShape(RoundedRectangle(cornerRadius: 9))
                                        VStack(alignment: .leading, spacing: 7) {
                                            Text(cap.name).font(Ink.font(15, .medium))
                                            Text(cap.description).font(Ink.font(12)).foregroundStyle(Ink.secondary)
                                            Text(cap.tools).font(Ink.font(11)).foregroundStyle(Ink.tertiary).lineLimit(1)
                                        }.frame(maxWidth: .infinity, alignment: .leading)
                                        if cap.installed { HStack(spacing: 5) { Glyph(name: "checkmark", size: 10); Text("Installed").font(Ink.font(11)) }.foregroundStyle(Ink.tertiary).frame(width: 76) }
                                        Button(cap.installed ? "Manage" : "Install") { show(cap) }.buttonStyle(InkButtonStyle(primary: !cap.installed)).frame(width: 76)
                                    }.padding(.vertical, 17)
                                    Rectangle().fill(Ink.border.opacity(0.75)).frame(height: 1).padding(.leading, 60)
                                }
                            }
                        }
                    }
                }
            }.pageBody()
        }
    }
    private func show(_ cap:Capability) {
        store.detail(cap.installed ? cap.name : "Install \(cap.name)?",icon:cap.icon,cap.description,fields:[("Tools",cap.tools),("Runs on","outpost-01 / self-hosted"),("Pi exposure","Discoverable tools and approved shell"),("Permissions",cap.id == "mail" ? "Connect account · Ask before sending" : "Workspace access · Ask for sensitive actions")],confirm:cap.installed ? "View tools" : "Install sample pack",action:{ if let i = store.capabilities.firstIndex(where:{$0.id == cap.id}) { store.capabilities[i].installed = true }; store.notify(cap.installed ? "\(cap.tools) available to Pi in the preview." : "\(cap.name) installed in the preview.") })
    }
}
