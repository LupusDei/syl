import GRDB
import SylKit
import XCTest

@testable import Syl

/// Goals on the device (`syl-011.1.1`, `syl-011.1.3`).
///
/// The phone had no `goal` table at all, and the sync engine dropped every goal change
/// on the floor. A goal screen written before this is a screen that must hit the network
/// to show anything, which breaks local-first on its first frame.
final class GoalStoreTests: XCTestCase {
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

    // MARK: - The shape of the table

    func testShouldCreateAGoalTableOnAFreshDatabase() throws {
        let tables = try database.queue.read { db in
            try Set(String.fetchAll(db, sql: "SELECT name FROM sqlite_master WHERE type = 'table'"))
        }

        XCTAssertTrue(tables.contains("goal"))
    }

    /// **The two refusals, asserted rather than commented.**
    ///
    /// `backend/src/migrations/0009_todos_goals.sql` states both in its header:
    /// self-reported percentages are fiction and they decay, and priority is a property
    /// of a moment rather than of a task. A column is the easiest possible place for
    /// either to creep back in, so the schema is the thing under test.
    func testShouldHaveNoPercentCompleteAndNoPriorityColumnOnAGoal() throws {
        let columns = try goalColumns()

        for forbidden in ["percentcomplete", "percent_complete", "progress", "priority"] {
            XCTAssertFalse(
                columns.contains(forbidden),
                "`\(forbidden)` is refused by design — progress is evidenced, never asserted"
            )
        }
    }

    func testShouldCarryTheColumnsTheGoalSurfacesFilterAndSortOn() throws {
        let columns = try goalColumns()

        for expected in ["id", "parentid", "title", "targetdate", "status", "updatedat", "payload"] {
            XCTAssertTrue(columns.contains(expected), "missing column \(expected)")
        }
    }

    /// A child goal routinely arrives before its parent, because `GET /sync` pages by
    /// `updatedAt` and knows nothing about the hierarchy. With `PRAGMA foreign_keys = ON`
    /// a real reference would make that upsert throw, the change would be reported as
    /// unreadable, and the goal would simply never appear.
    func testShouldAcceptAChildGoalWhoseParentHasNotArrivedYet() throws {
        let orphan = goal(
            id: "syl:goal:0198f2c3-0002-7000-8000-00000000d002",
            title: "Ship the list",
            parentId: "syl:goal:0198f2c3-0009-7000-8000-00000000d009"
        )

        XCTAssertNoThrow(try store.upsert([orphan]))
        XCTAssertEqual(try store.goals().count, 1, "sync order must never cost him a goal")
    }

    /// The schema, not the behaviour, because the behaviour cannot fail here.
    ///
    /// `SylDatabase.inMemory` — which every store test uses — does not set
    /// `PRAGMA foreign_keys = ON`; only `onDisk` does. So a `REFERENCES goals (id)` added
    /// to this table later would pass the test above and then drop goals on the
    /// Commander's actual phone. Asserting the pragma's own view of the table is the only
    /// version of this check that runs where the divergence lives.
    func testShouldDeclareNoForeignKeyOnAGoalsParent() throws {
        let references = try database.queue.read { db in
            try Row.fetchAll(db, sql: "PRAGMA foreign_key_list(goal)")
        }

        XCTAssertTrue(
            references.isEmpty,
            "a child arrives before its parent on every sync page that is ordered by time"
        )
    }

    func testShouldMigrateAnExistingDatabaseWithoutLosingItsTodos() throws {
        // The goal table arrives as a migration on top of a database that already holds
        // his to-dos. Losing them on upgrade day would be the worst possible outcome of
        // adding a feature.
        try store.upsert([todo(id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001")])

        try SylDatabase.migrator.migrate(database.queue)

        XCTAssertEqual(try store.openTodos().count, 1)
    }

    // MARK: - Reads

    func testShouldOrderGoalsByTargetDateThenTitle() throws {
        try store.upsert([
            goal(
                id: "syl:goal:0198f2c3-0003-7000-8000-00000000d003", title: "Zebra",
                target: "2026-09-01"),
            goal(
                id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001", title: "Apple",
                target: "2026-09-01"),
            goal(
                id: "syl:goal:0198f2c3-0002-7000-8000-00000000d002", title: "Marathon",
                target: "2026-08-15"),
        ])

        XCTAssertEqual(try store.goals().map(\.title), ["Marathon", "Apple", "Zebra"])
    }

    /// SQLite sorts NULLs first, which is exactly backwards for this question — the
    /// server's `todos_agenda_idx` says so in as many words. A goal with no date is not
    /// more urgent than one due this month.
    func testShouldSortAGoalWithNoTargetDateAfterEveryDatedOne() throws {
        try store.upsert([
            goal(
                id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001", title: "Someday", target: nil),
            goal(
                id: "syl:goal:0198f2c3-0002-7000-8000-00000000d002", title: "Marathon",
                target: "2027-01-01"),
        ])

        XCTAssertEqual(try store.goals().map(\.title), ["Marathon", "Someday"])
    }

    func testShouldReturnEveryGoalIncludingTheAbandonedOnes() throws {
        // `abandoned` is a first-class, non-shameful outcome with its history intact.
        // A read that hid it would be the accumulated-guilt design proposal B refuses.
        try store.upsert([
            goal(
                id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001", title: "Marathon",
                status: .abandoned),
            goal(
                id: "syl:goal:0198f2c3-0002-7000-8000-00000000d002", title: "Novel",
                status: .active),
        ])

        XCTAssertEqual(try store.goals().count, 2)
    }

    func testShouldReadOneGoalBackWithEveryFieldIntact() throws {
        try store.upsert([
            goal(
                id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001",
                title: "Run a marathon",
                target: "2027-04-18",
                why: "Because I said I would."
            )
        ])

        let stored = try XCTUnwrap(
            try store.goal(id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001"))

        XCTAssertEqual(stored.title, "Run a marathon")
        XCTAssertEqual(stored.why, "Because I said I would.")
        XCTAssertEqual(stored.targetDate, "2027-04-18")
        XCTAssertEqual(stored.cadenceDays, 7)
    }

    func testShouldReportNoGoalForAnIdItHasNeverSeen() throws {
        XCTAssertNil(try store.goal(id: "syl:goal:0198f2c3-0009-7000-8000-00000000d009"))
    }

    func testShouldMatchAGoalIdRegardlessOfHexCase() throws {
        // The contract's `Id` pattern permits either case and the service accepts both.
        // Two spellings the contract says are the same resource must not be two rows.
        try store.upsert([
            goal(id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001", title: "Marathon")
        ])

        XCTAssertNotNil(try store.goal(id: "syl:goal:0198F2C3-0001-7000-8000-00000000D001"))
    }

    func testShouldReplaceAGoalRatherThanDuplicateItWhenItArrivesTwice() throws {
        // Sync pages overlap by design.
        let goal = goal(id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001", title: "Marathon")

        try store.upsert([goal])
        try store.upsert([goal])

        XCTAssertEqual(try store.goals().count, 1)
    }

    func testShouldRemoveAGoalOnADeleteChange() throws {
        try store.upsert([
            goal(id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001", title: "Marathon")
        ])

        try store.delete(type: .goal, id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001")

        XCTAssertTrue(try store.goals().isEmpty)
    }

    // MARK: - The link that makes progress evidenced

    func testShouldReturnTheTodosLinkedToAGoal() throws {
        try store.upsert([
            todo(
                id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001",
                goalId: "syl:goal:0198f2c3-0001-7000-8000-00000000d001"),
            todo(id: "syl:todo:0198f2c2-0002-7000-8000-00000000c002", goalId: nil),
            todo(
                id: "syl:todo:0198f2c2-0003-7000-8000-00000000c003",
                goalId: "syl:goal:0198f2c3-0002-7000-8000-00000000d002"),
        ])

        let linked = try store.todos(goalId: "syl:goal:0198f2c3-0001-7000-8000-00000000d001")

        XCTAssertEqual(linked.map(\.id), ["syl:todo:0198f2c2-0001-7000-8000-00000000c001"])
    }

    func testShouldReturnClosedTodosAsWellAsOpenOnesForAGoal() throws {
        // A goal's progress is evidenced by what actually happened, and what happened is
        // mostly things that are finished. A read that returned only open work would
        // show an active goal as though nothing had ever moved.
        try store.upsert([
            todo(
                id: "syl:todo:0198f2c2-0001-7000-8000-00000000c001",
                goalId: "syl:goal:0198f2c3-0001-7000-8000-00000000d001",
                status: .done
            ),
            todo(
                id: "syl:todo:0198f2c2-0002-7000-8000-00000000c002",
                goalId: "syl:goal:0198f2c3-0001-7000-8000-00000000d001",
                status: .open
            ),
        ])

        XCTAssertEqual(
            try store.todos(goalId: "syl:goal:0198f2c3-0001-7000-8000-00000000d001").count, 2)
    }

    func testShouldSayNothingHasHappenedForAGoalWithNothingLinked() throws {
        try store.upsert([
            goal(id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001", title: "Marathon")
        ])

        XCTAssertTrue(
            try store.todos(goalId: "syl:goal:0198f2c3-0001-7000-8000-00000000d001").isEmpty)
    }

    /// The column is written from the payload, so a to-do that arrived before the column
    /// existed still finds its goal. Without the backfill the link is silently empty on
    /// upgrade day and every goal claims nothing has happened.
    func testShouldBackfillTheGoalLinkFromRowsWrittenBeforeTheColumnExisted() throws {
        let id: SylID = "syl:todo:0198f2c2-0001-7000-8000-00000000c001"
        let goalId: SylID = "syl:goal:0198f2c3-0001-7000-8000-00000000d001"
        try store.upsert([todo(id: id, goalId: goalId)])
        // Blank the column without touching the payload, which is exactly the state a
        // database migrated from before this column existed is in.
        try database.queue.write { db in
            try db.execute(sql: "UPDATE todo SET goalId = NULL")
        }
        XCTAssertTrue(try store.todos(goalId: goalId).isEmpty, "the precondition this test needs")

        try database.queue.write { db in
            try SylDatabase.backfillTodoGoalLinks(db)
        }

        XCTAssertEqual(try store.todos(goalId: goalId).map(\.id), [id])
    }

    func testShouldSurviveOneUnreadableRowWhenBackfillingTheGoalLink() throws {
        // A payload the current decoder cannot read must cost one link, never the
        // migration — a migration that throws leaves the app unable to open at all.
        try database.queue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO todo (id, status, dueAt, pinned, updatedAt, payload)
                    VALUES ('syl:todo:0198f2c2-0009-7000-8000-00000000c009', 'open', NULL, 0,
                            '2026-08-09 06:59:48.300', X'7b7d')
                    """
            )
        }

        XCTAssertNoThrow(
            try database.queue.write { db in
                try SylDatabase.backfillTodoGoalLinks(db)
            })
    }

    // MARK: - Builders

    private func goalColumns() throws -> Set<String> {
        try database.queue.read { db in
            try Set(
                Row.fetchAll(db, sql: "PRAGMA table_info(goal)")
                    .compactMap { ($0["name"] as String?)?.lowercased() }
            )
        }
    }

    private func goal(
        id: SylID,
        title: String,
        parentId: SylID? = nil,
        target: LocalDate? = "2026-12-31",
        why: String? = nil,
        status: GoalStatus = .active
    ) -> Goal {
        let base = instant("2026-08-09T06:59:48.300Z")
        return Goal(
            id: id,
            parentId: parentId,
            title: title,
            why: why,
            targetDate: target,
            metricKey: nil,
            targetValue: nil,
            cadenceDays: 7,
            status: status,
            statusReason: nil,
            createdAt: base,
            updatedAt: base
        )
    }

    private func todo(
        id: SylID,
        goalId: SylID? = nil,
        status: TodoStatus = .open
    ) -> Todo {
        let base = instant("2026-08-09T06:59:48.300Z")
        return Todo(
            id: id,
            text: "Call the pharmacy about the refill",
            goalId: goalId,
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

    private func instant(_ text: String) -> Date {
        try! Instant.parse(text)
    }
}
