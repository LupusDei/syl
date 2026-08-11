import SylKit
import XCTest

@testable import Syl

/// What a goal's progress actually is (`syl-011.5.1`, T023).
///
/// Proposal B: *"Self-reported percentages are fiction and they decay. Progress is
/// evidenced."* So the thing under test is a projection of **what happened and when**,
/// and the most important assertions in this file are the ones about the empty case —
/// a goal with nothing linked must project nothing, not a zero to render as a bar.
final class GoalEvidenceTests: XCTestCase {

    // MARK: - What counts as evidence

    func testShouldRecordAClosedTodoAsEvidenceDatedWhenItClosed() {
        let closed = GoalFixtures.day("2026-03-04")
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [GoalFixtures.todo(id: GoalFixtures.todoID(1), completedAt: closed)]
        )

        XCTAssertEqual(evidence.entries.count, 1)
        XCTAssertEqual(evidence.entries.first?.text, "Twelve miles, easy pace")
        XCTAssertEqual(evidence.entries.first?.at, closed)
        XCTAssertEqual(evidence.entries.first?.kind, .todoClosed)
    }

    func testShouldOrderEvidenceNewestFirst() {
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [
                GoalFixtures.todo(
                    id: GoalFixtures.todoID(1), text: "First",
                    completedAt: GoalFixtures.day("2026-02-01")),
                GoalFixtures.todo(
                    id: GoalFixtures.todoID(3), text: "Third",
                    completedAt: GoalFixtures.day("2026-04-01")),
                GoalFixtures.todo(
                    id: GoalFixtures.todoID(2), text: "Second",
                    completedAt: GoalFixtures.day("2026-03-01")),
            ]
        )

        XCTAssertEqual(evidence.entries.map(\.text), ["Third", "Second", "First"])
    }

    /// **The whole surface's reason for existing.** Nothing linked projects nothing —
    /// no zero, no empty series, nothing a view could round up into a bar.
    func testShouldSayNothingHasHappenedWhenNothingIsLinked() {
        let evidence = GoalEvidence.project(goal: GoalFixtures.goal(), todos: [])

        XCTAssertTrue(evidence.nothingHasHappened)
        XCTAssertTrue(evidence.entries.isEmpty)
        XCTAssertTrue(evidence.commitments.isEmpty)
        XCTAssertNil(evidence.lastActivityAt)
        XCTAssertNil(evidence.firstActivityAt)
        XCTAssertEqual(evidence.total, 0)
    }

    /// An open to-do is an intention. Counting it as progress is the self-report this
    /// design refuses, one indirection away.
    func testShouldNotTreatAnOpenTodoAsEvidence() {
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [GoalFixtures.todo(id: GoalFixtures.todoID(1), status: .open)]
        )

        XCTAssertTrue(evidence.nothingHasHappened)
        XCTAssertEqual(evidence.commitments.count, 1)
        XCTAssertEqual(evidence.commitments.first?.text, "Twelve miles, easy pace")
    }

    /// Evidence and commitments are counted independently and never against each other.
    /// The moment one is the denominator of the other there is a percentage on screen.
    func testShouldCountEvidenceAndCommitmentsIndependently() {
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [
                GoalFixtures.todo(id: GoalFixtures.todoID(1), completedAt: GoalFixtures.day("2026-02-01")),
                GoalFixtures.todo(id: GoalFixtures.todoID(2), status: .open),
                GoalFixtures.todo(id: GoalFixtures.todoID(3), status: .open),
            ]
        )

        XCTAssertEqual(evidence.total, 1)
        XCTAssertEqual(evidence.commitments.count, 2)
    }

    /// The store already filters by goal, so this guards the *other* caller: anything
    /// that hands the projection a wider list gets its own slice back rather than the
    /// whole device's history under one title.
    func testShouldIgnoreATodoLinkedToADifferentGoal() {
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [
                GoalFixtures.todo(id: GoalFixtures.todoID(1), completedAt: GoalFixtures.day("2026-02-01")),
                GoalFixtures.todo(
                    id: GoalFixtures.todoID(2), text: "Someone else's",
                    goalId: GoalFixtures.goalID(9),
                    completedAt: GoalFixtures.day("2026-02-02")),
                GoalFixtures.todo(
                    id: GoalFixtures.todoID(3), text: "Linked to nothing", goalId: nil,
                    completedAt: GoalFixtures.day("2026-02-03")),
            ]
        )

        XCTAssertEqual(evidence.entries.count, 1)
    }

    /// The contract permits either hex case for an id and the service accepts both. Two
    /// spellings of the same goal must not silently be two goals.
    func testShouldMatchAGoalIdRegardlessOfHexCase() {
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(id: GoalFixtures.rootGoalID.uppercased()),
            todos: [GoalFixtures.todo(id: GoalFixtures.todoID(1), completedAt: GoalFixtures.day("2026-02-01"))]
        )

        XCTAssertEqual(evidence.entries.count, 1)
    }

    // MARK: - Degenerate rows

    /// A closed to-do with no `completedAt` is real data — the column is nullable and the
    /// row may predate it. Dropping it would lose evidence; dating it "now" would invent
    /// one. `updatedAt` is the honest fallback: it is when the row last changed, which
    /// for a closed row is when it closed.
    func testShouldDateAClosedTodoByItsUpdateWhenItCarriesNoCompletionInstant() {
        let updated = GoalFixtures.day("2026-05-06")
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [
                GoalFixtures.todo(
                    id: GoalFixtures.todoID(1), status: .done,
                    updatedAt: updated, completedAt: nil)
            ]
        )

        XCTAssertEqual(evidence.entries.first?.at, updated)
    }

    /// Setting something down is not progress toward the goal, and it is not still owed
    /// either. It belongs in neither list.
    func testShouldExcludeADroppedTodoFromBothEvidenceAndCommitments() {
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [GoalFixtures.todo(id: GoalFixtures.todoID(1), status: .dropped)]
        )

        XCTAssertTrue(evidence.entries.isEmpty)
        XCTAssertTrue(evidence.commitments.isEmpty)
    }

    /// `proposed` is structure Syl inferred, not an explicit ask, and its UI is
    /// deliberately out of scope for this epic. Rendering it beside things he actually
    /// asked for would present a guess as a commitment.
    func testShouldExcludeAProposedTodoFromCommitments() {
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [GoalFixtures.todo(id: GoalFixtures.todoID(1), status: .proposed)]
        )

        XCTAssertTrue(evidence.commitments.isEmpty)
    }

    // MARK: - The window

    /// A goal worked at for a year has hundreds of closed to-dos and a detail screen
    /// cannot show them all. What it must never do is *hide* the depth, because "nine
    /// things happened" under a goal with two hundred behind it is its own small lie.
    func testShouldBoundTheWindowAndReportHowManyLieBehindIt() {
        let todos = (1...12).map { index in
            GoalFixtures.todo(
                id: GoalFixtures.todoID(index),
                text: "Session \(index)",
                completedAt: GoalFixtures.day("2026-03-01").addingTimeInterval(Double(index) * 86_400)
            )
        }

        let evidence = GoalEvidence.project(goal: GoalFixtures.goal(), todos: todos, window: 5)

        XCTAssertEqual(evidence.entries.count, 5)
        XCTAssertEqual(evidence.entries.first?.text, "Session 12", "the window keeps the newest")
        XCTAssertEqual(evidence.earlier, 7)
        XCTAssertEqual(evidence.total, 12, "the total is every closed thing, window or not")
    }

    func testShouldReportNothingEarlierWhenEverythingFitsTheWindow() {
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [GoalFixtures.todo(id: GoalFixtures.todoID(1), completedAt: GoalFixtures.day("2026-02-01"))],
            window: 5
        )

        XCTAssertEqual(evidence.earlier, 0)
    }

    // MARK: - The span

    func testShouldReportTheFirstAndLastThingThatHappened() {
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [
                GoalFixtures.todo(id: GoalFixtures.todoID(1), completedAt: GoalFixtures.day("2026-02-01")),
                GoalFixtures.todo(id: GoalFixtures.todoID(2), completedAt: GoalFixtures.day("2026-04-01")),
                GoalFixtures.todo(id: GoalFixtures.todoID(3), completedAt: GoalFixtures.day("2026-03-01")),
            ]
        )

        XCTAssertEqual(evidence.firstActivityAt, GoalFixtures.day("2026-02-01"))
        XCTAssertEqual(evidence.lastActivityAt, GoalFixtures.day("2026-04-01"))
    }

    /// Commitments carry the row's own durable signal and nothing else. `pinned` is the
    /// one bit proposal B keeps; there is no priority to read because none is stored.
    func testShouldCarryPinnedAndDueOnACommitmentAndNothingElse() {
        let due = GoalFixtures.day("2026-06-01")
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [
                GoalFixtures.todo(
                    id: GoalFixtures.todoID(1), status: .open, dueAt: due, pinned: true)
            ]
        )

        XCTAssertEqual(evidence.commitments.first?.dueAt, due)
        XCTAssertEqual(evidence.commitments.first?.pinned, true)
    }

    // MARK: - The copy

    /// The sentence for a goal nothing has been linked to. It has to be *true* and it has
    /// to read as a statement rather than as a failed load.
    func testShouldSayNothingHasHappenedInWordsWhenNothingIsLinked() {
        let evidence = GoalEvidence.project(goal: GoalFixtures.goal(), todos: [])

        XCTAssertEqual(evidence.headline, "Nothing has happened yet.")
        XCTAssertEqual(
            evidence.explanation,
            "Nothing is linked to this goal, so there is nothing to show you. "
                + "I would rather say that than invent a number."
        )
    }

    /// The other empty case, and it needs its own sentence: things *are* linked, so
    /// "nothing is linked" would be a plain contradiction of the list underneath it.
    func testShouldSayWhyNothingHasHappenedWhenThingsAreLinkedButUnfinished() {
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [GoalFixtures.todo(id: GoalFixtures.todoID(1), status: .open)]
        )

        XCTAssertEqual(evidence.headline, "Nothing has happened yet.")
        XCTAssertEqual(
            evidence.explanation,
            "Things are linked to this goal, but none of them has finished. "
                + "That is the whole of what I know."
        )
    }

    func testShouldOfferNoEmptyCopyOnceSomethingHasHappened() {
        let evidence = GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: [GoalFixtures.todo(id: GoalFixtures.todoID(1), completedAt: GoalFixtures.day("2026-02-01"))]
        )

        XCTAssertNil(evidence.headline)
        XCTAssertNil(evidence.explanation)
    }

    /// The grep gate, at the level a grep cannot reach: the strings themselves.
    func testShouldNeverPutAPercentageInTheEmptyCopy() {
        let evidence = GoalEvidence.project(goal: GoalFixtures.goal(), todos: [])

        for sentence in [evidence.headline, evidence.explanation].compactMap({ $0 }) {
            XCTAssertFalse(sentence.contains("%"), "progress is evidenced, never a percentage")
        }
    }
}
