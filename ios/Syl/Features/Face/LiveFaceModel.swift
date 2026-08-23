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
/// 5. **She is not shown until she is live.** The Commander's ruling, 2026-08-23: a
///    covering screen that says *Waking her* for thirty seconds is worse than no screen
///    at all, because it takes the phone away from him and gives him nothing. So the
///    session opens, the page loads and the room is joined **behind the home screen**,
///    and the only thing that presents her is her video track actually playing — see
///    ``pageSaid(_:detail:)``. Not the session row existing, not the page having loaded,
///    and not a timer.
@MainActor
final class LiveFaceModel: ObservableObject {
    /// What is on screen, and what is being billed.
    enum Standing: Equatable {
        /// Nothing open, nothing asked, nothing costing anything.
        case dormant
        /// He pressed. Nothing is billing yet — the broker has not answered.
        case waking
        /// The session is open and **billing**, and she is not on screen.
        ///
        /// The page is loading, the SDK is importing, the room is being joined — all of
        /// it behind the home screen he is still holding. This is the state that used to
        /// be a full-screen spinner, and it is the whole point of `syl-chzl.7.2`'s
        /// revision: the money starts here, the covering screen does not.
        case warming(FaceSession)
        /// She is here **and playing**. The face is on screen from this instant.
        case here(FaceSession)
        /// She is not coming, and this is why, in words.
        case refused(FaceRefusal)
    }

    @Published private(set) var standing: Standing = .dormant
    /// What this is costing, when the broker has told us. Nil is *unknown*, and the
    /// surface must render it as unknown rather than as free.
    @Published private(set) var report: FaceSessionReport?
    /// The last thing the page said about itself, as a phrase for the home screen.
    ///
    /// Published separately from ``standing`` because it moves several times inside one
    /// `warming`: the wait is legible only if it visibly progresses, and a hint that
    /// never changes for thirty seconds is a hint he stops believing.
    @Published private(set) var phase: String?

    private let gateway: FaceGateway
    private let clock: @Sendable () -> Date

    /// When the current warm-up began, for ``LiveFace/readyDeadline``. Nil unless warming.
    private var warmingSince: Date?

    /// Whether she ever actually reached the screen during this session.
    ///
    /// It decides **where a refusal is read**: one that arrives before she was ever shown
    /// belongs on the home screen, quietly, because that is where he is standing; one
    /// that arrives while he is looking at her belongs in front of him, because that is
    /// where he is. Same sentence, two places, and getting it wrong means either a modal
    /// he never asked for or a face that vanishes without a word.
    private var wasOnScreen = false

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

    /// The session being drawn, warming or live. Nil when there is nothing to draw.
    ///
    /// **Non-nil through `warming` on purpose.** The renderer needs the session before
    /// she is presented, because the page has to be running for there to be a video
    /// track to wait for. That is the mechanism: the surface exists, hidden, and becomes
    /// visible without being rebuilt.
    var drawnSession: FaceSession? {
        switch standing {
        case .warming(let session), .here(let session): return session
        case .dormant, .waking, .refused: return nil
        }
    }

    /// Whether her face is **covering the screen**.
    ///
    /// True only once her video is playing — and for a refusal that arrived while it
    /// was. A warming session is deliberately false: he stays on his home screen while
    /// she comes through.
    var isPresented: Bool {
        switch standing {
        case .here: return true
        case .refused: return wasOnScreen
        case .dormant, .waking, .warming: return false
        }
    }

    /// Whether her surface must exist in the view tree at all.
    ///
    /// Wider than ``isPresented`` and that gap is the whole design: while warming, the
    /// surface is built and hidden rather than absent, so that presenting her is a change
    /// of opacity rather than a construction. Building it at presentation time would
    /// throw away the page that had just spent thirty seconds connecting and start a
    /// second one — over a session already billing for the first.
    var needsSurface: Bool { drawnSession != nil || isPresented }

    /// The sentence on screen, when there is one to show. Never empty when non-nil.
    var visibleMessage: String? {
        guard case .refused(let refusal) = standing else { return nil }
        return refusal.sentence
    }

    /// What the **home screen** owes him right now, if anything.
    ///
    /// Nil in the two states where the home screen has nothing to say: nothing is
    /// happening, or she is already in front of him.
    var homeNotice: FaceNotice? {
        switch standing {
        case .dormant, .here:
            return nil
        case .waking:
            return FaceNotice(kind: .waking, sentence: LiveFace.wakingPhrase)
        case .warming:
            return FaceNotice(kind: .waking, sentence: phase ?? LiveFace.wakingPhrase)
        case .refused(let refusal):
            // A refusal he is already looking at is drawn where he is looking. Putting it
            // on the home screen as well would say the same thing twice.
            guard !wasOnScreen else { return nil }
            return FaceNotice(
                kind: .failed,
                sentence: refusal.sentence,
                offersRetry: refusal.isWorthAnotherPress
            )
        }
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
        case .waking, .warming, .here:
            // Already asked, already warming, or already here. One press is one session,
            // and `warming` is the case this revision added: the home screen still looks
            // idle while she comes through, so a second press is *likelier* now, not
            // less likely, and it must reach the broker exactly never.
            return
        case .dormant, .refused:
            break
        }

        wanted = true
        phase = nil
        standing = .waking

        do {
            let session = try await gateway.open()

            // He may have left while the broker was thinking. The session exists and is
            // billing, so it is closed now rather than shown to an empty screen.
            guard wanted else {
                await release(session.sessionId)
                return
            }
            warmingSince = clock()
            standing = .warming(session)
        } catch let error as APIError {
            wanted = false
            standing = .refused(.from(error))
        } catch {
            wanted = false
            standing = .refused(.unexplained(error.localizedDescription))
        }
    }

    /// What the page says about itself, arriving over the web view's host channel.
    ///
    /// **This is the signal the whole surface hangs on.** `playing` means a media element
    /// has data and is moving, which is the only claim that means *she can be spoken to* —
    /// everything before it (`connected` included) is a room joined with nothing coming
    /// out of it, and this app has already shown him thirty seconds of exactly that.
    ///
    /// The vocabulary is closed and defined server-side in `face/client-report.ts`; a
    /// word this does not recognise leaves the wait exactly where it was, which is the
    /// safe direction — an unknown state must never present her and must never hang up
    /// on her.
    func pageSaid(_ state: String, detail: String = "") async {
        guard let session = drawnSession else { return }
        let wasHere = wasOnScreen

        if state == "playing" {
            // Only out of `warming`. The page posts to the host on every call, so this
            // can arrive twice, and the second one must not restart anything.
            guard case .warming = standing else { return }
            wasOnScreen = true
            warmingSince = nil
            phase = nil
            standing = .here(session)
            return
        }

        if let sentence = LiveFace.failure(forPageState: state, detail: detail, wasHere: wasHere) {
            // She will never play. The session is open and billing, so it is settled
            // here rather than left for the reaper — and he is told, which is the part
            // that is not negotiable.
            await giveUp(on: session, saying: sentence)
            return
        }

        if let phrase = LiveFace.phrase(forPageState: state) {
            phase = phrase
        }
    }

    /// He dismissed the refusal. Back to a home screen with nothing on it.
    func acknowledgeRefusal() {
        guard case .refused = standing else { return }
        wasOnScreen = false
        phase = nil
        standing = .dormant
    }

    /// The one button on the home-screen notice.
    ///
    /// Cancel a wait, or dismiss a failure — they are the same gesture to him and two
    /// different acts underneath, and only one of them has a session to settle. Deciding
    /// here rather than at the call site is what stops the home screen having to know
    /// which of those it is looking at.
    func dismissNotice() async {
        if case .refused = standing {
            acknowledgeRefusal()
            return
        }
        await withdraw()
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

        // **Warming counts.** A session that has not finished connecting is billing
        // exactly as hard as one he is watching, and it is the *likelier* one to be
        // walked away from — he is still on his home screen, with nothing covering it,
        // free to put the phone in his pocket. Reading only `here` here would have made
        // this change introduce the leak it was written to prevent.
        let live: String?
        switch standing {
        case .warming(let session), .here(let session): live = session.sessionId
        case .dormant, .waking, .refused: live = nil
        }

        standing = .dormant
        report = nil
        phase = nil
        warmingSince = nil
        wasOnScreen = false
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
        // **A refusal is not a thing to leave.** The surface that holds it is torn down
        // the moment she stops being drawn, and its `onDisappear` lands here — so without
        // this guard the act of failing would immediately erase the sentence explaining
        // the failure, leaving him with a long press that did nothing. There is nothing
        // open to close in this state, so there is nothing to lose by staying put.
        if case .refused = standing { return }

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
        let session: FaceSession
        let live: Bool
        switch standing {
        case .warming(let warming): session = warming; live = false
        case .here(let here): session = here; live = true
        case .dormant, .waking, .refused: return
        }

        // **The one case where a clock is allowed to decide anything here.** It does not
        // decide when to show her — only when to stop waiting. The failures he has
        // actually hit produce no state at all from inside the page, so without this a
        // dead session warms silently and bills until the reaper finds it, and he is
        // left unable to tell a slow success from nothing at all.
        if !live,
           let began = warmingSince,
           now.timeIntervalSince(began) >= LiveFace.readyDeadline {
            await giveUp(
                on: session,
                saying: "I opened a session and never came through. I have closed it."
            )
            return
        }

        if let latest = try? await gateway.report(session.sessionId) {
            report = latest

            // The broker says it is over. Believe it, and say so — a face that has
            // stopped while the screen still shows a spinner is the stalled face this
            // whole surface exists to avoid.
            if let ended = latest.session.ended {
                wanted = false
                warmingSince = nil
                standing = .refused(.unexplained(LiveFaceModel.sentence(for: ended)))
                return
            }
        }

        guard live, session.isExpiring(at: now) else { return }
        await renew(replacing: session)
    }

    /// Stop waiting, settle the session, and leave a sentence behind.
    ///
    /// ``FaceRefusal/unavailable(_:)`` rather than `unexplained`, because it is worth
    /// another press: everything that reaches here is a connection that did not come up,
    /// and the next one plausibly does.
    private func giveUp(on session: FaceSession, saying sentence: String) async {
        wanted = false
        warmingSince = nil
        phase = nil
        standing = .refused(.unavailable(sentence))
        await release(session.sessionId)
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
