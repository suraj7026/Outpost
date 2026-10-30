import SwiftUI
import Observation

enum ControlMode: String, CaseIterable, Identifiable {
    case full = "Full control", auto = "Auto", ask = "Ask permission"
    var id: String { rawValue }
    var icon: String { self == .full ? "bolt" : self == .auto ? "sparkle.magnifyingglass" : "hand.raised" }
    var detail: String {
        switch self {
        case .full: "Work within the granted scope without routine permission prompts."
        case .auto: "A smaller model reviews proposed actions and asks you when needed."
        case .ask: "Ask before every work action, including reads, commands and browser steps."
        }
    }
}

enum Destination: String, CaseIterable, Identifiable {
    case home = "Home", tasks = "Tasks", approvals = "Needs you", browser = "Browser", machine = "Machine", capabilities = "Capabilities", automations = "Automations", library = "Library", accounts = "Accounts", spending = "Spending", memory = "Memory", catalogue = "Feature catalogue", settings = "Settings", workbench = "Workbench"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .home: "house"
        case .tasks, .workbench: "square.stack"
        case .approvals: "circle.inset.filled"
        case .browser: "globe"
        case .machine: "server.rack"
        case .capabilities: "shippingbox"
        case .automations: "clock.arrow.circlepath"
        case .library: "folder"
        case .accounts: "person.crop.square"
        case .spending: "creditcard"
        case .memory: "brain"
        case .catalogue: "square.grid.2x2"
        case .settings: "slider.horizontal.3"
        }
    }
}

struct Feature: Codable, Identifiable {
    var id: String
    var name: String
    var detail: String
    var priority: String
    var category: String
    var stage: String { priority == "C" ? "Core" : priority == "E" ? "Expansion" : "Advanced" }
}

struct DemoTask: Identifiable {
    var id: String
    var title: String
    var project: String
    var mode: String
    var status: String
    var time: String
    var summary: String
    var icon: String { mode == "Code" ? "chevron.left.forwardslash.chevron.right" : mode == "Browser" ? "globe" : mode == "Operations" ? "terminal" : mode == "Research" ? "magnifyingglass" : "doc.text" }
}

struct Capability: Identifiable {
    var id: String
    var name: String
    var icon: String
    var description: String
    var tools: String
    var installed: Bool
    var category: String
}

struct Approval: Identifiable {
    var id: String
    var title: String
    var type: String
    var task: String
    var detail: String
    var target: String
    var consequence: String
    var resolved = false
    var decision = ""
    var icon: String { type == "Purchase" ? "creditcard" : type == "Account" ? "key" : "terminal" }
}

struct DemoAutomation: Identifiable {
    var id: String
    var name: String
    var schedule: String
    var last: String
    var next: String
    var active: Bool
    var icon: String
}

struct DetailSheet: Identifiable {
    var id = UUID()
    var title: String
    var icon: String
    var detail: String
    var fields: [(String, String)]
    var confirm: String
    var action: (() -> Void)?
}

@MainActor @Observable final class MockStore {
    var destination: Destination = .home
    var selectedTask = "filter"
    var dark = true
    var showPhone = false
    var showCommand = false
    var sheet: DetailSheet?
    var toast: String?
    var taskSearch = ""
    var taskFilter = "All tasks"
    var featureSearch = ""
    var featureCategory = "All areas"
    var settingsTab = "Models"
    var workTab = "Diff"
    var composer = ""
    var mode = "Code"
    var controlMode: ControlMode = .ask
    var browserHuman = false
    var browserSignedIn = false
    var browserAddress = "github.com / storefront-web / pull / 48"
    var browserTab = "Pull request"
    var serverConnected = true
    var installedCount: Int { capabilities.filter(\.installed).count }
    var pending: [Approval] { approvals.filter { !$0.resolved } }
    var currentTask: DemoTask { tasks.first { $0.id == selectedTask } ?? tasks[0] }
    var features: [Feature] = []
    var messages: [String: [String]] = [:]
    var pinnedMemories: Set<String> = []
    var tasks: [DemoTask] = []
    var capabilities: [Capability] = []
    var approvals: [Approval] = []
    var automations: [DemoAutomation] = []
    var audit: [String] = []

    init() {
        if let url = Bundle.module.url(forResource: "features", withExtension: "json"), let data = try? Data(contentsOf: url) {
            features = (try? JSONDecoder().decode([Feature].self, from: data)) ?? []
        }
        reset()
    }
    func reset() {
        tasks = [
            .init(id: "filter", title: "Fix filter chip sync on /products", project: "storefront-web", mode: "Code", status: "Needs you", time: "12 min", summary: "Tests pass. Ready to push the reviewed changes."),
            .init(id: "report", title: "Prepare the October operations report", project: "Personal", mode: "Cowork", status: "Running", time: "8 min", summary: "Reconciling three source files and rendering the report."),
            .init(id: "invoice", title: "Collect this month’s hosting invoices", project: "Personal", mode: "Browser", status: "Needs you", time: "4 min", summary: "The billing portal needs a one-time sign-in."),
            .init(id: "server", title: "Investigate disk usage on outpost-01", project: "Infrastructure", mode: "Operations", status: "Needs you", time: "6 min", summary: "Found 18 GB of old build cache. A cleanup plan is ready."),
            .init(id: "research", title: "Compare self-hosted search tools", project: "Research", mode: "Research", status: "Done", time: "Today", summary: "Six primary sources, three options, one recommendation."),
            .init(id: "pipeline", title: "Reconcile the September pipeline", project: "Personal", mode: "Cowork", status: "Done", time: "Yesterday", summary: "482 records reconciled. Spreadsheet and notes are ready."),
            .init(id: "nightly", title: "Run the dependency update checks", project: "storefront-web", mode: "Code", status: "Failed", time: "Yesterday", summary: "A browser test timed out. The diagnostic trace is saved.")
        ]
        capabilities = [
            .init(id:"code",name:"Code & GitHub",icon:"chevron.left.forwardslash.chevron.right",description:"From an issue to a tested, reviewable pull request.",tools:"Git · gh · ripgrep · language servers",installed:true,category:"Development"),
            .init(id:"browser",name:"Browser",icon:"globe",description:"A persistent browser with live viewing and human takeover.",tools:"Chromium · Playwright · Steel",installed:true,category:"Browser & accounts"),
            .init(id:"docs",name:"Documents & data",icon:"doc.text",description:"Reports, spreadsheets, PDFs and traceable calculations.",tools:"Python · LibreOffice · Docling",installed:true,category:"Knowledge work"),
            .init(id:"ops",name:"Server operations",icon:"server.rack",description:"Inspect services, diagnose faults and request scoped sudo.",tools:"systemd · Docker · health checks",installed:true,category:"Infrastructure"),
            .init(id:"search",name:"Research & search",icon:"magnifyingglass",description:"Search, compare and return to the original evidence.",tools:"SearXNG · page extraction · citations",installed:true,category:"Knowledge work"),
            .init(id:"accounts",name:"Accounts & secrets",icon:"key",description:"Use approved identities without placing secrets in a task.",tools:"Local vault · OAuth · identity broker",installed:true,category:"Browser & accounts"),
            .init(id:"mail",name:"Mail & calendar",icon:"envelope",description:"Triage, draft replies and prepare calendar invitations.",tools:"Local adapters · approved account APIs",installed:false,category:"Personal"),
            .init(id:"payments",name:"Purchasing",icon:"creditcard",description:"Prepare a cart, request approval and keep the receipt.",tools:"Local payment broker · budget ledger",installed:true,category:"Personal"),
            .init(id:"voice",name:"Speech & media",icon:"waveform",description:"Turn voice notes and recordings into useful artifacts.",tools:"whisper.cpp · FFmpeg · OCR",installed:false,category:"Knowledge work"),
            .init(id:"mcp",name:"MCP & custom tools",icon:"puzzlepiece.extension",description:"Discover and install local adapters as needs grow.",tools:"Pi extensions · stdio MCP · skills",installed:true,category:"Development"),
            .init(id:"auto",name:"Automations",icon:"clock.arrow.circlepath",description:"Scheduled work and quiet, meaningful monitoring.",tools:"Local scheduler · triggers · procedures",installed:true,category:"Infrastructure")
        ]
        approvals = [
            .init(id:"push",title:"Push the filter-sync branch",type:"Command",task:"filter",detail:"The fix and three regression tests are ready. This publishes the branch; it does not merge or deploy it.",target:"git push origin fix/filter-sync",consequence:"storefront-web · 3 files changed · +146 −27"),
            .init(id:"sudo",title:"Clean old build cache",type:"Administration",task:"server",detail:"Remove cache files older than 14 days. Active worktrees, outputs and backups are excluded.",target:"sudo outpost-maintenance prune-build-cache --older-than 14d",consequence:"outpost-01 workspace · estimated 18.2 GB reclaimed"),
            .init(id:"login",title:"Sign in to the billing portal",type:"Account",task:"invoice",detail:"Take over the protected browser to sign in. Pi will resume collecting invoices after you return control.",target:"Hosting account / Billing",consequence:"Invoice downloads only · access expires in 30 minutes"),
            .init(id:"purchase",title:"Review the domain renewal",type:"Purchase",task:"invoice",detail:"Approve the entire renewal workflow: checkout, payment verification and receipt collection. The one-year order is capped at ₹1,249.00; auto-renew stays off.",target:"outpost-lab.dev · 1 year · ₹1,249.00",consequence:"One workflow · maximum ₹1,249.00 · expires in 15 minutes")
        ]
        automations = [
            .init(id:"health",name:"Keep an eye on the server",schedule:"Every 30 minutes",last:"Healthy, 12 minutes ago",next:"In 18 minutes",active:true,icon:"server.rack"),
            .init(id:"deps",name:"Weekly dependency review",schedule:"Mondays at 09:00 IST",last:"1 update needs review",next:"Monday, 2 Nov",active:true,icon:"shippingbox"),
            .init(id:"report",name:"Friday operations summary",schedule:"Fridays at 17:00 IST",last:"Report saved to Library",next:"Friday, 30 Oct",active:true,icon:"doc.text"),
            .init(id:"invoices",name:"Collect monthly invoices",schedule:"1st of each month",last:"Waiting for account access",next:"Paused",active:false,icon:"tray.and.arrow.down")
        ]
        audit = ["21:14  Read system journal · server operations", "21:12  Requested scoped cache cleanup · waiting", "21:10  Created checkpoint · filter-sync / turn 3", "21:08  Completed 11 tests · storefront-web", "21:04  Used GitHub read scope · personal account", "20:58  Started October report · documents worker"]
        messages = [:]; pinnedMemories = []; serverConnected = true; browserHuman = false; browserSignedIn = false
        browserTab = "Pull request"; composer = ""; mode = "Code"; toast = nil
        taskSearch = ""; taskFilter = "All tasks"; featureSearch = ""; featureCategory = "All areas"
        destination = .home; selectedTask = "filter"; workTab = "Diff"; sheet = nil
        controlMode = .ask
    }
    func changeControlMode(_ value: ControlMode) {
        controlMode = value
        audit.insert("21:16  Control mode changed to \(value.rawValue) · Owner", at: 0)
        notify("\(value.rawValue) selected for both mock clients. No actions were executed.")
    }
    func notify(_ message: String) { toast = message }
    func openTask(_ id: String) { selectedTask = id; destination = .workbench; workTab = id == "invoice" ? "Browser" : id == "report" || id == "pipeline" ? "Outputs" : id == "server" ? "Activity" : "Diff" }
    func setStatus(_ id: String, _ status: String) { if let i = tasks.firstIndex(where: { $0.id == id }) { tasks[i].status = status } }
    func decide(_ id: String, allow: Bool, device: String = "Mac") {
        guard let i = approvals.firstIndex(where: { $0.id == id }), !approvals[i].resolved else { return }
        if id == "login" && allow {
            browserHuman = true; browserTab = "Billing portal"
            if device == "Mac" { destination = .browser }
            notify("You have control. Complete the sample sign-in to resume Pi.")
            return
        }
        approvals[i].resolved = true; approvals[i].decision = allow ? "Approved on \(device)" : "Denied on \(device)"
        let stillWaiting = approvals.contains { $0.task == approvals[i].task && !$0.resolved }
        setStatus(approvals[i].task, allow ? (stillWaiting ? "Needs you" : "Done") : "Paused")
        audit.insert("21:16  \(allow ? "Approved" : "Denied") \(approvals[i].title.lowercased()) · \(device)", at: 0)
        notify(allow ? "Approval recorded in the preview." : "Action denied. The task is paused.")
    }
    func signIn(device: String = "Mac") {
        browserSignedIn = true; browserHuman = false
        if let i = approvals.firstIndex(where: { $0.id == "login" }), !approvals[i].resolved {
            approvals[i].resolved = true; approvals[i].decision = "Signed in on \(device)"
            setStatus("invoice", "Running")
            audit.insert("21:16  Completed sample billing sign-in · \(device)", at: 0)
        }
        notify("Sample session signed in. Pi can resume invoice collection.")
    }
    func detail(_ title: String, icon: String = "square.stack", _ description: String, fields: [(String,String)] = [], confirm: String = "Done", action: (() -> Void)? = nil) {
        sheet = DetailSheet(title:title,icon:icon,detail:description,fields:fields,confirm:confirm,action:action)
    }
    func send() {
        let text = composer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if destination != .workbench {
            let id = UUID().uuidString
            tasks.insert(.init(id:id,title:text,project:"Personal",mode:mode,status:"Running",time:"Just now",summary:"A new task is ready in this design preview."),at:0)
            selectedTask = id; destination = .workbench; workTab = mode == "Browser" ? "Browser" : "Plan"
        }
        messages[selectedTask, default: []].append(text)
        composer = ""; notify("Mock task updated. No real work is running.")
    }
}
