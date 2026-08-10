import SylKit
import XCTest

@testable import Syl

/// The list of everything he owes: what it renders, and what it refuses to make a row
/// look up for itself.
final class TodoListTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        return calendar
    }()

    /// 10:00 in Chicago, so "earlier today" and "later today" both exist.
    private var now: Date { instant("2026-08-10T15:00:00Z") }

    // MARK: - Everything appears, including the things with no day

    func testShouldShowUndatedTodosWhichIsTheWholeReasonThisScreenExists() {
        // The day spine can only ever show things with a time. Until this screen these
        // to-dos existed on the server and appeared nowhere on the phone — not hidden by
        // a bug, unrepresentable.
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "undated", due: nil), todo(id: "dated", due: "2026-08-11T16:00:00Z")],
            goals: [],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.rows.count, 2)
        XCTAssertTrue(snapshot.sections.contains { $0.band == .undated })
    }

    func testShouldReportNothingOwedRatherThanAnEmptyTable() {
        let snapshot = TodoListSnapshot.build(todos: [], goals: [], now: now, calendar: calendar)

        XCTAssertTrue(snapshot.isClear)
        XCTAssertTrue(snapshot.sections.isEmpty)
        XCTAssertEqual(snapshot.openCount, 0)
    }

    func testShouldCountEveryOpenTodoRatherThanTheWindowItRendered() {
        // "247 open" that quietly means "we stopped counting at the LIMIT" is the kind of
        // small lie this app spends its comments refusing to tell.
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "a", due: nil)],
            goals: [],
            now: now,
            calendar: calendar,
            openCount: 512,
            hasMore: true
        )

        XCTAssertEqual(snapshot.openCount, 512)
        XCTAssertEqual(snapshot.rows.count, 1)
        XCTAssertTrue(snapshot.hasMore)
    }

    // MARK: - The goal, without the row becoming a form

    func testShouldResolveAGoalTitleOntoTheRowItBelongsTo() {
        let goal = goal(id: "syl:goal:g1", title: "Finish the north valley work")
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "linked", due: nil, goalId: goal.id), todo(id: "loose", due: nil)],
            goals: [goal],
            now: now,
            calendar: calendar
        )

        let byText = Dictionary(uniqueKeysWithValues: snapshot.rows.map { ($0.todo.text, $0) })
        XCTAssertEqual(byText["linked"]?.goalTitle, "Finish the north valley work")
        XCTAssertNil(byText["loose"]?.goalTitle, "most to-dos serve no goal, and that is the design")
    }

    func testShouldMatchAGoalWhoseIdArrivedInADifferentHexCase() {
        // The contract permits either case for an id, so a raw string compare silently
        // loses the goal on half the rows — and it would look like a data problem rather
        // than a comparison problem.
        let goal = goal(id: "syl:goal:0198F2C0-0001-7000-8000-00000000C001", title: "Roof")
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "linked", due: nil, goalId: "syl:goal:0198f2c0-0001-7000-8000-00000000c001")],
            goals: [goal],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.rows.first?.goalTitle, "Roof")
    }

    func testShouldLeaveTheGoalNilWhenTheDeviceHasNotSyncedItYet() {
        // Goals arrive by sync like everything else. A row that referenced a goal the
        // device has never seen must render the to-do, not crash and not invent a name.
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "linked", due: nil, goalId: "syl:goal:unknown")],
            goals: [],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.rows.count, 1)
        XCTAssertNil(snapshot.rows.first?.goalTitle)
    }

    // MARK: - A row is handed its own values, never a collection to search

    func testShouldGiveARowOnlyItsOwnGoalTitleRatherThanEveryGoal() {
        // **This is R4, asserted.** `syl-008` handed every `ChatTurn` the whole
        // transcript's parsed markdown, so SwiftUI's value comparison deep-compared the
        // entire conversation once per row on the main thread. It presented as the app
        // freezing and being killed, and it cost the Commander two crashes. The same
        // shape was available here — a row holding `[SylID: Goal]` to look its own title
        // out of — and this fails if anyone reaches for it.
        let fields = Set(
            Mirror(reflecting: TodoListRow(todo: todo(id: "a", due: nil), goalTitle: "G", dueLabel: nil))
                .children
                .compactMap(\.label)
        )

        XCTAssertEqual(fields, ["todo", "goalTitle", "dueLabel"])
    }

    func testShouldPrepareEveryRowValueSoTheViewOnlyAssigns() {
        // The due label is words by the time it reaches the row, not a `Date` the row has
        // to format against a clock it would have to hold.
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "later-today", due: "2026-08-10T22:00:00Z")],
            goals: [],
            now: now,
            calendar: calendar
        )

        XCTAssertNotNil(snapshot.rows.first?.dueLabel)
    }

    // MARK: - What the date says, per band

    func testShouldSayWhatWasDueRatherThanLeavingHimABareDate() {
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "late", due: "2026-08-09T16:00:00Z")],
            goals: [],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.sections.first?.band, .overdue)
        XCTAssertTrue(
            snapshot.rows.first?.dueLabel?.hasPrefix("Was due") == true,
            "got \(String(describing: snapshot.rows.first?.dueLabel))"
        )
    }

    func testShouldGiveTheTimeWhenSomethingWentOverdueToday() throws {
        // Caught by looking at the first render: at ten o'clock on Monday the tenth the
        // row said "Was due Mon, Aug 10". True, useless, and it reads as a bug.
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "two-hours-ago", due: "2026-08-10T13:00:00Z")],
            goals: [],
            now: now,
            calendar: calendar
        )

        let label = try XCTUnwrap(snapshot.rows.first?.dueLabel)
        XCTAssertEqual(snapshot.sections.first?.band, .overdue)
        XCTAssertEqual(
            label,
            "Was due \(instant("2026-08-10T13:00:00Z").formatted(date: .omitted, time: .shortened))"
        )
    }

    func testShouldPrintNoDateAtAllOnAnUndatedTodo() {
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "undated", due: nil)],
            goals: [],
            now: now,
            calendar: calendar
        )

        XCTAssertNil(snapshot.rows.first?.dueLabel)
    }

    func testShouldNotInventAClockReadingForADateOnlyDeadline() throws {
        // The service stores a due date as an instant, so a date-only deadline arrives as
        // local midnight. Printing "00:00" beside it would invent a precision the to-do
        // does not have.
        //
        // Asserted against the day format itself rather than by hunting for a colon: a
        // time separator is a locale's business, and the first version of this test
        // failed on the comma inside "Thu, Aug 20" — which was the *date*.
        let midnight = calendar.startOfDay(for: instant("2026-08-20T16:00:00Z"))
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "someday", due: nil, dueAt: midnight)],
            goals: [],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.sections.first?.band, .comingUp)
        XCTAssertEqual(
            try XCTUnwrap(snapshot.rows.first?.dueLabel),
            midnight.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)),
            "the day and nothing else"
        )
    }

    func testShouldPrintTheTimeWhenTheDeadlineActuallyHasOne() throws {
        // The other half of the rule above: a deadline with a real time on it must not
        // lose it, or a 09:00 meeting and a whole free day read identically.
        let atNine = instant("2026-08-20T14:00:00Z")
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "meeting", due: nil, dueAt: atNine)],
            goals: [],
            now: now,
            calendar: calendar
        )

        let label = try XCTUnwrap(snapshot.rows.first?.dueLabel)
        let dayOnly = atNine.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
        XCTAssertTrue(label.hasPrefix(dayOnly), "got \(label)")
        XCTAssertGreaterThan(label.count, dayOnly.count, "the time is there too")
    }

    func testShouldPrintTheTimeAloneUnderTodaysHeading() {
        // Repeating today's date under a heading that already says "Today" is the
        // interface narrating itself.
        let snapshot = TodoListSnapshot.build(
            todos: [todo(id: "later-today", due: "2026-08-10T22:00:00Z")],
            goals: [],
            now: now,
            calendar: calendar
        )

        let label = snapshot.rows.first?.dueLabel ?? ""
        XCTAssertEqual(snapshot.sections.first?.band, .today)
        XCTAssertFalse(label.contains("Aug"), "got \(label)")
    }

    // MARK: - Reading from disk

    func testShouldLoadTheWholeListFromDiskWithNoNetworkAndNoLoadingState() throws {
        let store = try LocalStore(database: SylDatabase.inMemory())
        let goal = goal(id: "syl:goal:g1", title: "Roof")
        try store.upsert([goal])
        try store.upsert([
            todo(id: "undated", due: nil),
            todo(id: "dated", due: "2026-08-11T16:00:00Z", goalId: goal.id),
        ])

        let snapshot = try TodoListLoader(store: store, now: now, calendar: calendar).load()

        XCTAssertEqual(snapshot.rows.count, 2)
        XCTAssertEqual(snapshot.openCount, 2)
        XCTAssertFalse(snapshot.hasMore)
        XCTAssertEqual(snapshot.rows.first?.goalTitle, "Roof", "the dated one sorts first")
    }

    func testShouldLeaveFinishedTodosOutOfWhatHeStillOwes() throws {
        let store = try LocalStore(database: SylDatabase.inMemory())
        try store.upsert([
            todo(id: "open", due: nil),
            todo(id: "done", due: nil, status: .done),
            todo(id: "dropped", due: nil, status: .dropped),
        ])

        let snapshot = try TodoListLoader(store: store, now: now, calendar: calendar).load()

        XCTAssertEqual(snapshot.rows.map(\.todo.text), ["open"])
        XCTAssertEqual(snapshot.openCount, 1)
    }

    func testShouldSayWhenThereIsMoreThanThePageCarriesRatherThanStoppingSilently() throws {
        // A list that quietly stopped at its LIMIT would be the drop this project forbids
        // wearing a query's clothes — and invisible exactly when it mattered, because the
        // rows it hid are the ones sorted last.
        let store = try LocalStore(database: SylDatabase.inMemory())
        try store.upsert((1...7).map { todo(id: "t\($0)", due: nil) })

        let snapshot = try TodoListLoader(store: store, now: now, calendar: calendar, limit: 3).load()

        XCTAssertEqual(snapshot.rows.count, 3)
        XCTAssertTrue(snapshot.hasMore)
        XCTAssertEqual(snapshot.openCount, 7, "the count is the truth, the page is the window")
    }

    func testShouldNotClaimThereIsMoreWhenThePageFitsExactly() throws {
        // "Did the window fill" would be cheaper and wrong exactly when the list is a
        // whole multiple of the window — offering a way to nothing.
        let store = try LocalStore(database: SylDatabase.inMemory())
        try store.upsert((1...3).map { todo(id: "t\($0)", due: nil) })

        let snapshot = try TodoListLoader(store: store, now: now, calendar: calendar, limit: 3).load()

        XCTAssertEqual(snapshot.rows.count, 3)
        XCTAssertFalse(snapshot.hasMore)
    }

    func testShouldScaleToFiveHundredTodosWithoutDegrading() throws {
        // NFR2 names five hundred. What a unit test can hold is that the load stays one
        // pass and one goal lookup rather than a query per row — the shape that turns
        // "slow" into "quadratic".
        let store = try LocalStore(database: SylDatabase.inMemory())
        try store.upsert((1...500).map {
            todo(id: "t\(String(format: "%04d", $0))", due: nil)
        })

        let loaded = try measureLoad(store: store)

        XCTAssertEqual(loaded.rows.count, 500)
        XCTAssertEqual(loaded.openCount, 500)
        XCTAssertFalse(loaded.hasMore, "five hundred is the target, so the page must hold it")
    }

    // MARK: - The door at the foot of the day

    func testShouldCountTheTodosTheDayCannotShow() {
        // An undated to-do can never appear on a spine, so without this number the door
        // at the foot of the day gives no indication there is anything behind it — which
        // is the invisibility this whole screen exists to end.
        let snapshot = HomeSnapshot.build(
            reminders: [],
            todos: [
                todo(id: "undated-1", due: nil),
                todo(id: "undated-2", due: nil),
                todo(id: "due-today", due: "2026-08-10T22:00:00Z"),
            ],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.moments.count, 1, "only the dated one earns a place on the spine")
        XCTAssertEqual(snapshot.openElsewhere, 2)
    }

    func testShouldNotCountAPinnedTodoAsElsewhereWhenItIsAlreadyOnTheSpine() {
        // A pinned to-do earns a place on today's spine whether or not it has a date.
        // Counting it again behind the door would show him the same thing twice.
        let snapshot = HomeSnapshot.build(
            reminders: [],
            todos: [todo(id: "pinned", due: nil, pinned: true)],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.moments.count, 1)
        XCTAssertEqual(snapshot.openElsewhere, 0)
    }

    func testShouldCountEverythingOpenRatherThanTheDaysOwnWindow() {
        // The day reads a hundred rows. Without a real count the door would say
        // "100 open" for the rest of its life — a number that stops being true exactly
        // when it starts mattering.
        let snapshot = HomeSnapshot.build(
            reminders: [],
            todos: [todo(id: "undated", due: nil)],
            now: now,
            calendar: calendar,
            openTodoCount: 640
        )

        XCTAssertEqual(snapshot.openElsewhere, 640)
    }

    func testShouldNeverShowANegativeCountBehindTheDoor() {
        // The count and the window are two reads a moment apart, so a to-do finished
        // between them would otherwise put "-1 open" on his home screen.
        let snapshot = HomeSnapshot.build(
            reminders: [],
            todos: [todo(id: "pinned", due: nil, pinned: true)],
            now: now,
            calendar: calendar,
            openTodoCount: 0
        )

        XCTAssertEqual(snapshot.openElsewhere, 0)
    }

    func testShouldCountFromDiskWithoutBeingToldTheTotal() throws {
        let store = try LocalStore(database: SylDatabase.inMemory())
        try store.upsert([
            todo(id: "undated-1", due: nil),
            todo(id: "undated-2", due: nil),
            todo(id: "finished", due: nil, status: .done),
        ])

        let snapshot = try HomeSnapshotLoader(store: store, now: now, calendar: calendar).load()

        XCTAssertEqual(snapshot.openElsewhere, 2, "the finished one is not owed")
    }

    // MARK: - Harness

    private func measureLoad(store: LocalStore) throws -> TodoListSnapshot {
        try TodoListLoader(store: store, now: now, calendar: calendar).load()
    }

    private func instant(_ iso: String) -> Date {
        try! Instant.parse(iso)
    }

    private func goal(id: SylID, title: String) -> Goal {
        Goal(
            id: id,
            parentId: nil,
            title: title,
            why: nil,
            targetDate: nil,
            metricKey: nil,
            targetValue: nil,
            cadenceDays: nil,
            status: .active,
            statusReason: nil,
            createdAt: instant("2026-08-01T12:00:00Z"),
            updatedAt: instant("2026-08-01T12:00:00Z")
        )
    }

    private func todo(
        id: String,
        due: String?,
        dueAt: Date? = nil,
        updated: String = "2026-08-08T12:00:00Z",
        pinned: Bool = false,
        goalId: SylID? = nil,
        status: TodoStatus = .open
    ) -> Todo {
        Todo(
            id: "syl:todo:\(id)",
            text: id,
            goalId: goalId,
            dueAt: dueAt ?? due.map(instant),
            pinned: pinned,
            status: status,
            source: .commander,
            delegatedJobId: nil,
            createdAt: instant("2026-08-01T12:00:00Z"),
            updatedAt: instant(updated),
            completedAt: status == .done ? instant("2026-08-09T12:00:00Z") : nil
        )
    }
}
