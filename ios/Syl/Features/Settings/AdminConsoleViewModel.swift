import Foundation
import SylKit

/// What the admin WebView is allowed to know about the rest of the app: how to read
/// the bearer token, and how to ask Syl whether it is still one.
///
/// Deliberately two closures rather than the `TokenStore` and the `SylBackend`. This is
/// the one screen in the app that needs the *raw* credential rather than a client with
/// it already attached, so the surface it can reach is written out rather than implied.
struct AdminConsoleAccess {
    /// The bearer token, straight from the Keychain.
    let readCredential: @MainActor () -> String?
    /// `GET /auth/whoami` — the cheapest authenticated call there is, and the only one
    /// that can tell a dead token apart from a tunnel that has not come up yet.
    let verify: @MainActor () async -> AdminConsoleViewModel.Preflight
}

/// The state machine behind Settings → Web admin.
///
/// It exists for one reason that is worth stating plainly: **a WebView that renders an
/// empty admin on a rejected token is indistinguishable from a broken admin.** The
/// admin's own answer to a 401 is to clear the key and show its login gate, which on a
/// phone means a keyboard and a key the Commander does not have and should not need.
/// So the credential is checked natively first, and every way this can fail gets its
/// own state and its own sentence.
///
/// It also owns the navigation policy. The token handoff (`syl-iu3`) and the origin
/// restriction (`syl-1h3`) are one change, and this is where that is structural: the
/// object that hands out the credential is the object that carries the policy, and its
/// initialiser fails if no origin can be locked to.
@MainActor
final class AdminConsoleViewModel: ObservableObject {
    /// What asking the server produced.
    enum Preflight: Equatable, Sendable {
        case authenticated
        /// The server answered, and said no. Re-pairing is the fix.
        case rejected
        /// Nothing answered. Routine under Tailscale straight after a wake, and *not*
        /// the same thing as a rejected credential — rendering it as one would send the
        /// Commander back to the Mac for nothing.
        case unreachable(String)
    }

    enum State: Equatable {
        case checking
        /// Verified. The WebView may load.
        case ready
        /// Nothing in the Keychain. Only reachable if the app is somehow unpaired.
        case noCredential
        case unauthenticated
        case unreachable(String)
        /// The origin answered 404 — Syl is up, `/admin` is not being served.
        case notServed
        case failed(String)
    }

    let adminURL: URL
    /// The restriction, built from the URL this screen was pointed at. `let`, so
    /// nothing can widen it later.
    let policy: AdminNavigationPolicy

    @Published private(set) var state: State = .checking

    private let access: AdminConsoleAccess

    /// - Returns: `nil` when `adminURL` is not a web origin. There is no fallback on
    ///   purpose: a screen that could not determine an origin would be a WebView
    ///   holding a live credential and permitting everything.
    init?(adminURL: URL, access: AdminConsoleAccess) {
        guard let policy = AdminNavigationPolicy(adminURL: adminURL) else { return nil }
        self.adminURL = adminURL
        self.policy = policy
        self.access = access
    }

    /// The token to inject, or `nil` if there is not a usable one. Blank is not a
    /// credential — injecting `""` produces `Bearer ` and a 401 from inside the page,
    /// which is precisely the confusing outcome this screen avoids.
    var credential: String? {
        guard let raw = access.readCredential() else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Check, then decide whether the WebView loads at all. Also the retry path — it
    /// re-asks rather than re-rendering the last conclusion, because "the tunnel is up
    /// now" is the usual reason to press it.
    func load() async {
        state = .checking
        guard credential != nil else {
            state = .noCredential
            return
        }
        switch await access.verify() {
        case .authenticated: state = .ready
        case .rejected: state = .unauthenticated
        case .unreachable(let detail): state = .unreachable(detail)
        }
    }

    /// What the document request itself came back as.
    ///
    /// The preflight passing does not mean this will: a token can be revoked in
    /// between, and `/admin` may simply not exist yet — `syl-6vt` is the bead that
    /// serves it. A 404 rendered as a blank page reads as "the admin is broken", which
    /// is the wrong thing to go and debug.
    func handle(httpStatus: Int) {
        switch httpStatus {
        case 401, 403: state = .unauthenticated
        case 404: state = .notServed
        case 400..<600: state = .failed("The server answered \(httpStatus).")
        default: break
        }
    }

    func handleNavigationFailure(_ error: Error) {
        state = .unreachable((error as NSError).localizedDescription)
    }
}
