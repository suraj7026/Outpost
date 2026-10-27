import SwiftUI
import UIKit
import UserNotifications
import OutpostKit

final class NotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: Notification.Name("OutpostPushToken"), object: deviceToken.map { String(format: "%02x", $0) }.joined())
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run { NotificationCenter.default.post(name: Notification.Name("OutpostNoticeOpened"), object: nil) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: Notification.Name("OutpostPushFailure"), object: error.localizedDescription)
    }
}
@main struct OutpostPhoneApp: App {
    @UIApplicationDelegateAdaptor(NotificationDelegate.self) private var delegate
    @State private var connection = Connection()
    init() { Studio.registerFonts() }
    var body: some Scene {
        WindowGroup {
            WorkspaceView().environment(connection)
                .onReceive(NotificationCenter.default.publisher(for: Notification.Name("OutpostPushToken"))) { notice in
                    if let token = notice.object as? String {
                        Task { await connection.send("device.register_push", id: connection.deviceID, revision: 0, payload: ["token": .string(token), "topic": .string(Bundle.main.bundleIdentifier ?? "dev.outpost.ios"), "environment": .string("sandbox")]) }
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: Notification.Name("OutpostNoticeOpened"))) { _ in Task { await connection.connect() } }
                .onReceive(NotificationCenter.default.publisher(for: Notification.Name("OutpostPushFailure"))) { notice in connection.error = "Push is not provisioned: \(notice.object as? String ?? "registration failed"). Inbox sync still works." }
        }
    }
}
