import GRDB
import SylKit
import XCTest

@testable import Syl

/// The optimistic half of every write (`syl-011.1.4` — `syl-011.1.7`).
///
/// The transport was already finished: `Outbox.Kind` declared every intent and
/// `SyncEngine`'s flush already sent them with their stored idempotency key. What was
/// missing is this — the seam that changes the row on disk *and* queues the intent, in
/// one transaction, so the Commander sees his tap land.
///
/// A row that renders done with no outbox row is a lie; an outbox row with no local
/// change is a tap that did nothing.
final class OptimisticWriteTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!
    private var outbox: Outbox!

    private let todoId: SylID = "syl:todo:0198f2c2-0001-7000-8000-00000000c001"
    private let reminderId: SylID = "syl:reminder:0198f2c1-0001-7d21-9f00-1a2b3c4d5e01"

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

    // MARK: - Completing a to-do

    func testShouldMarkATodoDoneAndQueueTheIntentInOneStep() throws {
        try store.upsert([todo()])

        let completed = try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)

        XCTAssertEqual(completed.status, .done)
        XCTAssertEqual(completed.completedAt, now)
        XCTAssertEqual(try store.openTodos().count, 0, "it must stop being open on disk")
        let queued = try XCTUnwrap(try outbox.pending().first)
        XCTAssertEqual(queued.kind, .completeTodo)
        XCTAssertEqual(queued.targetId, todoId)
        XCTAssertEqual(queued.idempotencyKey, "key-todo-1")
    }

    func testShouldRollTheCompletionBackWhenQueueingTheIntentFails() throws {
        // The two halves are the same fact. A completion that wrote the row and then
        // failed to queue the intent would be a to-do that reads done here and is open
        // everywhere else, forever — and he would never know, because it looks finished.
        //
        // The trigger makes the second half fail on demand, which is the only way to
        // prove the first half is inside the same transaction rather than merely next
        // to it.
        try store.upsert([todo()])
        try refuseEveryOutboxInsert()

        XCTAssertThrowsError(
            try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now))

        XCTAssertEqual(try outbox.count(), 0, "nothing was queued")
        XCTAssertEqual(try store.openTodos().count, 1, "so nothing may read as done either")
    }

    func testShouldRollTheCaptureBackWhenQueueingTheIntentFails() throws {
        // The other direction of the same rule: a captured to-do with no intent behind
        // it is a row that exists on exactly one device and will never exist anywhere
        // else. Better that his tap visibly did nothing than that it silently half-did.
        try refuseEveryOutboxInsert()

        XCTAssertThrowsError(
            try store.createTodo(
                text: "Book the dentist", idempotencyKey: "key-cap-1", now: now, id: todoId))

        XCTAssertEqual(try outbox.count(), 0)
        XCTAssertTrue(try store.openTodos().isEmpty)
    }

    func testShouldRefuseToCompleteATodoItHasNeverSeen() throws {
        // Read the row before writing. A stale or half-remembered id costs a read and
        // never an item.
        XCTAssertThrowsError(
            try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        ) { error in
            XCTAssertEqual(error as? LocalStoreError, .noSuchTodo(id: self.todoId))
        }
        XCTAssertEqual(try outbox.count(), 0)
    }

    // MARK: - Refusing something already finished (`CONTEXT.md` §7)

    func testShouldRefuseToCompleteATodoThatIsAlreadyFinished() throws {
        // The store's complete is idempotent and would answer happily, reporting an act
        // nobody performed. `finish_todo` carries the same scar on the server side.
        try store.upsert([todo(status: .done)])

        XCTAssertThrowsError(
            try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        ) { error in
            XCTAssertEqual(
                error as? LocalStoreError,
                .todoAlreadyFinished(text: "Call the pharmacy about the refill")
            )
        }
        XCTAssertEqual(try outbox.count(), 0, "a refusal must not queue an intent")
    }

    func testShouldNameTheTodoInHisOwnWordsWhenItRefuses() throws {
        // The load-bearing half. Him hearing the wrong title is the only place a wrong
        // inference is still catchable, and a verb that answers "done" gives him nothing
        // to contradict.
        try store.upsert([todo(status: .done)])

        XCTAssertThrowsError(
            try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        ) { error in
            XCTAssertTrue(
                String(describing: error).contains("Call the pharmacy about the refill"),
                "every refusal path names the thing, in his words: \(error)"
            )
        }
    }

    func testShouldRefuseToCompleteACaptureTheServerHasNeverHeardOf() throws {
        // The row's only id is one this device minted, so `POST /todos/{id}/complete`
        // can only be `NOT_FOUND` — permanent, abandoned, and then the sweep replaces
        // the row with the server's copy, which is still open. The completion would undo
        // itself and say nothing. A refusal he can see is the better failure.
        _ = try store.createTodo(
            text: "Book the dentist", idempotencyKey: "key-cap-1", now: now, id: todoId)

        XCTAssertThrowsError(
            try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        ) { error in
            XCTAssertEqual(
                error as? LocalStoreError, .todoHasNotReachedSylYet(text: "Book the dentist"))
            XCTAssertTrue(String(describing: error).contains("Book the dentist"))
        }
        XCTAssertEqual(try outbox.count(), 1, "only the capture is queued")
    }

    func testShouldCompleteThatSameTodoOnceTheServerHasAcknowledgedIt() throws {
        // And the refusal is temporary by construction: the server's copy carries no
        // capture key, so it completes like anything else.
        try store.upsert([todo()])

        XCTAssertNoThrow(try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now))
    }

    func testShouldRefuseToDeferAReminderThatIsAlreadyFinished() throws {
        try store.upsert([reminder(state: .completed)])

        XCTAssertThrowsError(
            try store.snoozeReminder(
                id: reminderId, minutes: 15, idempotencyKey: "key-snz-1", now: now)
        ) { error in
            XCTAssertEqual(
                error as? LocalStoreError, .reminderAlreadyFinished(text: "Call the pharmacy."))
        }
        XCTAssertEqual(try outbox.count(), 0)
        XCTAssertTrue(try store.deferralRequests().isEmpty)
    }

    func testShouldNameTheReminderWhenItRefusesACompletedOne() throws {
        try store.upsert([reminder(state: .completed)])

        XCTAssertThrowsError(
            try store.completeReminder(id: reminderId, idempotencyKey: "key-rem-1", now: now)
        ) { error in
            XCTAssertEqual(
                error as? LocalStoreError,
                .reminderAlreadyFinished(text: "Call the pharmacy.")
            )
            XCTAssertTrue(String(describing: error).contains("Call the pharmacy."))
        }
        XCTAssertEqual(try outbox.count(), 0)
    }

    // MARK: - Completing a reminder

    func testShouldCompleteAReminderAndQueueTheIntentInOneStep() throws {
        try store.upsert([reminder()])

        let completed = try store.completeReminder(
            id: reminderId, idempotencyKey: "key-rem-1", now: now)

        XCTAssertEqual(completed.deliveryState, .completed)
        XCTAssertEqual(completed.completedAt, now)
        XCTAssertTrue(
            try store.upcomingReminders(after: now.addingTimeInterval(-3600)).isEmpty,
            "a completed reminder leaves the spine"
        )
        let queued = try XCTUnwrap(try outbox.pending().first)
        XCTAssertEqual(queued.kind, .completeReminder)
        XCTAssertEqual(queued.targetId, reminderId)
        XCTAssertNil(queued.payload, "a completion carries no body")
    }

    func testShouldRefuseToCompleteAReminderItHasNeverSeen() throws {
        XCTAssertThrowsError(
            try store.completeReminder(id: reminderId, idempotencyKey: "key-rem-1", now: now)
        ) { error in
            XCTAssertEqual(error as? LocalStoreError, .noSuchReminder(id: self.reminderId))
        }
    }

    // MARK: - A deferral is ASKED, not moved (D2)

    func testShouldNotWriteADeviceComputedInstantWhenADeferralIsAsked() throws {
        // Constraint 4 and proposal E agree: the server owns the new instant. Computing
        // "+15 minutes" here would be easy, would look right, and would put a time on
        // his screen that exists nowhere else — so a phone that is wiped, restored or
        // replaced would take his deferrals with it.
        try store.upsert([reminder()])
        let before = try XCTUnwrap(try store.reminder(id: reminderId))

        try store.snoozeReminder(id: reminderId, minutes: 15, idempotencyKey: "key-snz-1", now: now)

        let after = try XCTUnwrap(try store.reminder(id: reminderId))
        XCTAssertEqual(
            after.nextFireAt, before.nextFireAt,
            "the fire time is the server's answer and it has not answered yet"
        )
        XCTAssertEqual(after.deliveryState, before.deliveryState, "nor has the state moved")
        XCTAssertNil(after.deferredFrom, "a deferral chain is written by the server, not here")
        // The model above comes out of the payload blob, so it cannot see a write to the
        // indexed column beside it — and that column is what the spine sorts on. Assert
        // it separately or this test cannot fail for the reason it is named for.
        XCTAssertEqual(
            try storedInstant("nextFireAt"), before.nextFireAt,
            "the column the day sorts on is the server's answer too"
        )
    }

    func testShouldSendADurationRatherThanAnInstantSoTheServerDoesTheArithmetic() throws {
        try store.upsert([reminder()])

        try store.snoozeReminder(id: reminderId, minutes: 15, idempotencyKey: "key-snz-1", now: now)

        let queued = try XCTUnwrap(try outbox.pending().first)
        XCTAssertEqual(queued.kind, .snoozeReminder)
        XCTAssertEqual(queued.targetId, reminderId)
        let body = try queued.decodePayload(as: SnoozeReminderRequest.self)
        XCTAssertEqual(body.minutes, 15)
        XCTAssertNil(body.until, "an instant computed here is the bug this test exists for")
    }

    func testShouldRecordThatADeferralWasAskedForSoTheRowCanSaySo() throws {
        // The row does not show a new time — it has none yet. It shows that a deferral
        // was asked for, and it settles when the server answers.
        try store.upsert([reminder()])

        try store.snoozeReminder(id: reminderId, minutes: 15, idempotencyKey: "key-snz-1", now: now)

        XCTAssertEqual(try store.deferralRequests()[SylIDs.canonical(reminderId)], now)
    }

    func testShouldStoreOnlyTheInstantHeAskedAtAndNothingLaterThanIt() throws {
        // The single assertion that catches a "helpful" refactor: whatever the row
        // holds, none of it may be in the future. A device-computed fire time is by
        // definition later than the moment he asked.
        try store.upsert([reminder(fireOffset: -60)])

        try store.snoozeReminder(id: reminderId, minutes: 15, idempotencyKey: "key-snz-1", now: now)

        let instants = try database.queue.read { db -> [Date] in
            let row = try XCTUnwrap(try Row.fetchOne(db, sql: "SELECT * FROM reminder"))
            return ["nextFireAt", "updatedAt", "deferralRequestedAt"].compactMap { row[$0] as Date? }
        }
        XCTAssertFalse(instants.isEmpty)
        for stored in instants {
            XCTAssertLessThanOrEqual(
                stored, now,
                "nothing later than the ask may be written on the device"
            )
        }
    }

    func testShouldSettleTheDeferralWhenTheServersCopyOfTheReminderArrives() throws {
        try store.upsert([reminder()])
        try store.snoozeReminder(id: reminderId, minutes: 15, idempotencyKey: "key-snz-1", now: now)

        // The server answered: a later instant, which is the only place one may come
        // from. Its copy replaces the row and the ask is over.
        try store.upsert([reminder(fireOffset: 900)])

        XCTAssertTrue(try store.deferralRequests().isEmpty)
    }

    func testShouldRefuseToDeferAReminderItHasNeverSeen() throws {
        XCTAssertThrowsError(
            try store.snoozeReminder(
                id: reminderId, minutes: 15, idempotencyKey: "key-snz-1", now: now)
        ) { error in
            XCTAssertEqual(error as? LocalStoreError, .noSuchReminder(id: self.reminderId))
        }
        XCTAssertEqual(try outbox.count(), 0)
    }

    // MARK: - Capture

    func testShouldWriteACapturedTodoAndQueueTheIntentInOneStep() throws {
        let captured = try store.createTodo(
            text: "Book the dentist",
            idempotencyKey: "key-cap-1",
            now: now,
            id: todoId
        )

        XCTAssertEqual(captured.text, "Book the dentist")
        XCTAssertEqual(try store.openTodos().map(\.id), [todoId])
        let queued = try XCTUnwrap(try outbox.pending().first)
        XCTAssertEqual(queued.kind, .createTodo)
        XCTAssertEqual(try queued.decodePayload(as: CreateTodoRequest.self).text, "Book the dentist")
    }

    func testShouldCaptureWithNothingButTextAndATimestamp() throws {
        // Every field a human must fill in is a tax collected at the moment of lowest
        // motivation. They die at capture, not at review.
        let captured = try store.createTodo(
            text: "Book the dentist", idempotencyKey: "key-cap-1", now: now, id: todoId)

        XCTAssertNil(captured.dueAt)
        XCTAssertNil(captured.goalId)
        XCTAssertFalse(captured.pinned)
        XCTAssertNil(captured.completedAt)
        XCTAssertEqual(captured.createdAt, now)
        XCTAssertEqual(captured.source, .commander)
        XCTAssertEqual(captured.status, .open, "an explicit ask is never provisional")
    }

    func testShouldTrimTheCaptureRatherThanStoreHisTrailingNewline() throws {
        let captured = try store.createTodo(
            text: "  Book the dentist\n", idempotencyKey: "key-cap-1", now: now, id: todoId)

        XCTAssertEqual(captured.text, "Book the dentist")
    }

    func testShouldWriteNothingForAWhitespaceOnlyCapture() throws {
        XCTAssertThrowsError(
            try store.createTodo(text: "   \n", idempotencyKey: "key-cap-1", now: now, id: todoId)
        ) { error in
            XCTAssertEqual(error as? LocalStoreError, .emptyCapture)
        }

        XCTAssertEqual(try outbox.count(), 0)
        XCTAssertTrue(try store.openTodos().isEmpty)
    }

    func testShouldMintAWellFormedIdForACaptureSoTheRowIsAddressable() throws {
        let captured = try store.createTodo(
            text: "Book the dentist", idempotencyKey: "key-cap-1", now: now)

        XCTAssertTrue(
            SylIDs.isWellFormed(captured.id),
            "\(captured.id) must match the contract's id shape"
        )
        XCTAssertEqual(SylIDs.type(of: captured.id), "todo")
    }

    // MARK: - Replaying an intent applies once (`syl-011.1.6`)

    func testShouldQueueOneIntentForADoubleTapOnACompletion() throws {
        try store.upsert([todo()])

        try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now)
        // The second tap finds a finished to-do and is refused, which is the correct
        // answer twice over: nothing is applied and nothing is queued.
        XCTAssertThrowsError(
            try store.completeTodo(id: todoId, idempotencyKey: "key-todo-1", now: now))

        XCTAssertEqual(try outbox.count(), 1)
    }

    func testShouldQueueOneIntentForADoubleTapOnADeferral() throws {
        // A key regenerated per tap is the same as having no key at all: the server
        // would defer twice and the reminder would land half an hour late.
        try store.upsert([reminder()])

        for _ in 0..<2 {
            try store.snoozeReminder(
                id: reminderId, minutes: 15, idempotencyKey: "key-snz-1", now: now)
        }

        XCTAssertEqual(try outbox.count(), 1)
    }

    func testShouldWriteOneTodoForADoubleTapOnCapture() throws {
        for _ in 0..<2 {
            _ = try? store.createTodo(
                text: "Book the dentist", idempotencyKey: "key-cap-1", now: now, id: todoId)
        }

        XCTAssertEqual(try outbox.count(), 1)
        XCTAssertEqual(try store.openTodos().count, 1)
    }

    // MARK: - Optimistic markers settle when their intent leaves the queue

    func testShouldKeepTheCapturedTodoWhileItsIntentIsStillQueued() throws {
        // Offline. The intent is stuck in the outbox, so the row he captured must stay
        // exactly where he put it.
        _ = try store.createTodo(
            text: "Book the dentist", idempotencyKey: "key-cap-1", now: now, id: todoId)

        try store.settleOptimisticMarkers()

        XCTAssertEqual(try store.openTodos().count, 1)
    }

    func testShouldRetireTheCapturedTodoOnceItsIntentHasLeftTheQueue() throws {
        // The push created it on the server and the pull in the same pass brought the
        // server's copy back under the server's id. Leaving the optimistic row would
        // show him the same to-do twice, permanently.
        _ = try store.createTodo(
            text: "Book the dentist", idempotencyKey: "key-cap-1", now: now, id: todoId)
        let record = try XCTUnwrap(try outbox.pending().first)
        try outbox.complete(record)

        try store.settleOptimisticMarkers()

        XCTAssertTrue(try store.openTodos().isEmpty)
    }

    func testShouldNotRetireATodoTheServerSentUs() throws {
        // Only a row this device invented an id for is retired. A to-do that came down
        // the sync is the truth and nothing may sweep it away.
        try store.upsert([todo()])

        try store.settleOptimisticMarkers()

        XCTAssertEqual(try store.openTodos().count, 1)
    }

    func testShouldSettleADeferralWhoseIntentWasRefusedOutright() throws {
        // `DEFERRAL_NOT_LATER` is permanent, so the intent is abandoned and the row is
        // gone from the queue. The ask is over and the reminder still stands at the time
        // it always stood at — which the row must stop contradicting.
        try store.upsert([reminder()])
        try store.snoozeReminder(id: reminderId, minutes: 15, idempotencyKey: "key-snz-1", now: now)
        let record = try XCTUnwrap(try outbox.pending().first)
        try outbox.abandon(record)

        try store.settleOptimisticMarkers()

        XCTAssertTrue(try store.deferralRequests().isEmpty)
    }

    func testShouldKeepTheDeferralAskWhileItsIntentIsStillQueued() throws {
        try store.upsert([reminder()])
        try store.snoozeReminder(id: reminderId, minutes: 15, idempotencyKey: "key-snz-1", now: now)

        try store.settleOptimisticMarkers()

        XCTAssertEqual(try store.deferralRequests().count, 1)
    }

    // MARK: - Builders

    private var now: Date { instant("2026-08-09T07:00:00.000Z") }

    /// One instant column of the stored reminder row, read past the payload.
    private func storedInstant(_ column: String) throws -> Date? {
        try database.queue.read { db in
            try Date.fetchOne(db, sql: "SELECT \(column) FROM reminder LIMIT 1")
        }
    }

    /// Makes the second half of every write helper fail, on demand and from inside the
    /// transaction. There is no other way to observe a rollback that is supposed to be
    /// impossible.
    private func refuseEveryOutboxInsert() throws {
        try database.queue.write { db in
            try db.execute(
                sql: """
                    CREATE TRIGGER refuse_outbox BEFORE INSERT ON outbox
                    BEGIN SELECT RAISE(ABORT, 'the queue is unwritable'); END
                    """
            )
        }
    }

    private func todo(status: TodoStatus = .open) -> Todo {
        let base = instant("2026-08-09T06:59:48.300Z")
        return Todo(
            id: todoId,
            text: "Call the pharmacy about the refill",
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
        fireOffset: TimeInterval = 3600,
        state: ReminderDeliveryState = .scheduled
    ) -> Reminder {
        let base = instant("2026-08-09T07:00:00.000Z")
        return Reminder(
            id: reminderId,
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
            createdAt: instant("2026-08-09T06:00:00.000Z"),
            updatedAt: instant("2026-08-09T06:00:00.000Z"),
            completedAt: state == .completed ? instant("2026-08-09T06:30:00.000Z") : nil
        )
    }

    private func instant(_ text: String) -> Date {
        try! Instant.parse(text)
    }
}
