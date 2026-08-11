import CryptoKit
import Foundation
import SylKit

/// Turning eight digits and a hostname into a credential the app keeps forever.
///
/// **This is the only way a token ever enters the app.** Nothing is baked into the
/// build, nothing is typed in as a long secret, and the thing the Commander handles
/// is deliberately the *short-lived* half: eight digits, ten minutes, one device. The
/// token he never sees goes straight to the Keychain.
///
/// ## Why the failures are modelled and not stringified
///
/// `syl-q1f` shipped with `SylAPI.pair` having no callers at all, so none of this
/// existed. When it is written it is tempting to write it as one `catch` and one
/// "pairing failed" — and that is the version that costs an evening, because the four
/// things that go wrong here have four different next actions and no way to tell them
/// apart from a phone with no debugger attached:
///
/// - **the code is wrong** — check the digits and try again;
/// - **the code has expired** — go back to the Mac, run the command again;
/// - **the code has already paired something** — same, but stop retyping this one;
/// - **the Mac is not reachable at all** — nothing about the code is wrong; the
///   tunnel is down, or the hostname is not the right hostname.
///
/// The first three come back as typed error codes the service is careful about (see
/// `ErrorCode.pairingCodeExpired`). The fourth is the *absence* of an answer, and
/// telling it from a refusal is `APIError`'s whole job — under Tailscale the first
/// request after a wake genuinely does fail while the tunnel re-establishes, so
/// "cannot reach" must never render as "wrong code".
@MainActor
final class PairingViewModel: ObservableObject {
    /// Everything the screen can be showing.
    enum State: Equatable {
        case editing
        case pairing
        /// Done. The token is in the Keychain and the app can start.
        case paired(principalName: String)
    }

    /// What went wrong, in the terms the person in front of the phone needs.
    enum Failure: Equatable {
        /// Not eight digits. Caught here, without troubling the server.
        case malformedCode
        /// The entry is not something a URL can be made of.
        case unusableServer
        /// The server answered, and said no. Nothing narrows further than this.
        case incorrectCode
        case expiredCode
        case alreadyUsedCode
        /// Nothing answered. The code is not the problem.
        case unreachable(detail: String)
        /// The server answered something we could not read at all.
        case somethingElseAnswered(detail: String)

        /// The headline. Short enough to read at a glance while standing up.
        var title: String {
            switch self {
            case .malformedCode: return "That is not a pairing code"
            case .unusableServer: return "That is not a server address"
            case .incorrectCode: return "That code was not accepted"
            case .expiredCode: return "That code has expired"
            case .alreadyUsedCode: return "That code has already been used"
            case .unreachable: return "Could not reach that Mac"
            case .somethingElseAnswered: return "Something else answered"
            }
        }

        /// What to do next. Every one of these is a *different* next action, which is
        /// the entire reason this type exists.
        var recovery: String {
            switch self {
            case .malformedCode:
                return "A pairing code is eight digits, like 4821-9930."
            case .unusableServer:
                return """
                    Enter the address `npm run pair` printed, such as \
                    https://your-mac.tail0000.ts.net/api/v1
                    """
            case .incorrectCode:
                return "Check the digits and try again."
            case .expiredCode:
                return "A code lasts ten minutes. Run `npm run pair` on the Mac for a new one."
            case .alreadyUsedCode:
                return """
                    A code pairs one device and is then spent. Run `npm run pair` on the \
                    Mac for a new one — retyping this one will not work.
                    """
            case .unreachable(let detail):
                return """
                    The code may be fine. Check the address, and that Tailscale is \
                    connected on both this phone and the Mac. (\(detail))
                    """
            case .somethingElseAnswered(let detail):
                return """
                    Something on the network replied instead of Syl — a captive portal, \
                    or a Tailscale error page. (\(detail))
                    """
            }
        }

        /// Whether the code field is the thing to fix.
        ///
        /// Drives which field the screen puts the cursor back in. Getting this wrong
        /// is minor and getting it right is most of what makes a setup screen feel
        /// like it is helping.
        var isAboutTheCode: Bool {
            switch self {
            case .malformedCode, .incorrectCode, .expiredCode, .alreadyUsedCode:
                return true
            case .unusableServer, .unreachable, .somethingElseAnswered:
                return false
            }
        }
    }

    /// Performs the exchange. Injected so every branch above is reachable in a test
    /// without a Mac, a tailnet, or a server that can be made to expire a code.
    typealias Pairer = @Sendable (URL, PairRequest) async throws -> TokenGrant

    @Published var serverEntry: String
    @Published var code: String = ""
    @Published private(set) var state: State = .editing
    @Published private(set) var failure: Failure?

    private let deviceName: String
    private let pairer: Pairer
    private let onPaired: (ServerProfile, TokenGrant) -> Void

    init(
        serverEntry: String = "",
        deviceName: String,
        pairer: @escaping Pairer = PairingViewModel.livePairer,
        onPaired: @escaping (ServerProfile, TokenGrant) -> Void
    ) {
        self.serverEntry = serverEntry
        self.deviceName = deviceName
        self.pairer = pairer
        self.onPaired = onPaired
    }

    /// Whether the button should be tappable. Cheap local checks only.
    var canSubmit: Bool {
        if case .pairing = state { return false }
        return !serverEntry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && Self.normalise(code) != nil
    }

    /// `48219930`, `4821 9930`, `4821-9930` — all the same code.
    ///
    /// A person reading eight digits off a terminal types them however they type
    /// them, and rejecting a space is not a security property. Returns `nil` when the
    /// digits do not amount to a code.
    static func normalise(_ entry: String) -> String? {
        let digits = entry.filter(\.isNumber)
        guard digits.count == 8 else { return nil }
        let index = digits.index(digits.startIndex, offsetBy: 4)
        return "\(digits[..<index])-\(digits[index...])"
    }

    /// Try to pair. Ignored while an attempt is already in flight.
    func pair() async {
        if case .pairing = state { return }
        await attempt()
    }

    private func attempt() async {
        failure = nil

        guard let profile = ServerProfile.from(entry: serverEntry) else {
            failure = .unusableServer
            return
        }
        guard let pairingCode = Self.normalise(code) else {
            // Never sent. An eight-digit shape is something the phone can check, and
            // a round trip to be told so is a round trip that can also time out.
            failure = .malformedCode
            return
        }

        state = .pairing
        do {
            let grant = try await pairer(
                profile.baseURL,
                PairRequest(pairingCode: pairingCode, deviceName: deviceName)
            )
            // The order matters: the caller stores the token *and* selects the profile,
            // and until both have happened the app would talk to the old server with
            // the new token or the new server with none.
            onPaired(profile, grant)
            state = .paired(principalName: grant.principal.name)
        } catch let error as APIError {
            state = .editing
            failure = Self.classify(error)
        } catch {
            state = .editing
            failure = .unreachable(detail: error.localizedDescription)
        }
    }

    /// The four states, from one thrown error.
    static func classify(_ error: APIError) -> Failure {
        switch error {
        case .api(let api, _):
            switch api.code {
            case .pairingCodeExpired: return .expiredCode
            case .pairingCodeAlreadyUsed: return .alreadyUsedCode
            default: return .incorrectCode
            }
        case .transport(_, let description):
            return .unreachable(detail: description)
        case .malformedResponse(let status, let preview):
            // Envelope-shaped is Syl; anything else is a proxy or a portal, and
            // telling the Commander his code was wrong would be a lie.
            return .somethingElseAnswered(detail: "HTTP \(status): \(preview)")
        case .decoding(let detail):
            return .somethingElseAnswered(detail: detail)
        case .cancelled:
            return .unreachable(detail: "Cancelled.")
        }
    }

    /// The idempotency key for a pairing attempt. **Derived, never generated.**
    ///
    /// `syl-ux1` is the reason, and pairing is the write it happened to: the code is
    /// consumed on use, so a response lost in flight — which under Tailscale is a
    /// routine event, not an exotic one — left the code spent and the device
    /// permanently unpairable. A fresh key per attempt has exactly that failure. The
    /// same key means the second attempt replays the stored grant, and the Commander
    /// never learns anything went wrong.
    ///
    /// It is a SHA-256 and not the code itself because the key reaches the server's
    /// idempotency ledger, which is a table on disk. The pairing code is a
    /// credential; the service takes trouble to keep it out of its own store, and
    /// handing it back in a header would put it there anyway.
    static func idempotencyKey(for request: PairRequest) -> String {
        let material = Data("\(request.pairingCode)|\(request.deviceName)".utf8)
        let digest = SHA256.hash(data: material)
        return "pair-\(digest.map { String(format: "%02x", $0) }.joined())"
    }

    /// The real exchange. A client built for this one call, against the URL being
    /// tried rather than the one in `UserDefaults` — nothing has been selected yet.
    static let livePairer: Pairer = { baseURL, request in
        let client = APIClient(configuration: ServerConfiguration(baseURL: baseURL))
        return try await client.send(
            try SylAPI.pair(request, idempotencyKey: idempotencyKey(for: request))
        )
    }
}
