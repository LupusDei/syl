import SwiftUI
import SylKit

/// Settings → Web admin.
///
/// The WebView appears only once the credential has been verified. Every other outcome
/// is a native screen with a specific sentence and a specific next action, on the same
/// principle as `PairingView`: a surface that stops and says nothing sends the
/// Commander to debug the wrong thing.
struct AdminConsoleScreen: View {
    /// `@StateObject`, for the reason written out at length in `PairingView`: a parent
    /// re-render must not replace the model and restart the check.
    @StateObject private var model: AdminConsoleViewModel

    init(model: AdminConsoleViewModel) {
        _model = StateObject(wrappedValue: model)
    }

    var body: some View {
        content
            .navigationTitle("Web admin")
            .navigationBarTitleDisplayMode(.inline)
            .task { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .checking:
            ProgressView("Checking this device's credential…")

        case .ready:
            if let credential = model.credential {
                AdminWebView(
                    url: model.adminURL,
                    credential: credential,
                    policy: model.policy,
                    onHTTPStatus: { model.handle(httpStatus: $0) },
                    onFailure: { model.handleNavigationFailure($0) }
                )
                .ignoresSafeArea(edges: .bottom)
            } else {
                // Unreachable in practice — `load()` checks first — but a WebView with
                // no credential must never be the fallback.
                failure(
                    "No credential",
                    systemImage: "key.slash",
                    detail: "This device is not holding a token. Re-pair it."
                )
            }

        case .noCredential:
            failure(
                "This device is not paired",
                systemImage: "key.slash",
                detail: "There is no token in the Keychain, so there is nothing to sign in with."
            )

        case .unauthenticated:
            failure(
                "Not authenticated",
                systemImage: "lock.trianglebadge.exclamationmark",
                detail: """
                    Syl answered, and rejected this device's token. The admin is fine — \
                    the credential is not. Run `npm run pair` on the Mac and pair this \
                    device again.
                    """
            )

        case .unreachable(let detail):
            failure(
                "Cannot reach Syl",
                systemImage: "wifi.exclamationmark",
                detail: """
                    \(detail)

                    The credential is probably fine. Check Tailscale and that the Mac \
                    is awake, then try again.
                    """
            )

        case .notServed:
            failure(
                "The admin is not being served",
                systemImage: "questionmark.folder",
                detail: """
                    Syl is up and answering, but there is nothing at \
                    \(model.adminURL.path) on \(model.adminURL.host() ?? "this server"). \
                    That is the service half of this feature, not the app.
                    """
            )

        case .failed(let detail):
            failure("The admin did not load", systemImage: "exclamationmark.triangle", detail: detail)
        }
    }

    private func failure(_ title: String, systemImage: String, detail: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(detail)
        } actions: {
            Button("Try again") { Task { await model.load() } }
        }
    }
}
