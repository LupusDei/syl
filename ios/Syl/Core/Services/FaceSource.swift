import Foundation
import SylKit

/// How the app asks Syl for a live face, and how it lets one go.
///
/// ## Why a struct of closures rather than a protocol
///
/// The same reason ``SendingGateway`` is one: the fake a test needs is three closures,
/// not a conforming type with three stubs, and the live one is three lines. It also
/// keeps the whole thing `Sendable` without ceremony.
///
/// ## Why this seam exists at all right now
///
/// **The route is being built in parallel** (`syl-chzl.3.5`, T011). Everything above this
/// line — the gesture, the model, the surface, the closing — is testable and finished
/// against a fake, and the day the route lands the only edit is ``live(backend:)``. A
/// client written directly against a running server would have had to wait for one.
struct FaceGateway: Sendable {
    /// Open a session. **This is the call that starts spending**, roughly twenty cents
    /// a minute, so nothing may call it speculatively — not a prefetch, not a warm-up,
    /// not a retry the user did not ask for.
    var open: @Sendable () async throws -> FaceSession
    /// State and the live meter.
    var report: @Sendable (_ sessionId: String) async throws -> FaceSessionReport
    /// Close one and settle it. Idempotent on the server, and must stay callable twice
    /// here: the screen going away and the app backgrounding both mean "he has left",
    /// and they race.
    var close: @Sendable (_ sessionId: String) async throws -> FaceSessionReport

    /// A gateway that reaches nothing.
    ///
    /// The default for a preview, an offscreen render, or a screen built before the
    /// object graph exists — the role ``SendingGateway/offline`` plays. It refuses
    /// rather than hanging, so a long press in a preview says *I cannot reach you*
    /// instead of spinning forever, which is the same thing it must do on a dead
    /// tailnet.
    static var offline: FaceGateway {
        FaceGateway(
            open: { throw APIError.transport(code: .notConnectedToInternet, description: "offline") },
            report: { _ in throw APIError.transport(code: .notConnectedToInternet, description: "offline") },
            close: { _ in throw APIError.transport(code: .notConnectedToInternet, description: "offline") }
        )
    }

    static func live(backend: SylBackend) -> FaceGateway {
        FaceGateway(
            open: {
                // A fresh key per press, and it must be fresh: two presses are two
                // sessions he asked for, and reusing a key would silently hand the
                // second one the first one's answer.
                try await backend.client().send(
                    SylAPI.openFaceSession(idempotencyKey: IdempotencyKey.generate()))
            },
            report: { id in
                try await backend.client().send(SylAPI.faceSession(id))
            },
            close: { id in
                // **The key is derived from the session, not minted per attempt**, which
                // is the opposite of the rule above and is deliberate. Closing races with
                // itself by design; a per-attempt key would make the second close a
                // second settlement rather than a replay of the first.
                try await backend.client().send(
                    SylAPI.closeFaceSession(id, idempotencyKey: "face-close-\(id)"))
            }
        )
    }
}
