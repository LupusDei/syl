import SylKit
import XCTest

@testable import Syl

/// Grouping is pure, so it gets the exhaustive treatment. Adjutant has the same logic
/// buried in a 955-line view where none of these cases can be asserted.
final class MessageGroupingTests: XCTestCase {
    func testShouldProduceNothingForAnEmptyConversation() {
        XCTAssertTrue(MessageGrouping.group([]).isEmpty)
    }

    func testShouldKeepConsecutiveMessagesFromTheSameSpeakerTogether() {
        let messages = [
            message(id: "a", role: .assistant, offset: 0),
            message(id: "b", role: .assistant, offset: 5),
        ]

        let groups = MessageGrouping.group(messages)

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.messages.count, 2)
    }

    func testShouldStartANewGroupWhenTheSpeakerChanges() {
        let messages = [
            message(id: "a", role: .user, offset: 0),
            message(id: "b", role: .assistant, offset: 5),
        ]

        XCTAssertEqual(MessageGrouping.group(messages).map(\.role), [.user, .assistant])
    }

    func testShouldStartANewGroupAfterAPauseLongerThanTheGap() {
        // Five minutes is where a timestamp stops being obvious from context. A
        // reminder that fired an hour later should not join the morning's conversation.
        let messages = [
            message(id: "a", role: .assistant, offset: 0),
            message(id: "b", role: .assistant, offset: MessageGrouping.maximumGap + 1),
        ]

        XCTAssertEqual(MessageGrouping.group(messages).count, 2)
    }

    func testShouldKeepAMessageExactlyAtTheGapBoundaryInTheSameGroup() {
        let messages = [
            message(id: "a", role: .assistant, offset: 0),
            message(id: "b", role: .assistant, offset: MessageGrouping.maximumGap),
        ]

        XCTAssertEqual(MessageGrouping.group(messages).count, 1)
    }

    func testShouldNeverMergeAPendingMessageIntoAConfirmedGroup() {
        // They render differently, and merging them would make the whole group look
        // unsent.
        let messages = [
            message(id: "a", role: .user, offset: 0),
            message(id: "pending", role: .user, offset: 5),
        ]

        let groups = MessageGrouping.group(messages, pendingIds: ["pending"])

        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups.map(\.isPending), [false, true])
    }

    func testShouldIdentifyAGroupByItsFirstMessage() {
        let groups = MessageGrouping.group([
            message(id: "first", role: .assistant, offset: 0),
            message(id: "second", role: .assistant, offset: 1),
        ])

        XCTAssertEqual(groups.first?.id, "first")
    }

    func testShouldJoinTheTextOfAGroupInOrder() {
        let groups = MessageGrouping.group([
            message(id: "a", role: .assistant, offset: 0, text: "One."),
            message(id: "b", role: .assistant, offset: 1, text: "Two."),
        ])

        XCTAssertEqual(groups.first?.text, "One.\n\nTwo.")
    }

    private func message(
        id: SylID,
        role: MessageRole,
        offset: TimeInterval,
        text: String = "Done."
    ) -> Message {
        Message(
            id: id,
            conversationId: SylIDs.interactiveConversation,
            clientId: nil,
            role: role,
            text: text,
            createdAt: try! Instant.parse("2026-08-09T07:00:00.000Z").addingTimeInterval(offset),
            seq: 1
        )
    }
}

/// One page, named once (`syl-025.1.2`).
///
/// Both assertions matter and they are different assertions. The first pins the constant
/// to the requirement — 50 is what the Commander asked for and what the server gives you
/// when you ask for nothing. The second drives the **loader's own default** through the
/// real read path against a store far larger than the window, which is the only thing
/// that can catch the loader drifting away from the view model again. They were two
/// hand-written 200s, and no test could see the disagreement because neither had a name.
final class ChatPagingTests: XCTestCase {
    func testShouldReadFiftyAtATime() {
        XCTAssertEqual(ChatPaging.pageSize, 50)
    }

    func testShouldOpenTheLoaderOnExactlyOnePageWhenNoLimitIsGiven() throws {
        let database = try SylDatabase.inMemory()
        let store = LocalStore(database: database)
        let base = try Instant.parse("2026-08-09T07:00:03.114Z")
        try store.upsert(
            (1...500).map { seq in
                Message(
                    id: "syl:message:0198f2c0-0001-7000-8000-\(String(format: "%012d", seq))",
                    conversationId: SylIDs.interactiveConversation,
                    clientId: nil,
                    role: .assistant,
                    text: "Done.",
                    createdAt: base.addingTimeInterval(Double(seq) * (MessageGrouping.maximumGap + 1)),
                    seq: seq
                )
            }
        )

        let snapshot = try ChatSnapshotLoader(
            store: store,
            conversationId: SylIDs.interactiveConversation
        ).load()

        XCTAssertEqual(snapshot.groups.flatMap(\.messages).count, ChatPaging.pageSize)
        XCTAssertTrue(snapshot.mayHaveEarlier)
    }
}

/// The chat screen's state, driven against a real in-memory store.
///
/// The class is not `@MainActor` — XCTest's `setUpWithError` and `tearDown` are
/// nonisolated in the base class and an isolated override is a compile error. The test
/// methods carry the annotation instead, which is where the view model actually lives.
final class ChatViewModelTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        database = try SylDatabase.inMemory()
        store = LocalStore(database: database)
    }

    override func tearDown() {
        store = nil
        database = nil
        super.tearDown()
    }

    // MARK: - Rendering from disk

    @MainActor
    func testShouldRenderWhatIsOnDiskWithoutTouchingTheNetwork() async throws {
        try store.upsert([
            message(id: "syl:message:0198f2c0-0001-7000-8000-00000000b001", seq: 1)
        ])
        let model = makeModel()

        await model.refresh()

        XCTAssertEqual(model.snapshot.groups.count, 1)
        XCTAssertEqual(model.snapshot.highestSeq, 1)
    }

    @MainActor
    func testShouldStartEmptyRatherThanFailingOnAFreshDevice() async {
        let model = makeModel()

        await model.refresh()

        XCTAssertTrue(model.snapshot.groups.isEmpty)
        XCTAssertNil(model.notice)
    }

    // MARK: - Optimistic send

    @MainActor
    func testShouldShowTheBubbleImmediatelyAndQueueTheIntent() async throws {
        let model = makeModel()
        model.draft.text = "Remind me to call the pharmacy at 4 today."

        await model.send()

        XCTAssertEqual(model.snapshot.groups.count, 1)
        XCTAssertTrue(model.snapshot.groups.first?.isPending == true)
        XCTAssertEqual(model.snapshot.pendingCount, 1)
        XCTAssertEqual(try Outbox(database: database).count(), 1)
    }

    @MainActor
    func testShouldClearTheDraftOnceTheMessageIsQueued() async {
        let model = makeModel()
        model.draft.text = "Hello."

        await model.send()

        XCTAssertEqual(model.draft.text, "")
    }

    @MainActor
    func testShouldIgnoreAnEmptyOrWhitespaceOnlyDraft() async throws {
        let model = makeModel()
        model.draft.text = "   \n "

        await model.send()

        XCTAssertEqual(try Outbox(database: database).count(), 0)
        XCTAssertEqual(model.draft.text, "   \n ")
    }

    @MainActor
    func testShouldQueueTheMessageEvenWhenTheSocketIsDown() async throws {
        // Expected, not exceptional: the Mac reboots and the tailnet drops on a
        // handoff. The intent is durable before the socket is ever tried.
        let flushed = Flag()
        let model = makeModel(
            sendOverSocket: { _, _, _ in throw WebSocketClient.NotConnected() },
            flush: { await flushed.raise() }
        )
        model.draft.text = "Hello."

        await model.send()

        XCTAssertEqual(try Outbox(database: database).count(), 1)
        XCTAssertTrue(model.snapshot.groups.first?.isPending == true)
        let didFlush = await flushed.value
        XCTAssertTrue(didFlush, "a queued message should not wait for the next scheduled sync")
    }

    @MainActor
    func testShouldWriteToDiskBeforeItTriesTheSocket() async throws {
        // If the app is killed between the two, the message must still be queued and
        // still on screen. Sending first would lose both.
        let observed = Counter()
        let store = store!
        let model = makeModel(
            sendOverSocket: { _, _, _ in
                await observed.set((try? store.pendingMessages().count) ?? 0)
            }
        )
        model.draft.text = "Hello."

        await model.send()

        let pendingAtSendTime = await observed.value
        XCTAssertEqual(pendingAtSendTime, 1)
    }

    // MARK: - Reconciliation

    @MainActor
    func testShouldReplaceThePendingBubbleWhenTheSocketConfirms() async throws {
        let model = makeModel(makeClientId: { "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44" })
        model.draft.text = "Remind me to call the pharmacy at 4 today."
        await model.send()

        let changed = await model.apply(.deliveryConfirmation(confirmation()))

        XCTAssertTrue(changed)
        XCTAssertEqual(model.snapshot.pendingCount, 0)
        XCTAssertEqual(model.snapshot.groups.count, 1, "one bubble, not two")
    }

    @MainActor
    func testShouldIgnoreAConfirmationForAnotherConversation() async throws {
        let model = makeModel()

        let changed = await model.apply(
            .deliveryConfirmation(
                DeliveryConfirmation(
                    clientId: "c1",
                    serverId: "syl:message:0198f2c0-0001-7000-8000-00000000b001",
                    conversationId: "syl:conversation:0198f2d0-1111-7000-8000-00000000a001",
                    seq: 1,
                    acceptedAt: instant("2026-08-09T06:59:48.220Z")
                )
            )
        )

        XCTAssertFalse(changed)
    }

    // MARK: - Live messages

    @MainActor
    func testShouldAppendAMessageThatArrivesOnTheSocket() async throws {
        let model = makeModel()

        let changed = await model.apply(
            .message(message(id: "syl:message:0198f2c0-0002-7000-8000-00000000b002", seq: 2))
        )

        XCTAssertTrue(changed)
        XCTAssertEqual(model.snapshot.groups.count, 1)
    }

    @MainActor
    func testShouldIgnoreAMessageForAnotherLane() async throws {
        // Job lanes hold Syl's inner monologue and must never interleave with talking
        // to him.
        let model = makeModel()
        let other = Message(
            id: "syl:message:0198f2c0-0003-7000-8000-00000000b003",
            conversationId: "syl:conversation:0198f2d0-1111-7000-8000-00000000a001",
            clientId: nil,
            role: .assistant,
            text: "Gathering sources.",
            createdAt: instant("2026-08-09T07:00:03.114Z"),
            seq: 1
        )

        let changed = await model.apply(.message(other))

        XCTAssertFalse(changed)
        XCTAssertTrue(model.snapshot.groups.isEmpty)
    }

    // MARK: - Honest states

    @MainActor
    func testShouldSaySomethingDifferentForEveryConnectionState() async {
        let model = makeModel()

        await model.apply(.connectionState(.connecting))
        XCTAssertEqual(model.connectionSummary, "Connecting")

        await model.apply(.connectionState(.reconnecting(attempt: 3)))
        XCTAssertEqual(model.connectionSummary, "Reconnecting (3)")

        await model.apply(.connectionState(.offline))
        XCTAssertEqual(model.connectionSummary, "Offline")

        await model.apply(.connectionState(.connected))
        XCTAssertEqual(model.connectionSummary, "Connected")
    }

    @MainActor
    func testShouldSayHowManyMessagesAreWaitingWhenOffline() async {
        // An assistant that silently fails to sync is worse than one that says so.
        let model = makeModel(sendOverSocket: { _, _, _ in throw WebSocketClient.NotConnected() })
        model.draft.text = "Hello."
        await model.send()

        await model.apply(.connectionState(.offline))

        XCTAssertEqual(model.connectionSummary, "Offline — 1 waiting to send")
    }

    @MainActor
    func testShouldStayQuietOnlyWhenConnectedWithNothingQueued() async {
        let model = makeModel()

        await model.apply(.connectionState(.connected))

        XCTAssertFalse(model.isConnectionNoteworthy)
    }

    @MainActor
    func testShouldAskForPairingWhenTheTokenIsRefused() async {
        let model = makeModel()

        await model.apply(.connectionState(.unauthenticated))

        XCTAssertEqual(model.connectionSummary, "Needs pairing")
        XCTAssertNotNil(model.notice)
    }

    @MainActor
    func testShouldSayItIsCatchingUpWhenTheGapFellOffTheReplayBuffer() async {
        // Saying nothing would leave the client believing it is caught up when it is
        // not.
        let model = makeModel()

        await model.apply(.needsHTTPSync(fromSeq: 4102))

        XCTAssertNotNil(model.notice)
    }

    @MainActor
    func testShouldSurfaceAFatalErrorAndIgnoreATransientOne() async {
        let model = makeModel()

        await model.apply(
            .error(ApiError(code: .rateLimited, message: "Slow down.", retryable: true), fatal: false)
        )
        XCTAssertNil(model.notice)

        await model.apply(
            .error(
                ApiError(code: .unauthorized, message: "Token expired.", retryable: false),
                fatal: true
            )
        )
        XCTAssertEqual(model.notice, "Token expired.")
    }

    @MainActor
    func testShouldTrackPresenceWithoutTreatingItAsAMessage() async {
        let model = makeModel()

        let changed = await model.apply(
            .presence(
                WsPresence(
                    state: .thinking,
                    intensity: 0.55,
                    since: instant("2026-08-09T06:59:48.300Z"),
                    ttlMs: 15_000
                )
            )
        )

        XCTAssertEqual(model.presence, .thinking)
        XCTAssertFalse(changed)
        XCTAssertTrue(model.snapshot.groups.isEmpty)
    }

    // MARK: - Presence decay (syl-008.4.1 / T020)
    //
    // Chat used to store `frame.state` raw and never decay it. That is worse here than
    // on home: this is the screen where "she is thinking" is a claim about a turn the
    // Commander is actively waiting on, so a frozen state does not merely look wrong,
    // it tells him the machine is still working when it stopped minutes ago.

    @MainActor
    func testShouldDecayPresenceToIdleOnceTheTTLLapses() async throws {
        let clock = MutableClock(instant("2026-08-09T07:00:00.000Z"))
        let model = makeModel(now: { clock.now })

        await model.apply(
            .presence(
                WsPresence(state: .thinking, intensity: 0.55, since: clock.now, ttlMs: 100)
            )
        )
        XCTAssertEqual(model.presence, .thinking)
        XCTAssertEqual(model.intensity, 0.55, accuracy: 0.0001)

        // Past the TTL by a wide margin, so the assertion is about the ladder rather
        // than about hitting a boundary exactly.
        clock.advance(by: 1)
        try await Task.sleep(for: .milliseconds(400))

        XCTAssertEqual(model.presence, .idle)
        XCTAssertEqual(model.intensity, 0, "an amplitude outliving its state is the same lie as the state")
    }

    @MainActor
    func testShouldForgetPresenceWhenTheSocketDrops() async {
        let model = makeModel()

        await model.apply(
            .presence(
                WsPresence(
                    state: .thinking,
                    intensity: 0.55,
                    since: instant("2026-08-09T06:59:48.300Z"),
                    ttlMs: 15_000
                )
            )
        )
        XCTAssertEqual(model.presence, .thinking)

        await model.apply(.connectionState(.offline))

        // Not stale — false. Replaying "thinking" across a disconnection asserts
        // something about now that stopped being true when the socket died.
        XCTAssertEqual(model.presence, .absent)
        XCTAssertEqual(model.intensity, 0)
    }

    @MainActor
    func testShouldForgetPresenceWhenTheDeviceNeedsPairingAgain() async {
        let model = makeModel()

        await model.apply(
            .presence(
                WsPresence(
                    state: .speaking,
                    intensity: 0.9,
                    since: instant("2026-08-09T06:59:48.300Z"),
                    ttlMs: 15_000
                )
            )
        )
        XCTAssertEqual(model.presence, .speaking)

        await model.apply(.connectionState(.unauthenticated))

        XCTAssertEqual(model.presence, .absent)
        XCTAssertEqual(model.notice, "This device needs to be paired again.")
    }

    @MainActor
    func testShouldKeepRenderingPresenceAcrossAReconnectAttempt() async {
        // The edge on the other side: `reconnecting` is not a drop. Clearing on every
        // non-connected state would make her flicker out during an ordinary handoff.
        let model = makeModel()

        await model.apply(
            .presence(
                WsPresence(
                    state: .thinking,
                    intensity: 0.55,
                    since: instant("2026-08-09T06:59:48.300Z"),
                    ttlMs: 15_000
                )
            )
        )

        await model.apply(.connectionState(.reconnecting(attempt: 1)))

        XCTAssertEqual(model.presence, .thinking)
    }

    // MARK: - Reaching back through history (T039)

    @MainActor
    func testShouldNotOfferEarlierMessagesWhenTheWindowIsNotFull() async throws {
        try store.upsert((1...3).map { message(id: id($0), seq: $0) })
        let model = makeModel(limit: 10)

        await model.refresh()

        XCTAssertFalse(model.snapshot.mayHaveEarlier)
    }

    @MainActor
    func testShouldOfferEarlierMessagesWhenTheWindowFills() async throws {
        try store.upsert((1...10).map { message(id: id($0), seq: $0) })
        let model = makeModel(limit: 5)

        await model.refresh()

        XCTAssertEqual(model.snapshot.groups.flatMap(\.messages).count, 5)
        XCTAssertTrue(model.snapshot.mayHaveEarlier)
    }

    @MainActor
    func testShouldRevealOlderMessagesWhenAskedForEarlierOnes() async throws {
        // The defect this fixes: the loader was hard-capped with no way to reach
        // anything older, so a month-old conversation had no beginning.
        try store.upsert((1...10).map { message(id: id($0), seq: $0) })
        let model = makeModel(limit: 5)
        await model.refresh()

        await model.loadEarlier()

        XCTAssertEqual(model.snapshot.groups.flatMap(\.messages).count, 10)
        XCTAssertFalse(model.snapshot.mayHaveEarlier, "everything is now on screen")
        XCTAssertFalse(model.isLoadingEarlier)
    }

    @MainActor
    func testShouldDoNothingWhenThereIsNothingEarlierToLoad() async throws {
        try store.upsert((1...3).map { message(id: id($0), seq: $0) })
        let model = makeModel(limit: 10)
        await model.refresh()

        await model.loadEarlier()

        XCTAssertEqual(model.snapshot.groups.flatMap(\.messages).count, 3)
    }

    // MARK: - The window is one page, and it stays one page (syl-025.1.1)
    //
    // Every fixture above this line is SHORTER than the window, which is exactly the
    // condition under which the defect these tests describe does not exist. That is why
    // nothing caught it. The rule from `docs/CONTEXT.md` — *any query with a `LIMIT`
    // needs a test where the limit actually bites* — is the whole reason the seed here
    // is 2,000 and the assertions are counted against one page rather than against
    // "did we get everything".

    /// The page the Commander asked for, and the server's own default.
    ///
    /// Written as a literal on purpose: this is the requirement (FR-002), not a
    /// restatement of whatever the code happens to hold. `ChatPagingTests` is where the
    /// production constant is pinned to it.
    private static let page = 50

    @MainActor
    func testShouldLoadOnlyOnePageWhenTheConversationIsLong() async throws {
        try store.upsert(longConversation())
        // No limit passed — the window the phone itself opens with.
        let model = makeModel()

        await model.refresh()

        XCTAssertEqual(
            model.snapshot.groups.flatMap(\.messages).count,
            Self.page,
            """
            First paint read \(model.snapshot.groups.flatMap(\.messages).count) messages \
            of 2,000. It must read exactly one page: every one of them is sized on every \
            body pass, and the body re-runs on each keystroke.
            """
        )
        XCTAssertTrue(
            model.snapshot.mayHaveEarlier,
            "1,950 messages are still behind the window, and the way back must be offered"
        )
    }

    @MainActor
    func testShouldNotWidenTheWindowWithoutBeingAsked() async throws {
        // The defect, stated as a property. `loadEarlier()` was driven from an
        // `onAppear` on a row inside the `LazyVStack`, and every widening reassigned the
        // snapshot, which rebuilt the subtree, which re-created that row, which fired
        // `onAppear` again. The loop stopped only when the ENTIRE conversation was
        // resident. No finger touched the screen.
        try store.upsert(longConversation())
        let model = makeModel()
        await model.refresh()

        // Everything the view does to the model when the transcript is rebuilt.
        await model.refresh()
        await model.apply(.message(message(id: id(2_001), seq: 2_001)))
        await model.refresh()

        XCTAssertEqual(
            model.snapshot.groups.flatMap(\.messages).count,
            Self.page,
            "a rebuild is not a request for more history"
        )
    }

    @MainActor
    func testShouldNotWidenTheWindowTwiceForOneTrigger() async throws {
        // A fast flick to the top used to queue several overlapping reads that each
        // widened the window again, so one arrival cost four pages instead of one.
        try store.upsert(longConversation())
        let model = makeModel()
        await model.refresh()

        async let first: Void = model.loadEarlier()
        async let second: Void = model.loadEarlier()
        _ = await (first, second)

        XCTAssertEqual(
            model.snapshot.groups.flatMap(\.messages).count,
            Self.page * 2,
            "two overlapping triggers, one page of history"
        )
        XCTAssertFalse(model.isLoadingEarlier)
    }

    // MARK: - One arrival at the top, one page (syl-025.1.3)

    @MainActor
    func testShouldLoadOnlyOnePageHoweverOftenTheTopIsReported() async throws {
        // The runaway, at the seam where it lived. Each widening reassigned the snapshot,
        // which rebuilt the transcript subtree, which re-created the row at the top,
        // which reported the top again — and `isLoadingEarlier` was already cleared by
        // then. Five reports of the same arrival must still be one page.
        try store.upsert(longConversation())
        let model = makeModel()
        await model.refresh()

        for _ in 1...5 {
            await model.reachedTheTopOfTheWindow()
        }

        XCTAssertEqual(
            model.snapshot.groups.flatMap(\.messages).count,
            Self.page * 2,
            "one arrival at the top is one page, however many times the view says so"
        )
    }

    @MainActor
    func testShouldLoadAnotherPageOnceHeHasLeftTheTopAndComeBack() async throws {
        // The other half, and the reason the latch is a latch rather than a one-shot:
        // reaching back through a long history must not cost a tap per page after the
        // first.
        try store.upsert(longConversation())
        let model = makeModel()
        await model.refresh()

        await model.reachedTheTopOfTheWindow()
        model.leftTheTopOfTheWindow()
        await model.reachedTheTopOfTheWindow()

        XCTAssertEqual(model.snapshot.groups.flatMap(\.messages).count, Self.page * 3)
    }

    @MainActor
    func testShouldAlwaysHonourATapEvenWhenTheAutomaticTriggerIsSpent() async throws {
        // The control exists because an automatic trigger that misfires must never leave
        // him with no way back. A latch that also swallowed his taps would take the
        // fallback away exactly when it is needed.
        try store.upsert(longConversation())
        let model = makeModel()
        await model.refresh()
        await model.reachedTheTopOfTheWindow()

        await model.loadEarlier()
        await model.loadEarlier()

        XCTAssertEqual(
            model.snapshot.groups.flatMap(\.messages).count,
            Self.page * 4,
            "he asked twice, on top of the automatic page; he gets both"
        )
    }

    // MARK: - The parse cache (T040)

    func testShouldParseAMessageOnceAndReuseIt() {
        // Asserted by handing the cache the SAME id with DIFFERENT text: a cached
        // entry wins, which is the proof that no second parse happened.
        //
        // It also pins the assumption the cache rests on — a message's text is
        // immutable once written, so id is a safe key. If editing ever arrives, this
        // test is the one that must be changed, deliberately, rather than discovered.
        let cache = MarkdownCache()
        let first = message(id: id(1), seq: 1, text: "# First")
        let impostor = message(id: id(1), seq: 1, text: "# Second")

        XCTAssertEqual(cache.blocks(for: [first])[id(1)], [.heading(level: 1, text: "First")])
        XCTAssertEqual(
            cache.blocks(for: [impostor])[id(1)],
            [.heading(level: 1, text: "First")],
            "the cached parse was reused"
        )
    }

    func testShouldForgetMessagesThatHaveLeftTheWindow() {
        // Otherwise a long-running session accumulates the parse of every message ever
        // seen, and the cache becomes a leak with a nice name.
        let cache = MarkdownCache()
        _ = cache.blocks(for: [message(id: id(1), seq: 1, text: "one")])

        let second = cache.blocks(for: [message(id: id(2), seq: 2, text: "two")])

        XCTAssertNil(second[id(1)])
        XCTAssertNotNil(second[id(2)])
    }

    // MARK: - The view renders rows, so rows must exist whenever groups do

    @MainActor
    func testShouldProduceARowForEveryTurnItGroups() async throws {
        // `ChatView` renders `snapshot.rows`, not `snapshot.groups`. If the two ever
        // disagree the screen goes blank while the banner cheerfully reports the
        // pending count — a transcript that has messages and shows none.
        try store.upsert([message(id: id(1), seq: 1), message(id: id(2), seq: 2)])
        let model = makeModel()

        await model.refresh()

        XCTAssertFalse(model.snapshot.groups.isEmpty)
        XCTAssertEqual(
            model.snapshot.rows.filter { if case .turn = $0 { return true } else { return false } }.count,
            model.snapshot.groups.count,
            "every group must have a row, or it renders nowhere"
        )
    }

    @MainActor
    func testShouldRenderAPendingSendAsARowImmediately() async {
        // The exact shape of the Commander's report: banner says "Sending 1…" and the
        // transcript is empty. That can only happen if the pending message reaches
        // `pendingCount` without reaching `rows`.
        let model = makeModel()
        model.draft.text = "Can you create a reminder for me in 1 minute?"

        await model.send()

        XCTAssertEqual(model.snapshot.pendingCount, 1)
        XCTAssertFalse(
            model.snapshot.rows.isEmpty,
            "a message counted as pending must also be a row on screen"
        )
    }

    // MARK: - Blocks are sliced per turn, not handed out whole

    @MainActor
    func testShouldGiveEachTurnOnlyItsOwnParsedBlocks() async throws {
        // The row must not hold the transcript's markdown. SwiftUI compares a view's
        // stored values to decide whether to re-render it, so a row carrying the whole
        // map makes every update deep-compare every message — quadratic work on the main
        // thread, which the Commander experienced as the app freezing and then dying.
        try store.upsert([
            message(id: id(1), seq: 1, text: "# One"),
            message(id: id(2), seq: 2, text: "# Two"),
        ])
        let model = makeModel()

        await model.refresh()

        // Far enough apart to be separate turns, so each holds exactly one message.
        XCTAssertEqual(model.snapshot.groups.count, 2)
        let first = try XCTUnwrap(model.snapshot.groups.first)
        XCTAssertEqual(
            model.snapshot.blocks(forGroup: first.id),
            [[.heading(level: 1, text: "One")]],
            "a turn gets its own message's blocks and nobody else's"
        )
    }

    @MainActor
    func testShouldKeepBlocksInMessageOrderWithinATurn() async throws {
        // Positional: the view indexes by position, so an out-of-order slice would put
        // one message's words under another's.
        let base = instant("2026-08-09T07:00:03.114Z")
        try store.upsert([
            Message(
                id: id(1), conversationId: SylIDs.interactiveConversation, clientId: nil,
                role: .assistant, text: "# First", createdAt: base, seq: 1
            ),
            Message(
                id: id(2), conversationId: SylIDs.interactiveConversation, clientId: nil,
                role: .assistant, text: "# Second", createdAt: base.addingTimeInterval(5), seq: 2
            ),
        ])
        let model = makeModel()

        await model.refresh()

        let group = try XCTUnwrap(model.snapshot.groups.first)
        XCTAssertEqual(group.messages.count, 2, "one turn, both messages")
        XCTAssertEqual(
            model.snapshot.blocks(forGroup: group.id),
            [[.heading(level: 1, text: "First")], [.heading(level: 1, text: "Second")]]
        )
    }

    @MainActor
    func testShouldReturnNoBlocksForATurnItHasNeverSeen() async {
        let model = makeModel()

        XCTAssertEqual(model.snapshot.blocks(forGroup: id(99)), [])
    }

    // MARK: - Stalled sends and retry (T018)

    @MainActor
    func testShouldNotCallAQueuedTurnStalledWhileTheSocketIsUp() async throws {
        let model = makeModel()
        try store.upsert([message(id: "syl:message:0198f2c0-0001-7000-8000-00000000c001", seq: 1)])
        await model.apply(.connectionState(.connected))
        await model.refresh()

        let group = try XCTUnwrap(model.snapshot.groups.first)
        XCTAssertFalse(model.isStalled(group), "not pending, and connected")
    }

    @MainActor
    func testShouldCallAQueuedTurnStalledOnceTheSocketIsDown() async throws {
        let model = makeModel()
        model.draft.text = "Remind me at six."
        await model.send()
        await model.apply(.connectionState(.offline))

        let group = try XCTUnwrap(model.snapshot.groups.first)
        XCTAssertTrue(group.isPending)
        XCTAssertTrue(model.isStalled(group))
    }

    @MainActor
    func testShouldNotCryWolfWhileTheConnectionIsMerelyReconnecting() async throws {
        // A tailnet handoff is not a failure, and telling him to retry during one
        // trains him to ignore the warning that matters.
        let model = makeModel()
        model.draft.text = "Remind me at six."
        await model.send()
        await model.apply(.connectionState(.reconnecting(attempt: 1)))

        let group = try XCTUnwrap(model.snapshot.groups.first)
        XCTAssertFalse(model.isStalled(group))
    }

    @MainActor
    func testShouldRunTheOutboxWhenAskedToTryAgain() async {
        let flushed = Flag()
        let model = makeModel(flush: { await flushed.raise() })

        await model.retryQueued()

        let didFlush = await flushed.value
        XCTAssertTrue(didFlush)
        XCTAssertNil(model.notice)
    }

    // MARK: - Harness

    /// - Parameter limit: `nil` builds the model **exactly as `AppDelegate` does**, with
    ///   no window argument at all. That is the only shape in which a test can say
    ///   anything about the page size the Commander's phone actually uses; a harness
    ///   that always passes a limit can never disagree with the production default,
    ///   which is how a 200 sat opposite the server's 50 unnoticed.
    @MainActor
    private func makeModel(
        sendOverSocket: @escaping @Sendable (String, String, String) async throws -> Void = { _, _, _ in },
        flush: @escaping @Sendable () async -> Void = {},
        makeClientId: @escaping @Sendable () -> String = { UUID().uuidString },
        now: @escaping @Sendable () -> Date = { try! Instant.parse("2026-08-09T06:59:48.220Z") },
        limit: Int? = nil
    ) -> ChatViewModel {
        if let limit {
            return ChatViewModel(
                store: store,
                limit: limit,
                sendOverSocket: sendOverSocket,
                flush: flush,
                now: now,
                makeClientId: makeClientId,
                makeIdempotencyKey: { UUID().uuidString }
            )
        }
        return ChatViewModel(
            store: store,
            sendOverSocket: sendOverSocket,
            flush: flush,
            now: now,
            makeClientId: makeClientId,
            makeIdempotencyKey: { UUID().uuidString }
        )
    }

    /// A clock the test moves by hand.
    ///
    /// Presence decay is a function of elapsed time, and a test that waits for real
    /// seconds to pass is both slow and flaky. Advancing the clock lets the assertion
    /// be about the ladder rather than about a stopwatch. Lock-guarded because the
    /// view model's `now` is `@Sendable` and may be read off the main actor by the
    /// armed decay task.
    final class MutableClock: @unchecked Sendable {
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

    actor Flag {
        private(set) var value = false
        func raise() { value = true }
    }

    actor Counter {
        private(set) var value = 0
        func set(_ newValue: Int) { value = newValue }
    }

    private func message(id: SylID, seq: Int, text: String = "Done.") -> Message {
        Message(
            id: id,
            conversationId: SylIDs.interactiveConversation,
            clientId: nil,
            role: .assistant,
            text: text,
            // Spread far enough apart that grouping never merges them: these fixtures
            // are counted per MESSAGE, and a merged group would make a count assertion
            // pass or fail for reasons that have nothing to do with the window.
            createdAt: instant("2026-08-09T07:00:03.114Z")
                .addingTimeInterval(Double(seq) * (MessageGrouping.maximumGap + 1)),
            seq: seq
        )
    }

    /// A transcript far longer than any window that should ever be opened on it.
    ///
    /// Two thousand, because the assertion worth making is about the window and not
    /// about the fixture: at 2,000 the count is wrong by a factor of forty if the read
    /// is unbounded, and no page size anyone might reasonably choose can make an
    /// unbounded read look bounded.
    private func longConversation(_ count: Int = 2_000) -> [Message] {
        (1...count).map { message(id: id($0), seq: $0) }
    }

    /// A distinct, well-formed message id for an index.
    private func id(_ index: Int) -> SylID {
        "syl:message:0198f2c0-0001-7000-8000-\(String(format: "%012d", index))"
    }

    private func confirmation() -> DeliveryConfirmation {
        DeliveryConfirmation(
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            serverId: "syl:message:0198f2c0-0001-7000-8000-00000000b001",
            conversationId: SylIDs.interactiveConversation,
            seq: 1283,
            acceptedAt: instant("2026-08-09T06:59:48.220Z")
        )
    }

    private func instant(_ text: String) -> Date {
        try! Instant.parse(text)
    }
}
