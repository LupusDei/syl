import SwiftUI
import SylKit

/// Her face, live — everything about it that can be wrong (`syl-chzl.7.2`, T022).
///
/// ## Why the model is where all of this lives
///
/// Because it is the only part a test can drive. `ImageRenderer` renders neither a
/// `ScrollView` nor a `NavigationStack`, a SwiftUI gesture cannot be fired without a
/// running render loop, and this project has already shipped a green test over a screen
/// that could not reply to anyone. So ``LiveFaceView`` is a thin reading of the values
/// below, and every rule worth asserting is asserted here.
///
/// ## The four rules
///
/// 1. **One press is one session.** The gesture can fire twice, the model can be asked
///    twice, and neither may open a second face. Two sessions bill in parallel and only
///    one of them is on screen.
/// 2. **Leaving closes it.** Backgrounding the app and dismissing the screen both mean
///    *he has left*, they can race, and neither may be the one that is skipped. The
///    server-side reaper is a backstop for crashes and dead tailnets — never the
///    mechanism, because everything it catches billed for the length of its interval.
/// 3. **Coming back does not reopen it.** Foregrounding restores a screen; it does not
///    restart a meter. A face he did not ask for, that costs money, is the worst
///    possible surprise on this surface.
/// 4. **A refusal is a sentence.** Every path that cannot produce a face produces
///    something to read instead. The gesture is a long press with no label, so silence
///    would leave him unable to tell a spent budget from a press he did not hold long
///    enough — and that reads as a broken app.
@MainActor
final class LiveFaceModel: ObservableObject {
    /// What is on screen, and what is being billed.
    enum Standing: Equatable {
        /// Nothing open, nothing asked, nothing costing anything.
        case dormant
        /// He pressed. Nothing is billing yet — the broker has not answered.
        case waking
        /// She is here. **The meter is running from this instant.**
        case here(FaceSession)
        /// She is not coming, and this is why, in words.
        case refused(FaceRefusal)
    }

    @Published private(set) var standing: Standing = .dormant
    /// What this is costing, when the broker has told us. Nil is *unknown*, and the
    /// surface must render it as unknown rather than as free.
    @Published private(set) var report: FaceSessionReport?

    private let gateway: FaceGateway
    private let clock: @Sendable () -> Date

    /// Whether he still wants her here **right now**.
    ///
    /// Separate from ``standing`` because the two genuinely disagree for the length of
    /// one round trip: pressing and immediately backgrounding leaves an open in flight
    /// with nobody to watch it, and the session that lands then has to be closed on
    /// arrival rather than shown. Without this the app would background a face that
    /// billed until the reaper found it.
    private var wanted = false

    /// The renewal in flight, if any. One at a time.
    private var renewing = false

    init(gateway: FaceGateway, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.gateway = gateway
        self.clock = clock
    }

    // MARK: - What the surface reads

    /// Whether her live surface is up.
    ///
    /// True for a refusal too, deliberately: the refusal *is* the thing that must be
    /// visible. A press that dropped straight back to dormant is exactly the silent
    /// nothing this feature is forbidden to do.
    var isPresented: Bool { standing != .dormant }

    /// The sentence on screen, when there is one to show. Never empty when non-nil.
    var visibleMessage: String? {
        guard case .refused(let refusal) = standing else { return nil }
        return refusal.sentence
    }

    /// Whether the screen should offer him another go.
    ///
    /// False against a spent ceiling: a retry button over a budget that is gone invites
    /// him to be refused twice, which is worse than being told once.
    var offersAnotherTry: Bool {
        guard case .refused(let refusal) = standing else { return false }
        return refusal.isWorthAnotherPress
    }

    // **"Can this device draw her" is not a question the model can answer, and it used
    // to try.** `canRender` lived here and read `FaceSession.canJoin`, which asks whether
    // the broker minted NATIVE join credentials. `syl-chzl.7.5` made the answer depend on
    // the RENDERER instead: a web view over the page Syl serves draws a session that has
    // no native credentials at all, and a native room client could not draw one that
    // does. Two answers to one question eventually disagree, so there is one, and it
    // lives on ``FaceRenderer/canDraw`` where the drawing does.
    //
    // What the model still owes this surface is unchanged and is above: a session that
    // cannot be drawn is a state with its own SENTENCE, never a spinner.

    // MARK: - The press

    /// The long press. Open a face, or say why not.
    ///
    /// Guarded **before the first suspension point**, which is the whole of rule 1: the
    /// second press arrives while the first is still awaiting the broker, and a check
    /// after the `await` would let both through.
    func awaken() async {
        switch standing {
        case .waking, .here:
            return  // already asked, or already here. One press is one session.
        case .dormant, .refused:
            break
        }

        wanted = true
        standing = .waking

        do {
            let session = try await gateway.open()

            // He may have left while the broker was thinking. The session exists and is
            // billing, so it is closed now rather than shown to an empty screen.
            guard wanted else {
                await release(session.sessionId)
                return
            }
            standing = .here(session)
        } catch let error as APIError {
            wanted = false
            standing = .refused(.from(error))
        } catch {
            wanted = false
            standing = .refused(.unexplained(error.localizedDescription))
        }
    }

    /// He dismissed the refusal. Back to a home screen with nothing on it.
    func acknowledgeRefusal() {
        guard case .refused = standing else { return }
        standing = .dormant
    }

    // MARK: - Leaving

    /// Stop wanting her, synchronously, and hand back whatever now needs closing.
    ///
    /// **Separate from ``withdraw()`` because the decision must not be able to
    /// interleave.** Leaving is a fact the instant it happens; the network call that
    /// settles it is not. If the flag went down after an `await`, an open already in
    /// flight would land believing he was still watching, and put a billing session on a
    /// screen he had left.
    @discardableResult
    func relinquish() -> String? {
        wanted = false

        let live: String?
        if case .here(let session) = standing { live = session.sessionId } else { live = nil }

        standing = .dormant
        report = nil
        return live
    }

    /// How a session that ended by itself is described to him.
    ///
    /// Four different sentences because they are four different facts, and one of them
    /// is an admission: **`reaped` means the server found a face nobody was watching**,
    /// which is precisely what this client exists to make impossible. Rendering it the
    /// same as an ordinary close would hide the bug it is evidence of.
    static func sentence(for ended: FaceSessionEnd) -> String {
        switch ended {
        case .closed: return "That session is closed."
        case .reaped: return "I was left running with nobody watching, so I closed myself."
        case .expired: return "That session reached its limit."
        case .failed: return "Something went wrong at my end and I had to stop."
        }
    }

    /// He has left: the screen went away, or he pressed Home.
    ///
    /// Safe to call from every one of those places and safe to call twice — which it
    /// will be, because `onDisappear` and a background transition both fire when the app
    /// is put away with the face up.
    func withdraw() async {
        guard let sessionId = relinquish() else { return }
        await release(sessionId)
    }

    /// Scene phase, straight through.
    ///
    /// `.background` closes. `.active` does **nothing** — rule 3. `.inactive` also does
    /// nothing, and that is a considered choice rather than an omission: the app becomes
    /// inactive for a pulled-down notification centre and for the app switcher, and
    /// killing a live conversation because he glanced at a banner would be its own defect.
    func scenePhaseChanged(to phase: ScenePhase) async {
        guard phase == .background else { return }
        await withdraw()
    }

    // MARK: - Staying up

    /// One beat of the clock while she is here: refresh the meter, and renew before the
    /// cap rather than after it.
    ///
    /// Takes the instant rather than reading the clock, because a deadline that reads
    /// `Date()` cannot be tested and every deadline in this project is.
    func tick(at now: Date) async {
        guard case .here(let session) = standing else { return }

        if let latest = try? await gateway.report(session.sessionId) {
            report = latest

            // The broker says it is over. Believe it, and say so — a face that has
            // stopped while the screen still shows a spinner is the stalled face this
            // whole surface exists to avoid.
            if let ended = latest.session.ended {
                wanted = false
                standing = .refused(.unexplained(LiveFaceModel.sentence(for: ended)))
                return
            }
        }

        guard session.isExpiring(at: now) else { return }
        await renew(replacing: session)
    }

    /// Pre-empt the cap: open the next session, put it on screen, then let the old one go.
    ///
    /// In that order. Closing first and opening second would drop him for as long as the
    /// broker takes to answer, which is the visible break the cap was going to cause
    /// anyway — the renewal would have bought nothing.
    private func renew(replacing expiring: FaceSession) async {
        guard !renewing else { return }
        renewing = true
        defer { renewing = false }

        do {
            let next = try await gateway.open()

            guard wanted else {
                await release(next.sessionId)
                await release(expiring.sessionId)
                return
            }
            standing = .here(next)
            await release(expiring.sessionId)
        } catch let error as APIError {
            // A renewal that cannot happen is still an answer he is owed. The old
            // session is let go rather than left to expire silently on the broker.
            await release(expiring.sessionId)
            wanted = false
            standing = .refused(.from(error))
        } catch {
            await release(expiring.sessionId)
            wanted = false
            standing = .refused(.unexplained(error.localizedDescription))
        }
    }

    // MARK: - Letting go

    /// Close a session, and never let the closing itself become an error on screen.
    ///
    /// A failed close is not something he can act on, and the reaper covers it. Putting
    /// it in front of him would mean the ordinary act of leaving a screen sometimes ends
    /// in an alert.
    private func release(_ sessionId: String) async {
        _ = try? await gateway.close(sessionId)
    }
}
