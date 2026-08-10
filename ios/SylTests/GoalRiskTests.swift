import SylKit
import XCTest

@testable import Syl

/// The two computable risk signals (`syl-011.5.2`, T024).
///
/// **Silence** is `now − last linked activity > cadence_days`. **Arithmetic** is required
/// rate against observed rate, reported as *both numbers and never as a verdict* — "you
/// need four a week and you have averaged one for three weeks" is arithmetic; "behind" is
/// a judgement he did not ask for.
///
/// The degenerate cases carry as much weight as the happy ones. A goal with no cadence, a
/// target date in the past, no target at all, or a unit this device cannot measure must
/// each degrade to **nothing rather than to a guess** — a signal invented from a missing
/// field is the percentage problem wearing a different hat.
final class GoalRiskTests: XCTestCase {
    private let calendar = GoalFixtures.calendar

    // MARK: - Silence

    func testShouldReportSilenceWhenTheLastActivityIsOlderThanTheCadence() {
        let risk = project(
            goal: GoalFixtures.goal(cadenceDays: 7),
            closedOn: ["2026-03-01"],
            now: "2026-03-25"
        )

        XCTAssertEqual(risk.silence?.days, 24)
        XCTAssertEqual(risk.silence?.cadenceDays, 7)
        XCTAssertEqual(risk.silence?.since, GoalFixtures.day("2026-03-01"))
    }

    func testShouldReportNoSilenceWhileTheGoalIsStillInsideItsCadence() {
        let risk = project(
            goal: GoalFixtures.goal(cadenceDays: 7),
            closedOn: ["2026-03-01"],
            now: "2026-03-05"
        )

        XCTAssertNil(risk.silence)
    }

    /// The boundary. `>` and not `>=`: a cadence of seven days asks for something *every*
    /// seven days, so the seventh day is the day it is due rather than the day it is late.
    func testShouldReportNoSilenceOnTheCadenceDayItself() {
        let risk = project(
            goal: GoalFixtures.goal(cadenceDays: 7),
            closedOn: ["2026-03-01"],
            now: "2026-03-08"
        )

        XCTAssertNil(risk.silence)
    }

    /// **Degenerate: no cadence.** There is no sensible default here — seven days would be
    /// invented, and an invented threshold produces an invented alarm.
    func testShouldReportNoSilenceForAGoalThatDeclaredNoCadence() {
        let risk = project(
            goal: GoalFixtures.goal(cadenceDays: nil),
            closedOn: ["2026-01-02"],
            now: "2026-12-01"
        )

        XCTAssertNil(risk.silence)
        XCTAssertTrue(risk.isQuiet)
    }

    func testShouldReportNoSilenceForACadenceOfZeroOrLess() {
        let risk = project(
            goal: GoalFixtures.goal(cadenceDays: 0),
            closedOn: ["2026-01-02"],
            now: "2026-12-01"
        )

        XCTAssertNil(risk.silence)
    }

    /// A goal nothing has *ever* been linked to is the case a "days since last activity"
    /// signal would miss entirely. It is measured from the day it was made instead, which
    /// is the honest clock for it.
    func testShouldMeasureSilenceFromTheDayTheGoalWasMadeWhenNothingHasEverHappened() {
        let risk = project(
            goal: GoalFixtures.goal(cadenceDays: 7, createdAt: GoalFixtures.day("2026-03-01")),
            closedOn: [],
            now: "2026-03-25"
        )

        XCTAssertEqual(risk.silence?.days, 24)
        XCTAssertNil(risk.silence?.since, "nothing has happened, so there is no since")
    }

    func testShouldReportNoSilenceForAYoungGoalNothingHasHappenedOnYet() {
        let risk = project(
            goal: GoalFixtures.goal(cadenceDays: 30, createdAt: GoalFixtures.day("2026-03-01")),
            closedOn: [],
            now: "2026-03-04"
        )

        XCTAssertNil(risk.silence)
    }

    // MARK: - Status gates the whole thing

    /// **The tone requirement, enforced in the projection rather than in the view.** Risk
    /// on a goal he consciously set down is exactly the accumulated guilt proposal B made
    /// `abandoned` first-class to avoid. A view could forget; this cannot.
    func testShouldReportNoRiskAtAllOnAnAbandonedGoal() {
        let risk = project(
            goal: GoalFixtures.goal(targetValue: 40, cadenceDays: 7, status: .abandoned),
            closedOn: ["2026-01-05"],
            now: "2026-06-01"
        )

        XCTAssertTrue(risk.isQuiet)
        XCTAssertNil(risk.silence)
        XCTAssertNil(risk.arithmetic)
    }

    func testShouldReportNoRiskOnADormantGoal() {
        // "Not now" is a real answer. Nagging him about it turns it back into a failure.
        let risk = project(
            goal: GoalFixtures.goal(targetValue: 40, cadenceDays: 7, status: .dormant),
            closedOn: ["2026-01-05"],
            now: "2026-06-01"
        )

        XCTAssertTrue(risk.isQuiet)
    }

    func testShouldReportNoRiskOnAnAchievedGoal() {
        let risk = project(
            goal: GoalFixtures.goal(targetValue: 40, cadenceDays: 7, status: .achieved),
            closedOn: ["2026-01-05"],
            now: "2026-06-01"
        )

        XCTAssertTrue(risk.isQuiet)
    }

    // MARK: - Arithmetic

    /// The worked example from the plan: *"You need four a week and you have averaged one
    /// for three weeks."* Both numbers, both derived, neither compared.
    func testShouldReportBothTheRequiredAndTheObservedRate() {
        // Twelve weeks of history with twelve closed things — one a week. Ten weeks left
        // and forty to reach, of which twelve are done: 28 over 10 weeks is 2.8 a week.
        let closed = (0..<12).map { week in
            GoalFixtures.day("2026-01-05").addingTimeInterval(Double(week) * 7 * 86_400)
        }

        let risk = GoalRisk.project(
            goal: GoalFixtures.goal(
                targetDate: "2026-06-08", targetValue: 40,
                createdAt: GoalFixtures.day("2026-01-05")),
            evidence: evidence(closedOn: closed),
            now: GoalFixtures.day("2026-03-30"),
            calendar: calendar
        )

        let arithmetic = risk.arithmetic
        XCTAssertNotNil(arithmetic)
        XCTAssertEqual(arithmetic?.done, 12)
        XCTAssertEqual(arithmetic?.target, 40)
        XCTAssertEqual(arithmetic?.remaining, 28)
        XCTAssertEqual(arithmetic?.daysObserved, 84)
        XCTAssertEqual(arithmetic?.daysRemaining, 70)
        XCTAssertEqual(arithmetic?.observedPerWeek ?? 0, 1.0, accuracy: 0.001)
        XCTAssertEqual(arithmetic?.requiredPerWeek ?? 0, 2.8, accuracy: 0.001)
    }

    /// **Degenerate: the target date has already passed.** There are no weeks left to
    /// divide by, so there is no required rate — and any number produced here would be an
    /// artefact of the division rather than a fact about the goal.
    func testShouldReportNoArithmeticWhenTheTargetDateIsInThePast() {
        let risk = project(
            goal: GoalFixtures.goal(targetDate: "2026-02-01", targetValue: 40),
            closedOn: ["2026-01-05"],
            now: "2026-06-01"
        )

        XCTAssertNil(risk.arithmetic)
    }

    /// The other side of the same boundary: a target of *today* leaves zero whole weeks.
    func testShouldReportNoArithmeticWhenTheTargetDateIsToday() {
        let risk = project(
            goal: GoalFixtures.goal(targetDate: "2026-06-01", targetValue: 40),
            closedOn: ["2026-01-05"],
            now: "2026-06-01"
        )

        XCTAssertNil(risk.arithmetic)
    }

    /// **Degenerate: no target date at all.** A goal with no horizon has no rate it is
    /// required to keep, and inventing one would be inventing the deadline too.
    func testShouldReportNoArithmeticWhenThereIsNoTargetDate() {
        let risk = project(
            goal: GoalFixtures.goal(targetDate: nil, targetValue: 40),
            closedOn: ["2026-01-05"],
            now: "2026-06-01"
        )

        XCTAssertNil(risk.arithmetic)
    }

    func testShouldReportNoArithmeticWhenThereIsNoTargetValue() {
        let risk = project(
            goal: GoalFixtures.goal(targetDate: "2026-12-31", targetValue: nil),
            closedOn: ["2026-01-05"],
            now: "2026-06-01"
        )

        XCTAssertNil(risk.arithmetic)
    }

    /// **Degenerate: a unit this device cannot observe.** A goal measured in miles has a
    /// target of five hundred *miles*, and the only thing on the phone to count is closed
    /// to-dos. Counting those against it would report "you have averaged one mile a week"
    /// from data that never mentioned a mile — a fabricated measurement, which is worse
    /// than a fabricated percentage because it looks like it came from somewhere.
    func testShouldReportNoArithmeticForAUnitThisDeviceCannotMeasure() {
        let risk = project(
            goal: GoalFixtures.goal(
                targetDate: "2026-12-31", metricKey: "miles", targetValue: 500),
            closedOn: ["2026-01-05", "2026-01-12"],
            now: "2026-06-01"
        )

        XCTAssertNil(risk.arithmetic)
    }

    /// **Degenerate: a goal younger than the window it would be averaged over.** One
    /// closed to-do on the day a goal is made is not "seven a week"; it is one thing, and
    /// a weekly rate extrapolated from a single day is a guess with a decimal point.
    func testShouldReportNoObservedRateForAGoalYoungerThanAWeek() {
        let risk = project(
            goal: GoalFixtures.goal(
                targetDate: "2026-12-31", targetValue: 40,
                createdAt: GoalFixtures.day("2026-03-01")),
            closedOn: ["2026-03-01"],
            now: "2026-03-04"
        )

        XCTAssertNil(risk.arithmetic)
    }

    /// A rate of zero is a fact and it is the one he most needs. Suppressing it as
    /// "no data" would hide the very case the surface exists for.
    func testShouldReportAnObservedRateOfZeroRatherThanSuppressingIt() {
        let risk = project(
            goal: GoalFixtures.goal(
                targetDate: "2026-12-31", targetValue: 40,
                createdAt: GoalFixtures.day("2026-01-01")),
            closedOn: [],
            now: "2026-03-01"
        )

        XCTAssertEqual(risk.arithmetic?.observedPerWeek, 0)
        XCTAssertEqual(risk.arithmetic?.done, 0)
    }

    func testShouldReportNothingLeftToDoWhenTheTargetIsAlreadyMet() {
        let closed = (0..<5).map { week in
            GoalFixtures.day("2026-01-05").addingTimeInterval(Double(week) * 7 * 86_400)
        }

        let risk = GoalRisk.project(
            goal: GoalFixtures.goal(
                targetDate: "2026-12-31", targetValue: 4,
                createdAt: GoalFixtures.day("2026-01-05")),
            evidence: evidence(closedOn: closed),
            now: GoalFixtures.day("2026-03-01"),
            calendar: calendar
        )

        XCTAssertEqual(risk.arithmetic?.remaining, 0)
        XCTAssertEqual(risk.arithmetic?.requiredPerWeek, 0)
    }

    // MARK: - The sentences

    func testShouldPutBothNumbersInTheArithmeticSentences() {
        let closed = (0..<12).map { week in
            GoalFixtures.day("2026-01-05").addingTimeInterval(Double(week) * 7 * 86_400)
        }

        let risk = GoalRisk.project(
            goal: GoalFixtures.goal(
                targetDate: "2026-06-08", targetValue: 40,
                createdAt: GoalFixtures.day("2026-01-05")),
            evidence: evidence(closedOn: closed),
            now: GoalFixtures.day("2026-03-30"),
            calendar: calendar
        )

        XCTAssertEqual(risk.arithmetic?.required, "To reach 40 you need 2.8 a week.")
        XCTAssertEqual(risk.arithmetic?.observed, "Over the last 84 days you have averaged 1 a week.")
    }

    func testShouldSayTheTargetIsReachedRatherThanAskingForNoneAWeek() {
        let closed = (0..<5).map { week in
            GoalFixtures.day("2026-01-05").addingTimeInterval(Double(week) * 7 * 86_400)
        }

        let risk = GoalRisk.project(
            goal: GoalFixtures.goal(
                targetDate: "2026-12-31", targetValue: 4,
                createdAt: GoalFixtures.day("2026-01-05")),
            evidence: evidence(closedOn: closed),
            now: GoalFixtures.day("2026-03-01"),
            calendar: calendar
        )

        XCTAssertEqual(risk.arithmetic?.required, "You have reached 4.")
    }

    /// **The heart of T024.** Two numbers, and not one word that draws the conclusion for
    /// him. If any of these ever appear, the arithmetic has become a verdict.
    func testShouldNeverRenderTheArithmeticAsAVerdict() {
        let closed = (0..<3).map { week in
            GoalFixtures.day("2026-01-05").addingTimeInterval(Double(week) * 7 * 86_400)
        }

        let risk = GoalRisk.project(
            goal: GoalFixtures.goal(
                targetDate: "2026-06-08", targetValue: 40,
                cadenceDays: 7, createdAt: GoalFixtures.day("2026-01-05")),
            evidence: evidence(closedOn: closed),
            now: GoalFixtures.day("2026-03-30"),
            calendar: calendar
        )

        let verdicts = [
            "behind", "ahead", "on track", "off track", "failing", "failed", "falling",
            "short", "overdue", "not enough", "too slow", "at risk", "slipping", "should",
        ]

        for sentence in risk.sentences {
            for verdict in verdicts {
                XCTAssertFalse(
                    sentence.lowercased().contains(verdict),
                    "\"\(sentence)\" draws the conclusion for him with \"\(verdict)\""
                )
            }
            XCTAssertFalse(sentence.contains("%"), "progress is evidenced, never a percentage")
        }
    }

    func testShouldNameBothNumbersInTheSilenceSentence() {
        let risk = project(
            goal: GoalFixtures.goal(cadenceDays: 7),
            closedOn: ["2026-03-01"],
            now: "2026-03-25"
        )

        XCTAssertEqual(
            risk.silence?.sentence,
            "Nothing has been linked for 24 days. This one asks for something every 7 days."
        )
    }

    func testShouldSaySomethingDifferentWhenNothingHasEverBeenLinked() {
        let risk = project(
            goal: GoalFixtures.goal(cadenceDays: 7, createdAt: GoalFixtures.day("2026-03-01")),
            closedOn: [],
            now: "2026-03-25"
        )

        XCTAssertEqual(
            risk.silence?.sentence,
            "Nothing has ever been linked to this. It has been 24 days since you made it."
        )
    }

    func testShouldSayEveryDayRatherThanEveryOneDays() {
        let risk = project(
            goal: GoalFixtures.goal(cadenceDays: 1),
            closedOn: ["2026-03-01"],
            now: "2026-03-05"
        )

        XCTAssertEqual(
            risk.silence?.sentence,
            "Nothing has been linked for 4 days. This one asks for something every day."
        )
    }

    // MARK: - Helpers

    private func project(goal: Goal, closedOn: [LocalDate], now: LocalDate) -> GoalRisk {
        GoalRisk.project(
            goal: goal,
            evidence: evidence(closedOn: closedOn.map { GoalFixtures.day($0) }),
            now: GoalFixtures.day(now),
            calendar: calendar
        )
    }

    /// Built through the real projection rather than by hand, so a change to what counts
    /// as evidence moves these tests with it instead of leaving them asserting a shape
    /// nothing produces any more.
    private func evidence(closedOn dates: [Date]) -> GoalEvidence {
        GoalEvidence.project(
            goal: GoalFixtures.goal(),
            todos: dates.enumerated().map { index, date in
                GoalFixtures.todo(id: GoalFixtures.todoID(index + 1), completedAt: date)
            }
        )
    }
}
