import GRDB
import SwiftUI
import SylKit
import XCTest

@testable import Syl

/// The goals screens, from disk (`syl-011.5.3`–`syl-011.5.6`).
///
/// Everything here goes through the real `LocalStore` and the real loader, because the
/// question these tests answer is not "does the projection work" — `GoalEvidenceTests`
/// and `GoalRiskTests` answer that — but "does the screen he opens say true things about
/// the rows actually on the device".
final class GoalSurfaceTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!

    private let calendar = GoalFixtures.calendar
    private let now = GoalFixtures.day("2026-06-01")

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

    // MARK: - The list

    func testShouldGroupGoalsByStandingWithWhatIsLiveFirst() throws {
        try store.upsert([
            GoalFixtures.goal(id: GoalFixtures.goalID(1), title: "Marathon", status: .active),
            GoalFixtures.goal(id: GoalFixtures.goalID(2), title: "Novel", status: .abandoned),
            GoalFixtures.goal(id: GoalFixtures.goalID(3), title: "Cello", status: .dormant),
            GoalFixtures.goal(id: GoalFixtures.goalID(4), title: "Kitchen", status: .achieved),
        ])

        let snapshot = try load()

        XCTAssertEqual(snapshot.sections.map(\.status), [.active, .dormant, .achieved, .abandoned])
    }

    /// **T027, at the level a view cannot get wrong.** The word is "Set down". Not
    /// "Abandoned", not "Failed", not "Dropped" — the reason proposal B made the state
    /// first-class is that accumulated guilt is what kills goal systems, and the label is
    /// where that survives or does not.
    func testShouldTitleTheAbandonedSectionAsSetDown() throws {
        try store.upsert([
            GoalFixtures.goal(id: GoalFixtures.goalID(1), title: "Novel", status: .abandoned)
        ])

        let snapshot = try load()

        XCTAssertEqual(snapshot.sections.first?.title, "Set down")
    }

    /// Nothing is filtered out. A list that quietly deletes what he stopped doing teaches
    /// him not to look at it, which is the same failure as one that shames him.
    func testShouldKeepAnAbandonedGoalOnTheListWithItsHistoryIntact() throws {
        try store.upsert([
            GoalFixtures.goal(id: GoalFixtures.goalID(1), title: "Novel", status: .abandoned)
        ])
        try store.upsert([
            GoalFixtures.todo(
                id: GoalFixtures.todoID(1), text: "Chapter four",
                goalId: GoalFixtures.goalID(1),
                completedAt: GoalFixtures.day("2026-02-01"))
        ])

        let row = try XCTUnwrap(load().row(id: GoalFixtures.goalID(1)))

        XCTAssertEqual(row.evidence.entries.count, 1, "history survives being set down")
        XCTAssertEqual(row.standingLabel, "Set down")
        XCTAssertTrue(row.risk.isQuiet, "a goal he set down is never nagged about")
    }

    func testShouldDropASectionWithNoGoalsInIt() throws {
        try store.upsert([
            GoalFixtures.goal(id: GoalFixtures.goalID(1), title: "Marathon", status: .active)
        ])

        let snapshot = try load()

        XCTAssertEqual(snapshot.sections.count, 1)
    }

    func testShouldReportAnEmptyListWhenThereAreNoGoalsAtAll() throws {
        XCTAssertTrue(try load().isEmpty)
    }

    // MARK: - The row's own line

    func testShouldSayNothingIsLinkedYetOnAGoalNothingHasHappenedOn() throws {
        try store.upsert([GoalFixtures.goal(id: GoalFixtures.goalID(1))])

        let row = try XCTUnwrap(load().row(id: GoalFixtures.goalID(1)))

        XCTAssertEqual(row.activityLine, "Nothing linked yet")
    }

    func testShouldCountTheDaysSinceSomethingLastMoved() throws {
        try store.upsert([GoalFixtures.goal(id: GoalFixtures.goalID(1))])
        try store.upsert([
            GoalFixtures.todo(
                id: GoalFixtures.todoID(1), goalId: GoalFixtures.goalID(1),
                completedAt: GoalFixtures.day("2026-05-01"))
        ])

        let row = try XCTUnwrap(load().row(id: GoalFixtures.goalID(1)))

        XCTAssertEqual(row.activityLine, "Last moved 31 days ago")
    }

    func testShouldSaySomethingMovedTodayRatherThanZeroDaysAgo() throws {
        try store.upsert([GoalFixtures.goal(id: GoalFixtures.goalID(1))])
        try store.upsert([
            GoalFixtures.todo(
                id: GoalFixtures.todoID(1), goalId: GoalFixtures.goalID(1),
                completedAt: GoalFixtures.day("2026-06-01", hour: 8))
        ])

        let row = try XCTUnwrap(load().row(id: GoalFixtures.goalID(1)))

        XCTAssertEqual(row.activityLine, "Something moved today")
    }

    /// "Last moved two hundred days ago" under something he consciously put down is a
    /// reproach. The row says what state it is in instead.
    func testShouldNotCountDaysOfSilenceOnAGoalThatIsNotActive() throws {
        try store.upsert([
            GoalFixtures.goal(id: GoalFixtures.goalID(1), status: .abandoned)
        ])

        let row = try XCTUnwrap(load().row(id: GoalFixtures.goalID(1)))

        XCTAssertEqual(row.activityLine, "Set down")
    }

    // MARK: - Nesting

    func testShouldCarryTheParentLinkOnAChildGoal() throws {
        try store.upsert([
            GoalFixtures.goal(id: GoalFixtures.goalID(1), title: "Be strong at fifty"),
            GoalFixtures.goal(
                id: GoalFixtures.goalID(2), parentId: GoalFixtures.goalID(1),
                title: "Run a marathon"),
        ])

        let child = try XCTUnwrap(load().row(id: GoalFixtures.goalID(2)))

        XCTAssertEqual(child.parent?.title, "Be strong at fifty")
        XCTAssertEqual(child.parent?.id, GoalFixtures.goalID(1))
    }

    func testShouldCarryTheChildrenOnAParentGoal() throws {
        try store.upsert([
            GoalFixtures.goal(id: GoalFixtures.goalID(1), title: "Be strong at fifty"),
            GoalFixtures.goal(
                id: GoalFixtures.goalID(2), parentId: GoalFixtures.goalID(1), title: "Marathon"),
            GoalFixtures.goal(
                id: GoalFixtures.goalID(3), parentId: GoalFixtures.goalID(1), title: "Deadlift"),
        ])

        let parent = try XCTUnwrap(load().row(id: GoalFixtures.goalID(1)))

        XCTAssertEqual(Set(parent.children.map(\.title)), ["Marathon", "Deadlift"])
    }

    /// A child routinely arrives before its parent, because `GET /sync` pages by
    /// `updatedAt` and knows nothing about the hierarchy. The parent link is simply
    /// absent until the parent lands, rather than the child vanishing.
    func testShouldRenderAChildWhoseParentHasNotArrivedYet() throws {
        try store.upsert([
            GoalFixtures.goal(
                id: GoalFixtures.goalID(2), parentId: GoalFixtures.goalID(9), title: "Marathon")
        ])

        let child = try XCTUnwrap(load().row(id: GoalFixtures.goalID(2)))

        XCTAssertNil(child.parent)
        XCTAssertEqual(child.goal.title, "Marathon")
    }

    /// The horizon is derived here too, not stored — the same fact asserted at the seam
    /// where a stored column would have been read.
    func testShouldDeriveTheHorizonOnEveryRow() throws {
        try store.upsert([
            GoalFixtures.goal(
                id: GoalFixtures.goalID(1), targetDate: "2026-01-20",
                createdAt: GoalFixtures.day("2026-01-01")),
            GoalFixtures.goal(id: GoalFixtures.goalID(2), targetDate: nil),
        ])

        let snapshot = try load()

        XCTAssertEqual(snapshot.row(id: GoalFixtures.goalID(1))?.horizon, .month)
        XCTAssertEqual(snapshot.row(id: GoalFixtures.goalID(2))?.horizon, .life)
    }

    /// The render harness found this one: `life` covers both "no date at all" and "a date
    /// more than a year out", and printing "No end date" beside `Jun 1, 2027` is a screen
    /// contradicting itself in the same line.
    func testShouldSayNoEndDateOnlyForAGoalThatActuallyHasNone() throws {
        try store.upsert([
            GoalFixtures.goal(
                id: GoalFixtures.goalID(1), targetDate: "2027-06-01",
                createdAt: GoalFixtures.day("2026-03-01")),
            GoalFixtures.goal(id: GoalFixtures.goalID(2), targetDate: nil),
        ])

        let snapshot = try load()

        XCTAssertEqual(snapshot.row(id: GoalFixtures.goalID(1))?.horizon, .life)
        XCTAssertEqual(snapshot.row(id: GoalFixtures.goalID(1))?.horizonLabel, "Beyond a year")
        XCTAssertEqual(snapshot.row(id: GoalFixtures.goalID(2))?.horizonLabel, "No end date")
    }

    // MARK: - The target date

    func testShouldSayATargetDateHasPassedRatherThanCallingItOverdue() throws {
        try store.upsert([
            GoalFixtures.goal(id: GoalFixtures.goalID(1), targetDate: "2026-03-01")
        ])

        let row = try XCTUnwrap(load().row(id: GoalFixtures.goalID(1)))

        XCTAssertEqual(row.targetNote, "That date has passed.")
        XCTAssertEqual(row.daysUntilTarget, -92)
    }

    func testShouldCountTheDaysToATargetStillAhead() throws {
        try store.upsert([
            GoalFixtures.goal(id: GoalFixtures.goalID(1), targetDate: "2026-06-11")
        ])

        let row = try XCTUnwrap(load().row(id: GoalFixtures.goalID(1)))

        XCTAssertEqual(row.targetNote, "10 days from now.")
    }

    /// The set-down render read "TARGET September 1, 2026 · 92 days from now" directly
    /// above "You set this one down". A countdown on something he decided to stop is a
    /// clock ticking at him about a decision he already made.
    func testShouldRunNoCountdownOnAGoalHeHasSetDown() throws {
        try store.upsert([
            GoalFixtures.goal(
                id: GoalFixtures.goalID(1), targetDate: "2026-09-01", status: .abandoned)
        ])

        let row = try XCTUnwrap(load().row(id: GoalFixtures.goalID(1)))

        XCTAssertNil(row.targetNote, "no countdown on a goal he set down")
        XCTAssertNotNil(row.targetDay, "the date itself is part of what the goal was")
    }

    func testShouldOfferNoTargetLineForAGoalWithNoTargetDate() throws {
        try store.upsert([GoalFixtures.goal(id: GoalFixtures.goalID(1), targetDate: nil)])

        let row = try XCTUnwrap(load().row(id: GoalFixtures.goalID(1)))

        XCTAssertNil(row.targetDay)
        XCTAssertNil(row.targetNote)
    }

    // MARK: - Slicing, and the shape R4 forbids

    /// Plan R4: `syl-008` shipped a per-row view holding a collection covering the whole
    /// list, and it cost the Commander two watchdog terminations. Each row here must carry
    /// **its own** evidence and nobody else's.
    func testShouldGiveEachRowOnlyItsOwnEvidence() throws {
        try store.upsert([
            GoalFixtures.goal(id: GoalFixtures.goalID(1), title: "Marathon"),
            GoalFixtures.goal(id: GoalFixtures.goalID(2), title: "Novel"),
        ])
        try store.upsert([
            GoalFixtures.todo(
                id: GoalFixtures.todoID(1), text: "Twelve miles",
                goalId: GoalFixtures.goalID(1),
                completedAt: GoalFixtures.day("2026-05-01")),
            GoalFixtures.todo(
                id: GoalFixtures.todoID(2), text: "Chapter one",
                goalId: GoalFixtures.goalID(2),
                completedAt: GoalFixtures.day("2026-05-02")),
            GoalFixtures.todo(
                id: GoalFixtures.todoID(3), text: "Chapter two",
                goalId: GoalFixtures.goalID(2),
                completedAt: GoalFixtures.day("2026-05-03")),
        ])

        let snapshot = try load()

        XCTAssertEqual(snapshot.row(id: GoalFixtures.goalID(1))?.evidence.entries.map(\.text), [
            "Twelve miles"
        ])
        XCTAssertEqual(snapshot.row(id: GoalFixtures.goalID(2))?.evidence.entries.map(\.text), [
            "Chapter two", "Chapter one",
        ])
    }

    func testShouldFindNoRowForAGoalTheListDoesNotHold() throws {
        try store.upsert([GoalFixtures.goal(id: GoalFixtures.goalID(1))])

        XCTAssertNil(try load().row(id: GoalFixtures.goalID(9)))
    }

    // MARK: - Not a single percentage, anywhere

    /// **The gate the whole phase turns on.**
    ///
    /// Every string a goal screen can produce, checked for a percent sign and for the
    /// shapes a fraction takes in words. A grep over the source catches a literal `%`;
    /// this catches one assembled at runtime, which is the only way it could actually get
    /// here — there is no percent-complete column anywhere for it to come from.
    func testShouldProduceNoPercentageInAnyStringAGoalScreenCanShow() throws {
        try store.upsert([
            GoalFixtures.goal(
                id: GoalFixtures.goalID(1), title: "Marathon",
                targetDate: "2026-12-31", targetValue: 40, cadenceDays: 7,
                createdAt: GoalFixtures.day("2026-01-01")),
            GoalFixtures.goal(id: GoalFixtures.goalID(2), title: "Novel", status: .abandoned),
            GoalFixtures.goal(id: GoalFixtures.goalID(3), title: "Cello", status: .dormant),
        ])
        try store.upsert([
            GoalFixtures.todo(
                id: GoalFixtures.todoID(1), goalId: GoalFixtures.goalID(1),
                completedAt: GoalFixtures.day("2026-02-01")),
            GoalFixtures.todo(
                id: GoalFixtures.todoID(2), goalId: GoalFixtures.goalID(1), status: .open),
        ])

        let snapshot = try load()
        var sentences: [String] = [
            GoalListSnapshot.emptyHeadline, GoalListSnapshot.emptyExplanation,
        ]
        for section in snapshot.sections {
            sentences.append(section.title)
            for row in section.rows {
                sentences.append(contentsOf: [row.activityLine, row.standingLabel])
                sentences.append(contentsOf: [
                    row.standingNote, row.targetNote,
                    row.evidence.headline, row.evidence.explanation,
                ].compactMap { $0 })
                sentences.append(contentsOf: row.risk.sentences)
                sentences.append(row.horizonLabel)
            }
        }

        for sentence in sentences {
            XCTAssertFalse(sentence.contains("%"), "\"\(sentence)\" carries a percentage")
            XCTAssertFalse(
                sentence.lowercased().contains("percent"),
                "\"\(sentence)\" carries a percentage in words")
            XCTAssertFalse(
                sentence.range(of: #"\d+\s*(of|out of|/)\s*\d+"#, options: .regularExpression) != nil,
                "\"\(sentence)\" is a fraction with a denominator nobody set")
        }
    }

    // MARK: - The views build

    /// The screens are constructible from plain values, with no object graph — the same
    /// property `ContentView` and `HomeView` are written to have, and the thing that makes
    /// the render harness possible at all.
    @MainActor
    func testShouldBuildEveryGoalSurfaceFromPlainValues() throws {
        try store.upsert([
            GoalFixtures.goal(id: GoalFixtures.goalID(1), title: "Marathon")
        ])
        let snapshot = try load()

        XCTAssertNotNil(GoalListView(snapshot: snapshot, scrolls: false).body)
        XCTAssertNotNil(GoalListView(snapshot: nil, scrolls: false).body)
        XCTAssertNotNil(GoalListView(snapshot: GoalListSnapshot(), scrolls: false).body)

        let row = try XCTUnwrap(snapshot.row(id: GoalFixtures.goalID(1)))
        XCTAssertNotNil(GoalDetailView(snapshot: row, scrolls: false).body)
        XCTAssertNotNil(GoalNotHere().body)
    }

    /// The Goals orb is a door (`syl-011.5.3`). It could not be one before this: the home
    /// tab had no navigation stack, so `onOpen(.goals)` had nowhere to go — and a
    /// navigation path value has to be `Hashable` to exist at all.
    func testShouldMakeTheHomeDestinationUsableAsANavigationPathValue() {
        var path: [HomeView.Destination] = []
        path.append(.goals)

        XCTAssertEqual(path, [.goals])
        XCTAssertEqual(Set(HomeView.Destination.allDestinations).count, 3)
    }

    // MARK: - Helpers

    private func load() throws -> GoalListSnapshot {
        try GoalSnapshotLoader(store: store, now: now, calendar: calendar).load()
    }
}

extension HomeView.Destination {
    /// Only used by the test above, to assert the enum is hashable in the way a navigation
    /// path needs. Kept beside the test rather than on the type, so nothing in the app
    /// starts iterating destinations as though they were a menu.
    static var allDestinations: [HomeView.Destination] { [.goals, .memory, .today] }
}
