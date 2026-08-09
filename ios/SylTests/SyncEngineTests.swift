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

    // MARK: - Writes the service does not deduplicate

    func testShouldParkASnoozeThatMayAlreadyHaveTakenEffect() async throws {
        // `Idempotency-Key` is in the contract for every write but only message sends
        // honour it today (syl-1mz). Retrying a snooze after an ambiguous failure would
        // defer the reminder by another fifteen minutes.
        try enqueueSnooze(key: "key-00000001")

        let report = await makeEngine(
            push: { _ in throw APIError.transport(code: .timedOut, description: "timed out") }
        ).synchronise()

        XCTAssertEqual(report.blocked, 1)
        XCTAssertEqual(report.deferred, 0)
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
        // Message sends are deduplicated by the clientId unique index, so a replay is
        // safe and the bubble must not hang pending forever.
        try enqueueSend(clientId: "c1", key: "key-00000001")

        let report = await makeEngine(
            push: { _ in throw APIError.transport(code: .timedOut, description: "") }
        ).synchronise()

        XCTAssertEqual(report.blocked, 0)
        XCTAssertEqual(try outbox.pending().count, 1)
    }

    func testShouldKnowWhichIntentsAreSafeToReplayBlind() {
        XCTAssertTrue(OutboxRecord.Kind.sendMessage.isSafeToReplayBlind)
        XCTAssertTrue(OutboxRecord.Kind.acknowledgeDelivery.isSafeToReplayBlind)
        XCTAssertTrue(OutboxRecord.Kind.completeReminder.isSafeToReplayBlind)
        XCTAssertFalse(OutboxRecord.Kind.snoozeReminder.isSafeToReplayBlind)
        XCTAssertFalse(OutboxRecord.Kind.createTodo.isSafeToReplayBlind)
        XCTAssertFalse(OutboxRecord.Kind.createReminder.isSafeToReplayBlind)
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
                    type: .job,
                    op: .upsert,
                    id: "syl:job:0198f2c4-0001-7000-8000-00000000e001",
                    at: instant("2026-08-09T07:00:00.000Z"),
                    resource: .object(["id": .string("syl:job:x")])
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
        maxPagesPerRun: Int = 10
    ) -> SyncEngine {
        SyncEngine(
            store: store,
            outbox: outbox,
            gateway: SyncGateway(push: push, pull: pull),
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

        func next(since: String?) -> SyncResponse {
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
