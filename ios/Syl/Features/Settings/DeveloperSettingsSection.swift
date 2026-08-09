import SwiftUI
import SylKit

/// The Developer section at the bottom of Settings, and the only way into the admin.
///
/// ## Why a toggle and not `#if DEBUG`
///
/// The master plan calls the web admin a **development instrument, not a user
/// feature**, so it should be reachable rather than prominent. `#if DEBUG` is the
/// obvious way to express that and is the wrong one here: the Commander's phone runs
/// the TestFlight build, which is Release, so a debug-only surface would be absent from
/// the one build that needs it. He asked to debug the admin *from his phone*.
///
/// So: an explicit toggle, off by default, at the bottom of Settings. Off, the section
/// is a single row nobody trips over. On, it stays on, because a debug surface that
/// resets itself every launch is a debug surface nobody uses.
struct DeveloperSettingsSection: View {
    /// The API base URL the app is actually talking to. The admin URL is *derived*
    /// from it — see `AdminConsole.url(forAPIBaseURL:)` — rather than stored beside it,
    /// so re-pairing moves both at once.
    let apiBaseURL: URL
    /// `nil` in previews and in anything constructed without the app's object graph.
    let access: AdminConsoleAccess?

    @AppStorage("syl.settings.webAdminEnabled") private var isEnabled = false

    var body: some View {
        Section {
            Toggle("Web admin", isOn: $isEnabled)

            if isEnabled {
                destination
            }
        } header: {
            Text("Developer")
        } footer: {
            Text("""
                Syl's web admin, served from the same server this app is paired to. \
                It is a debugging instrument — it signs in with this device's own \
                credential and cannot navigate anywhere but \
                \(apiBaseURL.host() ?? "the paired server").
                """)
        }
    }

    @ViewBuilder
    private var destination: some View {
        if let access,
           let adminURL = AdminConsole.url(forAPIBaseURL: apiBaseURL),
           let model = AdminConsoleViewModel(adminURL: adminURL, access: access) {
            NavigationLink {
                AdminConsoleScreen(model: model)
            } label: {
                LabeledContent("Open") {
                    Text(adminURL.absoluteString)
                        .font(.footnote.monospaced())
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
        } else {
            // The mock profile lands here, and correctly. `AdminConsole` refuses to
            // derive an admin URL over cleartext: this WebView carries a live bearer
            // token, an `http` origin would publish it on the wire, and loading one at
            // all would need an App Transport Security exception the project has
            // deliberately not taken.
            Text("""
                The admin needs a server reachable over https. \
                \(apiBaseURL.host() ?? "This profile") is not one.
                """)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }
}
