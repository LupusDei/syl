import SylKit
import XCTest

@testable import Syl

/// The sync state machine: push outbox, pull since cursor, reconcile, ack.
///
/// The gateway is two closures, so none of this needs a network, a `URLSession` or a
/// server — which matters, because the interesting failures here are all about
/// ordering and about what happens when a call fails.
final class SyncEngineTests: XCTestCase {
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

    // MARK: - Push

    func testShouldSendEveryQueuedIntentAndClearTheQueue() async throws {
        try enqueueSend(clientId: "c1", key: "key-00000001")
        try enqueueSend(clientId: "c2", key: "key-00000002")
        let recorder = Recorder()

        let report = await makeEngine(
            push: { record in
                await recorder.record(record.idempotencyKey)
                return .done
            }
        ).synchronise()

        XCTAssertEqual(report.pushed, 2)
        XCTAssertEqual(try outbox.count(), 0)
        let sent = await recorder.values
        XCTAssertEqual(sent, ["key-00000001", "key-00000002"], "oldest first — he acted in that order")
    }

    func testShouldReuseTheStoredIdempotencyKeyRatherThanMintingAFreshOne() async throws {
        // A key regenerated per attempt is the same as having no key at all: the
        // server sees a new operation and does the work twice.
        try enqueueSend(clientId: "c1", key: "key-00000001")
        let recorder = Recorder()
        let engine = makeEngine(
            push: { record in
                await recorder.record(record.idempotencyKey)
                throw APIError.transport(code: .timedOut, description: "")
            }
        )

        _ = await engine.synchronise()
        _ = await engine.synchronise()

        let keys = await recorder.values
        XCTAssertEqual(keys, ["key-00000001", "key-00000001"])
    }

    func testShouldReconcileTheOptimisticBubbleWhenAMessageIsConfirmed() async throws {
        try enqueueSend(clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44", key: "key-00000001")
        let confirmation = confirmation()

        _ = await makeEngine(push: { _ in .confirmed(confirmation) }).synchronise()

        XCTAssertTrue(try store.pendingMessages().isEmpty)
        XCTAssertEqual(
            try store.messages(conversationId: SylIDs.interactiveConversation).first?.id,
            "syl:message:0198f2c0-0001-7000-8000-00000000b001"
        )
    }

    func testShouldKeepAnIntentQueuedWhenTheServerIsUnreachable() async throws {
        // The Mac is rebooting or the tunnel is down. A dropped intent is the failure
        // this whole mechanism exists to prevent.
        try enqueueSend(clientId: "c1", key: "key-00000001")

        let report = await makeEngine(
            push: { _ in throw APIError.transport(code: .cannotConnectToHost, description: "") }
        ).synchronise()

        XCTAssertEqual(report.deferred, 1)
        XCTAssertEqual(try outbox.count(), 1)
        XCTAssertEqual(try outbox.pending().first?.attempts, 1)
    }

    func testShouldStopPushingAtTheFirstRecoverableFailureToPreserveOrder() async throws {
        // Pushing past a stuck row would deliver his actions out of the order he did
        // them in.
        try enqueueSend(clientId: "c1", key: "key-00000001")
        try enqueueSend(clientId: "c2", key: "key-00000002")
        let recorder = Recorder()

        _ = await makeEngine(
            push: { record in
                await recorder.record(record.idempotencyKey)
                throw APIError.transport(code: .timedOut, description: "")
            }
        ).synchronise()

        let attempted = await recorder.values
        XCTAssertEqual(attempted, ["key-00000001"])
        XCTAssertEqual(try outbox.count(), 2)
    }

    func testShouldAbandonAnIntentThatCanNeverSucceed() async throws {
        // A validation failure fails identically forever, and leaving it at the head
        // of the queue blocks everything behind it.
        try enqueueSend(clientId: "c1", key: "key-00000001")
        try enqueueSend(clientId: "c2", key: "key-00000002")

        let report = await makeEngine(
            push: { record in
                guard record.idempotencyKey == "key-00000001" else { return .done }
                throw APIError.api(
                    ApiError(code: .validationFailed, message: "no", retryable: false),
                    status: 422
                )
            }
        ).synchronise()

        XCTAssertEqual(report.abandoned, 1)
        XCTAssertEqual(report.pushed, 1, "the queue kept moving")
        XCTAssertEqual(try outbox.count(), 0)
    }

    func testShouldKeepAnIntentQueuedWhenTheTokenExpired() async throws {
        // The intent is fine; the token is not. Discarding the Commander's message
        // because a token expired would be the worst possible response.
        try enqueueSend(clientId: "c1", key: "key-00000001")

        _ = await makeEngine(
            push: { _ in
                throw APIError.api(
                    ApiError(code: .unauthorized, message: "expired", retryable: false),
                    status: 401
                )
            }
        ).synchronise()

        XCTAssertEqual(try outbox.count(), 1)
    }

    // MARK: - Writes after an ambiguous failure

    func testShouldRetryASnoozeAfterAnAmbiguousFailureNowThatTheServerDeduplicates() async throws {
        // This used to park. `Idempotency-Key` was in the contract for every write but
        // only message sends honoured it, so a retried snooze deferred the reminder by
        // another fifteen minutes and the client had to refuse to try. `syl-ux1` put
        // every implemented write through the server's ledger, so the retry replays the
        // stored answer and the workaround is retired.
        try enqueueSnooze(key: "key-00000001")

        let report = await makeEngine(
            push: { _ in throw APIError.transport(code: .timedOut, description: "timed out") }
        ).synchronise()

        XCTAssertEqual(report.blocked, 0)
        XCTAssertEqual(report.deferred, 1)
        XCTAssertEqual(try outbox.pending().count, 1, "retried, carrying the same key")
        XCTAssertEqual(try outbox.blocked().count, 0)
    }

    func testShouldStillParkAnIntentThatIsDeclaredUnsafeToReplay() async throws {
        // The parking machinery is not deleted just because nothing currently reaches
        // it. It is the honest response if a future write forgets the ledger, so it
        // stays covered: parked means neither retried nor dropped.
        try enqueueSnooze(key: "key-00000001")
        let record = try XCTUnwrap(try outbox.pending().first)

        try outbox.block(record, reason: "may already have taken effect")

        XCTAssertEqual(try outbox.pending().count, 0, "not retried")
        XCTAssertEqual(try outbox.blocked().count, 1, "and not dropped either")
    }

    func testShouldRetryASnoozeWhenTheRequestProvablyNeverLeftTheDevice() async throws {
        // Nothing was received, so nothing can have been applied twice.
        try enqueueSnooze(key: "key-00000001")

        let report = await makeEngine(
            push: { _ in throw APIError.transport(code: .cannotConnectToHost, description: "") }
        ).synchronise()

        XCTAssertEqual(report.blocked, 0)
        XCTAssertEqual(report.deferred, 1)
        XCTAssertEqual(try outbox.pending().count, 1)
    }

    func testShouldStillRetryAMessageAfterAnAmbiguousFailure() async throws {
        // Message sends are deduplicated by the clientId unique index as well as by
        // the ledger, so a replay is safe and the bubble must not hang pending forever.
        try enqueueSend(clientId: "c1", key: "key-00000001")

        let report = await makeEngine(
            push: { _ in throw APIError.transport(code: .timedOut, description: "") }
        ).synchronise()

        XCTAssertEqual(report.blocked, 0)
        XCTAssertEqual(try outbox.pending().count, 1)
    }

    func testShouldTreatEveryIntentAsSafeToReplayBlind() {
        // Every kind, and the list is exhaustive on purpose: a new kind added without
        // an idempotency story fails this test rather than quietly duplicating.
        for kind in OutboxRecord.Kind.allCases {
            XCTAssertTrue(
                kind.isSafeToReplayBlind,
                "\(kind.rawValue) must survive a retry — every implemented write now "
                    + "goes through the server's idempotency ledger (syl-ux1)"
            )
        }
    }

    func testShouldClassifyPermanentAndRecoverableFailuresApart() {
        XCTAssertTrue(
            SyncEngine.isPermanent(
                .api(ApiError(code: .validationFailed, message: "", retryable: false), status: 422))
        )
        XCTAssertTrue(
            SyncEngine.isPermanent(
                .api(ApiError(code: .deferralNotLater, message: "", retryable: false), status: 422))
        )
        XCTAssertFalse(
            SyncEngine.isPermanent(
                .api(ApiError(code: .unauthorized, message: "", retryable: false), status: 401))
        )
        XCTAssertFalse(SyncEngine.isPermanent(.transport(code: .timedOut, description: "")))
        XCTAssertFalse(
            SyncEngine.isPermanent(
                .api(ApiError(code: .rateLimited, message: "", retryable: true), status: 429))
        )
    }

    // MARK: - Pull

    func testShouldApplyEveryChangeInAPageAndAdvanceTheCursor() async throws {
        let response = SyncResponse(
            cursor: "cursor-2",
            hasMore: false,
            changes: [
                upsertChange(type: .todo, id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001"),
                upsertChange(type: .reminder, id: "syl:reminder:0198f2c1-0001-7d21-9f00-1a2b3c4d5e01"),
            ],
            serverTime: instant("2026-08-09T07:00:05.000Z")
        )

        let report = await makeEngine(pull: { _ in response }).synchronise()

        XCTAssertEqual(report.changesApplied, 2)
        XCTAssertEqual(try store.syncState().cursor, "cursor-2")
        XCTAssertEqual(try store.openTodos().count, 1)
    }

    func testShouldKeepPagingWhileTheServerSaysThereIsMore() async throws {
        // A device back from a week away pages.
        let pages = PageSource(
            pages: [
                (cursor: "c1", hasMore: true),
                (cursor: "c2", hasMore: true),
                (cursor: "c3", hasMore: false),
            ],
            serverTime: instant("2026-08-09T07:00:05.000Z")
        )

        let report = await makeEngine(pull: { since in await pages.next(since: since) })
            .synchronise()

        XCTAssertEqual(report.pagesPulled, 3)
        XCTAssertFalse(report.hasMore)
        XCTAssertEqual(try store.syncState().cursor, "c3")
        let cursors = await pages.cursorsSeen
        XCTAssertEqual(
            cursors,
            [nil, "c1", "c2"],
            "each page must be asked for from where the previous one ended"
        )
    }

    func testShouldStopAtThePageCeilingAndSayThereIsMore() async throws {
        // A week of history must not block the app for a minute on launch. The cursor
        // is written after every page, so the next run resumes rather than restarting.
        let pages = PageSource(
            pages: Array(repeating: (cursor: "c", hasMore: true), count: 20),
            serverTime: instant("2026-08-09T07:00:05.000Z")
        )

        let report = await makeEngine(
            pull: { since in await pages.next(since: since) },
            maxPagesPerRun: 3
        ).synchronise()

        XCTAssertEqual(report.pagesPulled, 3)
        XCTAssertTrue(report.hasMore)
    }

    func testShouldPassTheStoredCursorOnTheNextRun() async throws {
        try store.setCursor("cursor-from-last-time")
        let recorder = Recorder()
        let serverTime = instant("2026-08-09T07:00:05.000Z")

        _ = await makeEngine(
            pull: { since in
                await recorder.record(since ?? "<none>")
                return SyncResponse(
                    cursor: "cursor-2", hasMore: false, changes: [], serverTime: serverTime
                )
            }
        ).synchronise()

        let seen = await recorder.values
        XCTAssertEqual(seen, ["cursor-from-last-time"])
    }

    func testShouldBootstrapWithNoCursorOnAFirstRun() async throws {
        let recorder = Recorder()
        let serverTime = instant("2026-08-09T07:00:05.000Z")

        _ = await makeEngine(
            pull: { since in
                await recorder.record(since ?? "<none>")
                return SyncResponse(
                    cursor: "cursor-1", hasMore: false, changes: [], serverTime: serverTime
                )
            }
        ).synchronise()

        let seen = await recorder.values
        XCTAssertEqual(seen, ["<none>"])
    }

    func testShouldApplyADeleteChange() async throws {
        try store.upsert([todo(id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001")])
        let response = SyncResponse(
            cursor: "cursor-2",
            hasMore: false,
            changes: [
                SyncChange(
                    type: .todo,
                    op: .delete,
                    id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001",
                    at: instant("2026-08-09T06:30:00.000Z"),
                    resource: nil
                )
            ],
            serverTime: instant("2026-08-09T07:00:05.000Z")
        )

        _ = await makeEngine(pull: { _ in response }).synchronise()

        XCTAssertTrue(try store.openTodos().isEmpty)
    }

    func testShouldSkipAChangeForAResourceTypeTheDeviceDoesNotStore() async throws {
        let response = SyncResponse(
            cursor: "cursor-2",
            hasMore: false,
            changes: [
                upsertChange(type: .todo, id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001"),
                SyncChange(
                    type: .device,
                    op: .upsert,
                    id: "syl:device:0198f2c4-0001-7000-8000-00000000e001",
                    at: instant("2026-08-09T07:00:00.000Z"),
                    resource: .object(["id": .string("syl:device:x")])
                ),
            ],
            serverTime: instant("2026-08-09T07:00:05.000Z")
        )

        let report = await makeEngine(pull: { _ in response }).synchronise()

        XCTAssertEqual(report.changesApplied, 1)
        XCTAssertTrue(report.failures.isEmpty, "skipping is correct, not an error")
    }

    func testShouldSurviveOneUnreadableChangeWithoutAbandoningThePage() async throws {
        let response = SyncResponse(
            cursor: "cursor-2",
            hasMore: false,
            changes: [
                SyncChange(
                    type: .todo,
                    op: .upsert,
                    id: "syl:todo:0198f2c2-0009-7000-8000-00000000c009",
                    at: instant("2026-08-09T07:00:00.000Z"),
                    resource: .object(["nonsense": .bool(true)])
                ),
                upsertChange(type: .todo, id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001"),
            ],
            serverTime: instant("2026-08-09T07:00:05.000Z")
        )

        let report = await makeEngine(pull: { _ in response }).synchronise()

        XCTAssertEqual(report.changesApplied, 1)
        XCTAssertEqual(report.failures.count, 1)
        XCTAssertEqual(try store.openTodos().count, 1)
    }

    func testShouldReportAPullFailureWithoutLosingTheCursor() async throws {
        try store.setCursor("cursor-from-last-time")

        let report = await makeEngine(
            pull: { _ in throw APIError.transport(code: .timedOut, description: "timed out") }
        ).synchronise()

        XCTAssertEqual(report.pagesPulled, 0)
        XCTAssertEqual(report.failures.count, 1)
        XCTAssertEqual(try store.syncState().cursor, "cursor-from-last-time")
    }

    // MARK: - Goals (`syl-011.1.2`)

    func testShouldStoreAGoalThatArrivesOnASyncPage() async throws {
        // It used to be dropped on the floor, with a comment saying the phone had no use
        // for it. That was true until the app grew a goal surface; a screen built on the
        // old rule would have to hit the network to show anything.
        let response = SyncResponse(
            cursor: "cursor-2",
            hasMore: false,
            changes: [
                upsertChange(type: .goal, id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001")
            ],
            serverTime: instant("2026-08-09T07:00:05.000Z")
        )

        let report = await makeEngine(pull: { _ in response }).synchronise()

        XCTAssertEqual(report.changesApplied, 1)
        XCTAssertEqual(try store.goals().map(\.title), ["Run a marathon"])
    }

    func testShouldRemoveAGoalOnADeleteChange() async throws {
        let arrival = SyncResponse(
            cursor: "cursor-2",
            hasMore: false,
            changes: [
                upsertChange(type: .goal, id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001")
            ],
            serverTime: instant("2026-08-09T07:00:05.000Z")
        )
        _ = await makeEngine(pull: { _ in arrival }).synchronise()
        XCTAssertEqual(try store.goals().count, 1, "the precondition this test needs")

        let response = SyncResponse(
            cursor: "cursor-3",
            hasMore: false,
            changes: [
                SyncChange(
                    type: .goal,
                    op: .delete,
                    id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001",
                    at: instant("2026-08-09T06:30:00.000Z"),
                    resource: nil
                )
            ],
            serverTime: instant("2026-08-09T07:00:05.000Z")
        )

        _ = await makeEngine(pull: { _ in response }).synchronise()

        XCTAssertTrue(try store.goals().isEmpty)
    }

    func testShouldStillSkipTheResourcesThePhoneGenuinelyHasNoUseFor() async throws {
        // Goals moved out of the skipped list; deliveries, devices, jobs and runs stay
        // in it for the original reason.
        for type in [SyncResourceType.device, .delivery] {
            XCTAssertNil(LocalStore.tableName(for: type), "\(type.rawValue) is not stored")
        }
        XCTAssertEqual(LocalStore.tableName(for: .goal), "goal")
    }

    // MARK: - An intent applies once, driven through the real outbox (`syl-011.1.6`)

    func testShouldPushACompletionOnceAndLeaveNothingToReplay() async throws {
        try store.upsert([todo(id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001")])
        try store.completeTodo(
            id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001",
            idempotencyKey: "key-complete-1",
            now: instant("2026-08-09T07:00:00.000Z")
        )
        let recorder = Recorder()
        let engine = makeEngine(
            push: { record in
                await recorder.record("\(record.kind.rawValue):\(record.idempotencyKey)")
                return .done
            }
        )

        _ = await engine.synchronise()
        _ = await engine.synchronise()

        let sent = await recorder.values
        XCTAssertEqual(sent, ["completeTodo:key-complete-1"], "the second run has nothing to send")
        XCTAssertEqual(try outbox.count(), 0)
    }

    func testShouldCarryTheSameKeyThroughEveryRetryOfACompletion() async throws {
        // A key regenerated per attempt is the same as having no key at all.
        try store.upsert([todo(id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001")])
        try store.completeTodo(
            id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001",
            idempotencyKey: "key-complete-1",
            now: instant("2026-08-09T07:00:00.000Z")
        )
        let recorder = Recorder()
        let engine = makeEngine(
            push: { record in
                await recorder.record(record.idempotencyKey)
                throw APIError.transport(code: .timedOut, description: "")
            }
        )

        _ = await engine.synchronise()
        _ = await engine.synchronise()

        let keys = await recorder.values
        XCTAssertEqual(keys, ["key-complete-1", "key-complete-1"])
    }

    func testShouldLeaveOneTodoAfterACaptureHasBeenPushedAndPulledBack() async throws {
        // The push creates it; the pull in the same pass brings back the server's copy
        // under the server's id. Two rows would mean he sees the same to-do twice,
        // permanently — and there is no `clientId` on a to-do to reconcile them with.
        _ = try store.createTodo(
            text: "Book the dentist",
            idempotencyKey: "key-capture-1",
            now: instant("2026-08-09T07:00:00.000Z"),
            id: "syl:todo:0198f2c2-0aaa-7000-8000-00000000caaa"
        )
        let serversCopy = SyncResponse(
            cursor: "cursor-2",
            hasMore: false,
            changes: [
                upsertChange(type: .todo, id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001")
            ],
            serverTime: instant("2026-08-09T07:00:05.000Z")
        )

        _ = await makeEngine(pull: { _ in serversCopy }).synchronise()

        XCTAssertEqual(
            try store.openTodos().map(\.id),
            ["syl:todo:0198f2c2-0001-7000-8000-00000000c001"]
        )
    }

    func testShouldKeepACapturedTodoWhenThePullNeverLanded() async throws {
        // The push may have created it on the server, but this device has not been told
        // so. Retiring the row here would take his capture off the screen with nothing
        // to put in its place — the silent drop, in a new costume.
        _ = try store.createTodo(
            text: "Book the dentist",
            idempotencyKey: "key-capture-1",
            now: instant("2026-08-09T07:00:00.000Z"),
            id: "syl:todo:0198f2c2-0aaa-7000-8000-00000000caaa"
        )

        _ = await makeEngine(
            pull: { _ in throw APIError.transport(code: .cannotConnectToHost, description: "") }
        ).synchronise()

        XCTAssertEqual(try store.openTodos().count, 1)
    }

    func testShouldClearADeferralAskOnceTheServerHasRefusedIt() async throws {
        // `DEFERRAL_NOT_LATER` is permanent, so the intent is abandoned and no new copy
        // of the reminder is ever coming. The row must stop saying a deferral is pending.
        try store.upsert([reminder(id: "syl:reminder:0198f2c1-0001-7d21-9f00-1a2b3c4d5e01")])
        try store.snoozeReminder(
            id: "syl:reminder:0198f2c1-0001-7d21-9f00-1a2b3c4d5e01",
            minutes: 15,
            idempotencyKey: "key-snooze-1",
            now: instant("2026-08-09T07:00:00.000Z")
        )

        let report = await makeEngine(
            push: { _ in
                throw APIError.api(
                    ApiError(code: .deferralNotLater, message: "not later", retryable: false),
                    status: 422
                )
            }
        ).synchronise()

        XCTAssertEqual(report.abandoned, 1)
        XCTAssertTrue(try store.deferralRequests().isEmpty)
    }

    // MARK: - Order

    func testShouldPushBeforeItPullsSoTheServerReturnsHisOwnWritesAsAuthoritative() async throws {
        // Pulling first would race: a page fetched before the push lands describes a
        // world without his last message in it.
        try enqueueSend(clientId: "c1", key: "key-00000001")
        let recorder = Recorder()
        let serverTime = instant("2026-08-09T07:00:05.000Z")

        _ = await makeEngine(
            push: { _ in
                await recorder.record("push")
                return .done
            },
            pull: { _ in
                await recorder.record("pull")
                return SyncResponse(
                    cursor: "c", hasMore: false, changes: [], serverTime: serverTime
                )
            }
        ).synchronise()

        let order = await recorder.values
        XCTAssertEqual(order, ["push", "pull"])
    }

    // MARK: - Harness

    private func makeEngine(
        push: @escaping @Sendable (OutboxRecord) async throws -> PushResult = { _ in .done },
        pull: @escaping @Sendable (String?) async throws -> SyncResponse = { _ in
            SyncResponse(
                cursor: "cursor", hasMore: false, changes: [],
                serverTime: try! Instant.parse("2026-08-09T07:00:05.000Z")
            )
        },
        allGoals: @escaping @Sendable (String?) async throws -> GoalPage = { _ in
            GoalPage(items: [], nextCursor: nil, hasMore: false)
        },
        allTodos: @escaping @Sendable (String?) async throws -> TodoPage = { _ in
            TodoPage(items: [], nextCursor: nil, hasMore: false)
        },
        /// What the engine asked the feed for. Kept as a side-channel so `pull` above
        /// stays a one-argument closure and every existing test reads unchanged.
        onPullTypes: @escaping @Sendable ([SyncResourceType]) -> Void = { _ in },
        maxPagesPerRun: Int = 10
    ) -> SyncEngine {
        SyncEngine(
            store: store,
            outbox: outbox,
            gateway: SyncGateway(
                push: push,
                pull: { since, types in
                    onPullTypes(types)
                    return try await pull(since)
                },
                allGoals: allGoals,
                allTodos: allTodos
            ),
            maxPagesPerRun: maxPagesPerRun
        )
    }

    /// Records what happened, in order, from whatever task the closure ran on.
    actor Recorder {
        private(set) var values: [String] = []

        func record(_ value: String) {
            values.append(value)
        }
    }

    /// Hands out prepared pages.
    actor PageSource {
        private var pages: [(cursor: String, hasMore: Bool)]
        private let serverTime: Date

        init(pages: [(cursor: String, hasMore: Bool)], serverTime: Date) {
            self.pages = pages
            self.serverTime = serverTime
        }

        private(set) var cursorsSeen: [String?] = []

        /// Records the cursor it was handed. A source that ignored `since` could not
        /// tell a client that pages correctly from one that re-asks for page one
        /// forever, which is the failure paging tests exist to catch.
        func next(since: String?) -> SyncResponse {
            cursorsSeen.append(since)
            guard !pages.isEmpty else {
                return SyncResponse(
                    cursor: since ?? "", hasMore: false, changes: [], serverTime: serverTime)
            }
            let page = pages.removeFirst()
            return SyncResponse(
                cursor: page.cursor, hasMore: page.hasMore, changes: [], serverTime: serverTime)
        }
    }

    private func enqueueSnooze(key: String) throws {
        try outbox.enqueue(
            OutboxRecord(
                idempotencyKey: key,
                kind: .snoozeReminder,
                targetId: "syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f",
                payload: try SylJSON.encoder().encode(SnoozeReminderRequest.minutes(15)),
                createdAt: instant("2026-08-09T06:59:48.220Z")
            )
        )
    }

    private func enqueueSend(clientId: String, key: String) throws {
        _ = try store.enqueueSend(
            conversationId: SylIDs.interactiveConversation,
            clientId: clientId,
            idempotencyKey: key,
            text: "Remind me to call the pharmacy at 4 today.",
            now: instant("2026-08-09T06:59:48.220Z")
        )
    }

    private func upsertChange(type: SyncResourceType, id: SylID) -> SyncChange {
        let resource: JSONValue
        switch type {
        case .todo:
            resource = .object([
                "id": .string(id),
                "text": .string("Call the pharmacy about the refill"),
                "goalId": .null,
                "dueAt": .null,
                "pinned": .bool(false),
                "status": .string("open"),
                "source": .string("commander"),
                "delegatedJobId": .null,
                "createdAt": .string("2026-08-09T06:59:48.300Z"),
                "updatedAt": .string("2026-08-09T06:59:48.300Z"),
                "completedAt": .null,
            ])
        case .reminder:
            resource = .object([
                "id": .string(id),
                "kind": .string("commitment"),
                "text": .string("Call the pharmacy — the refill lapses today."),
                // Required-and-nullable, so the keys are present even when the
                // values are not. Mirrors `http/reminder.commitment.json`.
                "because": .string("you asked me to chase it after you said the refill lapses today"),
                "origin": .string("he_asked"),
                "todoId": .null,
                "eventId": .null,
                "wallTime": .string("16:00"),
                "tz": .string("America/Chicago"),
                "rrule": .null,
                "scheduledFor": .string("2026-08-09T21:00:00.000Z"),
                "nextFireAt": .string("2026-08-09T21:00:00.000Z"),
                "urgent": .bool(true),
                "late": .bool(false),
                "deferredFrom": .null,
                "supersedesPrevious": .bool(false),
                "deliveryState": .string("scheduled"),
                "createdAt": .string("2026-08-09T06:59:48.400Z"),
                "updatedAt": .string("2026-08-09T06:59:48.400Z"),
                "completedAt": .null,
            ])
        case .goal:
            resource = .object([
                "id": .string(id),
                "parentId": .null,
                "title": .string("Run a marathon"),
                "why": .string("Because I said I would."),
                "targetDate": .string("2027-04-18"),
                "metricKey": .null,
                "targetValue": .null,
                "cadenceDays": .number(7),
                "status": .string("active"),
                "statusReason": .null,
                "createdAt": .string("2026-08-09T06:59:48.500Z"),
                "updatedAt": .string("2026-08-09T06:59:48.500Z"),
            ])
        default:
            resource = .null
        }

        return SyncChange(
            type: type,
            op: .upsert,
            id: id,
            at: instant("2026-08-09T07:00:00.000Z"),
            resource: resource
        )
    }

    private func todo(id: SylID) -> Todo {
        let base = instant("2026-08-09T06:59:48.300Z")
        return Todo(
            id: id, text: "Call the pharmacy about the refill", goalId: nil, dueAt: nil,
            pinned: false, status: .open, source: .commander, delegatedJobId: nil,
            createdAt: base, updatedAt: base, completedAt: nil
        )
    }

    private func reminder(id: SylID) -> Reminder {
        let base = instant("2026-08-09T07:00:00.000Z")
        return Reminder(
            id: id, kind: .commitment, text: "Call the pharmacy.", todoId: nil, eventId: nil,
            wallTime: "16:00", tz: "America/Chicago", rrule: nil,
            scheduledFor: base.addingTimeInterval(3600),
            nextFireAt: base.addingTimeInterval(3600),
            urgent: false, late: false, deferredFrom: nil, supersedesPrevious: false,
            deliveryState: .scheduled, createdAt: base, updatedAt: base, completedAt: nil
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

    // MARK: - The goals the cursor walked past (`syl-011.9`)

    /// The recovery, and the defect behind it.
    ///
    /// `pullChanges` writes the cursor after every page whether or not anything in it was
    /// applied. While `.goal` sat in the ignore list, every goal that came down a page was
    /// dropped **and the cursor advanced past it** — and `GET /sync` only returns changes
    /// since the cursor, so those goals are never offered again. The device believes it is
    /// perfectly up to date and is missing them for good.
    ///
    /// The Commander hit it within the hour: three goals on the server, one on the phone,
    /// and no error anywhere. This is the one-off list fetch that gets them back.
    func testShouldRecoverGoalsTheChangeFeedWillNeverSendAgain() async throws {
        // A device that has already synced past them — exactly his state.
        try store.setCursor("cursor-well-past-the-goals")
        let engine = makeEngine(allGoals: { _ in
            GoalPage(items: [Self.goal(id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001"),
                             Self.goal(id: "syl:goal:0198f2c3-0002-7000-8000-00000000d002")],
                     nextCursor: nil, hasMore: false)
        })

        _ = await engine.synchronise()

        XCTAssertEqual(try store.goals().count, 2, "the change feed cannot produce these; the list route must")
    }

    func testShouldRunTheGoalRecoveryOnlyOnce() async throws {
        // A full list fetch on every launch trades a one-off recovery for a permanent
        // cost.
        let calls = Counter()
        let engine = makeEngine(allGoals: { _ in
            await calls.increment()
            return GoalPage(items: [], nextCursor: nil, hasMore: false)
        })

        _ = await engine.synchronise()
        _ = await engine.synchronise()

        let count = await calls.value
        XCTAssertEqual(count, 1)
    }

    func testShouldNotRecordTheRecoveryWhenItFailed() async throws {
        // The one thing it must not do is claim a success it did not have — that would
        // leave the goals missing forever with the flag saying they were fetched.
        struct Unreachable: Error {}
        let engine = makeEngine(allGoals: { _ in throw Unreachable() })

        let report = await engine.synchronise()

        XCTAssertNil(try store.syncState().goalsBackfilledAt, "a failure must be retried")
        XCTAssertTrue(report.failures.contains { $0.contains("goal backfill") })
    }

    func testShouldPageThroughEveryGoalRatherThanTakingTheFirstPage() async throws {
        let engine = makeEngine(allGoals: { cursor in
            cursor == nil
                ? GoalPage(items: [Self.goal(id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001")],
                           nextCursor: "page-2", hasMore: true)
                : GoalPage(items: [Self.goal(id: "syl:goal:0198f2c3-0002-7000-8000-00000000d002")],
                           nextCursor: nil, hasMore: false)
        })

        _ = await engine.synchronise()

        XCTAssertEqual(try store.goals().count, 2)
    }

    static func goal(id: SylID) -> Goal {
        Goal(
            id: id,
            parentId: nil,
            title: "Get out of debt",
            why: nil,
            targetDate: nil,
            metricKey: nil,
            targetValue: nil,
            cadenceDays: nil,
            status: .active,
            statusReason: nil,
            createdAt: try! Instant.parse("2026-08-09T07:00:00.000Z"),
            updatedAt: try! Instant.parse("2026-08-09T07:00:00.000Z")
        )
    }

    actor Counter {
        private(set) var value = 0
        func increment() { value += 1 }
    }

    // MARK: - syl-020: the to-dos that never arrived

    /// The device must ask the feed only for what it stores.
    ///
    /// Measured on the Commander's own database the day this was written: 26,268 rows in
    /// `sync_log`, of which 25,705 — 97.9% — were `job` and `run` telemetry no device
    /// keeps. The phone pages 500 changes a run while those types were being written at
    /// 6,352 an hour, so it was not slowly catching up, it was falling behind for good,
    /// and his 23 to-do rows sat behind tens of thousands it would never reach.
    ///
    /// `GET /sync` has accepted `?types=` all along. The phone simply never sent it.
    func testShouldAskTheFeedOnlyForTheTypesItActuallyStores() async throws {
        let asked = TypeRecorder()

        _ = await makeEngine(onPullTypes: { types in asked.record(types) }).synchronise()

        let types = asked.seen
        XCTAssertFalse(types.isEmpty, "the phone asked for everything, which is syl-020")
        XCTAssertTrue(types.contains(.todo))
        // The four it downloads and throws away. `job` and `run` alone were 97.9%.
        for ignored in [SyncResourceType.device, .delivery] {
            XCTAssertFalse(
                types.contains(ignored),
                "asked for \(ignored.rawValue), which this device discards on arrival"
            )
        }
    }

    /// The requested list and the stored list are the same list.
    ///
    /// The two are declared in different places — `SYNCED_RESOURCE_TYPES` and the switch
    /// in `SyncEngine.upsert` — and drift between them is silent in the direction that
    /// matters: a type stored but not requested simply never arrives, with no error, on
    /// every device. That is this bug's whole shape, so it gets a test rather than a
    /// comment asking people to remember.
    func testShouldRequestExactlyTheTypesItKnowsHowToStore() {
        XCTAssertEqual(
            Set(SYNCED_RESOURCE_TYPES),
            Set([.conversation, .message, .reminder, .todo, .goal, .sending] as [SyncResourceType]),
            "SYNCED_RESOURCE_TYPES and SyncEngine.upsert have drifted apart"
        )
    }

    /// Filtering fixes the future. It cannot reach behind the cursor.
    ///
    /// `GET /sync` returns only what is ahead of the cursor, so every to-do the starved
    /// feed already walked past is unreachable by any amount of correct paging. Goals
    /// needed a hand-written recovery for exactly this and to-dos never got one.
    func testShouldRecoverTheTodosTheCursorAlreadyWalkedPast() async throws {
        let stranded = Todo(
            id: "syl:todo:0198f2c2-0020-7000-8000-00000000d020",
            text: "Verify Blue Cross Blue Shield", goalId: nil, dueAt: nil, pinned: true,
            status: .open, source: .commander, delegatedJobId: nil,
            createdAt: try Instant.parse("2026-08-09T07:00:00.000Z"),
            updatedAt: try Instant.parse("2026-08-09T07:00:00.000Z"),
            completedAt: nil
        )

        // The feed has nothing to say — the row is behind the cursor, which is the whole
        // problem. Only the list route can still see it.
        _ = await makeEngine(
            allTodos: { _ in TodoPage(items: [stranded], nextCursor: nil, hasMore: false) }
        ).synchronise()

        XCTAssertEqual(try store.openTodos().map(\.id), [stranded.id])
    }

    /// The recovery runs once, not on every launch.
    ///
    /// A full list fetch every time would trade a one-off rescue for a permanent cost —
    /// `backfillGoals` states the same rule and this must not be the version that
    /// forgets it.
    func testShouldRecoverTheTodosOnlyOnce() async throws {
        let calls = Counter()

        let engine = makeEngine(
            allTodos: { _ in
                await calls.increment()
                return TodoPage(items: [], nextCursor: nil, hasMore: false)
            }
        )
        _ = await engine.synchronise()
        _ = await engine.synchronise()

        let count = await calls.value
        XCTAssertEqual(count, 1, "the one-off recovery ran again")
    }

    /// A failed recovery must not record itself as done.
    ///
    /// The one thing it may never do. Recording success it did not have would strand
    /// those to-dos permanently behind a flag saying they had been fetched.
    func testShouldRetryTheRecoveryWhenItCouldNotFetch() async throws {
        struct Offline: Error {}
        let calls = Counter()

        let engine = makeEngine(
            allTodos: { _ in
                await calls.increment()
                throw Offline()
            }
        )
        _ = await engine.synchronise()
        _ = await engine.synchronise()

        let count = await calls.value
        XCTAssertEqual(count, 2, "a failed recovery marked itself done and will never retry")
    }

    /// The cursor does not step over a page that failed to apply.
    ///
    /// This is the mechanism behind both `syl-011.9` and `syl-020`, and the code used to
    /// carry a comment asserting the opposite — that a failed change "stays stale, and
    /// the next cursor pass sees it again". It did not: `GET /sync` returns only what is
    /// ahead of the cursor, so a change stepped over is lost permanently and silently,
    /// and the device goes on believing it is current.
    func testShouldNotAdvanceTheCursorPastAChangeThatFailedToApply() async throws {
        let response = SyncResponse(
            cursor: "cursor-past-the-broken-row",
            hasMore: false,
            changes: [
                SyncChange(
                    type: .todo,
                    op: .upsert,
                    id: "syl:todo:0198f2c2-0021-7000-8000-00000000d021",
                    at: instant("2026-08-09T06:30:00.000Z"),
                    // An upsert carrying no resource: a contract violation, and formerly
                    // dropped with no error recorded anywhere at all.
                    resource: nil
                )
            ],
            serverTime: instant("2026-08-09T07:00:05.000Z")
        )

        let report = await makeEngine(pull: { _ in response }).synchronise()

        XCTAssertFalse(
            report.failures.isEmpty,
            "a to-do vanished without one trace in the report"
        )
        XCTAssertNotEqual(
            try store.syncState().cursor, "cursor-past-the-broken-row",
            "the cursor moved past a change that never applied — it can never be re-delivered"
        )
    }

    /// Captures what the engine asked for, from whatever task the closure ran on.
    final class TypeRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var types: [SyncResourceType] = []

        func record(_ values: [SyncResourceType]) {
            lock.lock(); defer { lock.unlock() }
            types = values
        }

        var seen: [SyncResourceType] {
            lock.lock(); defer { lock.unlock() }
            return types
        }
    }
}
