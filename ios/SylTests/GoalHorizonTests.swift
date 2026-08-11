import SylKit
import XCTest

@testable import Syl

/// The horizon is **derived**, never stored (`syl-011.5.6`, T028).
///
/// Proposal B gives a goal a target date and no horizon column, and that is deliberate:
/// a stored horizon is a second copy of the same fact, and the two disagree the first
/// time one of them is edited. So `life / year / season / month` is a function of the
/// span the goal was set over.
///
/// **Measured from the day it was made, not from today.** A year-long goal set in January
/// is still a year-long goal in November — deriving from `now` would quietly reclassify
/// it as a month goal as its deadline approached, which is a statement about the calendar
/// rather than about the kind of goal it is.
final class GoalHorizonTests: XCTestCase {
    private let calendar = GoalFixtures.calendar

    // MARK: - The four horizons

    func testShouldDeriveAMonthHorizonFromAShortSpan() {
        XCTAssertEqual(derive(created: "2026-01-01", target: "2026-01-28"), .month)
    }

    func testShouldDeriveASeasonHorizonFromASpanOfAFewMonths() {
        XCTAssertEqual(derive(created: "2026-01-01", target: "2026-04-01"), .season)
    }

    func testShouldDeriveAYearHorizonFromASpanApproachingAYear() {
        XCTAssertEqual(derive(created: "2026-01-01", target: "2026-12-31"), .year)
    }

    func testShouldDeriveALifeHorizonFromASpanBeyondAYear() {
        XCTAssertEqual(derive(created: "2026-01-01", target: "2031-01-01"), .life)
    }

    /// The boundaries, asserted rather than left to a comment. Each pair straddles one
    /// threshold, so a nudge to any number here fails loudly instead of silently
    /// reclassifying every goal on the device.
    func testShouldPlaceEachBoundaryExactlyWhereItIsDocumented() {
        XCTAssertEqual(derive(created: "2026-01-01", target: "2026-02-15"), .month, "45 days")
        XCTAssertEqual(derive(created: "2026-01-01", target: "2026-02-16"), .season, "46 days")
        XCTAssertEqual(derive(created: "2026-01-01", target: "2026-05-31"), .season, "150 days")
        XCTAssertEqual(derive(created: "2026-01-01", target: "2026-06-01"), .year, "151 days")
        XCTAssertEqual(derive(created: "2026-01-01", target: "2027-02-05"), .year, "400 days")
        XCTAssertEqual(derive(created: "2026-01-01", target: "2027-02-06"), .life, "401 days")
    }

    // MARK: - The degenerate cases

    /// **A goal with no target date is not a goal with a missing field.** It is a goal
    /// that ends when he does — which is what `life` means, and the derivation is still
    /// entirely a function of the target date, namely of its absence.
    func testShouldDeriveALifeHorizonForAGoalWithNoTargetDateAtAll() {
        let goal = GoalFixtures.goal(targetDate: nil)

        XCTAssertEqual(GoalHorizon.derive(for: goal, calendar: calendar), .life)
    }

    /// Imported or hand-edited data really does carry a target before the creation
    /// instant. The span is negative, so it falls into the nearest horizon rather than
    /// throwing or landing in `life` — a goal whose deadline has already gone is the
    /// shortest horizon there is, not the longest.
    func testShouldDeriveAMonthHorizonForATargetThatPredatesTheGoal() {
        XCTAssertEqual(derive(created: "2026-06-01", target: "2026-01-01"), .month)
    }

    /// A malformed date must not be guessed at. It falls back to the open-ended horizon,
    /// which is the same answer as no date — because an unreadable date *is* no date.
    func testShouldFallBackToLifeForATargetDateItCannotRead() {
        let goal = GoalFixtures.goal(targetDate: "not a date")

        XCTAssertEqual(GoalHorizon.derive(for: goal, calendar: calendar), .life)
    }

    // MARK: - Labels

    func testShouldLabelEveryHorizon() {
        XCTAssertEqual(GoalHorizon.month.label, "This month")
        XCTAssertEqual(GoalHorizon.season.label, "This season")
        XCTAssertEqual(GoalHorizon.year.label, "This year")
        XCTAssertEqual(GoalHorizon.life.label, "Beyond a year")
    }

    /// **A defect the render harness found and no assertion would have.**
    ///
    /// `life` covers two different situations, and the label has to tell them apart. A
    /// goal created in March 2026 with a target of June 2027 spans 457 days, lands in
    /// `life`, and rendered on the list as `NO END DATE · Jun 1, 2027` — a label directly
    /// contradicting the date printed next to it.
    func testShouldNotSayAGoalHasNoEndDateWhileShowingItsEndDate() {
        XCTAssertEqual(GoalHorizon.life.label, "Beyond a year")
        XCTAssertNotEqual(
            GoalHorizon.life.label, "No end date",
            "only a goal with no target date at all may say that, and only the snapshot knows"
        )
    }

    // MARK: - The calendar helpers

    func testShouldReadALocalDateAsMidnightInTheGivenZone() {
        let day = GoalCalendar.day("2026-03-15", in: calendar)

        XCTAssertEqual(day, calendar.startOfDay(for: GoalFixtures.day("2026-03-15")))
    }

    func testShouldRefuseALocalDateThatIsNotYearMonthDay() {
        XCTAssertNil(GoalCalendar.day("15/03/2026", in: calendar))
        XCTAssertNil(GoalCalendar.day("2026-03", in: calendar))
        XCTAssertNil(GoalCalendar.day("", in: calendar))
    }

    /// A rolled-over month is the trap here: `DateComponents(month: 13)` is not an error
    /// to `Calendar`, it is January of the next year. A server that ever emitted one
    /// would silently move a goal's horizon by a year.
    func testShouldRefuseAnOutOfRangeMonthOrDayRatherThanRollingItOver() {
        XCTAssertNil(GoalCalendar.day("2026-13-01", in: calendar))
        XCTAssertNil(GoalCalendar.day("2026-00-01", in: calendar))
        XCTAssertNil(GoalCalendar.day("2026-03-32", in: calendar))
    }

    /// Whole days, counted from midnight to midnight. Counting by elapsed seconds would
    /// make the answer depend on the time of day — and on the two mornings a year when a
    /// day is 23 or 25 hours long, it would be wrong by one.
    func testShouldCountWholeDaysAcrossADaylightSavingBoundary() {
        // US DST begins on 8 March 2026: that week contains a 23-hour day.
        let days = GoalCalendar.wholeDays(
            from: GoalFixtures.day("2026-03-05"),
            to: GoalFixtures.day("2026-03-12"),
            in: calendar
        )

        XCTAssertEqual(days, 7, "seven calendar days, whatever the clocks did")
    }

    func testShouldCountZeroDaysWithinOneDay() {
        let days = GoalCalendar.wholeDays(
            from: GoalFixtures.day("2026-03-05", hour: 1),
            to: GoalFixtures.day("2026-03-05", hour: 23),
            in: calendar
        )

        XCTAssertEqual(days, 0)
    }

    func testShouldCountBackwardsAsANegativeNumber() {
        let days = GoalCalendar.wholeDays(
            from: GoalFixtures.day("2026-03-12"),
            to: GoalFixtures.day("2026-03-05"),
            in: calendar
        )

        XCTAssertEqual(days, -7)
    }

    // MARK: - Helpers

    private func derive(created: LocalDate, target: LocalDate) -> GoalHorizon {
        GoalHorizon.derive(
            for: GoalFixtures.goal(targetDate: target, createdAt: GoalFixtures.day(created)),
            calendar: calendar
        )
    }
}
