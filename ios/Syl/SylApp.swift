import SwiftUI

@main
struct SylApp: App {
    /// The delegate exists only because APNs hands the device token to a delegate
    /// method with no SwiftUI equivalent. It reads its configuration from
    /// `UserDefaults`, not from anything in this scene, because it runs on launch
    /// paths where this scene has not been built yet.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView(appDelegate: appDelegate)
        }
    }
}

/// Wires the live state into the shell.
///
/// `NotificationService` is observed separately rather than reached through the
/// delegate: a nested `ObservableObject` does not republish its owner, so permission
/// changing from "not asked" to "allowed" would update nothing on screen.
struct RootView: View {
    @ObservedObject var appDelegate: AppDelegate
    @StateObject private var profiles = ServerProfileStore()
    @StateObject private var network = NetworkMonitor()

    var body: some View {
        StatusView(
            notifications: appDelegate.notifications,
            serverName: profiles.selected.name,
            baseURL: profiles.selected.baseURL,
            reachability: network.reachability,
            registration: appDelegate.registration
        )
        .task {
            network.start()
            appDelegate.notifications.refreshAuthorization()
        }
    }
}

struct StatusView: View {
    @ObservedObject var notifications: NotificationService
    let serverName: String
    let baseURL: URL
    let reachability: NetworkMonitor.Reachability
    let registration: AppDelegate.RegistrationState

    var body: some View {
        ContentView(
            serverName: serverName,
            baseURL: baseURL,
            reachability: reachability,
            notificationAuthorization: notifications.authorization,
            registration: registration
        )
    }
}
