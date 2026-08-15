import Foundation
import SylKit
import XCTest

@testable import Syl

/// A turn that never comes back must not leave the screen waiting forever.
///
/// ## Why this is not a timeout
///
/// The obvious fix — start a stopwatch on send, complain after N seconds — is wrong here
/// and the service is why. A turn is allowed to take **ten minutes**
/// (`DEFAULT_TURN_TIMEOUT_MS`), and twenty if `SylAgent.ask` retries from a clean session.
/// Any stopwatch short enough to be useful would accuse a turn that is working perfectly.
///
/// But the service also tells us, continuously, that it is still working: `thinking`
/// carries a 15-second TTL and is re-announced every 7.5 seconds for as long as the turn
/// runs. So there is already a heartbeat, and the honest question is not "has it been
/// long enough" but **"is anything still vouching for this turn"**.
///
/// That makes the rule structural rather than a bolted-on timer, which is what
/// `PresenceTimeline` was built for in the first place: presence decays to `absent` after
/// the TTL and a further 30 seconds of silence, and it is *cleared outright* when the
/// socket drops. So:
///
/// > **If a turn is outstanding and presence has fallen to `absent`, nothing is vouching
/// > for it any more.**
///
/// A working turn re-announces every 7.5s and never reaches `absent`. A turn whose server
/// died, whose socket dropped, or whose reply the app missed does — and does so on its
/// own, with no clock of ours.
///
/// ## And saying so is not enough
///
/// `CLAUDE.md` constraint 4 is that the system does not get to silently discard things. A
/// notice that says "that turn did not come back" and then does nothing about it is still
/// a dropped reply, just a narrated one. The reply usually **exists on the server** — it
/// did in the incident that produced these tests, appended at 13:39:43 while the phone
/// showed nothing — so the recovery has to actually ask. `flush` is already
/// `SyncEngine.synchronise()`, which pushes the outbox *and* pulls changes, so the answer
/// is one call away.
final class ChatTurnRecoveryTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!

    override func setUpWithError() throws {
        database = try SylDatabase.inMemory()
        store = LocalStore(database: database)
    }

    override func tearDown() {
        store = nil
        database = nil
    }

    // MARK: - The turn that did not come back

    @MainActor
    func testShouldSayTheTurnDidNotComeBackOncePresenceStopsVouchingForIt() async throws {
        let clock = MutableClock(Self.instant("2026-08-09T07:00:00.000Z"))
        let model = makeModel(now: { clock.now })

        model.draft.text = "Send me a new video of yourself."
        await model.send()
        await model.apply(.presence(Self.thinking(at: clock.now, ttlMs: 100)))
        XCTAssertNil(model.notice, "nothing is wrong while she is still working")

        // Past the TTL and the grace. Nothing has vouched for the turn since.
        clock.advance(by: PresenceTimeline.idleGrace + 1)
        try await Self.settle()

        XCTAssertNotNil(
            model.notice,
            """
            The turn stopped being vouched for and the screen said nothing. His message \
            sits there and Syl never answers — which is the freeze he reported, and the \
            state constraint 4 exists to forbid.
            """
        )
        XCTAssertFalse(model.isAwaitingReply, "a turn nothing vouches for is not still in flight")
    }

    @MainActor
    func testShouldRecoverTheReplyByAskingRatherThanMerelyComplaining() async throws {
        // The reply the server already holds. The socket frame that carried it never
        // arrived — the app was wedged, or the gap was older than the buffer — so the
        // only thing that can produce it is a pull.
        let store = store!
        let clock = MutableClock(Self.instant("2026-08-09T07:00:00.000Z"))
        let arrived = Arrived()

        let model = makeModel(
            flush: {
                await arrived.record()
                try? store.upsert([
                    Self.reply(text: "Rendering now.", createdAt: try! Instant.parse("2026-08-09T07:00:20.000Z"))
                ])
            },
            now: { clock.now }
        )

        model.draft.text = "Send me a new video of yourself."
        await model.send()
        await model.apply(.presence(Self.thinking(at: clock.now, ttlMs: 100)))

        clock.advance(by: PresenceTimeline.idleGrace + 1)
        try await Self.settle()

        let pulled = await arrived.count
        XCTAssertGreaterThanOrEqual(pulled, 1, "the recovery has to ask the server, not just narrate")
        XCTAssertTrue(
            model.snapshot.groups.contains { $0.role == .assistant },
            "the reply existed on the server the whole time and must end up on screen"
        )
        XCTAssertNil(model.notice, "once it is recovered there is nothing left to report")
        XCTAssertFalse(model.isAwaitingReply)
    }

    /// The send that gets no presence frame at all.
    ///
    /// This is the case `turnSilence` exists for and the one every other test here
    /// accidentally covered up: they all apply a presence frame straight after the send,
    /// and each frame re-arms the watch — so the arming that `send` itself does was never
    /// the thing under test. **Mutation found it.** Deleting `armTurnWatch` from `send`
    /// left all six of them green.
    ///
    /// What it describes is real and is the worst version of the bug: the socket was never
    /// up, or the service took the message and died before announcing the turn. Nothing
    /// ever speaks for it, so nothing but this floor can notice.
    @MainActor
    func testShouldReportASendThatNothingEverAnnouncedAtAll() async throws {
        let clock = MutableClock(Self.instant("2026-08-09T07:00:00.000Z"))
        let model = makeModel(now: { clock.now })

        model.draft.text = "Send me a new video of yourself."
        await model.send()
        // No presence frame. Ever.
        try await Self.settle()

        XCTAssertNotNil(
            model.notice,
            "nothing ever spoke for this turn and the screen never said so"
        )
        XCTAssertFalse(model.isAwaitingReply)
    }

    // MARK: - And it must not cry wolf

    @MainActor
    func testShouldNotAccuseATurnThatIsStillWorking() async throws {
        // The case a stopwatch gets wrong. A ten-minute turn is legitimate, and the
        // service says so every 7.5 seconds.
        //
        // **The watch must actually fire during this test.** An earlier version applied a
        // presence frame every 60ms against a 100ms watch, so each frame re-armed it and
        // it never woke at all — the assertion passed because nothing happened, not
        // because the right thing happened. Mutation proved it: deleting the "is anything
        // still vouching for it" guard left this green. One frame and then a wait long
        // enough for the watch to wake is what puts the guard under test.
        let clock = MutableClock(Self.instant("2026-08-09T07:00:00.000Z"))
        let model = makeModel(now: { clock.now })

        model.draft.text = "Do the long thing."
        await model.send()
        await model.apply(.presence(Self.thinking(at: clock.now, ttlMs: 15_000)))

        // Well past the watch's wake-up, nowhere near the frame's TTL. She is still
        // working, and the clock says so.
        clock.advance(by: 5)
        try await Self.settle()

        XCTAssertNil(model.notice, "she is still working — the watch woke and must let it be")
        XCTAssertTrue(model.isAwaitingReply, "the turn is still outstanding, not abandoned")
    }

    @MainActor
    func testShouldStopWaitingTheMomentSheAnswers() async throws {
        let clock = MutableClock(Self.instant("2026-08-09T07:00:00.000Z"))
        let model = makeModel(now: { clock.now })

        model.draft.text = "Check now"
        await model.send()
        await model.apply(.presence(Self.thinking(at: clock.now, ttlMs: 100)))

        await model.apply(.message(Self.reply(text: "Still rendering.", createdAt: clock.now)))
        XCTAssertFalse(model.isAwaitingReply, "she answered")

        // The presence that was vouching for it now lapses. Nothing should be reported:
        // the turn it belonged to is closed.
        clock.advance(by: PresenceTimeline.idleGrace + 1)
        try await Self.settle()

        XCTAssertNil(model.notice, "a closed turn cannot go missing afterwards")
    }

    @MainActor
    func testShouldNotReportATurnNobodyAskedFor() async throws {
        // Presence lapsing with nothing outstanding is the ordinary resting case — it
        // happens every time she finishes anything. It must be silent.
        let clock = MutableClock(Self.instant("2026-08-09T07:00:00.000Z"))
        let model = makeModel(now: { clock.now })

        await model.apply(.presence(Self.thinking(at: clock.now, ttlMs: 100)))
        clock.advance(by: PresenceTimeline.idleGrace + 1)
        try await Self.settle()

        XCTAssertNil(model.notice)
        XCTAssertFalse(model.isAwaitingReply)
    }

    /// The socket dropping mid-turn is the same question asked a different way.
    ///
    /// `apply(.connectionState(.offline))` clears the timeline outright, so presence is
    /// `absent` immediately rather than in 45 seconds. A turn outstanding across that
    /// has lost the only thing that could have vouched for it.
    @MainActor
    func testShouldReportATurnStrandedByTheSocketDropping() async throws {
        let clock = MutableClock(Self.instant("2026-08-09T07:00:00.000Z"))
        let model = makeModel(now: { clock.now })

        model.draft.text = "Send me a new video of yourself."
        await model.send()
        await model.apply(.presence(Self.thinking(at: clock.now, ttlMs: 15_000)))

        await model.apply(.connectionState(.offline))
        try await Self.settle()

        XCTAssertFalse(model.isAwaitingReply)
        XCTAssertNotNil(model.notice)
    }

    // MARK: - Harness

    @MainActor
    private func makeModel(
        flush: @escaping @Sendable () async -> Void = {},
        now: @escaping @Sendable () -> Date = { try! Instant.parse("2026-08-09T07:00:00.000Z") },
        turnSilence: TimeInterval = 0.1
    ) -> ChatViewModel {
        ChatViewModel(
            store: store,
            sendOverSocket: { _, _, _ in },
            flush: flush,
            now: now,
            makeClientId: { UUID().uuidString },
            makeIdempotencyKey: { UUID().uuidString },
            // Short, so the no-presence floor is exercised rather than waited out. What
            // it *concludes* is driven by the injected clock; only its wake-up is real.
            turnSilence: turnSilence
        )
    }

    /// Lets the armed watch fire. The watch sleeps in real time — the clock injection is
    /// about *what it concludes*, not about when it wakes — so this is the one place the
    /// suite genuinely has to wait, and it waits for a tick rather than for a duration.
    private static func settle(for duration: Duration = .milliseconds(400)) async throws {
        try await Task.sleep(for: duration)
    }

    private static func thinking(at instant: Date, ttlMs: Int) -> WsPresence {
        WsPresence(state: .thinking, intensity: 0.55, since: instant, ttlMs: ttlMs)
    }

    private static func reply(text: String, createdAt: Date) -> Message {
        Message(
            id: "syl:message:0198f2c0-0002-7000-8000-0000000000\(Int.random(in: 10...99))",
            conversationId: SylIDs.interactiveConversation,
            clientId: nil,
            role: .assistant,
            text: text,
            createdAt: createdAt,
            seq: Int.random(in: 100...999)
        )
    }

    private static func instant(_ text: String) -> Date {
        try! Instant.parse(text)
    }

    /// Counts the pulls, off the main actor.
    private actor Arrived {
        private(set) var count = 0
        func record() { count += 1 }
    }

    /// A clock the test moves by hand. Lock-guarded because the armed watch reads it
    /// from a task that is not the one that moved it.
    private final class MutableClock: @unchecked Sendable {
        private let lock = NSLock()
        private var instant: Date

        init(_ instant: Date) { self.instant = instant }

        var now: Date {
            lock.lock()
            defer { lock.unlock() }
            return instant
        }

        func advance(by interval: TimeInterval) {
            lock.lock()
            defer { lock.unlock() }
            instant = instant.addingTimeInterval(interval)
        }
    }
}
