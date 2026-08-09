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

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            NavigationStack {
                if let chat = appDelegate.chat {
                    ChatView(model: chat)
                } else {
                    // A database that will not open is a real state, not a crash. The
                    // status tab still works and still says what is wrong.
                    ContentUnavailableView(
                        "This device's copy of Syl could not be opened",
                        systemImage: "externaldrive.badge.exclamationmark",
                        description: Text("Check free space, then relaunch.")
                    )
                }
            }
            .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }

            StatusView(
                notifications: appDelegate.notifications,
                serverName: profiles.selected.name,
                baseURL: profiles.selected.baseURL,
                reachability: network.reachability,
                registration: appDelegate.registration
            )
            .tabItem { Label("Status", systemImage: "gearshape") }
        }
        .task {
            network.start()
            appDelegate.notifications.refreshAuthorization()
        }
        .onChange(of: scenePhase) { _, phase in
            // The foreground reconcile. Push collapses a night of notifications into
            // one and Apple offers no way to ask what arrived, so returning to the app
            // is where anything dropped or coalesced reappears.
            guard phase == .active else { return }
            Task { await appDelegate.synchroniseNow() }
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
