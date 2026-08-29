import GRDB
import SylKit
import XCTest

@testable import Syl

/// A queue that stops moving must say so, and it must not quietly undo his work.
///
/// ## The defect
///
/// The Commander marked to-dos complete in the app for three days. Syl saw every one of
/// them still open. Neither side was lying: `LocalStore.completeTodo` writes `done`
/// locally and queues a `completeTodo` intent, and `SyncEngine.pushOutbox` stops at the
/// **first** recoverable failure — deliberately, because "the queue is ordered because
/// he acted in that order, and pushing past a stuck row would deliver his actions out of
/// sequence". That ordering rule is correct and is not what is being changed here.
///
/// What was wrong is everything after it. The failure went into `SyncReport.failures`,
/// which is appended to in eleven places across `SyncEngine` and `DeliveryReconciler`
/// and **read in none** — every call site discards the return value of `synchronise()`.
/// So one blip blocked every completion behind it, indefinitely, and the only record of
/// it was a value that was constructed and thrown away.
///
/// It is `syl-019` again in a different subsystem: the screen had one way to say "this
/// is done" and no way to say "this is done here and nowhere else", and the two
/// collapsed onto the comforting one.
///
/// ## The two halves
///
/// **A stall is visible** (`Outbox.stall`, and `HomeViewModel.stall` above it). Derived
/// from the queue on disk rather than from a report that exists only during a sync, so
/// it survives a relaunch and is answerable at any moment — which is the same
/// local-first rule the rest of this app is built on.
///
/// **A queued completion is not reverted.** The sweep used to write the server's copy
/// straight over the local row, so a to-do he finished, whose intent had not left the
/// queue, would come back `open` with nothing said. `LocalStore.completeTodo` already
/// describes this ending for the unsynced-capture case in its own comment — *"the
/// completion would revert itself with nothing said"* — and it was reachable by a second
/// route nobody had closed.
final class StuckQueueTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!
    private var outbox: Outbox!

    private let todoId: SylID = "syl:todo:0198f2c2-0031-7000-8000-00000000c031"
    private let reminderId: SylID = "syl:reminder:0198f2c1-0031-7d21-9f00-1a2b3c4d5e31"

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

    // MARK: - The sweep may not undo a completion that is still queued

    func testShouldKeepACompletedTodoWhileItsCompletionIsStillQueued() throws {
        // The three-day defect, in five lines. He finished it; the push has not landed;
        // the pull brings back the server's copy, which is still open — because the
        // server has not been told yet. Writing that over his row takes the completion
        // off his screen and leaves nothing anywhere saying it ever happened.
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)

        try store.upsert([todo(status: .open)])

        XCTAssertEqual(
            try store.todo(id: todoId)?.status, .done,
            "the server's stale copy overwrote an act he performed and is still owed"
        )
        XCTAssertEqual(try outbox.pending().count, 1, "and the intent is still owed")
    }

    func testShouldKeepACompletedTodoWhoseIntentIsBlockedRatherThanMerelyQueued() throws {
        // A blocked row is skipped by the push — `Outbox.pending` filters it out — so a
        // guard written against the *pending* queue would let exactly the rows that are
        // stuck hardest be reverted. Blocked means unresolved, which is the condition
        // that matters here.
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        let queued = try XCTUnwrap(try outbox.pending().first)
        try outbox.block(queued, reason: "the request may already have taken effect")

        try store.upsert([todo(status: .open)])

        XCTAssertEqual(try store.todo(id: todoId)?.status, .done)
    }

    func testShouldTakeTheServersCopyOnceTheCompletionHasLeftTheQueue() throws {
        // The guard is self-limiting, and it has to be. Once the intent is gone the
        // server is the authority again — including when it says `open`, which is what a
        // to-do genuinely reopened on another surface looks like. A guard that outlived
        // its intent would freeze the row for good.
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        let queued = try XCTUnwrap(try outbox.pending().first)
        try outbox.complete(queued)

        try store.upsert([todo(status: .open)])

        XCTAssertEqual(try store.todo(id: todoId)?.status, .open)
    }

    func testShouldTakeTheServersCopyWhenItAlreadyAgreesTheTodoIsDone() throws {
        // The ordinary ending: the push landed, the pull brought the server's `done` row
        // back in the same pass, and the intent has not been cleared yet. Holding this
        // one back would mean the row never picks up anything the server changed.
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)

        try store.upsert([todo(status: .done, text: "Call the pharmacy about the refill (Syl)")])

        XCTAssertEqual(try store.todo(id: todoId)?.text, "Call the pharmacy about the refill (Syl)")
    }

    func testShouldNotHoldBackATodoWithNoCompletionQueuedAtAll() throws {
        // The sweep is unchanged for every row that is not the subject of an unfinished
        // act of his. A to-do reopened on the web must still arrive.
        try store.upsert([todo(status: .done)])

        try store.upsert([todo(status: .open)])

        XCTAssertEqual(try store.todo(id: todoId)?.status, .open)
    }

    func testShouldKeepACompletedReminderWhileItsCompletionIsStillQueued() throws {
        // Identical hazard, identical guard. A reminder he finished, whose intent is
        // stuck behind the same blockage, would otherwise be put back on his spine by
        // the very sweep that is failing to deliver it.
        try store.upsert([reminder()])
        try store.completeReminder(id: reminderId, idempotencyKey: "key-rem-1", now: now)

        try store.upsert([reminder(state: .scheduled)])

        XCTAssertEqual(try store.reminder(id: reminderId)?.deliveryState, .completed)
        XCTAssertTrue(
            try store.upcomingReminders(after: now.addingTimeInterval(-3_600)).isEmpty,
            "a completion he made was undone and the reminder returned to the day"
        )
    }

    func testShouldTakeTheServersReminderOnceTheCompletionHasLeftTheQueue() throws {
        try store.upsert([reminder()])
        try store.completeReminder(id: reminderId, idempotencyKey: "key-rem-1", now: now)
        let queued = try XCTUnwrap(try outbox.pending().first)
        try outbox.complete(queued)

        try store.upsert([reminder(state: .scheduled)])

        XCTAssertEqual(try store.reminder(id: reminderId)?.deliveryState, .scheduled)
    }

    // MARK: - What is stuck, read off the disk

    func testShouldReportNothingStuckWhenTheQueueIsEmpty() throws {
        XCTAssertNil(try outbox.stall())
    }

    func testShouldReportNothingStuckWhenTheQueueHasSimplyNotBeenTriedYet() throws {
        // A queue that has never been attempted is not stuck, it is new — he tapped two
        // seconds ago and the sync has not run. Reporting that as trouble would train
        // him to ignore the one notice that matters.
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)

        XCTAssertNil(try outbox.stall())
    }

    func testShouldReportTheStallOnceTheHeadOfTheQueueHasFailed() throws {
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        let queued = try XCTUnwrap(try outbox.pending().first)
        try outbox.recordFailure(queued, error: "The request timed out.")

        let stall = try XCTUnwrap(try outbox.stall())
        XCTAssertEqual(stall.waiting, 1)
        XCTAssertEqual(stall.since, now)
        XCTAssertEqual(stall.kind, .completeTodo)
        XCTAssertEqual(
            stall.reason, "The request timed out.",
            "the error's own words — the cause is unknown, so a tidy stand-in erases the "
                + "only evidence anyone has"
        )
        XCTAssertFalse(stall.blocked)
    }

    func testShouldCountEverythingBehindTheStuckRowBecauseNoneOfItIsMoving() throws {
        // The push returns at the first recoverable failure, so the count he needs is
        // the whole queue rather than the number of rows that have themselves failed.
        // Three completions behind one stuck send are three completions Syl has not
        // heard about.
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        try store.createTodo(text: "Book the dentist", idempotencyKey: "key-cap-1", now: later)
        try store.createTodo(text: "Call the roofer", idempotencyKey: "key-cap-2", now: later)
        let head = try XCTUnwrap(try outbox.pending().first)
        try outbox.recordFailure(head, error: "The request timed out.")

        let stall = try XCTUnwrap(try outbox.stall())
        XCTAssertEqual(stall.waiting, 3)
    }

    func testShouldDateTheStallFromTheOldestThingHeDidRatherThanTheLastAttempt() throws {
        // "Since Tuesday" is the sentence that makes this real to him. The last attempt
        // was thirty seconds ago on every reading, and saying so would make a three-day
        // outage look like a momentary one.
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        try store.createTodo(text: "Book the dentist", idempotencyKey: "key-cap-1", now: later)
        for record in try outbox.pending() {
            try outbox.recordFailure(record, error: "The request timed out.")
        }

        let stall = try XCTUnwrap(try outbox.stall())
        XCTAssertEqual(stall.since, now)
    }

    func testShouldReportABlockedRowEvenThoughThePushStepsOverIt() throws {
        // A blocked row waits for a decision nobody has asked him to make. It is
        // excluded from `pending`, so before this it was invisible to the push AND to
        // every surface — parked forever with nothing anywhere saying so.
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        let queued = try XCTUnwrap(try outbox.pending().first)
        try outbox.block(queued, reason: "It may already have taken effect.")

        let stall = try XCTUnwrap(try outbox.stall())
        XCTAssertTrue(stall.blocked)
        XCTAssertEqual(stall.waiting, 1)
        XCTAssertEqual(stall.reason, "It may already have taken effect.")
    }

    func testShouldStopReportingAStallThatHasCleared() throws {
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        let queued = try XCTUnwrap(try outbox.pending().first)
        try outbox.recordFailure(queued, error: "The request timed out.")
        XCTAssertNotNil(try outbox.stall())

        try outbox.complete(queued)

        XCTAssertNil(try outbox.stall(), "the queue drained and the notice must go with it")
    }

    // MARK: - What the screen is handed

    func testShouldDrawNothingAtAllWhenNothingIsStuck() {
        XCTAssertNil(StallNotice(nil), "the ordinary case must add nothing to the screen")
    }

    func testShouldLeadWithHowMuchOfHisHasNotArrived() throws {
        // The count is what turns "the network is flaky" into "Syl does not know about
        // three things I did", and only the second of those is worth interrupting him
        // for.
        let one = try XCTUnwrap(StallNotice(stall(waiting: 1)))
        XCTAssertEqual(one.title, "1 thing you did has not reached me")

        let several = try XCTUnwrap(StallNotice(stall(waiting: 3)))
        XCTAssertEqual(several.title, "3 things you did have not reached me")
    }

    func testShouldNameTheActItIsStuckOnInHisOwnTerms() throws {
        let notice = try XCTUnwrap(StallNotice(stall(kind: .completeTodo)))
        XCTAssertTrue(
            notice.detail.contains("a to-do you finished"),
            "\(notice.detail) does not say what he did"
        )
        XCTAssertTrue(notice.detail.contains("waiting behind it"))
    }

    func testShouldSayWhenItWillNotFreeItselfSoHeIsNotWaitingOnNothing() throws {
        let notice = try XCTUnwrap(StallNotice(stall(blocked: true)))
        XCTAssertTrue(
            notice.detail.contains("will not try it again"),
            "a parked intent that reads as 'still trying' is a promise nothing will keep"
        )
    }

    func testShouldCarryTheErrorItselfRatherThanAFriendlyStandIn() throws {
        // The same rule `HomeViewModel.loadFailure` follows. The cause of this class of
        // failure is unknown, the device is the only place it happens, and a tidy
        // sentence in its place destroys the only evidence anyone has.
        let notice = try XCTUnwrap(StallNotice(stall(reason: "The request timed out.")))
        XCTAssertEqual(notice.reason, "The request timed out.")
        XCTAssertEqual(notice.since, now)
    }

    // MARK: - The model behind that screen

    @MainActor
    func testShouldPublishTheStallSoTheDayCanSaySo() async throws {
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        let queued = try XCTUnwrap(try outbox.pending().first)
        try outbox.recordFailure(queued, error: "The request timed out.")

        let instant = later
        let model = HomeViewModel(store: store, outbox: outbox, clock: { instant })
        await model.refresh()

        let published = try XCTUnwrap(model.stall)
        XCTAssertEqual(published.waiting, 1)
        XCTAssertEqual(published.kind, .completeTodo)
    }

    @MainActor
    func testShouldStopSayingSoOnceTheQueueDrains() async throws {
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        let queued = try XCTUnwrap(try outbox.pending().first)
        try outbox.recordFailure(queued, error: "The request timed out.")

        let instant = later
        let model = HomeViewModel(store: store, outbox: outbox, clock: { instant })
        await model.refresh()
        XCTAssertNotNil(model.stall)

        try outbox.complete(queued)
        await model.refresh()

        XCTAssertNil(model.stall, "the notice must retire itself rather than be dismissed")
    }

    @MainActor
    func testShouldStillReportTheStallOnADayItCouldNotRead() async throws {
        // The two failures are independent and the combination is the worst one: he
        // cannot see his day AND his last completions are stranded. A model that
        // returned early on the spine's failure would report only the first.
        try store.upsert([todo()])
        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        let queued = try XCTUnwrap(try outbox.pending().first)
        try outbox.recordFailure(queued, error: "The request timed out.")
        try spoilTheOnlyReminder()

        let instant = later
        let model = HomeViewModel(store: store, outbox: outbox, clock: { instant })
        await model.refresh()

        XCTAssertNotNil(model.loadFailure)
        XCTAssertNotNil(model.stall)
    }

    @MainActor
    func testShouldSayNothingIsStuckForAModelWithNoQueueBehindIt() async throws {
        // A preview, an offscreen render, a screenshot harness. No queue means nothing
        // can be stuck in one, which is the honest reading rather than a suppressed one.
        let instant = later
        let model = HomeViewModel(store: store, clock: { instant })
        await model.refresh()

        XCTAssertNil(model.stall)
    }

    // MARK: - Builders

    /// A reminder whose payload cannot be decoded, which is how the day's read actually
    /// throws in the field. See `HomeLoadFailureTests` for the full argument.
    private func spoilTheOnlyReminder() throws {
        // Firing AFTER the clock the model reads at, or `upcomingReminders` filters it
        // out on the indexed column and never decodes the payload at all — the row would
        // be spoiled and the day would load perfectly.
        try store.upsert([reminder(firingAt: later.addingTimeInterval(3_600))])
        try database.queue.write { db in
            try db.execute(
                sql: "UPDATE reminder SET payload = ? WHERE id = ?",
                arguments: [Data(#"{"but_this_is_not":"a reminder"}"#.utf8), reminderId]
            )
        }
    }

    private func stall(
        waiting: Int = 1,
        kind: OutboxRecord.Kind = .completeTodo,
        reason: String = "The request timed out.",
        blocked: Bool = false
    ) -> OutboxStall {
        OutboxStall(waiting: waiting, since: now, kind: kind, reason: reason, blocked: blocked)
    }

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

    private func todo(
        status: TodoStatus = .open,
        text: String = "Call the pharmacy about the refill"
    ) -> Todo {
        let base = instant("2026-08-25T15:00:00.000Z")
        return Todo(
            id: todoId,
            text: text,
            goalId: nil,
            dueAt: nil,
            pinned: false,
            status: status,
            source: .commander,
            delegatedJobId: nil,
            createdAt: base,
            updatedAt: base,
            completedAt: status == .done ? base : nil
        )
    }

    private func reminder(
        state: ReminderDeliveryState = .scheduled,
        firingAt: Date? = nil
    ) -> Reminder {
        let base = instant("2026-08-25T15:00:00.000Z")
        let fires = firingAt ?? base.addingTimeInterval(3_600)
        return Reminder(
            id: reminderId,
            kind: .commitment,
            text: "Call the pharmacy.",
            todoId: nil,
            eventId: nil,
            wallTime: "16:00",
            tz: "America/Chicago",
            rrule: nil,
            scheduledFor: fires,
            nextFireAt: fires,
            urgent: false,
            late: false,
            deferredFrom: nil,
            supersedesPrevious: false,
            deliveryState: state,
            createdAt: base,
            updatedAt: base,
            completedAt: state == .completed ? base : nil
        )
    }
}
