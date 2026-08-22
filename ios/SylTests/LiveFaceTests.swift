import SwiftUI
import SylKit
import UIKit
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
        XCTAssertEqual(face.standing, .here(aSession()))
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

    // MARK: - 3b. Leaving closes it

    func testShouldCloseTheSessionWhenHeLeavesTheScreen() async {
        let broker = broker { _ in aSession(id: "face-9") }
        let face = model(broker)
        await face.awaken()

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
        let face = model(broker)
        await face.awaken()

        await face.scenePhaseChanged(to: .background)

        XCTAssertEqual(broker.closedIDs, ["face-bg"])
        XCTAssertEqual(face.standing, .dormant)
    }

    /// Glancing at a notification banner is not leaving. Tearing down a live conversation
    /// because the app went inactive for a second would be its own defect.
    func testShouldNotCloseMerelyBecauseTheAppWentInactive() async {
        let broker = broker { _ in aSession() }
        let face = model(broker)
        await face.awaken()

        await face.scenePhaseChanged(to: .inactive)

        XCTAssertTrue(broker.closedIDs.isEmpty)
        XCTAssertEqual(face.standing, .here(aSession()))
    }

    /// Two things both mean "he has left" and they race. Neither may be the one that is
    /// skipped, and the second must not error.
    func testShouldSurviveLeavingTwice() async {
        let broker = broker { _ in aSession(id: "face-2x") }
        let face = model(broker)
        await face.awaken()

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
        let face = model(broker)
        await face.awaken()
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

        XCTAssertTrue(face.isPresented, "a refusal is the thing that must be visible")
        XCTAssertFalse(
            (face.visibleMessage ?? "").isEmpty,
            "there is always something to read; silence is the one forbidden outcome")
        XCTAssertTrue(face.offersAnotherTry, "an unreachable Mac is worth another press")
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
        let face = model(broker)
        await face.awaken()

        await face.tick(at: now)

        XCTAssertEqual(broker.openCount, 2)
        XCTAssertEqual(face.standing, .here(aSession(id: "second")))
        XCTAssertEqual(broker.closedIDs, ["first"], "the expiring one is let go, after")
    }

    /// A session with room to spare is left alone. Renewing early is money.
    func testShouldNotRenewASessionThatHasTimeLeft() async {
        let broker = broker { _ in aSession(expiresIn: 300) }
        broker.report = { id in aReport(id: id) }
        let face = model(broker)
        await face.awaken()

        await face.tick(at: now)

        XCTAssertEqual(broker.openCount, 1)
    }

    /// The meter reaches the screen, because the money is his.
    func testShouldPublishTheMeterWhileSheIsHere() async {
        let broker = broker { _ in aSession() }
        broker.report = { id in aReport(id: id, elapsed: 94) }
        let face = model(broker)
        await face.awaken()

        await face.tick(at: now)

        XCTAssertEqual(face.report?.meter.elapsedSeconds, 94)
        XCTAssertEqual(face.report?.budget.dollarsSpentToday, 0.6)
    }

    /// **A face that has stopped must not look like a face that is loading.** When the
    /// broker says the session ended, the screen says so in the broker's words.
    func testShouldSayThatSheHasGoneRatherThanShowingAStalledFace() async {
        let broker = broker { _ in aSession() }
        broker.report = { id in aReport(id: id, ended: .reaped) }
        let face = model(broker)
        await face.awaken()

        await face.tick(at: now)

        XCTAssertEqual(
            face.visibleMessage, LiveFaceModel.sentence(for: .reaped),
            "a reaped session is an admission, not an ordinary close")
        XCTAssertNotEqual(
            LiveFaceModel.sentence(for: .reaped), LiveFaceModel.sentence(for: .closed),
            "the four ends are four different facts and must not read alike")
    }

    // MARK: - The surface's own honesty

    /// A broker that minted only browser credentials has opened something this phone
    /// cannot draw. That is a state with its own sentence, not a spinner.
    func testShouldKnowWhenTheSessionItWasGivenCannotBeRenderedHere() async {
        let broker = broker { _ in aSession(native: false) }
        let face = model(broker)

        await face.awaken()

        XCTAssertFalse(face.canRender)
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
