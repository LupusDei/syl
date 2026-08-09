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
        model.draft = "Remind me to call the pharmacy at 4 today."

        await model.send()

        XCTAssertEqual(model.snapshot.groups.count, 1)
        XCTAssertTrue(model.snapshot.groups.first?.isPending == true)
        XCTAssertEqual(model.snapshot.pendingCount, 1)
        XCTAssertEqual(try Outbox(database: database).count(), 1)
    }

    @MainActor
    func testShouldClearTheDraftOnceTheMessageIsQueued() async {
        let model = makeModel()
        model.draft = "Hello."

        await model.send()

        XCTAssertEqual(model.draft, "")
    }

    @MainActor
    func testShouldIgnoreAnEmptyOrWhitespaceOnlyDraft() async throws {
        let model = makeModel()
        model.draft = "   \n "

        await model.send()

        XCTAssertEqual(try Outbox(database: database).count(), 0)
        XCTAssertEqual(model.draft, "   \n ")
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
        model.draft = "Hello."

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
        model.draft = "Hello."

        await model.send()

        let pendingAtSendTime = await observed.value
        XCTAssertEqual(pendingAtSendTime, 1)
    }

    // MARK: - Reconciliation

    @MainActor
    func testShouldReplaceThePendingBubbleWhenTheSocketConfirms() async throws {
        let model = makeModel(makeClientId: { "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44" })
        model.draft = "Remind me to call the pharmacy at 4 today."
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
        model.draft = "Hello."
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

    // MARK: - Harness

    @MainActor
    private func makeModel(
        sendOverSocket: @escaping @Sendable (String, String, String) async throws -> Void = { _, _, _ in },
        flush: @escaping @Sendable () async -> Void = {},
        makeClientId: @escaping @Sendable () -> String = { UUID().uuidString }
    ) -> ChatViewModel {
        ChatViewModel(
            store: store,
            sendOverSocket: sendOverSocket,
            flush: flush,
            now: { try! Instant.parse("2026-08-09T06:59:48.220Z") },
            makeClientId: makeClientId,
            makeIdempotencyKey: { UUID().uuidString }
        )
    }

    actor Flag {
        private(set) var value = false
        func raise() { value = true }
    }

    actor Counter {
        private(set) var value = 0
        func set(_ newValue: Int) { value = newValue }
    }

    private func message(id: SylID, seq: Int) -> Message {
        Message(
            id: id,
            conversationId: SylIDs.interactiveConversation,
            clientId: nil,
            role: .assistant,
            text: "Done.",
            createdAt: instant("2026-08-09T07:00:03.114Z"),
            seq: seq
        )
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
