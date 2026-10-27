import SwiftUI
import OutpostKit

@main struct OutpostApp: App {
    @State private var connection = Connection()
    init() { Studio.registerFonts() }
    var body: some Scene {
        WindowGroup { WorkspaceView().environment(connection).frame(minWidth: 760, minHeight: 620) }
            .defaultSize(width: 1280, height: 860)
            .commands { SidebarCommands(); CommandGroup(after: .newItem) { Button("Reconnect to Server") { Task { await connection.connect() } }.keyboardShortcut("r") } }
        Settings { ConnectionView().environment(connection).frame(width: 660, height: 560) }
    }
}
