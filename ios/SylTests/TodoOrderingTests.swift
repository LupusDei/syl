import SylKit
import XCTest

@testable import Syl

/// How the list of everything he owes reads down the page.
///
/// The calendar and `now` are pinned in every test. Banding is a wall-clock question —
/// "is this due today" — and a test that reads the device calendar is a test that passes
/// in Chicago and fails in Auckland.
final class TodoOrderingTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        return calendar
    }()

    /// Mid-morning, so "earlier today" and "later today" both exist on the same day.
    private var now: Date { instant("2026-08-10T15:00:00Z") }   // 10:00 in Chicago

    // MARK: - Deadline outranks the pin

    func testShouldPutADeadlineAboveAPinnedTodoWithNoDate() {
        // **The case that settled the precedence.** Pin "call the roofer" with no date,
        // have "file the taxes" due in two hours, and a pinned-first list puts the roofer
        // on top. That is not the list honouring his pin, it is the list lying about what
        // is urgent.
        let ordered = TodoOrdering.order([
            todo(id: "roofer", due: nil, pinned: true),
            todo(id: "taxes", due: "2026-08-10T17:00:00Z"),
        ])

        XCTAssertEqual(ordered.map(\.id), ["syl:todo:taxes", "syl:todo:roofer"])
    }

    func testShouldNotLetAPinJumpAToDoAheadOfASoonerDeadline() {
        // The same rule inside the dated group, which is where an ORDER BY of
        // `dueAt IS NULL, pinned DESC, dueAt` would still get it wrong.
        let ordered = TodoOrdering.order([
            todo(id: "pinned-next-month", due: "2026-09-10T16:00:00Z", pinned: true),
            todo(id: "due-in-an-hour", due: "2026-08-10T16:00:00Z"),
        ])

        XCTAssertEqual(ordered.map(\.id), ["syl:todo:due-in-an-hour", "syl:todo:pinned-next-month"])
    }

    func testShouldPutTheSoonestDeadlineFirst() {
        let ordered = TodoOrdering.order([
            todo(id: "later", due: "2026-08-14T16:00:00Z"),
            todo(id: "sooner", due: "2026-08-11T16:00:00Z"),
            todo(id: "soonest", due: "2026-08-10T16:00:00Z"),
        ])

        XCTAssertEqual(ordered.map(\.id).map(bare), ["soonest", "sooner", "later"])
    }

    // MARK: - The pin is an elevator

    func testShouldLiftAPinnedTodoAboveItsEqualsRatherThanAboveEverything() {
        // Capture writes every column except the text as null, so the undated group is
        // where most of his to-dos live — and it is where the pin does its work.
        let ordered = TodoOrdering.order([
            todo(id: "fresh", due: nil, updated: "2026-08-10T14:00:00Z"),
            todo(id: "pinned", due: nil, updated: "2026-08-01T12:00:00Z", pinned: true),
        ])

        XCTAssertEqual(
            ordered.map(\.id).map(bare),
            ["pinned", "fresh"],
            "pinned beats recency, having already lost to every deadline"
        )
    }

    func testShouldBreakATieBetweenTwoIdenticalDeadlinesWithThePin() {
        let ordered = TodoOrdering.order([
            todo(id: "plain", due: "2026-08-11T16:00:00Z"),
            todo(id: "pinned", due: "2026-08-11T16:00:00Z", pinned: true),
        ])

        XCTAssertEqual(ordered.map(\.id).map(bare), ["pinned", "plain"])
    }

    // MARK: - Undated to-dos land somewhere sane

    func testShouldLandAnUndatedTodoAfterEveryDatedOneRatherThanAtTheTop() {
        // SQLite orders NULLs FIRST by default, which put every undated to-do above the
        // one due in an hour. It was a real defect in `openTodos`; this is the pure
        // statement of the same rule.
        let ordered = TodoOrdering.order([
            todo(id: "undated", due: nil),
            todo(id: "next-year", due: "2027-01-01T16:00:00Z"),
        ])

        XCTAssertEqual(ordered.map(\.id).map(bare), ["next-year", "undated"])
    }

    func testShouldPutTheMostRecentlyTouchedFirstAmongUndatedTodos() {
        // The last term is recency, not age, and capture is why. The capture field sits
        // at the head of this list; a to-do he just wrote down that sorted to the bottom
        // of five hundred undated rows would look exactly like a capture that did nothing.
        let ordered = TodoOrdering.order([
            todo(id: "old", due: nil, updated: "2026-08-01T12:00:00Z"),
            todo(id: "just-captured", due: nil, updated: "2026-08-10T14:59:00Z"),
            todo(id: "middling", due: nil, updated: "2026-08-05T12:00:00Z"),
        ])

        XCTAssertEqual(ordered.map(\.id).map(bare), ["just-captured", "middling", "old"])
    }

    // MARK: - Nothing is read that does not exist

    func testShouldReadNoStoredPriorityBecauseNoneExists() {
        // Not a tautology: it is the assertion that fails the day someone adds a priority
        // column and reaches for it here. `Todo` carries exactly one durable signal of
        // importance and this names it.
        let fields = Set(Mirror(reflecting: todo(id: "a", due: nil)).children.compactMap(\.label))

        XCTAssertTrue(fields.contains("pinned"))
        XCTAssertFalse(fields.contains("priority"))
        XCTAssertFalse(fields.contains("importance"))
        XCTAssertFalse(fields.contains("urgency"))
        XCTAssertFalse(fields.contains("rank"))
    }

    // MARK: - Shape

    func testShouldOrderAnEmptyListWithoutComplaint() {
        XCTAssertTrue(TodoOrdering.order([]).isEmpty)
    }

    func testShouldKeepEveryTodoItWasGiven() {
        // An ordering that drops a row is the silent loss this project forbids, wearing
        // a sort's clothes.
        let input = shuffledFixture
        XCTAssertEqual(Set(TodoOrdering.order(input).map(\.id)), Set(input.map(\.id)))
    }

    func testShouldBeStableSoTiedRowsDoNotReshuffleBetweenLoads() {
        // Two rows identical in every ordering term. A list that reorders them on each
        // refresh reads as a glitch.
        let first = todo(id: "first", due: "2026-08-11T16:00:00Z", updated: "2026-08-09T12:00:00Z")
        let second = todo(id: "second", due: "2026-08-11T16:00:00Z", updated: "2026-08-09T12:00:00Z")

        XCTAssertEqual(TodoOrdering.order([first, second]).map(\.id).map(bare), ["first", "second"])
        XCTAssertEqual(TodoOrdering.order([second, first]).map(\.id).map(bare), ["second", "first"])
    }

    // MARK: - Bands

    func testShouldSeparateWhatHeIsLateOnFromWhatIsStillToCome() {
        let sections = TodoOrdering.sections(
            for: [
                todo(id: "late", due: "2026-08-10T13:00:00Z"),         // 08:00, an hour ago
                todo(id: "later-today", due: "2026-08-10T22:00:00Z"),  // 17:00
            ],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(sections.map(\.band), [.overdue, .today])
        XCTAssertEqual(sections.first?.todos.map(\.id).map(bare), ["late"])
    }

    func testShouldNotGivePinnedABandOfItsOwn() {
        // A "Pinned" heading at the top would reintroduce pinned-first through the back
        // door — a to-do due this morning sitting below one he pinned last March.
        let sections = TodoOrdering.sections(
            for: [
                todo(id: "overdue", due: "2026-08-01T13:00:00Z"),
                todo(id: "pinned", due: nil, pinned: true),
            ],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(sections.map(\.band), [.overdue, .undated])
    }

    func testShouldPutUndatedTodosInTheirOwnBandLast() {
        let sections = TodoOrdering.sections(
            for: [
                todo(id: "undated", due: nil),
                todo(id: "next-week", due: "2026-08-20T16:00:00Z"),
            ],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(sections.map(\.band), [.comingUp, .undated])
    }

    func testShouldBandTheDayAtLocalMidnightRatherThanUTC() {
        // 04:00 UTC on the 11th is still the evening of the 10th in Chicago. Banding on
        // UTC would file tonight's to-do under "coming up" — the exact reason this
        // project stores IANA zones rather than offsets.
        let sections = TodoOrdering.sections(
            for: [todo(id: "tonight", due: "2026-08-11T04:00:00Z")],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(sections.map(\.band), [.today])
    }

    func testShouldDropEmptyBandsRatherThanDrawHeadingsOverNothing() {
        let sections = TodoOrdering.sections(
            for: [todo(id: "undated", due: nil)],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(sections.map(\.band), [.undated])
    }

    func testShouldProduceNoSectionsForAClearList() {
        XCTAssertTrue(TodoOrdering.sections(for: [], now: now, calendar: calendar).isEmpty)
    }

    func testShouldNameEveryBandInWordsHeWouldUse() {
        XCTAssertEqual(
            TodoOrdering.Band.allCases.map(\.title),
            ["Overdue", "Today", "Coming up", "No date"]
        )
    }

    // MARK: - Bands are a presentation of the order, never a reordering of it

    func testShouldReadTopToBottomInExactlyTheFlatOrder() {
        // The load-bearing invariant. Sections exist so five hundred rows have signposts;
        // if banding could reorder anything, the headings would be lying about the rule
        // the flat function states.
        let input = shuffledFixture

        let flattened = TodoOrdering.sections(for: input, now: now, calendar: calendar)
            .flatMap(\.todos)
            .map(\.id)

        XCTAssertEqual(flattened, TodoOrdering.order(input).map(\.id))
    }

    // MARK: - Agreement with the disk

    func testShouldOrderExactlyAsOpenTodosDoes() throws {
        // **This is the test that stops a silent, invisible defect.**
        //
        // `openTodos` takes a LIMIT, so SQLite chooses *which* rows the list ever sees.
        // If the pure function disagreed with that ORDER BY, the database would pick the
        // wrong hundred out of five hundred and this function would then arrange the
        // wrong hundred immaculately. Nothing on screen would look broken; to-dos would
        // simply never appear. So the two are asserted equal against a real database
        // rather than trusted to stay in step.
        let store = try LocalStore(database: SylDatabase.inMemory())
        try store.upsert(shuffledFixture)

        let fromDisk = try store.openTodos(limit: 100)

        XCTAssertEqual(
            TodoOrdering.order(fromDisk).map(\.id),
            fromDisk.map(\.id),
            "TodoOrdering must be a no-op on what openTodos already returned"
        )
    }

    func testShouldChooseTheSameRowsAsTheDatabaseDoesUnderALimit() throws {
        // The failure above, made concrete: order everything by hand, take the top three,
        // and check the database's own top three is the same three.
        let store = try LocalStore(database: SylDatabase.inMemory())
        try store.upsert(shuffledFixture)

        let byHand = TodoOrdering.order(shuffledFixture).prefix(3).map(\.id)
        let byDisk = try store.openTodos(limit: 3).map(\.id)

        XCTAssertEqual(Array(byHand), byDisk)
    }

    // MARK: - Agreement with the goal read, which is a second copy of the same hazard

    func testShouldOrderAGoalsTodosExactlyAsTheGoalReadDoes() throws {
        // **`todos(goalId:)` is the same hazard on a second read, and the consequence is
        // worse.** It carries its own `limit` (200), and it is where a goal's *evidence*
        // comes from — so a disagreement here does not scramble a page, it makes a goal
        // quietly under-report what has actually happened on it. That is precisely the
        // failure US4 exists to prevent, arriving through the back door.
        //
        // The two reads share an `ORDER BY` string today. That is enough today, and it
        // stops being enough the moment someone tunes one and not the other — which is
        // exactly how these two got out of step in the first place.
        let store = try LocalStore(database: SylDatabase.inMemory())
        try store.upsert(evidenceFixture)

        let fromDisk = try store.todos(goalId: goalUnderTest)

        XCTAssertEqual(
            TodoOrdering.order(fromDisk).map(\.id),
            fromDisk.map(\.id),
            "TodoOrdering must be a no-op on what todos(goalId:) already returned"
        )
    }

    func testShouldChooseTheSameEvidenceAsTheDatabaseDoesUnderALimit() throws {
        let store = try LocalStore(database: SylDatabase.inMemory())
        try store.upsert(evidenceFixture)

        let byHand = TodoOrdering.order(evidenceFixture.filter { $0.goalId == goalUnderTest })
            .prefix(3)
            .map(\.id)
        let byDisk = try store.todos(goalId: goalUnderTest, limit: 3).map(\.id)

        XCTAssertEqual(Array(byHand), byDisk)
    }

    func testShouldOrderFinishedWorkByTheSameRuleAsOpenWork() throws {
        // The case `openTodos` can never reach. Evidence is *mostly* finished work, so the
        // goal read deliberately returns closed rows — and `TodoOrdering` reads no status
        // at all, which is only correct if the database does not either. If a `status`
        // term ever appeared in one of them, the parity tests above would catch it and
        // this one says why it would matter.
        let store = try LocalStore(database: SylDatabase.inMemory())
        try store.upsert(evidenceFixture)

        let fromDisk = try store.todos(goalId: goalUnderTest)

        XCTAssertTrue(
            fromDisk.contains { $0.status == .done },
            "the precondition: closed work is part of the evidence"
        )
        XCTAssertEqual(TodoOrdering.order(fromDisk).map(\.id), fromDisk.map(\.id))
    }

    // MARK: - Harness

    private let goalUnderTest: SylID = "syl:goal:0198f2c3-0001-7000-8000-00000000d001"

    /// What a goal's evidence is made of: finished work, dropped work, and what is still
    /// open — plus a to-do belonging to a *different* goal, so a query that forgot its
    /// filter would be visible rather than merely lucky.
    private var evidenceFixture: [Todo] {
        [
            todo(id: "e-open-undated", due: nil, updated: "2026-08-02T12:00:00Z", goalId: goalUnderTest),
            todo(id: "b-done-dated", due: "2026-08-09T16:00:00Z", goalId: goalUnderTest, status: .done),
            todo(id: "d-open-pinned", due: nil, updated: "2026-08-06T12:00:00Z", pinned: true, goalId: goalUnderTest),
            todo(id: "a-done-earlier", due: "2026-08-03T16:00:00Z", goalId: goalUnderTest, status: .done),
            todo(id: "c-dropped", due: "2026-08-15T16:00:00Z", goalId: goalUnderTest, status: .dropped),
            todo(id: "z-other-goal", due: "2026-08-04T16:00:00Z", goalId: "syl:goal:0198f2c3-0001-7000-8000-00000000d002"),
        ]
    }

    /// One of every case that matters, in an order that is not the answer: pinned and
    /// not, dated and not, overdue and future, and no two rows tied on every term.
    ///
    /// Expected order: `b-overdue`, `d-later-today`, `f-pinned-dated`, `e-next-week`,
    /// `g-pinned-undated`, `a-undated-fresh`, `c-undated-old`.
    private var shuffledFixture: [Todo] {
        [
            todo(id: "c-undated-old", due: nil, updated: "2026-08-02T12:00:00Z"),
            todo(id: "b-overdue", due: "2026-08-09T16:00:00Z"),
            todo(id: "f-pinned-dated", due: "2026-08-12T16:00:00Z", pinned: true),
            todo(id: "d-later-today", due: "2026-08-10T22:00:00Z"),
            todo(id: "a-undated-fresh", due: nil, updated: "2026-08-09T12:00:00Z"),
            todo(id: "e-next-week", due: "2026-08-19T16:00:00Z"),
            todo(id: "g-pinned-undated", due: nil, updated: "2026-08-03T12:00:00Z", pinned: true),
        ]
    }

    private func instant(_ iso: String) -> Date {
        try! Instant.parse(iso)
    }

    /// Strips the `syl:todo:` prefix so a failure prints the name of the row that moved.
    private func bare(_ id: SylID) -> String {
        String(id.dropFirst("syl:todo:".count))
    }

    /// Ids are readable rather than realistic on purpose — a failing assertion should say
    /// which row moved, not print two UUIDs.
    private func todo(
        id: String,
        due: String?,
        updated: String = "2026-08-08T12:00:00Z",
        pinned: Bool = false,
        goalId: SylID? = nil,
        status: TodoStatus = .open
    ) -> Todo {
        Todo(
            id: "syl:todo:\(id)",
            text: id,
            goalId: goalId,
            dueAt: due.map(instant),
            pinned: pinned,
            status: status,
            source: .commander,
            delegatedJobId: nil,
            createdAt: instant("2026-08-01T12:00:00Z"),
            updatedAt: instant(updated),
            completedAt: status == .done ? instant("2026-08-09T18:00:00Z") : nil
        )
    }
}
