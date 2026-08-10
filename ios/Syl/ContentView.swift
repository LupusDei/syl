import SwiftUI
import SylKit

/// The shell's status surface.
///
/// Deliberately a pure function of values, with no observable objects of its own, so
/// it can be constructed and rendered in a test without booting the app's object
/// graph. `RootView` is what wires the live state in.
///
/// What it shows is chosen on one principle: **offline is a state to design, not an
/// error to report.** The server genuinely will be unreachable sometimes — the Mac
/// reboots, the tailnet drops on a WiFi-to-cellular handoff, the phone goes through a
/// tunnel — and an assistant that silently fails to sync is worse than one that says
/// so.
///
/// It is also the app's Settings surface, which until `syl-1h3` did not exist at all.
/// The Developer section at the bottom is the only way to the web admin.
struct ContentView: View {
    var serverName: String = ServerProfile.mock.name
    var baseURL: URL = ServerProfile.mock.baseURL
    var reachability: NetworkMonitor.Reachability = .unknown
    var notificationAuthorization: NotificationService.Authorization = .unknown
    var registration: AppDelegate.RegistrationState = .idle
    /// How the Developer section reaches the bearer token and checks it. `nil` in
    /// previews and tests, which have no Keychain and no server — the section then
    /// says so rather than offering a link that cannot work.
    var adminAccess: AdminConsoleAccess? = nil
    /// Crash and hang reports collected on this device. `nil` in previews and tests,
    /// which have no MetricKit delivery to subscribe to.
    var diagnostics: CrashDiagnostics? = nil
    /// The appearance choice, live. A `Binding` with a constant default rather than the
    /// store itself, so this view keeps its defining property — constructible from plain
    /// values, with no object graph — while still writing through to `UserDefaults` in
    /// the app. `RootView` hands it the real one.
    var appearance: Binding<AppearanceChoice> = .constant(.system)

    var body: some View {
        NavigationStack {
            List {
                // First, and above the server rows, because it is the only thing on this
                // screen he came here to *change* — everything below it is the app
                // reporting on itself. "How do I switch dark mode?" was the question that
                // created this control, and a setting he has to scroll past three
                // diagnostic sections to find has only half answered it.
                AppearanceSection(choice: appearance)

                Section("Server") {
                    LabeledContent("Profile", value: serverName)
                    LabeledContent("Address", value: baseURL.absoluteString)
                        .font(.footnote.monospaced())
                    LabeledContent("Network", value: reachabilityLabel)
                }

                Section("Notifications") {
                    LabeledContent("Permission", value: authorizationLabel)
                    LabeledContent("Push", value: registrationLabel)
                    if case .registered(_, let environment) = registration {
                        // The environment travels with the token, and a mismatch is
                        // invisible except as BadDeviceToken on every send — so it is
                        // on screen rather than in a log.
                        LabeledContent("APNs", value: environment.rawValue)
                    }
                }

                Section {
                    Text(
                        """
                        Reminders arrive as notifications whether or not this app is \
                        open, and whether or not the tailnet is up — push reaches the \
                        phone over Apple's network, which does not touch the tunnel.
                        """
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }

                if let diagnostics {
                    DiagnosticsSection(diagnostics: diagnostics)
                }

                DeveloperSettingsSection(apiBaseURL: baseURL, access: adminAccess)
            }
            .navigationTitle("Settings")
        }
    }

    private var reachabilityLabel: String {
        switch reachability {
        case .unknown: return "Checking"
        case .online(let isExpensive): return isExpensive ? "Online (cellular)" : "Online"
        case .offline: return "Offline"
        }
    }

    private var authorizationLabel: String {
        switch notificationAuthorization {
        case .unknown: return "Not asked"
        case .granted: return "Allowed"
        case .denied: return "Denied"
        }
    }

    private var registrationLabel: String {
        switch registration {
        case .idle: return "Not registered"
        case .registering: return "Registering"
        case .registered(let suffix, _): return "…\(suffix)"
        case .failed(let reason): return reason
        }
    }
}

#Preview {
    ContentView(
        reachability: .online(isExpensive: false),
        notificationAuthorization: .granted,
        registration: .registered(tokenSuffix: "9c0d2e41", environment: .production)
    )
}
