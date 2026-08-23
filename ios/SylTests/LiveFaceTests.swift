import SwiftUI
import SylKit
import UIKit
import WebKit
import XCTest

@testable import Syl

/// A fixed instant. A test that reads the clock is a test that fails at midnight.
private let anInstant = Date(timeIntervalSince1970: 1_787_000_000)

/// The fixtures are free functions rather than methods on the test case, and that is
/// forced rather than stylistic: the broker's closures are `@Sendable`, an `XCTestCase`
/// is not `Sendable`, so a method fixture cannot be called from inside one.
private func aSession(
    id: String = "face-1",
    expiresIn: TimeInterval = 300,
    native: Bool = true
) -> FaceSession {
    FaceSession(
        sessionId: id,
        sessionKey: "sk_short_lived",
        expiresAt: anInstant.addingTimeInterval(expiresIn),
        roomName: native ? "room-\(id)" : nil,
        serverURL: native ? URL(string: "wss://realtime.test") : nil,
        token: native ? "join.token" : nil,
        avatarId: "48cbc73d-f47f-41de-bed8-58a532b3b84b"
    )
}

private func aRow(id: String = "face-1", ended: FaceSessionEnd? = nil) -> FaceSessionRow {
    FaceSessionRow(
        sessionId: id,
        avatarId: "48cbc73d-f47f-41de-bed8-58a532b3b84b",
        openedAt: anInstant,
        closedAt: ended == nil ? nil : anInstant.addingTimeInterval(120),
        ended: ended,
        credits: 12,
        dollars: 0.4,
        lastActivityAt: anInstant
    )
}

private func aReport(
    id: String = "face-1",
    elapsed: Double = 60,
    ended: FaceSessionEnd? = nil
) -> FaceSessionReport {
    FaceSessionReport(
        session: aRow(id: id, ended: ended),
        meter: FaceMeter(elapsedSeconds: elapsed, blocks: 10, credits: 6, dollars: 0.2),
        budget: FaceBudget(
            creditsSpentToday: 18, creditCeiling: 100, creditsRemaining: 82,
            dollarsSpentToday: 0.6)
    )
}

/// Bringing her face to life, and everything that must not break doing it
/// (`syl-chzl.7`, T022).
///
/// ## The three things a reviewer should look for
///
/// 1. **The gesture is on her face.** Not on a button, not on a tab. Asserted against the
///    hero the home screen actually builds and against the recogniser that view carries.
/// 2. **The tap is untouched.** Asserted by pressing all four doors and checking where
///    each one goes — because a door whose handler went missing renders pixel-identical
///    to one that works, so no snapshot could ever catch it. This project has that scar
///    already.
/// 3. **Nothing bills silently.** One press is one session, leaving closes it, coming
///    back does not reopen it, and every path that cannot produce a face produces a
///    sentence instead.
@MainActor
final class LiveFaceTests: XCTestCase {
    // MARK: - Fixtures

    /// A fixed instant. A test that reads the clock is a test that fails at midnight.
    private let now = anInstant

    /// A broker that answers instantly and counts everything asked of it.
    ///
    /// A class rather than captured locals because the gateway's closures are
    /// `@Sendable` and the counts have to survive being read after the awaits.
    private final class Broker: @unchecked Sendable {
        private let lock = NSLock()
        private var opens = 0
        private var closes: [String] = []

        /// Deliberately `async`. Most tests answer instantly, but one has to hold the
        /// broker open while the Commander leaves — and the only way to write that
        /// deterministically is for the answer to be suspendable.
        var answer: @Sendable (Int) async throws -> FaceSession = { _ in
            throw APIError.cancelled
        }
        var report: @Sendable (String) async throws -> FaceSessionReport = { _ in
            throw APIError.cancelled
        }
        var closeAnswer: @Sendable (String) -> FaceSessionRow = { aRow(id: $0, ended: .closed) }

        var openCount: Int { lock.withLock { opens } }
        var closedIDs: [String] { lock.withLock { closes } }

        func gateway() -> FaceGateway {
            FaceGateway(
                open: { [self] in
                    let ordinal = lock.withLock { () -> Int in
                        opens += 1
                        return opens
                    }
                    return try await answer(ordinal)
                },
                report: { [self] id in try await report(id) },
                close: { [self] id in
                    lock.withLock { closes.append(id) }
                    return closeAnswer(id)
                }
            )
        }
    }

    private func broker(
        answering answer: @escaping @Sendable (Int) async throws -> FaceSession
    ) -> Broker {
        let broker = Broker()
        broker.answer = answer
        return broker
    }

    private func model(_ broker: Broker) -> LiveFaceModel {
        LiveFaceModel(gateway: broker.gateway(), clock: { [now] in now })
    }

    /// A model that has got all the way to a face he can actually talk to.
    ///
    /// Two steps, because they are now two facts: the broker opens a session, and then
    /// **the page reports that her video is playing**. Nothing in this app may treat the
    /// first as the second — that conflation is the thirty-second spinner this bead
    /// exists to delete — so every test that needs her live has to say so out loud.
    private func liveModel(_ broker: Broker) async -> LiveFaceModel {
        let face = model(broker)
        await face.awaken()
        await face.pageSaid("playing")
        return face
    }

    // MARK: - 1. The gesture is on her face

    /// **The home screen hands its hero a way to wake her.**
    ///
    /// The recogniser itself lives behind a `UIViewRepresentable`, inside a
    /// `GeometryReader`, inside a `ScrollView`, and none of that is reachable from a
    /// test. What is reachable — and what actually goes wrong — is whether the handler
    /// got as far as the view that draws her.
    func testShouldPutTheLongPressHandlerOnTheHomeScreensOwnHero() {
        var woke = false
        let view = HomeView(
            snapshot: .preview(remaining: 2),
            presence: .idle,
            presenceIntensity: 0.4,
            now: now,
            onAwaken: { woke = true }
        )

        let hero = view.figure

        XCTAssertNotNil(hero.onAwaken, "the hero is the video cell; the gesture goes on it")
        hero.onAwaken?()
        XCTAssertTrue(woke, "the hero's handler must reach the home screen's handler")
    }

    /// And carries none when there is nothing to open — a preview, an offscreen render,
    /// a device with no object graph. An affordance that does nothing reads as broken;
    /// `SylOrb.isReady` exists because this app already shipped one.
    func testShouldCarryNoGestureWhenThereIsNoLiveFaceToOpen() {
        let view = HomeView(
            snapshot: .preview(remaining: 2), presence: .idle, presenceIntensity: 0.4, now: now)

        XCTAssertNil(view.figure.onAwaken)
    }

    /// The touch layer over her face recognises a long press, at a duration chosen to be
    /// deliberate rather than accidental.
    func testShouldRecogniseALongPressOnHerFaceAndNothingElse() {
        let layer = LivingFaceTouchView(onPress: {}, onFeedback: {})

        let recognisers = layer.gestureRecognizers ?? []
        XCTAssertEqual(recognisers.count, 1, "one gesture, not a collection of them")
        let press = recognisers.first as? UILongPressGestureRecognizer
        XCTAssertNotNil(press, "the one gesture on her face is a long press")
        XCTAssertEqual(press?.minimumPressDuration, LiveFace.minimumPressDuration)
        XCTAssertGreaterThan(
            LiveFace.minimumPressDuration, 0.5,
            "the system default is what a free menu costs; this one spends money")
    }

    /// He is told the instant it takes. Without it the only feedback is a round trip, and
    /// a gesture with no acknowledgement is one he holds twice.
    func testShouldAcknowledgeThePressTheMomentItLands() {
        var felt = 0
        var opened = 0
        let layer = LivingFaceTouchView(onPress: { opened += 1 }, onFeedback: { felt += 1 })

        layer.respond(to: .began)

        XCTAssertEqual(felt, 1)
        XCTAssertEqual(opened, 1)
    }

    // MARK: - 2. The tap still does what it did

    /// **A plain tap must keep doing whatever it does today**, and the gesture layer is
    /// configured so it cannot interfere: it cancels no touches, delays none, and adds no
    /// tap recogniser of its own. Every touch still reaches whatever was going to get it.
    func testShouldLeaveEveryTapUnderneathHerExactlyAsItWas() {
        let layer = LivingFaceTouchView(onPress: {}, onFeedback: {})
        let press = layer.press

        XCTAssertFalse(
            press.cancelsTouchesInView,
            "cancelling touches is how this gesture would eat a tap it never wanted")
        XCTAssertFalse(press.delaysTouchesBegan)
        XCTAssertFalse(press.delaysTouchesEnded)
        XCTAssertFalse(
            (layer.gestureRecognizers ?? []).contains { $0 is UITapGestureRecognizer },
            "nothing here may add a tap")
    }

    /// A quick tap is not merely unhandled — it is unreachable. Only `.began` opens a
    /// session, so a press that never lasted long enough, and the `.ended` that follows
    /// one that did, both do nothing.
    func testShouldOpenNothingOnAnyGestureStateExceptTheOneThatMeansHeld() {
        var opened = 0
        let layer = LivingFaceTouchView(onPress: { opened += 1 }, onFeedback: {})

        for state in [UIGestureRecognizer.State.possible, .changed, .ended, .cancelled, .failed] {
            layer.respond(to: state)
        }
        XCTAssertEqual(opened, 0, "a tap, a drag and a lift are not a long press")

        layer.respond(to: .began)
        XCTAssertEqual(opened, 1, "and holding it is, exactly once")
    }

    /// **The doors still open.** The four orbs under her are the taps this screen has
    /// today; adding a gesture above them must not move one. Pressed here rather than
    /// looked at, because a handler that went missing is invisible in a snapshot.
    func testShouldStillOpenEveryDoorOnAPlainTap() {
        var opened: [HomeView.Destination] = []
        let view = HomeView(
            snapshot: .preview(remaining: 3),
            presence: .idle,
            presenceIntensity: 0.4,
            now: now,
            onOpen: { opened.append($0) },
            onAwaken: {}
        )

        let doors = view.doors()

        XCTAssertEqual(doors.map(\.title), ["Goals", "Memory", "From Syl", "Today"])
        for door in doors { door.action() }

        // Today is the one that does not push: it scrolls to the day already on this
        // screen, which is why it is absent from the destinations rather than a fourth
        // entry. Asserting the exact list is what would catch it being rewired.
        XCTAssertEqual(opened, [.goals, .memory, .fromSyl])
    }

    /// The count on the Today door is still the count. It is the one number this screen
    /// is allowed and it comes from the snapshot, not from anything the gesture touched.
    func testShouldStillCountWhatIsLeftOnTheTodayDoor() {
        let busy = HomeView(
            snapshot: .preview(remaining: 3), presence: .idle, presenceIntensity: 0, now: now)
        let clear = HomeView(
            snapshot: HomeSnapshot(
                moments: [], remaining: 0, note: nil, prominence: 1, greeting: "Good evening"),
            presence: .idle, presenceIntensity: 0, now: now)

        XCTAssertNotNil(busy.doors().last?.detail)
        XCTAssertNil(clear.doors().last?.detail, "a clear day carries no badge")
    }

    // MARK: - 3a. One press is one session

    func testShouldOpenExactlyOneSessionForOnePress() async {
        let broker = broker { _ in aSession() }
        let face = model(broker)

        await face.awaken()

        XCTAssertEqual(broker.openCount, 1)
        XCTAssertEqual(
            face.standing, .warming(aSession()),
            "the session is open and billing; she is not on screen and must not be")
    }

    /// **Two presses are still one session.** The gesture can fire again while the first
    /// open is in flight, and a second session bills in parallel behind one nobody can
    /// see. The guard is before the first suspension point for exactly this reason.
    func testShouldRefuseToOpenASecondSessionWhileOneIsAlreadyOpen() async {
        let broker = broker { _ in aSession() }
        let face = model(broker)

        await face.awaken()
        await face.awaken()
        await face.awaken()

        XCTAssertEqual(broker.openCount, 1, "one face, whatever his thumb did")
    }

    /// **And a press that arrives while she is WARMING is the one that now matters most.**
    ///
    /// Nothing covers the home screen during the wait, so pressing again is the natural
    /// thing to do — there is no modal telling him something is already happening. The
    /// broker cuts a previous live session before creating the next one, so a second ask
    /// would not merely double-bill; it would *destroy the session that was thirty
    /// seconds from arriving* and start the wait over. The phone must not ask.
    func testShouldNotStartASecondSessionWhileTheFirstIsStillWarming() async {
        let broker = broker { ordinal in aSession(id: "face-\(ordinal)") }
        let face = model(broker)
        await face.awaken()
        XCTAssertEqual(face.standing, .warming(aSession(id: "face-1")))

        await face.awaken()
        await face.awaken()

        XCTAssertEqual(broker.openCount, 1, "the wait is invisible; the guard is not")
        XCTAssertEqual(face.standing, .warming(aSession(id: "face-1")))
        XCTAssertTrue(broker.closedIDs.isEmpty, "and nothing was cut short to find that out")
    }

    // MARK: - 3b. Leaving closes it

    func testShouldCloseTheSessionWhenHeLeavesTheScreen() async {
        let broker = broker { _ in aSession(id: "face-9") }
        let face = await liveModel(broker)

        await face.withdraw()

        XCTAssertEqual(broker.closedIDs, ["face-9"])
        XCTAssertEqual(face.standing, .dormant)
        XCTAssertNil(face.report, "the meter is not a souvenir")
    }

    /// **The leak this project is named for.** A face in a backgrounded app goes on
    /// billing until a server-side reaper notices, and everything the reaper catches was
    /// charged for the length of its interval.
    func testShouldCloseTheSessionWhenTheAppIsPutAway() async {
        let broker = broker { _ in aSession(id: "face-bg") }
        let face = await liveModel(broker)

        await face.scenePhaseChanged(to: .background)

        XCTAssertEqual(broker.closedIDs, ["face-bg"])
        XCTAssertEqual(face.standing, .dormant)
    }

    /// **The new shape of the same leak.** He presses, nothing covers his home screen,
    /// and he puts the phone in his pocket while she is still coming through. That
    /// session is open and billing at twenty cents a minute and he cannot see it, which
    /// makes it the *likeliest* one to be abandoned and the one nothing on screen would
    /// ever remind him about.
    func testShouldCloseASessionThatIsStillWarmingWhenTheAppIsPutAway() async {
        let broker = broker { _ in aSession(id: "face-warm-bg") }
        let face = model(broker)
        await face.awaken()
        XCTAssertFalse(face.isPresented, "she never reached the screen")

        await face.scenePhaseChanged(to: .background)

        XCTAssertEqual(
            broker.closedIDs, ["face-warm-bg"],
            "a session nobody has seen yet bills exactly as hard as one he is watching")
        XCTAssertEqual(face.standing, .dormant)
        XCTAssertNil(face.homeNotice, "and the home screen goes back to saying nothing")
    }

    /// Glancing at a notification banner is not leaving. Tearing down a live conversation
    /// because the app went inactive for a second would be its own defect.
    func testShouldNotCloseMerelyBecauseTheAppWentInactive() async {
        let broker = broker { _ in aSession() }
        let face = await liveModel(broker)

        await face.scenePhaseChanged(to: .inactive)

        XCTAssertTrue(broker.closedIDs.isEmpty)
        XCTAssertEqual(face.standing, .here(aSession()))
    }

    /// Two things both mean "he has left" and they race. Neither may be the one that is
    /// skipped, and the second must not error.
    func testShouldSurviveLeavingTwice() async {
        let broker = broker { _ in aSession(id: "face-2x") }
        let face = await liveModel(broker)

        await face.withdraw()
        await face.withdraw()

        XCTAssertEqual(broker.closedIDs, ["face-2x"], "the second leave has nothing to close")
        XCTAssertEqual(face.standing, .dormant)
    }

    /// **The race the flag exists for.** He presses and immediately puts the phone away;
    /// the broker answers into an empty screen. That session exists and is billing, so it
    /// is closed on arrival rather than shown to nobody.
    func testShouldCloseASessionThatArrivesAfterHeHasAlreadyGone() async {
        let reached = AsyncStream<Void>.makeStream()
        let mayAnswer = AsyncStream<Void>.makeStream()

        let broker = Broker()
        broker.answer = { _ in
            reached.continuation.yield()
            var waiting = mayAnswer.stream.makeAsyncIterator()
            _ = await waiting.next()
            return aSession(id: "face-late")
        }
        let face = model(broker)

        // The press, and then the leaving, in that order and genuinely interleaved:
        // the broker is held open until the test has already walked away.
        let pressing = Task { await face.awaken() }
        var arrival = reached.stream.makeAsyncIterator()
        _ = await arrival.next()
        face.relinquish()
        mayAnswer.continuation.yield()
        await pressing.value

        XCTAssertEqual(
            broker.closedIDs, ["face-late"],
            "a session that lands after he has gone is still billing, so it is closed")
        XCTAssertEqual(face.standing, .dormant, "nothing is shown to a screen he has left")
    }

    // MARK: - 3c. Coming back does not reopen it

    /// Foregrounding restores a screen; it does not restart a meter. A face he did not
    /// ask for, that costs money, is the worst possible surprise on this surface.
    func testShouldNotReopenAnythingWhenHeComesBack() async {
        let broker = broker { _ in aSession() }
        let face = await liveModel(broker)
        await face.scenePhaseChanged(to: .background)

        await face.scenePhaseChanged(to: .active)

        XCTAssertEqual(broker.openCount, 1, "coming back is not asking")
        XCTAssertEqual(face.standing, .dormant)
    }

    // MARK: - 3d. A refusal is a sentence

    /// **The requirement with no exceptions.** A long press that cannot open a session
    /// says so on the spot — a gesture that silently does nothing reads as a broken app,
    /// and he cannot tell it from not having held it long enough.
    func testShouldSayWhyWhenTheSessionCannotOpen() async {
        let broker = Broker()
        broker.answer = { _ in
            throw APIError.transport(code: .cannotConnectToHost, description: "no route")
        }
        let face = model(broker)

        await face.awaken()

        XCTAssertFalse(
            (face.visibleMessage ?? "").isEmpty,
            "there is always something to read; silence is the one forbidden outcome")
        XCTAssertTrue(face.offersAnotherTry, "an unreachable Mac is worth another press")

        // **And it is said where he is standing.** She never reached the screen, so
        // covering it to apologise would be a modal he did not ask for on top of a
        // gesture that already failed.
        XCTAssertFalse(face.isPresented, "nothing covers the home screen for this")
        XCTAssertEqual(face.homeNotice?.kind, .failed)
        XCTAssertEqual(face.homeNotice?.sentence, face.visibleMessage)
        XCTAssertEqual(face.homeNotice?.offersRetry, true)
    }

    /// The ceiling is a refusal with its own words and its own answer to "press again".
    func testShouldSurfaceTheCeilingInTheBrokersOwnWordsAndOfferNoRetry() async {
        let broker = Broker()
        broker.answer = { _ in
            throw APIError.api(
                ApiError(
                    code: .rateLimited,
                    message: "rate limited",
                    retryable: false,
                    details: .object(["reason": .string("That is today's face budget spent.")])
                ),
                status: 429
            )
        }
        let face = model(broker)

        await face.awaken()

        XCTAssertEqual(face.visibleMessage, "That is today's face budget spent.")
        XCTAssertFalse(
            face.offersAnotherTry,
            "a retry against a spent budget invites him to be refused twice")
    }

    /// A refused press leaves nothing running and can be pressed again — the state is
    /// dismissable rather than sticky.
    func testShouldReturnToNothingWhenHeDismissesARefusal() async {
        let broker = Broker()
        broker.answer = { _ in throw APIError.transport(code: .timedOut, description: "slow") }
        let face = model(broker)
        await face.awaken()

        face.acknowledgeRefusal()

        XCTAssertEqual(face.standing, .dormant)
        XCTAssertFalse(face.isPresented)
        XCTAssertTrue(broker.closedIDs.isEmpty, "there was never a session to close")
    }

    // MARK: - 3e. Staying up

    /// **Pre-empt the cap rather than being dropped by it**, and in that order: the
    /// replacement is on screen before the old one is let go, because closing first would
    /// cost him exactly the break the renewal exists to prevent.
    func testShouldRenewBeforeTheCapDropsHim() async {
        let broker = broker { ordinal in
            ordinal == 1 ? aSession(id: "first", expiresIn: 10) : aSession(id: "second")
        }
        broker.report = { id in aReport(id: id) }
        let face = await liveModel(broker)

        await face.tick(at: now)

        XCTAssertEqual(broker.openCount, 2)
        XCTAssertEqual(face.standing, .here(aSession(id: "second")))
        XCTAssertEqual(broker.closedIDs, ["first"], "the expiring one is let go, after")
    }

    /// A session with room to spare is left alone. Renewing early is money.
    func testShouldNotRenewASessionThatHasTimeLeft() async {
        let broker = broker { _ in aSession(expiresIn: 300) }
        broker.report = { id in aReport(id: id) }
        let face = await liveModel(broker)

        await face.tick(at: now)

        XCTAssertEqual(broker.openCount, 1)
    }

    /// The meter reaches the screen, because the money is his.
    func testShouldPublishTheMeterWhileSheIsHere() async {
        let broker = broker { _ in aSession() }
        broker.report = { id in aReport(id: id, elapsed: 94) }
        let face = await liveModel(broker)

        await face.tick(at: now)

        XCTAssertEqual(face.report?.meter.elapsedSeconds, 94)
        XCTAssertEqual(face.report?.budget.dollarsSpentToday, 0.6)
    }

    /// **A face that has stopped must not look like a face that is loading.** When the
    /// broker says the session ended, the screen says so in the broker's words.
    func testShouldSayThatSheHasGoneRatherThanShowingAStalledFace() async {
        let broker = broker { _ in aSession() }
        broker.report = { id in aReport(id: id, ended: .reaped) }
        let face = await liveModel(broker)

        await face.tick(at: now)

        XCTAssertEqual(
            face.visibleMessage, LiveFaceModel.sentence(for: .reaped),
            "a reaped session is an admission, not an ordinary close")
        XCTAssertNotEqual(
            LiveFaceModel.sentence(for: .reaped), LiveFaceModel.sentence(for: .closed),
            "the four ends are four different facts and must not read alike")

        // **Said where he is looking.** She was on screen when it ended, so the sentence
        // stays on screen — dropping him back to the home screen with a pill would make
        // her vanish mid-conversation and explain it somewhere he is no longer looking.
        XCTAssertTrue(face.isPresented, "the end of a face he was watching is shown to him")
        XCTAssertNil(face.homeNotice, "and is not also said a second time behind it")
    }

    // MARK: - 4. She is not shown until she is live (`syl-chzl.7.2`, 2026-08-23)

    /// **The whole bead, as one assertion.** He held her face down; the broker answered;
    /// nothing may appear.
    ///
    /// The old surface presented here and spent the next five to thirty seconds saying
    /// *Waking her* over a screen he could no longer use. The session existing is not
    /// her being here — it is a room being booked.
    func testShouldNotShowHerJustBecauseASessionExists() async {
        let broker = broker { _ in aSession() }
        let face = model(broker)

        await face.awaken()

        XCTAssertFalse(face.isPresented, "a session row is not a face")
        XCTAssertNotNil(
            face.drawnSession,
            "and yet the surface must exist, hidden — the page has to be running for "
                + "there to be a video track to wait for")
        XCTAssertTrue(face.needsSurface)
    }

    /// **The signal, and the only signal.** A media element with data, moving. Everything
    /// short of it is a room joined with nothing coming out of it, which is precisely
    /// what he has been staring at.
    func testShouldShowHerTheMomentHerVideoActuallyPlays() async {
        let broker = broker { _ in aSession() }
        let face = model(broker)
        await face.awaken()

        await face.pageSaid("playing", detail: "1 element(s)")

        XCTAssertTrue(face.isPresented)
        XCTAssertEqual(face.standing, .here(aSession()))
        XCTAssertNil(face.homeNotice, "she is in front of him; the home screen is silent")
    }

    /// And on nothing else. Every one of these is the page making progress, and this app
    /// has already shown him thirty seconds of `connected` with a blank rectangle in it.
    func testShouldShowHerOnNothingShortOfPlaying() async {
        let broker = broker { _ in aSession() }
        let face = model(broker)
        await face.awaken()

        for state in [
            "booting", "sdk_loaded", "mic_requested", "camera_blocked", "mic_granted",
            "connecting", "connected",
        ] {
            await face.pageSaid(state)
            XCTAssertFalse(face.isPresented, "\(state) is not a face he can speak to")
            XCTAssertEqual(face.standing, .warming(aSession()), "and it is still warming")
        }

        await face.pageSaid("playing")
        XCTAssertTrue(face.isPresented, "and then, exactly once, it is")
    }

    /// A word the page has never been able to say leaves the wait exactly where it was.
    /// The safe direction is both ways at once: an unknown state must not present her,
    /// and must not hang up on her either.
    func testShouldIgnoreAWordThePageCannotSay() async {
        let broker = broker { _ in aSession() }
        let face = model(broker)
        await face.awaken()

        await face.pageSaid("hello", detail: "not in the vocabulary")

        XCTAssertEqual(face.standing, .warming(aSession()))
        XCTAssertTrue(broker.closedIDs.isEmpty)
    }

    /// **A long press must never change nothing.** The haptic answers *did I hold it long
    /// enough*; it does not answer *is anything happening*, and it is silent on a phone
    /// with haptics off or on a table. So the home screen says so, quietly, over her own
    /// figure — and keeps saying something different as the page gets further along,
    /// because a hint that never moves for thirty seconds is a hint he stops believing.
    func testShouldTellHimSomethingIsHappeningWithoutTakingHisScreen() async {
        let broker = broker { _ in aSession() }
        let face = model(broker)

        await face.awaken()

        XCTAssertEqual(face.homeNotice?.kind, .waking)
        XCTAssertEqual(face.homeNotice?.sentence, LiveFace.wakingPhrase)
        XCTAssertEqual(face.homeNotice?.offersRetry, false, "there is nothing to retry yet")
        XCTAssertFalse(face.isPresented, "and it costs him no part of his screen")

        await face.pageSaid("connected")
        XCTAssertEqual(
            face.homeNotice?.sentence, LiveFace.phrase(forPageState: "connected"),
            "the wait is legible only if it visibly moves")
        XCTAssertFalse(face.isPresented)
    }

    // MARK: - 5. Cancelling, and settling what it cost

    /// **Thirty seconds is long enough to change your mind**, and the meter has been
    /// running the whole time. Cancelling must reach the broker, not merely stop looking.
    func testShouldSettleTheSessionWhenHeCancelsTheWait() async {
        let broker = broker { _ in aSession(id: "face-cancel") }
        let face = model(broker)
        await face.awaken()
        XCTAssertEqual(face.homeNotice?.kind, .waking)

        await face.dismissNotice()

        XCTAssertEqual(
            broker.closedIDs, ["face-cancel"],
            "cancelling a wait closes the session it was waiting on")
        XCTAssertEqual(face.standing, .dormant)
        XCTAssertNil(face.homeNotice)
    }

    /// The same button on a failure has nothing to settle — it dismisses the sentence and
    /// must not invent a close for a session that never opened or is already gone.
    func testShouldDismissAFailureWithoutClosingAnythingTwice() async {
        let broker = Broker()
        broker.answer = { _ in throw APIError.transport(code: .timedOut, description: "slow") }
        let face = model(broker)
        await face.awaken()
        XCTAssertEqual(face.homeNotice?.kind, .failed)

        await face.dismissNotice()

        XCTAssertEqual(face.standing, .dormant)
        XCTAssertNil(face.homeNotice)
        XCTAssertTrue(broker.closedIDs.isEmpty, "there was never a session to close")
    }

    /// He can press again after cancelling. A cancelled wait is not a state he is stuck in.
    func testShouldLetHimPressAgainAfterCancelling() async {
        let broker = broker { ordinal in aSession(id: "face-\(ordinal)") }
        let face = model(broker)
        await face.awaken()
        await face.dismissNotice()

        await face.awaken()

        XCTAssertEqual(broker.openCount, 2)
        XCTAssertEqual(face.standing, .warming(aSession(id: "face-2")))
    }

    // MARK: - 6. A failure is visible, in words, where he is

    /// **The case that matters most.** She never becomes ready — and right now that
    /// happens, repeatedly, with *could not establish signal connection*. Silence after a
    /// long press is the worst outcome available: he cannot tell a slow success from a
    /// dead failure, so he presses again, and pays again.
    func testShouldSayOnTheHomeScreenWhenThePageCannotDrawHer() async {
        let broker = broker { _ in aSession(id: "face-dead") }
        let face = model(broker)
        await face.awaken()

        await face.pageSaid("failed", detail: "could not establish signal connection")

        XCTAssertEqual(face.homeNotice?.kind, .failed)
        XCTAssertTrue(
            face.homeNotice?.sentence.contains("could not establish signal connection") == true,
            "the page's own words are the difference between 'it broke' and something he "
                + "can act on")
        XCTAssertEqual(face.homeNotice?.offersRetry, true)
        XCTAssertFalse(face.isPresented, "she never arrived; nothing covers his screen")
        XCTAssertEqual(
            broker.closedIDs, ["face-dead"],
            "and the session that will never draw her is settled, not left to the reaper")
    }

    /// Every fatal word the page can say produces a sentence and settles the session.
    /// None of them may leave the wait running, and none may leave him with nothing.
    func testShouldSaySomethingForEveryWayThePageCanFail() async {
        for state in ["sdk_failed", "failed", "no_media", "autoplay_blocked", "no_session", "ended"] {
            let broker = broker { _ in aSession(id: "face-\(state)") }
            let face = model(broker)
            await face.awaken()

            await face.pageSaid(state, detail: "why")

            XCTAssertEqual(face.homeNotice?.kind, .failed, "\(state) must be said out loud")
            XCTAssertFalse((face.homeNotice?.sentence ?? "").isEmpty, "\(state)")
            XCTAssertEqual(
                broker.closedIDs, ["face-\(state)"],
                "\(state) leaves a billing session behind unless it is settled")
        }
    }

    /// **Nothing at all is the failure with no signal to hang off.** The connection
    /// failures he has actually hit report no state from inside the page whatsoever, so
    /// the only thing that can end that wait is a deadline — and it ends it by *saying
    /// so*, which is the opposite of presenting on a timer.
    func testShouldGiveUpAndSaySoWhenNothingEverPlays() async {
        let broker = broker { _ in aSession(id: "face-silent") }
        broker.report = { id in aReport(id: id) }
        let face = model(broker)
        await face.awaken()

        // One beat just short of the deadline changes nothing.
        await face.tick(at: now.addingTimeInterval(LiveFace.readyDeadline - 1))
        XCTAssertEqual(face.standing, .warming(aSession(id: "face-silent")), "still waiting")
        XCTAssertTrue(broker.closedIDs.isEmpty)

        await face.tick(at: now.addingTimeInterval(LiveFace.readyDeadline))

        XCTAssertEqual(face.homeNotice?.kind, .failed)
        XCTAssertFalse((face.homeNotice?.sentence ?? "").isEmpty)
        XCTAssertEqual(face.homeNotice?.offersRetry, true, "the next press plausibly works")
        XCTAssertEqual(broker.closedIDs, ["face-silent"], "and it stops costing money")
        XCTAssertFalse(face.isPresented)
    }

    /// The deadline is generous against the slowest good case, because the cost of being
    /// early is hanging up on a face that was about to arrive.
    func testShouldWaitLongerThanTheSlowestGoodCaseBeforeGivingUp() {
        XCTAssertGreaterThan(
            LiveFace.readyDeadline, 30,
            "the observed wait runs to thirty seconds; giving up inside it kills good sessions")
    }

    // MARK: - 7. The signal reaches the model at all

    /// **The handler that was not there.** `FaceRenderer.web` was built with no `onState`
    /// at all, so every word the page said — the whole closed vocabulary in
    /// `face/client-report.ts` — arrived at an empty closure and nothing on the phone
    /// ever heard it. A snapshot cannot catch that: a surface wired to nothing renders
    /// pixel-identical to one wired to everything.
    ///
    /// So this evaluates the real surface, takes the sink it hands its renderer, and
    /// drives the model through it.
    func testShouldWireThePagesOwnReportsAllTheWayToTheModel() async {
        let broker = broker { _ in aSession() }
        let face = model(broker)
        await face.awaken()

        // A renderer that draws nothing and keeps whatever sink it is given.
        final class Box: @unchecked Sendable { var sink: (@MainActor (String, String) -> Void)? }
        let box = Box()
        let renderer = FaceRenderer(
            canDraw: { _ in true },
            view: { _, onState in
                box.sink = onState
                return AnyView(Color.clear)
            }
        )

        _ = LiveFaceView(model: face, renderer: renderer, clock: { [now] in now }).body
        let sink = try? XCTUnwrap(box.sink)
        XCTAssertNotNil(sink, "the surface must hand the renderer somewhere to report to")

        sink?("playing", "1 element(s)")
        // The relay hops through a Task; give it the one turn it needs.
        await Task.yield()
        for _ in 0..<20 where !face.isPresented { await Task.yield() }

        XCTAssertTrue(
            face.isPresented,
            "the page said it was playing and the phone must have heard it")
    }

    /// And the page hands what it hears to whoever is drawing it. The two halves of the
    /// same wire, asserted separately because they break separately.
    func testShouldCarryThePagesStateOutOfTheWebViewToItsCaller() throws {
        var heard: [String] = []
        let page = FaceWebPage(
            session: aSession(),
            pageURL: try XCTUnwrap(URL(string: "https://syl.example/face/live")),
            onState: { state, _ in heard.append(state) }
        )

        page.makeCoordinator().receive(state: "playing", detail: "1 element(s)")

        XCTAssertEqual(heard, ["playing"])
    }

    // MARK: - 8. The notice on the home screen is a thing he can press

    /// The pill carries the only way to cancel a billing session and the only way to
    /// retry a failed one. Pressed here rather than looked at — this project has the scar.
    func testShouldPutWorkingButtonsOnTheAwakeningNotice() throws {
        var cancelled = 0
        var pressedAgain = 0
        let view = HomeView(
            snapshot: .preview(remaining: 2),
            presence: .idle,
            presenceIntensity: 0.4,
            now: now,
            onAwaken: { pressedAgain += 1 },
            awakening: FaceNotice(kind: .failed, sentence: "I could not reach you.", offersRetry: true),
            onCancelAwakening: { cancelled += 1 }
        )

        let notice = try XCTUnwrap(view.awakeningNotice())
        notice.onCancel()
        notice.onRetry?()

        XCTAssertEqual(cancelled, 1, "dismissing must reach the model that settles the session")
        XCTAssertEqual(pressedAgain, 1, "and retry is the same one way in as the long press")
    }

    /// And there is nothing on the home screen at all in the ordinary case. She is not
    /// coming, nothing is billing, and this screen is exactly the screen it always was.
    func testShouldPutNothingOnTheHomeScreenWhenNothingIsHappening() {
        let view = HomeView(
            snapshot: .preview(remaining: 2), presence: .idle, presenceIntensity: 0.4, now: now,
            onAwaken: {})

        XCTAssertNil(view.awakeningNotice())
    }

    // MARK: - The surface's own honesty

    /// A build with no way to draw her says so, and that is what the surface shows.
    ///
    /// This used to ask ``LiveFaceModel`` — a `canRender` reading `FaceSession.canJoin`,
    /// which asks whether the broker minted NATIVE join credentials. `syl-chzl.7.5` moved
    /// the answer to the renderer, because it is a property of the renderer: the web view
    /// draws a session with no native credentials at all, and a native room client could
    /// not draw one that has none. The requirement is unchanged and is what is asserted
    /// here — **a session that cannot be drawn is a sentence, never a spinner.**
    func testShouldKnowWhenTheSessionItWasGivenCannotBeRenderedHere() {
        XCTAssertFalse(
            FaceRenderer.notInThisBuild.canDraw(aSession(native: false)),
            "a build with no renderer must not claim it can draw her")
        XCTAssertFalse(
            FaceRenderer.notInThisBuild.canDraw(aSession(native: true)),
            "native credentials do not help a build that cannot use them")
    }

    // MARK: - The web renderer (`syl-chzl.7.5`)

    /// **The zero-dependency rule, expressed as a test.** The phone draws her by pointing
    /// a web view at a page Syl serves, so a session it can draw is one with a session
    /// key and an origin — not one with native LiveKit credentials, which this app never
    /// asks for and could not use.
    func testShouldDrawAnyLiveSessionOnceThereIsAnOriginToDrawItFrom() {
        let renderer = FaceRenderer.web(origin: { URL(string: "https://syl.example/api/v1") })

        XCTAssertTrue(
            renderer.canDraw(aSession(native: false)),
            "the page turns a session key into a room; native credentials are not needed")
        XCTAssertTrue(renderer.canDraw(aSession(native: true)))
    }

    /// And refuses when there is nowhere to point it. A web view loading nothing over a
    /// session that is already billing is the spinner this surface is forbidden to show.
    func testShouldRefuseToDrawWhenThereIsNoOriginToDrawFrom() {
        XCTAssertFalse(FaceRenderer.web(origin: { nil }).canDraw(aSession()))
    }

    /// **The web renderer takes its state sink at draw time and cannot be built without
    /// one.** It used to be a defaulted argument on `web(origin:onState:)`, `AppDelegate`
    /// built the renderer without it, and the phone went deaf. Asserting the signature
    /// this way means the compiler asks every future call site the question that was
    /// silently answered wrong.
    func testShouldRequireSomewhereToReportToBeforeItWillDrawAnything() throws {
        var heard: [String] = []
        let renderer = FaceRenderer.web(origin: { URL(string: "https://syl.example/api/v1") })

        _ = renderer.view(aSession()) { state, _ in heard.append(state) }

        // Building the page cannot make it speak — a real one needs a real web view. What
        // is asserted is that there is a parameter to fill at all, which is what was
        // missing; `testShouldCarryThePagesStateOutOfTheWebViewToItsCaller` covers the
        // other end.
        XCTAssertTrue(heard.isEmpty)
    }

    /// The page lives beside the contract, not inside it — same origin, so there is no
    /// CORS, no second certificate and no ATS exception.
    func testShouldBuildThePageURLFromTheApiOriginAndNotUnderTheApiPrefix() {
        let base = URL(string: "https://syl.example:8888/api/v1")!

        XCTAssertEqual(
            LiveFacePage.url(apiBaseURL: base)?.absoluteString,
            "https://syl.example:8888/face/live")
    }

    /// A base URL with nothing to build an origin from produces no page, rather than a
    /// URL that will fail to load in front of a running meter.
    func testShouldProduceNoPageURLWhenThereIsNoOrigin() {
        XCTAssertNil(LiveFacePage.url(apiBaseURL: URL(string: "/api/v1")!))
    }

    /// **The credential reaches the page and reaches nothing else.**
    ///
    /// It is injected as a document-start script, so it appears in no address bar, no
    /// access log, no proxy log and no `Referer` header — which is the whole reason the
    /// host does not use the page's URL-fragment path.
    func testShouldHandTheSessionToThePageWithoutPuttingItInAURL() throws {
        let script = try XCTUnwrap(LiveFacePage.handoff(for: aSession()))

        XCTAssertTrue(script.hasPrefix("window.__sylFaceSession = "))
        XCTAssertTrue(script.contains("sk_short_lived"), "the page needs the session key")
        XCTAssertNil(
            LiveFacePage.url(apiBaseURL: URL(string: "https://syl.example/api/v1")!)?.query,
            "nothing about the session may travel in a query the server would log")
    }

    /// A session id is a value off the network, and a value off the network pasted into a
    /// script literal is script injection into the one document holding a live
    /// credential. It is JSON-encoded, so a hostile id is an inert string.
    func testShouldNotLetASessionIdBreakOutOfTheHandoffScript() throws {
        let hostile = FaceSession(
            sessionId: "\";window.stolen=window.__sylFaceSession;//",
            sessionKey: "sk_short_lived",
            expiresAt: nil
        )

        let script = try XCTUnwrap(LiveFacePage.handoff(for: hostile))

        // **The proof is that everything after the assignment parses as ONE JSON object.**
        // Asserting the hostile text is absent would be the wrong test — it is supposed to
        // be there, as data. What must not have happened is it ending the string literal,
        // and had it done so the remainder would no longer be a single JSON value.
        let prefix = "window.__sylFaceSession = "
        let literal = String(script.dropFirst(prefix.count).dropLast())
        let decoded = try JSONSerialization.jsonObject(with: Data(literal.utf8)) as? [String: String]

        XCTAssertEqual(
            decoded?["sessionId"], hostile.sessionId,
            "the id survives as data, and only as data")
        XCTAssertTrue(script.contains("\\\""), "the quote that would have closed it is escaped")
    }

    /// **The microphone, and only the microphone.** He talks to her; he is not on camera,
    /// and a camera grant would be a permission prompt for a capability this surface
    /// never uses.
    func testShouldGrantTheMicrophoneAndRefuseTheCamera() {
        XCTAssertEqual(FaceWebPage.Coordinator.decision(for: .microphone), .grant)
        XCTAssertEqual(FaceWebPage.Coordinator.decision(for: .camera), .deny)
        XCTAssertEqual(FaceWebPage.Coordinator.decision(for: .cameraAndMicrophone), .deny)
    }

    /// The page's own report of what it is doing reaches the host. A web view that
    /// renders nothing and says nothing is the stalled face this epic exists to prevent,
    /// and the host cannot see inside the document.
    func testShouldRelayWhatThePageSaysAboutItselfAndIgnoreNoise() {
        var heard: [String] = []
        let coordinator = FaceWebPage.Coordinator { state, _ in heard.append(state) }

        coordinator.receive(state: "connected", detail: "")
        coordinator.receive(state: "", detail: "nothing to say")
        coordinator.receive(state: "ended", detail: "")

        XCTAssertEqual(heard, ["connected", "ended"])
    }

    /// The meter line is a pure function, so what he reads can be asserted without a
    /// screen. Unknown renders as unknown; it never renders as zero, which would be a
    /// confident false claim about a meter that is running.
    func testShouldNeverRenderAnUnknownCostAsFree() {
        XCTAssertEqual(
            LiveFaceView.meterLine(nil), "Live · cost not known yet",
            "before the first report a $0.00 would be a false claim about a running meter")

        XCTAssertEqual(
            LiveFaceView.meterLine(aReport(elapsed: 125)),
            "Live · 2:05 · $0.20 · today $0.60")

        // No usable ceiling drops the day's figure rather than dividing by nothing.
        let uncapped = FaceSessionReport(
            session: aRow(),
            meter: FaceMeter(elapsedSeconds: 65, blocks: 11, credits: 7, dollars: 0.22),
            budget: FaceBudget(
                creditsSpentToday: 7, creditCeiling: 0, creditsRemaining: 0,
                dollarsSpentToday: 0.22)
        )
        XCTAssertEqual(LiveFaceView.meterLine(uncapped), "Live · 1:05 · $0.22")
    }

    // MARK: - The gateway that reaches nothing

    /// A preview, an offscreen render or an unpaired phone presses her face and is told
    /// so. `offline` refuses; it does not hang, and it is not a stub that succeeds.
    func testShouldRefuseAPressWithNothingBehindIt() async {
        let face = LiveFaceModel(gateway: .offline, clock: { [now] in now })

        await face.awaken()

        XCTAssertNotNil(face.visibleMessage)
        guard case .refused(let refusal) = face.standing else {
            return XCTFail("offline must refuse, not succeed: \(face.standing)")
        }
        guard case .unreachable = refusal else {
            return XCTFail("a dead tailnet is unreachable, not a mystery: \(refusal)")
        }
    }
}
