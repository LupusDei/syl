import SwiftUI
import UIKit

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
        if appDelegate.isPaired {
            paired
        } else {
            // `syl-q1f`. Without this the app looked healthy and was inert: no token
            // meant no `Authorization` header on anything, a socket that answered
            // `.unauthenticated` and stopped, and no screen anywhere that said so.
            //
            // The arguments are read once — `PairingView` holds its model as a
            // `@StateObject` — so this body re-evaluating does not wipe the fields
            // he is typing into. See the note there.
            PairingView(
                // Pre-filled only when he has been here before: a profile he already
                // chose is the likeliest answer, and retyping a tailnet hostname on a
                // phone keyboard is nobody's idea of a good time.
                serverEntry: profiles.selected.id == "mock"
                    ? ""
                    : profiles.selected.baseURL.absoluteString,
                deviceName: UIDevice.current.name,
                onPaired: { profile, grant in
                    appDelegate.completePairing(grant: grant, profile: profile, profiles: profiles)
                }
            )
        }
    }

    private var paired: some View {
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
            // Is the credential we are holding still a credential? A Keychain item
            // survives deleting the app, so a reinstall arrives already "paired"
            // against a token that may have been revoked in the meantime.
            await appDelegate.verifyPairing()
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
