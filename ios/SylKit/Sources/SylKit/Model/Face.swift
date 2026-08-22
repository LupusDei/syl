import Foundation

/// Her face, live — the client half of the contract (`syl-chzl.7.1`, T021).
///
/// ## The one rule this file exists to enforce
///
/// **The avatar secret has no representation in SylKit and no place to be stored on a
/// phone.** The device asks Syl's own backend for a session and receives a *short-lived
/// session key* and nothing else; the vendor API key stays on the Mac at home, exactly as
/// Adjutant's bridge broker already does it. There is deliberately no `apiKey`, no
/// `secret` and no `Authorization`-bearing field anywhere in this type — not because
/// nobody would add one, but so that adding one is a visible change to a file whose
/// documentation says not to.
///
/// ## Why the join credentials are optional
///
/// `sessionId`, `sessionKey` and `expiresAt` are what T011 promises and are therefore
/// required. `roomName`, `serverURL` and `token` are the *native* join credentials — a
/// browser hands the session key to a JavaScript SDK and gets a room; a phone cannot,
/// and needs the room minted server-side (the shape Adjutant calls
/// `NativeConsumerCreds`).
///
/// They are optional rather than absent so that this client decodes a broker that
/// supplies them **and** a broker that does not, without a second model and without a
/// coordinated landing. A session with no join credentials is still a session — it is
/// simply one this device cannot yet render, and ``canJoin`` is the honest name for that
/// difference. See the note in `LiveFaceModel` about what the surface says when it is
/// false.
public struct FaceSession: Codable, Equatable, Sendable, Identifiable {
    /// The broker's handle on this session. What ``SylAPI/closeFaceSession(_:idempotencyKey:)``
    /// names, and what the meter is read against.
    public let sessionId: String

    /// The short-lived credential. **This is the only secret-shaped thing that ever
    /// reaches the device**, it is scoped to one session, and it expires.
    public let sessionKey: String

    /// When the credential stops working — the session cap, typically minutes away.
    ///
    /// Not advisory when it is there: a face that reaches this instant with nobody
    /// watching for it drops mid-sentence, which is the failure mode `syl-chzl.7.2`
    /// calls "a stalled face".
    ///
    /// **Optional because the broker's own type makes it optional** — the provider does
    /// not always report a cap, and `FaceSessionCredentials` in
    /// `backend/src/face/face-session-broker.ts` omits the key rather than sending null.
    /// A client that required it would fail to decode a perfectly good session over a
    /// field the server was never promised to have. Nil means *no cap was published*,
    /// which ``isExpiring(at:lead:)`` reads as "nothing to get ahead of" — never as
    /// "already expired", which would renew in a loop.
    public let expiresAt: Date?

    /// The room to subscribe to, when the broker minted one for a native client.
    public let roomName: String?
    /// The realtime server to connect to, when the broker minted native credentials.
    public let serverURL: URL?
    /// The room-scoped join token. Short-lived, like everything else here.
    public let token: String?
    /// Which face answered. Informational — the device never chooses one.
    public let avatarId: String?

    public init(
        sessionId: String,
        sessionKey: String,
        expiresAt: Date?,
        roomName: String? = nil,
        serverURL: URL? = nil,
        token: String? = nil,
        avatarId: String? = nil
    ) {
        self.sessionId = sessionId
        self.sessionKey = sessionKey
        self.expiresAt = expiresAt
        self.roomName = roomName
        self.serverURL = serverURL
        self.token = token
        self.avatarId = avatarId
    }

    public var id: String { sessionId }

    /// Whether this device has everything it needs to render her.
    ///
    /// False means the broker opened a session it can only serve to a browser. The
    /// surface must say so rather than showing a spinner over a session that is already
    /// costing money.
    public var canJoin: Bool { serverURL != nil && token != nil }

    /// How long is left, against a clock the caller supplies. Nil when no cap was
    /// published.
    ///
    /// Takes the instant rather than reading `Date()`, because every deadline in this
    /// project is tested and a function that reads the clock cannot be.
    public func secondsRemaining(at now: Date) -> TimeInterval? {
        expiresAt.map { $0.timeIntervalSince(now) }
    }

    /// Whether the cap is close enough that a renewal should already be in flight.
    ///
    /// The lead is generous on purpose: opening a replacement takes seconds, and the
    /// alternative to being early is him watching her stop mid-sentence.
    ///
    /// **No published cap is false, not true.** Reading an absent expiry as "expired"
    /// would open a replacement session on the first tick and again on the next one —
    /// a renewal loop billing at twenty cents a minute per lap.
    public func isExpiring(at now: Date, lead: TimeInterval = FaceSession.renewLead) -> Bool {
        guard let remaining = secondsRemaining(at: now) else { return false }
        return remaining <= lead
    }

    /// Thirty seconds, the same lead Adjutant's broker uses.
    public static let renewLead: TimeInterval = 30
}

/// How a session ended. `nil` on a live row means it has not.
///
/// Closed, like every other enum in this contract except `PresenceState`. An unknown
/// end here has no safe rendering, and the four cases are genuinely different things to
/// say: **`reaped` is the one the client is supposed to make impossible** — it means the
/// server found a face nobody was watching, which is the leak the phone is meant to
/// close instantly.
public enum FaceSessionEnd: String, Codable, Equatable, Sendable, CaseIterable {
    /// Somebody closed it. The ordinary case, and the one this client aims for.
    case closed
    /// The idle reaper found it. A backstop that fired means the client did not.
    case reaped
    /// It ran past its cap.
    case expired
    /// It ended badly.
    case failed
}

/// One session as the ledger holds it — the row `GET` and `DELETE` both answer.
///
/// Deliberately mirrors `PublicFaceSession` in
/// `backend/src/face/face-session-store.ts`, which exists so that a route returning the
/// private row is a type error rather than a leak. Nothing credential-shaped is on it.
public struct FaceSessionRow: Codable, Equatable, Sendable, Identifiable {
    public let sessionId: String
    public let avatarId: String
    public let openedAt: Date
    /// Null while it is still live.
    public let closedAt: Date?
    /// Null while it is still live. See ``FaceSessionEnd``.
    public let ended: FaceSessionEnd?
    /// Everything charged for this session so far, upfront included.
    public let credits: Double
    public let dollars: Double
    /// What the reaper reads. Moved forward by every question put to her.
    public let lastActivityAt: Date

    public init(
        sessionId: String,
        avatarId: String,
        openedAt: Date,
        closedAt: Date?,
        ended: FaceSessionEnd?,
        credits: Double,
        dollars: Double,
        lastActivityAt: Date
    ) {
        self.sessionId = sessionId
        self.avatarId = avatarId
        self.openedAt = openedAt
        self.closedAt = closedAt
        self.ended = ended
        self.credits = credits
        self.dollars = dollars
        self.lastActivityAt = lastActivityAt
    }

    public var id: String { sessionId }

    /// Whether she is still here. Derived from the row rather than from a separate
    /// status field, because two fields that can disagree eventually will.
    public var isLive: Bool { ended == nil && closedAt == nil }
}

/// What *this* session has cost so far.
public struct FaceMeter: Codable, Equatable, Sendable {
    /// Wall-clock seconds elapsed, never negative.
    public let elapsedSeconds: Double
    /// Streaming blocks billed, rounded up.
    public let blocks: Int
    public let credits: Double
    public let dollars: Double

    public init(elapsedSeconds: Double, blocks: Int, credits: Double, dollars: Double) {
        self.elapsedSeconds = elapsedSeconds
        self.blocks = blocks
        self.credits = credits
        self.dollars = dollars
    }
}

/// What the *day* has cost, and what is left of it.
public struct FaceBudget: Codable, Equatable, Sendable {
    public let creditsSpentToday: Double
    public let creditCeiling: Double
    public let creditsRemaining: Double
    public let dollarsSpentToday: Double

    public init(
        creditsSpentToday: Double,
        creditCeiling: Double,
        creditsRemaining: Double,
        dollarsSpentToday: Double
    ) {
        self.creditsSpentToday = creditsSpentToday
        self.creditCeiling = creditCeiling
        self.creditsRemaining = creditsRemaining
        self.dollarsSpentToday = dollarsSpentToday
    }

    /// How much of the day is gone, or nil when there is no usable ceiling.
    ///
    /// Nil must render as *unknown*, never as *nothing spent*. A meter that reports
    /// zero because it could not divide is a confident false claim about money.
    public func fractionSpent() -> Double? {
        guard creditCeiling > 0 else { return nil }
        return min(creditsSpentToday / creditCeiling, 1)
    }
}

/// A session's state, its live meter and the day's spend — `GET /face/sessions/{id}`.
///
/// **The meter is on his phone because the cost is his.** A surface that spends about
/// twenty cents a minute and shows no number is asking him to trust an invisible tap.
/// The operator's view in the web admin (`syl-chzl.7.3`) shows the same figures, and
/// neither is the authority — the broker is.
public struct FaceSessionReport: Codable, Equatable, Sendable, Identifiable {
    public let session: FaceSessionRow
    public let meter: FaceMeter
    public let budget: FaceBudget

    public init(session: FaceSessionRow, meter: FaceMeter, budget: FaceBudget) {
        self.session = session
        self.meter = meter
        self.budget = budget
    }

    public var id: String { session.sessionId }
}

/// What the broker was asked for.
///
/// Everything is optional and the ordinary call sends `{}`: the phone has no controls to
/// turn, and choosing an avatar or writing a persona from the device would put a decision
/// about who she is on the wrong side of the boundary.
public struct OpenFaceSessionRequest: Codable, Equatable, Sendable {
    /// What she should say first, when the caller has a reason to name it. Nil from the
    /// home screen: the gesture means *be here*, not *say this*.
    public let startScript: String?

    public init(startScript: String? = nil) {
        self.startScript = startScript
    }
}

/// Why a face could not open, in terms a screen can render.
///
/// ## Why this is an interpretation and not a wire type
///
/// `ErrorCode` is closed on purpose, so the broker cannot invent `FACE_CEILING_REACHED`
/// without a contract change, and it should not have to: **the refusals a face can meet
/// are already spelled by codes this contract has.** What was missing is the reading —
/// `RATE_LIMITED` on `POST /face/sessions` means *today's money is spent*, and rendering
/// it as "rate limited" would be technically true and useless.
///
/// So this maps an ``APIError`` onto the four things that can actually be wrong, keeps
/// the server's own sentence when there is one, and always produces something that can be
/// shown. That last part is the requirement: a long press that cannot open a session must
/// say so on the spot, and there is no path here that yields silence.
public enum FaceRefusal: Equatable, Sendable {
    /// The day's budget is gone. Not an error — a ceiling doing its job.
    case ceilingReached(String)
    /// She is not warm enough to answer live yet (T006's precondition).
    case notReady(String)
    /// The avatar service is not answering.
    case unavailable(String)
    /// This device is not paired, or its token no longer carries the right.
    case notPermitted(String)
    /// The Mac at home could not be reached at all.
    case unreachable(String)
    /// Anything else. Still carries a sentence, because a shrug is the one outcome
    /// this whole type exists to prevent.
    case unexplained(String)

    /// Read a failure the way this surface needs to read it.
    public static func from(_ error: APIError) -> FaceRefusal {
        let said = detail(in: error) ?? error.errorDescription ?? "Something went wrong."

        switch error {
        case .transport:
            return .unreachable(said)
        case .cancelled:
            return .unexplained("Cancelled.")
        case .malformedResponse, .decoding:
            return .unexplained(said)
        case .api(let api, _):
            switch api.code {
            // The ceiling. `RATE_LIMITED` is the code the contract already has for
            // "you may not have another one right now", and on this route that is
            // what a spent daily budget is.
            case .rateLimited:
                return .ceilingReached(said)
            // T006's warm-lane precondition: the session is refused because *she* is
            // not ready, not because anything failed.
            case .conflict:
                return .notReady(said)
            case .unauthorized, .forbidden:
                return .notPermitted(said)
            case .upstreamUnavailable, .internalError:
                return .unavailable(said)
            default:
                return .unexplained(said)
            }
        }
    }

    /// What the screen shows him. Always non-empty.
    public var sentence: String {
        switch self {
        case .ceilingReached(let said),
             .notReady(let said),
             .unavailable(let said),
             .notPermitted(let said),
             .unreachable(let said),
             .unexplained(let said):
            return said
        }
    }

    /// Whether pressing again in a moment could plausibly work.
    ///
    /// The ceiling is false: offering a retry against a spent budget invites him to hold
    /// her face down repeatedly and be refused each time.
    public var isWorthAnotherPress: Bool {
        switch self {
        case .ceilingReached, .notPermitted: return false
        case .notReady, .unavailable, .unreachable, .unexplained: return true
        }
    }

    /// The broker's own sentence, when it put one in `details.reason`.
    ///
    /// Preferred over `message` because `message` is documented as "for a log line or an
    /// admin screen. Never parsed" — a `reason` is what the broker wrote *to be shown*.
    private static func detail(in error: APIError) -> String? {
        guard case .api(let api, _) = error,
              let details = api.details,
              case .string(let reason)? = details["reason"],
              !reason.isEmpty
        else { return nil }
        return reason
    }
}
