import SylKit
import XCTest

@testable import Syl

/// The local-first store. Every test runs against an in-memory database, so none of
/// them touch the disk and none of them need a simulator's filesystem to behave.
final class LocalStoreTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!
    private var outbox: Outbox!

    override func setUpWithError() throws {
        try super.setUpWithError()
        database = try SylDatabase.inMemory()
        store = LocalStore(database: database)
        outbox = Outbox(database: database)
    }

    override func tearDown() {
        outbox = nil
        store = nil
        database = nil
        super.tearDown()
    }

    // MARK: - Rendering from disk

    func testShouldReturnMessagesOldestFirstWhichIsTheOrderAChatRendersIn() throws {
        try store.upsert([
            message(id: "syl:message:0198f2c0-0002-7000-8000-00000000b002", seq: 2, offset: 10),
            message(id: "syl:message:0198f2c0-0001-7000-8000-00000000b001", seq: 1, offset: 0),
        ])

        let messages = try store.messages(conversationId: SylIDs.interactiveConversation)

        XCTAssertEqual(messages.map(\.seq), [1, 2])
    }

    func testShouldReturnTheMostRecentMessagesWhenTheHistoryIsLongerThanTheWindow() throws {
        // The window exists to bound the read, and it must bound it from the RECENT
        // end. Ordering ascending and taking the first N returns the OLDEST N, which
        // means that past the window a conversation freezes: the screen shows the first
        // messages ever exchanged and nothing arriving is ever visible.
        try store.upsert((1...10).map {
            message(
                id: "syl:message:0198f2c0-0001-7000-8000-\(String(format: "%012d", $0))",
                seq: $0,
                offset: Double($0) * 60
            )
        })

        let messages = try store.messages(conversationId: SylIDs.interactiveConversation, limit: 3)

        XCTAssertEqual(messages.map(\.seq), [8, 9, 10], "the newest three, still oldest-first")
    }

    func testShouldReplaceARowRatherThanDuplicateItWhenTheSameMessageArrivesTwice() throws {
        // Sync pages overlap by design; a device that duplicated on re-delivery would
        // show the same message twice after every reconnect.
        let message = message(id: "syl:message:0198f2c0-0001-7000-8000-00000000b001", seq: 1)

        try store.upsert([message])
        try store.upsert([message])

        XCTAssertEqual(try store.messages(conversationId: SylIDs.interactiveConversation).count, 1)
    }

    func testShouldReportNoMessagesForAConversationItHasNeverSeen() throws {
        XCTAssertTrue(try store.messages(conversationId: "syl:conversation:unknown").isEmpty)
    }

    /// The upgrade case, and the reason `Message.attachments` decodes tolerantly.
    ///
    /// **This test is the reason, and it exists because a comment cannot fail a build.**
    ///
    /// `MessageRecord` stores the encoded `Message` as a payload blob, so the contract
    /// decoder reads this app's own disk and not only the wire. Every row written before
    /// `attachments` existed has no such key. `attachments` is *required* in the
    /// contract — the service always sends it — so tightening the decode to match looks
    /// like an obvious tidy-up, and it passes every other test in the suite, because
    /// every fixture already carries the key.
    ///
    /// What it actually does is this: `messages()` maps a whole window in one go, so a
    /// single row that throws takes the entire array with it, `refresh()` reports
    /// "Could not read the conversation from this device", and on upgrade day the
    /// Commander opens chat to find his whole history gone. Losing one bubble would be
    /// a degradation; losing the transcript is not.
    ///
    /// The row is written as raw SQL rather than through `upsert` on purpose — `upsert`
    /// encodes with today's encoder, which would put the key back and test nothing.
    func testShouldStillReadAConversationWrittenBeforeAttachmentsExisted() throws {
        let id: SylID = "syl:message:0198f2c0-0001-7000-8000-00000000b001"
        // The exact shape the encoder produced before this field was added. Written out
        // rather than derived, so a change to today's encoder cannot quietly rewrite
        // history and make this pass for the wrong reason.
        let legacyPayload = """
            {"id":"\(id)",\
            "conversationId":"\(SylIDs.interactiveConversation)",\
            "clientId":null,"role":"assistant","text":"Done.",\
            "createdAt":"2026-08-09T07:00:03.114Z","seq":1}
            """
        let hex = Data(legacyPayload.utf8).map { String(format: "%02x", $0) }.joined()

        try database.queue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO message
                        (id, conversationId, seq, createdAt, clientId, pending, payload)
                    VALUES
                        ('\(id)', '\(SylIDs.interactiveConversation)', 1,
                         '2026-08-09 07:00:03.114', NULL, 0, X'\(hex)')
                    """
            )
        }

        let messages = try store.messages(conversationId: SylIDs.interactiveConversation)

        XCTAssertEqual(messages.count, 1, "an old row must not take the transcript with it")
        XCTAssertEqual(messages.first?.text, "Done.")
        XCTAssertEqual(
            messages.first?.attachments,
            [],
            "a missing key reads as no attachments, which is what it meant when it was written"
        )
    }

    /// The other half of the same asymmetry: what goes back out always carries the key.
    ///
    /// Without this, "tolerant" could quietly become "optional in both directions", and
    /// the app would start sending the server the very shape the contract forbids.
    func testShouldWriteTheAttachmentsKeyBackEvenWhenThereAreNone() throws {
        let encoded = try SylJSON.encoder().encode(
            message(id: "syl:message:0198f2c0-0001-7000-8000-00000000b001", seq: 1)
        )

        XCTAssertTrue(
            String(decoding: encoded, as: UTF8.self).contains("\"attachments\":[]"),
            "a client must never make the server guess between 'none' and 'not sent'"
        )
    }

    func testShouldTrackTheHighestConversationSequenceItHolds() throws {
        try store.upsert([
            message(id: "syl:message:0198f2c0-0001-7000-8000-00000000b001", seq: 1),
            message(id: "syl:message:0198f2c0-0002-7000-8000-00000000b002", seq: 9),
        ])

        XCTAssertEqual(
            try store.highestMessageSeq(conversationId: SylIDs.interactiveConversation),
            9
        )
    }

    func testShouldOrderUpcomingRemindersBySoonestFirstAndSkipClosedOnes() throws {
        let now = instant("2026-08-09T07:00:00.000Z")
        try store.upsert([
            reminder(id: "syl:reminder:0198f2c1-0001-7d21-9f00-1a2b3c4d5e01", fireOffset: 7200),
            reminder(id: "syl:reminder:0198f2c1-0002-7d21-9f00-1a2b3c4d5e02", fireOffset: 60),
            reminder(
                id: "syl:reminder:0198f2c1-0003-7d21-9f00-1a2b3c4d5e03",
                fireOffset: 30,
                state: .cancelled
            ),
        ])

        let upcoming = try store.upcomingReminders(after: now)

        XCTAssertEqual(
            upcoming.map(\.id),
            [
                "syl:reminder:0198f2c1-0002-7d21-9f00-1a2b3c4d5e02",
                "syl:reminder:0198f2c1-0001-7d21-9f00-1a2b3c4d5e01",
            ]
        )
    }

    func testShouldPutPinnedTodosFirst() throws {
        // The one durable bit of "this one matters". There is no priority ladder.
        try store.upsert([
            todo(id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001", pinned: false),
            todo(id: "syl:todo:0198f2c2-0002-7000-8000-00000000c002", pinned: true),
        ])

        XCTAssertEqual(
            try store.openTodos().first?.id,
            "syl:todo:0198f2c2-0002-7000-8000-00000000c002"
        )
    }

    /// The case that decided the rule, and the one nobody had written down.
    ///
    /// `pinned` is an **elevator, not an override**. Pin "call the roofer", which has no
    /// date, and pinned-first puts it above "submit the taxes" due in two hours — that is
    /// not the list saying *this one matters*, it is the list lying about what is urgent.
    ///
    /// Proposal B calls `pinned` durable and never calls it more important than a
    /// deadline; its whole argument for computing order rather than storing it is that
    /// urgency belongs to the moment.
    ///
    /// This existed as a disagreement between the SQL here and `TodoOrdering` — read as
    /// correct in both files and wrong on screen, which is the worst kind of defect this
    /// project produces, because every test passes. Decided 2026-08-10.
    func testShouldRankADeadlineAboveAPin() throws {
        try store.upsert([
            todo(id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001", pinned: true, dueAt: nil),
            todo(
                id: "syl:todo:0198f2c2-0002-7000-8000-00000000c002",
                pinned: false,
                dueAt: instant("2026-08-09T08:00:00.000Z")
            ),
        ])

        XCTAssertEqual(
            try store.openTodos().map(\.id),
            [
                "syl:todo:0198f2c2-0002-7000-8000-00000000c002",
                "syl:todo:0198f2c2-0001-7000-8000-00000000c001",
            ],
            "a pin lifts a to-do above other undated ones, not above something actually due"
        )
    }

    func testShouldReportTodosTheServerHasNotAcknowledged() throws {
        // So a view can disable completion WITH A REASON rather than offering a control
        // that refuses on contact. A capture has no clientId in the contract, so
        // `pendingKey` is the only thing tying the optimistic row to its intent.
        let captured = try store.createTodo(
            text: "Call the roofer",
            idempotencyKey: "k-1",
            now: instant("2026-08-09T07:00:00.000Z")
        )

        XCTAssertEqual(try store.unsyncedTodoIDs(), [captured.id])
    }

    /// A regression. `openTodos` ordered on `dueAt` alone, and SQLite puts NULLs first —
    /// so every undated to-do sorted above the one due in an hour, which is exactly
    /// backwards for this question. The server's `todos_agenda_idx` says so in its own
    /// comment; the client had the same rule and not the same ordering.
    ///
    /// It was invisible because the only ordering test here had two undated rows.
    func testShouldSortAnUndatedTodoAfterEveryDatedOne() throws {
        try store.upsert([
            todo(id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001", pinned: false, dueAt: nil),
            todo(
                id: "syl:todo:0198f2c2-0002-7000-8000-00000000c002",
                pinned: false,
                dueAt: instant("2026-08-09T08:00:00.000Z")
            ),
        ])

        XCTAssertEqual(
            try store.openTodos().map(\.id),
            [
                "syl:todo:0198f2c2-0002-7000-8000-00000000c002",
                "syl:todo:0198f2c2-0001-7000-8000-00000000c001",
            ],
            "a to-do with no deadline is not more urgent than one due today"
        )
    }

    // MARK: - Optimistic send

    func testShouldRenderTheBubbleAndQueueTheIntentInOneStep() throws {
        // A pending bubble with no outbox row is a message that will never be sent; an
        // outbox row with no bubble is a message he cannot see he sent.
        let optimistic = try store.enqueueSend(
            conversationId: SylIDs.interactiveConversation,
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            idempotencyKey: "9f2c41d8-b7e0-4a6f-8c1d-3e5a7b9c0d2e",
            text: "Remind me to call the pharmacy at 4 today.",
            now: instant("2026-08-09T06:59:48.220Z")
        )

        XCTAssertEqual(optimistic.id, "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44")
        XCTAssertEqual(optimistic.seq, 0, "the server has not given it a position yet")
        XCTAssertEqual(try store.pendingMessages().count, 1)
        XCTAssertEqual(try outbox.count(), 1)
    }

    func testShouldNotQueueASecondIntentForADoubleTap() throws {
        // The idempotency key is UNIQUE in the schema. Queueing the same intent twice
        // is a no-op at the database level rather than a rule anyone has to remember.
        for _ in 0..<2 {
            _ = try store.enqueueSend(
                conversationId: SylIDs.interactiveConversation,
                clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
                idempotencyKey: "9f2c41d8-b7e0-4a6f-8c1d-3e5a7b9c0d2e",
                text: "Remind me to call the pharmacy at 4 today.",
                now: instant("2026-08-09T06:59:48.220Z")
            )
        }

        XCTAssertEqual(try outbox.count(), 1)
        XCTAssertEqual(try store.pendingMessages().count, 1)
    }

    func testShouldSwapTheOptimisticRowForTheServersCopyOnConfirmation() throws {
        _ = try store.enqueueSend(
            conversationId: SylIDs.interactiveConversation,
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            idempotencyKey: "key-12345678",
            text: "Remind me to call the pharmacy at 4 today.",
            now: instant("2026-08-09T06:59:48.220Z")
        )

        let reconciled = try store.reconcile(confirmation())

        XCTAssertTrue(reconciled)
        XCTAssertTrue(try store.pendingMessages().isEmpty)
        let messages = try store.messages(conversationId: SylIDs.interactiveConversation)
        XCTAssertEqual(messages.count, 1, "one message, not two")
        XCTAssertEqual(messages.first?.id, "syl:message:0198f2c0-0001-7000-8000-00000000b001")
        XCTAssertEqual(messages.first?.seq, 1283)
    }

    func testShouldKeepTheTextAndTimestampFromTheOptimisticRow() throws {
        // The confirmation carries ids and a sequence, not content. Losing the text
        // here would blank the bubble the instant the server answered.
        _ = try store.enqueueSend(
            conversationId: SylIDs.interactiveConversation,
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            idempotencyKey: "key-12345678",
            text: "Remind me to call the pharmacy at 4 today.",
            now: instant("2026-08-09T06:59:48.220Z")
        )

        try store.reconcile(confirmation())

        let message = try XCTUnwrap(
            try store.messages(conversationId: SylIDs.interactiveConversation).first
        )
        XCTAssertEqual(message.text, "Remind me to call the pharmacy at 4 today.")
        XCTAssertEqual(message.role, .user)
    }

    func testShouldReportNothingToReconcileWhenTheConfirmationIsForAnotherDevice() throws {
        // A reinstall, or a confirmation replayed from the socket after the pending row
        // was already resolved. Not an error.
        XCTAssertFalse(try store.reconcile(confirmation()))
    }

    // MARK: - Sync position

    func testShouldKeepTheTwoSyncPositionsApart() throws {
        // `cursor` survives a reinstall; `lastFrameSeq` survives one reconnect. Feeding
        // one to the other makes the client either replay everything or silently
        // believe it is caught up.
        try store.setCursor("eyJhdCI6IjIwMjYtMDgtMDlUMDc6MDA6MDMuMTE0WiJ9")
        try store.setLastFrameSeq(4488, serverEpoch: nil)

        let state = try store.syncState()

        XCTAssertEqual(state.cursor, "eyJhdCI6IjIwMjYtMDgtMDlUMDc6MDA6MDMuMTE0WiJ9")
        XCTAssertEqual(state.lastFrameSeq, 4488)
    }

    func testShouldStartWithNoCursorSoTheFirstSyncIsABootstrap() throws {
        let state = try store.syncState()

        XCTAssertNil(state.cursor)
        XCTAssertEqual(state.lastFrameSeq, 0)
        XCTAssertNil(state.serverEpoch)
    }

    func testShouldStoreTheServerRunTheFrameSequenceCameFrom() throws {
        // `syl-47j`. A frame sequence is only meaningful inside one run of the
        // server, and this is the only number in the app that outlives a launch. Kept
        // without the run it belongs to, it is restored on the next launch and
        // compared against a stream that never issued it.
        try store.setLastFrameSeq(4488, serverEpoch: "boot-a")

        let state = try store.syncState()

        XCTAssertEqual(state.lastFrameSeq, 4488)
        XCTAssertEqual(state.serverEpoch, "boot-a")
    }

    func testShouldWriteTheSequenceAndItsRunInOneGoSoTheyCannotDisagree() throws {
        // Two writes would leave a window in which the mark belongs to a run the row
        // does not name — which is precisely the state this field exists to prevent.
        try store.setLastFrameSeq(4488, serverEpoch: "boot-a")
        try store.setLastFrameSeq(3, serverEpoch: "boot-b")

        let state = try store.syncState()

        XCTAssertEqual(state.lastFrameSeq, 3, "the mark goes backwards across a restart")
        XCTAssertEqual(state.serverEpoch, "boot-b")
    }

    func testShouldLeaveTheCursorAloneWhenWritingTheFrameSequence() throws {
        // The sync engine writes the cursor from its own actor while the socket pump
        // writes the frame position. A read-then-write-the-whole-row would roll one
        // of them back.
        try store.setCursor("eyJhdCI6IjIwMjYtMDgtMDlUMDc6MDA6MDMuMTE0WiJ9")

        try store.setLastFrameSeq(12, serverEpoch: "boot-a")

        XCTAssertEqual(try store.syncState().cursor, "eyJhdCI6IjIwMjYtMDgtMDlUMDc6MDA6MDMuMTE0WiJ9")
    }

    // MARK: - Deletes

    func testShouldRemoveARowOnADeleteChange() throws {
        try store.upsert([todo(id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001", pinned: false)])

        try store.delete(type: .todo, id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001")

        XCTAssertTrue(try store.openTodos().isEmpty)
    }

    func testShouldIgnoreADeleteForAResourceTypeTheDeviceDoesNotStore() throws {
        // Devices and deliveries are the service's business, not the phone's.
        // Skipping is correct, not a gap.
        //
        // `.job` and `.run` stood here until `syl-020`: they are no longer sync
        // resources at all, so there is no longer a case to skip. Jobs and runs remain
        // the admin surface's business and it still reads them live from `/jobs` and
        // `/runs` — what changed is that they stopped being written to a change feed
        // no client ever stored one from.
        XCTAssertNil(LocalStore.tableName(for: .device))
        XCTAssertNoThrow(try store.delete(type: .device, id: "syl:device:whatever"))
    }

    // MARK: - Migrations

    func testShouldMigrateAFreshDatabaseCleanly() throws {
        let fresh = try SylDatabase.inMemory()

        let tables = try fresh.queue.read { db in
            try Set(
                String.fetchAll(db, sql: "SELECT name FROM sqlite_master WHERE type = 'table'")
            )
        }

        for expected in ["conversation", "message", "reminder", "todo", "outbox", "syncState"] {
            XCTAssertTrue(tables.contains(expected), "missing table \(expected)")
        }
    }

    func testShouldBeIdempotentWhenMigratedTwice() throws {
        XCTAssertNoThrow(try SylDatabase.migrator.migrate(database.queue))
    }

    // MARK: - Builders

    private func message(id: SylID, seq: Int, offset: TimeInterval = 0) -> Message {
        Message(
            id: id,
            conversationId: SylIDs.interactiveConversation,
            clientId: nil,
            role: .assistant,
            text: "Done.",
            createdAt: instant("2026-08-09T07:00:03.114Z").addingTimeInterval(offset),
            seq: seq
        )
    }

    private func reminder(
        id: SylID,
        fireOffset: TimeInterval,
        state: ReminderDeliveryState = .scheduled
    ) -> Reminder {
        let base = instant("2026-08-09T07:00:00.000Z")
        return Reminder(
            id: id,
            kind: .commitment,
            text: "Call the pharmacy.",
            todoId: nil,
            eventId: nil,
            wallTime: "16:00",
            tz: "America/Chicago",
            rrule: nil,
            scheduledFor: base.addingTimeInterval(fireOffset),
            nextFireAt: base.addingTimeInterval(fireOffset),
            urgent: false,
            late: false,
            deferredFrom: nil,
            supersedesPrevious: false,
            deliveryState: state,
            createdAt: base,
            updatedAt: base,
            completedAt: nil
        )
    }

    private func todo(id: SylID, pinned: Bool, dueAt: Date? = nil) -> Todo {
        let base = instant("2026-08-09T06:59:48.300Z")
        return Todo(
            id: id,
            text: "Call the pharmacy about the refill",
            goalId: nil,
            dueAt: dueAt,
            pinned: pinned,
            status: .open,
            source: .commander,
            delegatedJobId: nil,
            createdAt: base,
            updatedAt: base,
            completedAt: nil
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

    // MARK: - Reaching past the device (syl-025.4.2)
    //
    // Every fixture here is LARGER than the page it is read with. A bounded read tested
    // only with unbounded data is untested — under a fixture that fits, taking the page
    // from the wrong end returns the identical result, which is precisely how the head
    // read shipped ascending and froze the transcript on the first messages ever
    // exchanged. The same mistake is available one query along and this is the shape
    // that catches it.

    /// A conversation of `count` confirmed messages, seq 1...count, a minute apart.
    private func history(_ count: Int) throws {
        try store.upsert(
            (1...count).map {
                message(
                    id: "syl:message:0198f2c0-0001-7000-8000-\(String(format: "%012d", $0))",
                    seq: $0,
                    offset: Double($0) * 60
                )
            }
        )
    }

    func testShouldTakeTheOlderPageFromTheEndNEARESTTheCursorNotTheStartOfHistory() throws {
        // The whole question. The page wanted is the one adjacent to the cursor. Taking
        // it ascending returns the oldest rows in the conversation instead — identical
        // under a short history, and past it every "load earlier" hands back the same
        // first page forever.
        try history(30)

        let page = try store.messages(
            conversationId: SylIDs.interactiveConversation,
            olderThan: 20,
            limit: 5
        )

        XCTAssertEqual(
            page.map(\.seq),
            [15, 16, 17, 18, 19],
            "the five immediately before the cursor, still oldest-first — not seq 1...5"
        )
    }

    func testShouldWalkTheWholeHistoryExactlyOncePageByPage() throws {
        try history(30)

        var seen: [Int] = []
        var cursor = 31
        for _ in 0..<20 {
            let page = try store.messages(
                conversationId: SylIDs.interactiveConversation,
                olderThan: cursor,
                limit: 7
            )
            guard let oldest = page.first?.seq else { break }
            seen.insert(contentsOf: page.map(\.seq), at: 0)
            cursor = oldest
        }

        XCTAssertEqual(seen, Array(1...30), "every message once, in order, no gaps and no repeats")
    }

    func testShouldNotDragThePendingBubbleOntoTheBeginningOfHistory() throws {
        // An optimistic row carries seq 0, so it is older than EVERY cursor. Without the
        // guard the message he just typed is dragged in as the oldest thing in the
        // conversation, while still sitting at the foot of the transcript — the same
        // bubble rendered twice, once where he sent it and once before the first message
        // ever exchanged.
        //
        // **The cursor has to be low enough that the page is not full**, and getting
        // that wrong is how this test first failed to test anything. At `olderThan: 10`
        // with a page of 5, `ORDER BY seq DESC` takes seqs 9 down to 5 and the seq 0 row
        // sorts below all of them — the limit hides it, and removing the guard changes
        // nothing. It bites only where fewer than a full page lies below the cursor,
        // which is the LAST page he loads: the one that reveals the true beginning, and
        // the one the terminal state of the earlier control is read from.
        try history(30)
        _ = try store.enqueueSend(
            conversationId: SylIDs.interactiveConversation,
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            idempotencyKey: "9f2c41d8-b7e0-4a6f-8c1d-3e5a7b9c0d2e",
            text: "Remind me to call the pharmacy at 4 today.",
            now: instant("2026-08-09T09:00:00.000Z")
        )

        let page = try store.messages(
            conversationId: SylIDs.interactiveConversation,
            olderThan: 4,
            limit: 5
        )

        XCTAssertEqual(page.map(\.seq), [1, 2, 3], "the beginning, and only the beginning")
        XCTAssertFalse(page.contains { $0.seq == 0 }, "seq 0 is no position, not the oldest one")
    }

    func testShouldReportNothingOlderThanTheFirstMessageEvenWhileASendIsPending() throws {
        // The same guard at the boundary that matters most: `olderThan: 1` with a
        // pending row present. Without the guard this answers "there is one more, and it
        // is the message you are currently sending" — which would put his own unsent
        // words before the first thing either of them ever said.
        try history(30)
        _ = try store.enqueueSend(
            conversationId: SylIDs.interactiveConversation,
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            idempotencyKey: "9f2c41d8-b7e0-4a6f-8c1d-3e5a7b9c0d2e",
            text: "Remind me to call the pharmacy at 4 today.",
            now: instant("2026-08-09T09:00:00.000Z")
        )

        XCTAssertTrue(
            try store.messages(
                conversationId: SylIDs.interactiveConversation,
                olderThan: 1,
                limit: 5
            ).isEmpty,
            "nothing precedes the first message, least of all one he has not sent yet"
        )
    }

    func testShouldReportNoOlderPageAtTheBeginningRatherThanWrappingAround() throws {
        try history(30)

        XCTAssertTrue(
            try store.messages(
                conversationId: SylIDs.interactiveConversation,
                olderThan: 1,
                limit: 5
            ).isEmpty,
            "nothing precedes the first message"
        )
    }

    func testShouldIgnoreThePendingRowWhenReportingTheOldestSeqItHolds() throws {
        try history(30)
        _ = try store.enqueueSend(
            conversationId: SylIDs.interactiveConversation,
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            idempotencyKey: "9f2c41d8-b7e0-4a6f-8c1d-3e5a7b9c0d2e",
            text: "Remind me to call the pharmacy at 4 today.",
            now: instant("2026-08-09T09:00:00.000Z")
        )

        XCTAssertEqual(
            try store.oldestMessageSeq(conversationId: SylIDs.interactiveConversation),
            1,
            "a cursor of 0 would ask the server for everything before the message he is sending"
        )
    }

    func testShouldTellNeverAskedApartFromNothingIsOlder() throws {
        // The distinction the whole marker exists for. Both present as "the local window
        // has run out"; one means ask the server, the other means show him an ending.
        try history(30)

        XCTAssertNil(
            try store.historyFloor(conversationId: SylIDs.interactiveConversation),
            "nobody has asked yet"
        )
        XCTAssertFalse(try store.hasWholeHistory(conversationId: SylIDs.interactiveConversation))

        try store.confirmHistoryBegins(at: 1, conversationId: SylIDs.interactiveConversation)

        XCTAssertEqual(try store.historyFloor(conversationId: SylIDs.interactiveConversation), 1)
        XCTAssertTrue(try store.hasWholeHistory(conversationId: SylIDs.interactiveConversation))
    }

    func testShouldNotClaimTheWholeHistoryWhileRowsBelowTheFloorAreStillMissing() throws {
        // A confirmation says where the beginning IS, not that the device has reached
        // it. Both halves are load-bearing, and this is the half a Bool would lose.
        try store.upsert([
            message(id: "syl:message:0198f2c0-0001-7000-8000-000000000020", seq: 20, offset: 60),
            message(id: "syl:message:0198f2c0-0001-7000-8000-000000000021", seq: 21, offset: 120),
        ])

        try store.confirmHistoryBegins(at: 1, conversationId: SylIDs.interactiveConversation)

        XCTAssertEqual(try store.historyFloor(conversationId: SylIDs.interactiveConversation), 1)
        XCTAssertFalse(
            try store.hasWholeHistory(conversationId: SylIDs.interactiveConversation),
            "history begins at 1 and the oldest row held is 20 — there is more to fetch"
        )
    }

    func testShouldSurviveTheMarkerOutlivingTheMessagesItDescribes() throws {
        // The device is cleared but the marker stands. Answering "yes, whole history"
        // for an empty conversation would show an ending over nothing at all.
        try store.confirmHistoryBegins(at: 1, conversationId: SylIDs.interactiveConversation)

        XCTAssertFalse(try store.hasWholeHistory(conversationId: SylIDs.interactiveConversation))
    }

    func testShouldKeepTheDeepestFloorAnyoneHasEverConfirmed() throws {
        // Two runs can confirm different depths. A later, shallower answer that won
        // would claim history had been lost — the system does not get to quietly
        // discard things.
        try history(30)

        try store.confirmHistoryBegins(at: 1, conversationId: SylIDs.interactiveConversation)
        try store.confirmHistoryBegins(at: 12, conversationId: SylIDs.interactiveConversation)

        XCTAssertEqual(
            try store.historyFloor(conversationId: SylIDs.interactiveConversation),
            1,
            "the deepest answer anyone has had, not the most recent one"
        )
    }

    func testShouldRefuseToRecordAPendingRowsSeqAsTheBeginningOfAConversation() throws {
        try history(30)

        try store.confirmHistoryBegins(at: 0, conversationId: SylIDs.interactiveConversation)

        XCTAssertNil(
            try store.historyFloor(conversationId: SylIDs.interactiveConversation),
            "seq 0 is the absence of a position; it can never be where history begins"
        )
    }

    func testShouldKeepEachConversationsFloorToItself() throws {
        let other: SylID = "syl:conversation:0198f2c0-0009-7000-8000-00000000c001"
        try history(30)

        try store.confirmHistoryBegins(at: 1, conversationId: SylIDs.interactiveConversation)

        XCTAssertNil(try store.historyFloor(conversationId: other))
        XCTAssertFalse(try store.hasWholeHistory(conversationId: other))
    }

    private func instant(_ text: String) -> Date {
        // A literal from the contract; a failure here is a broken fixture, not a
        // runtime condition.
        try! Instant.parse(text)
    }
}
