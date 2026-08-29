import GRDB
import SylKit
import XCTest

@testable import Syl

/// One row this build cannot name must not stop everything he did behind it.
///
/// ## The defect (`syl-e213`)
///
/// `OutboxRecord` is `Codable` and `FetchableRecord`, and `kind` is an enum — so decoding
/// a row whose stored string has no case throws `DecodingError.dataCorrupted`. **It
/// throws for the FETCH, not for the row.** `Outbox.pending`, `queued` and `blocked` all
/// materialise records, so a single unnameable row makes the whole queue unreadable,
/// `SyncEngine.pushOutbox` catches it at *"could not read the outbox"* and returns, and
/// every intent behind it is stuck for good — with the only record going into
/// `SyncReport.failures`, which nothing reads.
///
/// It is the blast radius `HomeLoadFailureTests` documents for a single undecodable
/// reminder blanking his entire day, in the one table where the consequence is that the
/// Commander's own actions never leave the device.
///
/// **This is a candidate mechanism, not a finding.** It produces exactly the symptom of
/// the 2026-08-25 outage and has never been ruled out. Nothing here claims it is what
/// happened, and nothing should until something observed says so.
///
/// ## What correct behaviour is
///
/// Two halves, and shipping only the first would trade a loud stall for a silent one:
///
/// 1. **The queue drains past it.** A row this build cannot send is skipped rather than
///    fatal — filtered in SQL, so no unknown string ever reaches the decoder.
/// 2. **The row is neither deleted nor hidden.** It stays on disk with its payload
///    intact, it is counted, and the day says so. A row that is quietly stepped over
///    forever is the silent discard this project forbids, arriving by a slower road.
///
/// ## How it was found, which is the point worth keeping
///
/// By a test written for something else — the per-kind breakdown — that failed in its own
/// *arrange* step rather than at its assertion. That is the third defect this week found
/// by something built to check a different thing.
final class UnreadableIntentTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!
    private var outbox: Outbox!

    private let todoId: SylID = "syl:todo:0198f2c2-0042-7000-8000-00000000c042"

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

    // MARK: - The queue must stay readable

    func testShouldStillReadTheQueueWhenOneRowHasAKindItCannotName() throws {
        // The whole defect in three lines. Before this, `pending()` threw and took every
        // other intent in the table down with it.
        try insertUnnameableRow(key: "key-unknown-1", at: now)
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: later)

        let queued = try outbox.pending()

        XCTAssertEqual(
            queued.map(\.idempotencyKey), ["key-todo-1"],
            "the readable intent must survive a neighbour this build cannot decode"
        )
    }

    func testShouldSurviveAnUnnameableRowOnEveryReadThePushDependsOn() throws {
        // `pushOutbox` reads `pending`; `DeliveryReconciler` reads `queued` as its own
        // memory of what it has already surfaced; the blocked list is read to show what
        // is parked. All three materialise records, so all three had the same hole.
        try insertUnnameableRow(key: "key-unknown-1", at: now)

        XCTAssertNoThrow(try outbox.pending())
        XCTAssertNoThrow(try outbox.blocked())
        XCTAssertNoThrow(try outbox.queued(idempotencyKey: "key-todo-1"))
        XCTAssertNoThrow(try outbox.count())
        XCTAssertNoThrow(try outbox.stall())
    }

    func testShouldDeliverEveryIntentBehindTheOneItCannotRead() async throws {
        // The consequence that actually costs him something: his completions sat behind
        // an unreadable row and never left the device. The push must walk past it.
        try insertUnnameableRow(key: "key-unknown-1", at: now)
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: later)

        let sent = Recorder()
        let engine = SyncEngine(
            store: store,
            outbox: outbox,
            gateway: SyncGateway(
                push: { record in
                    await sent.record(record.idempotencyKey)
                    return .done
                },
                pull: { _, _ in
                    SyncResponse(
                        cursor: "cursor", hasMore: false, changes: [],
                        serverTime: try Instant.parse("2026-08-26T09:00:05.000Z")
                    )
                }
            )
        )

        let report = await engine.synchronise()

        let delivered = await sent.values
        XCTAssertEqual(delivered, ["key-todo-1"], "his completion never reached the server")
        XCTAssertEqual(report.pushed, 1)
    }

    func testShouldNotDeleteTheRowItCannotRead() throws {
        // Skipping is not discarding. The payload is the only surviving copy of what he
        // meant, and a build that can name the kind — an update, a downgrade reversed —
        // must still find it here.
        try insertUnnameableRow(key: "key-unknown-1", at: now)

        _ = try outbox.pending()

        XCTAssertEqual(try outbox.count(), 1, "the row was stepped over, not thrown away")
        let payload = try database.queue.read { db in
            try String.fetchOne(db, sql: "SELECT payload FROM outbox WHERE idempotencyKey = ?",
                                arguments: ["key-unknown-1"])
        }
        XCTAssertEqual(payload, "{\"text\":\"something he meant\"}")
    }

    // MARK: - And it must not become a silent one

    func testShouldSaySoEvenThoughNoRowHasFailed() throws {
        // The half that keeps this from trading a loud stall for a quiet one. A row the
        // push skips is never attempted, so it never records a `lastError` — and the
        // stall card's trigger is "something failed". Without this, the queue moves
        // again and one of his intents sits there forever with nothing anywhere saying
        // so.
        try insertUnnameableRow(key: "key-unknown-1", at: now)

        let stall = try XCTUnwrap(try outbox.stall())
        XCTAssertEqual(stall.unreadable, 1)
        XCTAssertEqual(stall.waiting, 1)
        XCTAssertNil(stall.kind, "there is no name for it — that is the whole problem")
    }

    func testShouldTellHimWhatToDoAboutIt() throws {
        // "Updating should release it" is actionable and true: the realistic cause is a
        // build older than the row. A notice he can do nothing with is decoration.
        try insertUnnameableRow(key: "key-unknown-1", at: now)

        let notice = try XCTUnwrap(StallNotice(try outbox.stall()))
        let unreadable = try XCTUnwrap(notice.unreadable)
        XCTAssertTrue(unreadable.contains("this version of the app"), unreadable)
        XCTAssertTrue(unreadable.contains("Updating"), unreadable)
    }

    func testShouldSayNothingAboutUnreadableRowsWhenThereAreNone() throws {
        // The ordinary stall must not grow a sentence about a problem it does not have.
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        let queued = try XCTUnwrap(try outbox.pending().first)
        try outbox.recordFailure(queued, error: "The request timed out.")

        let notice = try XCTUnwrap(StallNotice(try outbox.stall()))
        XCTAssertNil(notice.unreadable)
    }

    func testShouldCountAnUnreadableRowAmongWhatIsWaitingButNotAmongTheKinds() throws {
        // The same asymmetry the breakdown already runs on: `waiting` comes from the
        // table and may not under-report, the per-kind split is best-effort. A row
        // nobody can name is still his and still undelivered.
        try insertUnnameableRow(key: "key-unknown-1", at: now)
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: later)

        let stall = try XCTUnwrap(try outbox.stall())
        XCTAssertEqual(stall.waiting, 2)
        XCTAssertEqual(stall.waitingByKind[.completeTodo], 1)
        XCTAssertEqual(stall.waitingByKind.values.reduce(0, +), 1)
    }

    // MARK: - Builders

    private var now: Date { instant("2026-08-25T15:51:44.792Z") }
    private var later: Date { instant("2026-08-26T09:00:00.000Z") }

    private func instant(_ text: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: text) else {
            XCTFail("\(text) is not an instant")
            return Date(timeIntervalSince1970: 0)
        }
        return date
    }

    /// A row whose `kind` has no case in this build. Written straight to the table,
    /// because `OutboxRecord.Kind` is precisely what makes it unrepresentable in Swift —
    /// which is the condition under test.
    private func insertUnnameableRow(key: String, at instant: Date) throws {
        try database.queue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO outbox (idempotencyKey, kind, payload, createdAt, attempts)
                    VALUES (?, 'recalibrateTheFlux', ?, ?, 0)
                    """,
                arguments: [key, Data(#"{"text":"something he meant"}"#.utf8), instant]
            )
        }
    }

    private func todo() -> Todo {
        let base = instant("2026-08-25T15:00:00.000Z")
        return Todo(
            id: todoId,
            text: "Call the pharmacy about the refill",
            goalId: nil,
            dueAt: nil,
            pinned: false,
            status: .open,
            source: .commander,
            delegatedJobId: nil,
            createdAt: base,
            updatedAt: base,
            completedAt: nil
        )
    }

    private actor Recorder {
        private(set) var values: [String] = []
        func record(_ value: String) { values.append(value) }
    }
}
