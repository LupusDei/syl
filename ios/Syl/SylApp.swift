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
    @StateObject private var appearance = AppearanceStore()

    @Environment(\.scenePhase) private var scenePhase

    /// One `preferredColorScheme`, at the root, above both the paired and unpaired
    /// branches.
    ///
    /// Applied here rather than per screen for the reason the setting exists at all: an
    /// appearance applied screen by screen is exactly how the app ended up bright in chat
    /// and black on Home. One call at the top is a guarantee that nothing below can be
    /// out of step, and `nil` for System leaves the window unpinned so iOS changing
    /// appearance moves the whole app with no relaunch.
    ///
    /// `sylAppearance` travels alongside it because the resolved scheme cannot answer
    /// "did he ask for this" — and the home screen has to know the difference.
    var body: some View {
        content
            .preferredColorScheme(appearance.choice.preferredColorScheme)
            .environment(\.sylAppearance, appearance.choice)
    }

    @ViewBuilder
    private var content: some View {
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
            // Home first, because it is the screen that answers "what do I need to do"
            // and `SOUL.md` says that is what the first thing on any surface must
            // answer. It is also the only tab that leads anywhere else.
            Group {
                if let home = appDelegate.home, let list = appDelegate.list {
                    HomeScreen(
                        model: home,
                        list: list,
                        // The seam both constellation squads stopped short of. Without it
                        // the Memory door opens onto an empty field that looks exactly
                        // like the truth.
                        sky: SkyFromMemory.source(appDelegate.constellation)
                    )
                } else {
                    unopenableStore
                }
            }
            .tabItem { Label("Today", systemImage: "sparkles") }

            NavigationStack {
                if let chat = appDelegate.chat {
                    ChatView(model: chat)
                } else {
                    unopenableStore
                }
            }
            // The paired origin and the credentialed fetcher, for any bubble carrying a
            // picture. Read from the delegate on every evaluation rather than captured,
            // so re-pairing moves the attachments with everything else.
            .environment(\.attachmentContext, appDelegate.attachmentContext)
            .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }

            StatusView(
                notifications: appDelegate.notifications,
                serverName: profiles.selected.name,
                baseURL: profiles.selected.baseURL,
                reachability: network.reachability,
                registration: appDelegate.registration,
                adminAccess: appDelegate.adminConsoleAccess,
                diagnostics: appDelegate.diagnostics,
                appearance: $appearance.choice
            )
            .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(SylTheme.Colour.accent)
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

    /// A database that will not open is a real state, not a crash. The status tab still
    /// works and still says what is wrong.
    private var unopenableStore: some View {
        ContentUnavailableView(
            "This device's copy of Syl could not be opened",
            systemImage: "externaldrive.badge.exclamationmark",
            description: Text("Check free space, then relaunch.")
        )
    }
}

struct StatusView: View {
    @ObservedObject var notifications: NotificationService
    let serverName: String
    let baseURL: URL
    let reachability: NetworkMonitor.Reachability
    let registration: AppDelegate.RegistrationState
    let adminAccess: AdminConsoleAccess
    let diagnostics: CrashDiagnostics
    /// Straight through to the store's own `@Published` property, so choosing a
    /// segment persists and repaints the app in the same gesture.
    let appearance: Binding<AppearanceChoice>

    var body: some View {
        ContentView(
            serverName: serverName,
            baseURL: baseURL,
            reachability: reachability,
            notificationAuthorization: notifications.authorization,
            registration: registration,
            adminAccess: adminAccess,
            diagnostics: diagnostics,
            appearance: appearance
        )
    }
}
