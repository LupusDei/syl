import GRDB
import SylKit
import XCTest

@testable import Syl

/// Finishing and deferring a thing, from the day's spine (`syl-011.2`).
///
/// Phase 1 built the seam — `LocalStore.completeTodo`, `completeReminder`,
/// `snoozeReminder` — and this is what stands on it. Everything interesting is in
/// `HomeSnapshot`'s pure transforms and in `HomeViewModel`'s ordering, precisely so it
/// can be asserted here rather than looked at in a simulator.
///
/// The rule under most of these tests is **D2**: the server owns a deferral's new
/// instant. A row that renders "+15 minutes" would look right and be wrong.
@MainActor
final class DayActionTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!
    private var outbox: Outbox!

    private let todoId: SylID = "syl:todo:0198f2c2-0001-7000-8000-00000000d001"
    private let reminderId: SylID = "syl:reminder:0198f2c1-0001-7d21-9f00-1a2b3c4d5e11"

    override func setUp() async throws {
        try await super.setUp()
        database = try SylDatabase.inMemory()
        store = LocalStore(database: database)
        outbox = Outbox(database: database)
    }

    override func tearDown() async throws {
        outbox = nil
        store = nil
        database = nil
        try await super.tearDown()
    }

    // MARK: - Fixtures

    private let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago") ?? .gmt
        return c
    }()

    /// 2026-08-10 09:00 Central. Fixed — a test that reads the clock fails at midnight.
    private var now: Date { at(9) }

    private func at(_ hour: Int, _ minute: Int = 0) -> Date {
        DateComponents(
            calendar: calendar, timeZone: calendar.timeZone,
            year: 2026, month: 8, day: 10, hour: hour, minute: minute
        ).date!
    }

    private func reminder(
        id: SylID? = nil,
        text: String = "Call the roofer",
        fireAt: Date,
        state: ReminderDeliveryState = .scheduled
    ) -> Reminder {
        Reminder(
            id: id ?? reminderId, kind: .commitment, text: text, todoId: nil, eventId: nil,
            wallTime: "09:00", tz: "America/Chicago", rrule: nil,
            scheduledFor: fireAt, nextFireAt: fireAt,
            urgent: false, late: false, deferredFrom: nil, supersedesPrevious: false,
            deliveryState: state, createdAt: fireAt, updatedAt: fireAt, completedAt: nil
        )
    }

    private func todo(
        id: SylID? = nil,
        text: String = "Book the dentist",
        dueAt: Date? = nil,
        pinned: Bool = true,
        status: TodoStatus = .open
    ) -> Todo {
        Todo(
            id: id ?? todoId, text: text, goalId: nil, dueAt: dueAt, pinned: pinned,
            status: status, source: .commander, delegatedJobId: nil,
            createdAt: now, updatedAt: now, completedAt: nil
        )
    }

    private func moment(
        _ id: SylID,
        title: String = "A thing",
        standing: DayMoment.Standing = .due,
        origin: DayMoment.Origin = .todo
    ) -> DayMoment {
        DayMoment(
            id: id, title: title, at: at(9), standing: standing, origin: origin,
            urgent: false, late: false, pinned: false
        )
    }

    private func spine(_ moments: [DayMoment]) -> HomeSnapshot {
        HomeSnapshot(
            moments: moments,
            remaining: moments.filter { $0.standing != .done }.count,
            note: nil,
            prominence: HomeSnapshot.prominence(remaining: moments.filter { $0.standing != .done }.count),
            greeting: "Good morning"
        )
    }

    /// A model wired to this test's store, with every clock and key generator pinned.
    private func model(
        settle: Duration = .zero,
        flush: @escaping @Sendable () async -> Void = {}
    ) -> HomeViewModel {
        // The default key generator is left alone deliberately: the outbox is unique on
        // the key, so a fixed one would silently swallow the second of two completions
        // and the test would be asserting the dedup rather than the write.
        HomeViewModel(store: store, clock: { [now] in now }, flush: flush, settle: settle)
    }

    // MARK: - HomeSnapshot.marking

    func testShouldMarkOneMomentDoneAndLeaveTheRestAlone() {
        let snapshot = spine([moment("a", title: "One"), moment("b", title: "Two")])

        let marked = snapshot.marking("a", as: .done)

        XCTAssertEqual(marked.moments.first?.standing, .done)
        XCTAssertEqual(marked.moments.last?.standing, .due, "the other row is untouched")
        XCTAssertEqual(marked.moments.count, 2, "it settles in place; it does not vanish")
    }

    func testShouldDropTheFinishedRowOutOfWhatIsLeft() {
        let snapshot = spine([moment("a"), moment("b")])
        XCTAssertEqual(snapshot.remaining, 2)

        let marked = snapshot.marking("a", as: .done)

        XCTAssertEqual(marked.remaining, 1, "the count is his confirmation as much as the row is")
        XCTAssertGreaterThan(marked.prominence, snapshot.prominence, "and Syl gets the room back")
    }

    func testShouldLeaveTheSpineUntouchedForAnIdThatIsNotOnIt() {
        let snapshot = spine([moment("a")])

        XCTAssertEqual(snapshot.marking("nope", as: .done), snapshot)
    }

    func testShouldMatchTheRowWhateverCaseTheIdArrivesIn() {
        // The contract's `Id` pattern permits either hex case. A bare `==` here would
        // silently mark nothing and look exactly like a tap that did not register.
        let snapshot = spine([moment("syl:todo:0198F2C2-AAAA")])

        let marked = snapshot.marking("syl:todo:0198f2c2-aaaa", as: .done)

        XCTAssertEqual(marked.moments.first?.standing, .done)
    }

    // MARK: - HomeSnapshot.applying(refusals:)

    func testShouldPutARefusalOnItsOwnRowAndNowhereElse() {
        let snapshot = spine([moment("a"), moment("b")])

        let applied = snapshot.applying(refusals: ["a": "Already finished"])

        XCTAssertEqual(applied.moments.first?.refusal, "Already finished")
        XCTAssertNil(applied.moments.last?.refusal, "a banner is the failure mode; this is not one")
    }

    func testShouldClearARefusalThatHasBeenDismissed() {
        var snapshot = spine([moment("a")])
        snapshot = snapshot.applying(refusals: ["a": "Already finished"])

        let cleared = snapshot.applying(refusals: [:])

        XCTAssertNil(cleared.moments.first?.refusal)
    }

    func testShouldMatchARefusalToItsRowWhateverCaseTheIdArrivesIn() {
        let snapshot = spine([moment("syl:todo:0198F2C2-BBBB")])

        let applied = snapshot.applying(refusals: ["syl:todo:0198f2c2-bbbb": "Already finished"])

        XCTAssertEqual(applied.moments.first?.refusal, "Already finished")
    }

    // MARK: - Building a deferred row

    func testShouldCarryThatADeferralWasAskedForWithoutMovingTheTime() throws {
        // R3, and the single most important assertion in this file. The device may not
        // compute the new instant, so the row keeps the *original* time and says only
        // that he asked.
        let fire = at(9, 30)
        let snapshot = HomeSnapshot.build(
            reminders: [reminder(fireAt: fire)],
            todos: [],
            now: now,
            calendar: calendar,
            deferralsAskedAt: [SylIDs.canonical(reminderId): at(9, 5)]
        )

        let row = try XCTUnwrap(snapshot.moments.first)
        XCTAssertEqual(row.deferralAskedAt, at(9, 5))
        XCTAssertEqual(row.at, fire, "the time on screen is still the server's, unmoved")
    }

    func testShouldLeaveARowWithNoDeferralSayingNothingAboutOne() throws {
        let snapshot = HomeSnapshot.build(
            reminders: [reminder(fireAt: at(9, 30))], todos: [], now: now, calendar: calendar
        )

        XCTAssertNil(try XCTUnwrap(snapshot.moments.first).deferralAskedAt)
    }

    func testShouldNeverMarkATodoAsHavingADeferralAsked() throws {
        // The contract has no deferral for a to-do. A stray key that happened to collide
        // with a to-do id must not make one appear.
        let snapshot = HomeSnapshot.build(
            reminders: [], todos: [todo()], now: now, calendar: calendar,
            deferralsAskedAt: [SylIDs.canonical(todoId): at(9, 5)]
        )

        XCTAssertNil(try XCTUnwrap(snapshot.moments.first).deferralAskedAt)
    }

    // MARK: - Which affordances a row may carry

    func testShouldOfferBothActionsOnAReminderNobodyHasAskedAnythingOf() {
        let row = moment("r", standing: .due, origin: .reminder)

        XCTAssertTrue(row.mayBeCompleted)
        XCTAssertTrue(row.mayBeDeferred)
    }

    func testShouldNeverOfferLaterOnATodo() {
        // The contract has no deferral for a to-do, so the affordance must not exist —
        // an offer that cannot be honoured is worse than no offer.
        let row = moment("t", standing: .due, origin: .todo)

        XCTAssertTrue(row.mayBeCompleted)
        XCTAssertFalse(row.mayBeDeferred)
    }

    func testShouldWithdrawLaterWhileADeferralIsAlreadyInFlight() throws {
        // A second ask mints a second key and the server honours it as a second deferral:
        // half an hour, not fifteen minutes. He cannot see that happen, because D2
        // forbids the row from showing a new time — so the affordance goes away instead.
        var row = moment("r", standing: .due, origin: .reminder)
        row.deferralAskedAt = at(9, 5)

        XCTAssertFalse(row.mayBeDeferred)
        XCTAssertTrue(row.mayBeCompleted, "he may still finish it while she is answering")
    }

    func testShouldOfferNothingOnARowThatIsAlreadySettling() {
        let row = moment("r", standing: .done, origin: .reminder)

        XCTAssertFalse(row.mayBeCompleted)
        XCTAssertFalse(row.mayBeDeferred)
    }

    func testShouldNotQueueASecondDeferralForARowThatAlreadyHasOneInFlight() async throws {
        try store.upsert([reminder(fireAt: at(9, 30))])
        let home = model()
        await home.refresh()
        await home.postpone(try XCTUnwrap(home.snapshot.moments.first))

        // The row now says it is waiting. Asking again — a stale view, a rotor action,
        // a future call site — must not queue a second fifteen minutes.
        await home.postpone(try XCTUnwrap(home.snapshot.moments.first))

        XCTAssertEqual(try outbox.pending().filter { $0.kind == .snoozeReminder }.count, 1)
    }

    // MARK: - What a refusal reads as

    func testShouldSayWhatIsTrueWhenSylHasNotSeenTheCaptureYet() {
        // `syl-011.1.8`. The store refuses by name rather than losing the completion;
        // the row has to make that look like a "not yet", not like a broken button.
        let phrase = DayRefusal.phrase(for: LocalStoreError.todoHasNotReachedSylYet(text: "Book the dentist"))

        XCTAssertEqual(phrase, "Not with Syl yet — this one completes once she has it")
    }

    func testShouldSayWhenTheThingWasAlreadyFinished() {
        XCTAssertEqual(
            DayRefusal.phrase(for: LocalStoreError.todoAlreadyFinished(text: "Book the dentist")),
            "Already finished"
        )
        XCTAssertEqual(
            DayRefusal.phrase(for: LocalStoreError.reminderAlreadyFinished(text: "Call the roofer")),
            "Already finished"
        )
    }

    func testShouldSayWhenTheRowIsNoLongerOnTheDevice() {
        XCTAssertEqual(
            DayRefusal.phrase(for: LocalStoreError.noSuchTodo(id: todoId)),
            "No longer on this device"
        )
    }

    func testShouldStillSaySomethingForAnErrorItHasNeverSeen() {
        // Silence is the failure this rule exists to prevent. An unrecognised error is
        // still a tap that did not land, and he is told so.
        struct Unknown: Error {}

        XCTAssertEqual(DayRefusal.phrase(for: Unknown()), "That did not go through")
    }

    // MARK: - Completing, from the spine

    func testShouldMarkTheRowDoneOnScreenTheMomentTheWriteLands() async throws {
        try store.upsert([todo()])
        let home = model(settle: .seconds(60))
        await home.refresh()
        let row = try XCTUnwrap(home.snapshot.moments.first)

        await home.complete(row)

        // Still on the spine, and now visibly finished. This is the whole of T009: the
        // confirmation *is* the row, held long enough to be read.
        XCTAssertEqual(home.snapshot.moments.count, 1)
        XCTAssertEqual(home.snapshot.moments.first?.standing, .done)
        XCTAssertEqual(home.snapshot.remaining, 0)
    }

    func testShouldQueueExactlyOneIntentForACompletion() async throws {
        try store.upsert([todo()])
        let home = model(settle: .seconds(60))
        await home.refresh()

        await home.complete(try XCTUnwrap(home.snapshot.moments.first))

        let queued = try outbox.pending()
        XCTAssertEqual(queued.count, 1)
        XCTAssertEqual(queued.first?.kind, .completeTodo)
        XCTAssertEqual(queued.first?.targetId, todoId)
    }

    func testShouldLetTheFinishedRowLeaveOnceItHasSettled() async throws {
        try store.upsert([todo()])
        let home = model()
        await home.refresh()

        await home.complete(try XCTUnwrap(home.snapshot.moments.first))
        await home.awaitDeparture()

        XCTAssertTrue(home.snapshot.moments.isEmpty, "it marks done, then leaves")
    }

    func testShouldCompleteAReminderThroughTheReminderPath() async throws {
        try store.upsert([reminder(fireAt: at(9, 30))])
        let home = model(settle: .seconds(60))
        await home.refresh()

        await home.complete(try XCTUnwrap(home.snapshot.moments.first))

        XCTAssertEqual(try outbox.pending().first?.kind, .completeReminder)
        XCTAssertEqual(try store.reminder(id: reminderId)?.deliveryState, .completed)
    }

    func testShouldPutTheRefusalOnTheRowRatherThanAnywhereElse() async throws {
        // The store refuses a second completion by name. That refusal belongs beside the
        // thing it is about — a banner at the top of the screen is the failure mode
        // T012 exists to prevent.
        try store.upsert([todo(), todo(id: "syl:todo:0198f2c2-0002-7000-8000-00000000d002", text: "Other")])
        let home = model(settle: .seconds(60))
        await home.refresh()
        let row = try XCTUnwrap(home.snapshot.moments.first { $0.title == "Book the dentist" })
        _ = try store.completeTodo(id: todoId, idempotencyKey: "elsewhere", now: now)

        await home.complete(row)

        let refused = try XCTUnwrap(home.snapshot.moments.first { $0.id == todoId })
        XCTAssertEqual(refused.refusal, "Already finished")
        XCTAssertNil(
            home.snapshot.moments.first { $0.id != todoId }?.refusal,
            "and on no other row"
        )
    }

    func testShouldNotQueueAnythingForACompletionThatWasRefused() async throws {
        try store.upsert([todo(status: .done)])
        let home = model(settle: .seconds(60))
        // A done to-do is off `openTodos`, so build the row by hand: this is the stale
        // tap — the spine he is looking at is a moment behind the disk.
        let row = moment(todoId, title: "Book the dentist")

        await home.complete(row)

        XCTAssertEqual(try outbox.count(), 0, "a refusal reports nothing and queues nothing")
    }

    func testShouldClearAnOldRefusalWhenHeActsOnThatRowAgain() async throws {
        // The stale-tap case, then its recovery: he taps a row the device has since lost,
        // the sweep brings the real one back, and the second tap works. The refusal must
        // not still be sitting under the row that just succeeded.
        let home = model(settle: .seconds(60))
        await home.complete(moment(todoId, title: "Book the dentist"))

        try store.upsert([todo()])
        await home.refresh()
        XCTAssertEqual(home.snapshot.moments.first?.refusal, "No longer on this device")

        await home.complete(try XCTUnwrap(home.snapshot.moments.first))

        XCTAssertNil(home.snapshot.moments.first?.refusal, "acting again is what clears it")
    }

    // MARK: - Deferring, from the spine

    func testShouldRecordThatHeAskedWithoutInventingANewTime() async throws {
        let fire = at(9, 30)
        try store.upsert([reminder(fireAt: fire)])
        let home = model()
        await home.refresh()

        await home.postpone(try XCTUnwrap(home.snapshot.moments.first))

        let row = try XCTUnwrap(home.snapshot.moments.first)
        XCTAssertEqual(row.deferralAskedAt, now, "the row says he asked, and when")
        XCTAssertEqual(row.at, fire, "and still shows the time the server last stated")
        XCTAssertEqual(try store.reminder(id: reminderId)?.nextFireAt, fire)
    }

    func testShouldSendADurationAndLetTheServerDoTheArithmetic() async throws {
        try store.upsert([reminder(fireAt: at(9, 30))])
        let home = model()
        await home.refresh()

        await home.postpone(try XCTUnwrap(home.snapshot.moments.first))

        let queued = try XCTUnwrap(try outbox.pending().first)
        XCTAssertEqual(queued.kind, .snoozeReminder)
        let body = try queued.decodePayload(as: SnoozeReminderRequest.self)
        XCTAssertEqual(body.minutes, ReminderNotification.snoozeMinutes)
        XCTAssertNil(body.until, "the device never names an instant")
    }

    func testShouldRefuseToDeferAToDoBecauseTheContractHasNoSuchThing() async throws {
        try store.upsert([todo()])
        let home = model()
        await home.refresh()

        await home.postpone(try XCTUnwrap(home.snapshot.moments.first))

        XCTAssertEqual(try outbox.count(), 0)
        XCTAssertNil(home.snapshot.moments.first?.deferralAskedAt)
    }

    func testShouldPutADeferralsRefusalOnTheRowToo() async throws {
        try store.upsert([reminder(fireAt: at(9, 30))])
        let home = model()
        await home.refresh()
        let row = try XCTUnwrap(home.snapshot.moments.first)
        _ = try store.completeReminder(id: reminderId, idempotencyKey: "elsewhere", now: now)

        await home.postpone(row)

        XCTAssertEqual(home.snapshot.moments.first?.refusal, "Already finished")
    }

    // MARK: - Dismissing what she said

    func testShouldTakeTheRefusalOffTheRowWhenHeDismissesIt() async throws {
        // The row has to be on screen for the refusal to be on it, so this is the whole
        // sequence: a stale tap on a to-do the disk already has as finished, and the
        // spine still showing it because it is a minute behind.
        try store.upsert([todo()])
        let home = model(settle: .seconds(60))
        await home.refresh()
        let row = try XCTUnwrap(home.snapshot.moments.first)
        _ = try store.completeTodo(id: todoId, idempotencyKey: "elsewhere", now: now)

        await home.complete(row)
        XCTAssertEqual(home.snapshot.moments.first?.refusal, "Already finished")

        home.dismissRefusal(todoId)

        XCTAssertNil(home.snapshot.moments.first?.refusal)
    }

    func testShouldSurviveDismissingARefusalThatIsNotThere() async throws {
        try store.upsert([todo()])
        let home = model()
        await home.refresh()

        home.dismissRefusal("syl:todo:nothing")

        XCTAssertNil(home.snapshot.moments.first?.refusal)
    }

    func testShouldKeepARefusalAcrossTheMinuteRefreshRatherThanBlinkingItAway() async throws {
        // The spine rebuilds itself every minute. A refusal that a scheduled refresh
        // wiped would be a message he might never have seen at all.
        try store.upsert([todo(status: .done)])
        let home = model()
        await home.complete(moment(todoId, title: "Book the dentist"))

        try store.upsert([todo()])
        await home.refresh()

        XCTAssertEqual(home.snapshot.moments.first?.refusal, "Already finished")
    }

    // MARK: - Pushing what he asked for

    func testShouldRunTheOutboxAfterACompletionRatherThanWaitForTheNextSync() async throws {
        try store.upsert([todo()])
        let flushed = Flushes()
        let home = model(flush: { await flushed.record() })
        await home.refresh()

        await home.complete(try XCTUnwrap(home.snapshot.moments.first))
        await home.awaitDeparture()

        let count = await flushed.count
        XCTAssertEqual(count, 1, "a tap he made should leave the device now, not in a minute")
    }

    func testShouldRunTheOutboxAfterADeferralToo() async throws {
        try store.upsert([reminder(fireAt: at(9, 30))])
        let flushed = Flushes()
        let home = model(flush: { await flushed.record() })
        await home.refresh()

        await home.postpone(try XCTUnwrap(home.snapshot.moments.first))

        let count = await flushed.count
        XCTAssertEqual(count, 1)
    }

    func testShouldNotPushAnythingWhenTheWriteWasRefused() async throws {
        try store.upsert([todo(status: .done)])
        let flushed = Flushes()
        let home = model(flush: { await flushed.record() })

        await home.complete(moment(todoId, title: "Book the dentist"))

        let count = await flushed.count
        XCTAssertEqual(count, 0)
    }
}

/// Counts flushes across actor hops without tripping Swift 6's concurrency checking.
private actor Flushes {
    private(set) var count = 0
    func record() { count += 1 }
}
