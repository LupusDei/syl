import Foundation
import SylKit

/// How far out a goal was set — **derived from its target date, never stored.**
///
/// Proposal B gives a goal a target date and no horizon column, and that is deliberate: a
/// stored horizon is a second copy of the same fact, and the two disagree the first time
/// one of them is edited.
///
/// ## Measured from the day it was made, not from today
///
/// A year-long goal set in January is still a year-long goal in November. Deriving the
/// horizon from `now` would quietly reclassify it as a month goal as its deadline
/// approached — which is a statement about the calendar rather than about the kind of
/// goal it is, and it would make the same goal appear under a different heading every few
/// weeks.
enum GoalHorizon: String, Equatable, Sendable, CaseIterable {
    case month
    case season
    case year
    case life

    /// The thresholds, in days, spanning creation to target. Named rather than inline so
    /// the numbers are arguable — and asserted in `GoalHorizonTests` so nudging one fails
    /// loudly instead of silently reclassifying every goal on the device.
    private static let monthCeiling = 45
    private static let seasonCeiling = 150
    private static let yearCeiling = 400

    static func derive(for goal: Goal, calendar: Calendar = .current) -> GoalHorizon {
        // No target date, or one that cannot be read, is the same answer: a goal with no
        // readable horizon is open-ended. That is not a missing field to be guessed at —
        // it is a goal that ends when he does.
        guard
            let targetDate = goal.targetDate,
            let target = GoalCalendar.day(targetDate, in: calendar)
        else { return .life }

        let span = GoalCalendar.wholeDays(from: goal.createdAt, to: target, in: calendar)

        // A negative span — a target that predates the goal, which imported and
        // hand-edited data really does carry — falls here. A deadline that has already
        // gone is the shortest horizon there is, not the longest.
        if span <= monthCeiling { return .month }
        if span <= seasonCeiling { return .season }
        if span <= yearCeiling { return .year }
        return .life
    }

    /// The heading a goal sits under.
    ///
    /// `life` says **"Beyond a year"** rather than "No end date", and the difference was
    /// found by looking at a render rather than by reasoning: a goal created in March 2026
    /// with a target of June 2027 spans 457 days, lands in `life`, and rendered as
    /// `NO END DATE · Jun 1, 2027` — a label contradicting the date printed beside it.
    /// A goal that genuinely has no date says so through
    /// ``GoalDetailSnapshot/horizonLabel``, which is the only place that knows.
    ///
    /// It is not "A life" either. That is a claim about him, and this screen is not in the
    /// business of making those.
    var label: String {
        switch self {
        case .month: return "This month"
        case .season: return "This season"
        case .year: return "This year"
        case .life: return "Beyond a year"
        }
    }
}

/// Calendar arithmetic for the goal surfaces, in one place.
///
/// Both the horizon and the risk signals count days, and two copies of "how many days
/// between these" is two chances for one of them to divide an interval by 86,400 — which
/// is wrong by one on the two mornings a year when a day is 23 or 25 hours long, and
/// wrong invisibly.
enum GoalCalendar {

    /// Read a `YYYY-MM-DD` as midnight in the given calendar's zone.
    ///
    /// Hand-parsed rather than via `DateFormatter` because a formatter carries a locale,
    /// and a locale that renders `2026-03-15` under a non-Gregorian calendar turns a
    /// target date into a different day entirely.
    ///
    /// The ranges are checked rather than trusted. `DateComponents(month: 13)` is not an
    /// error to `Calendar` — it is January of the next year — so a server that ever
    /// emitted one would silently move a goal's horizon by twelve months.
    static func day(_ local: LocalDate, in calendar: Calendar) -> Date? {
        let parts = local.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        guard
            parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
            let year = Int(parts[0]), let month = Int(parts[1]), let dayOfMonth = Int(parts[2]),
            (1...12).contains(month), (1...31).contains(dayOfMonth)
        else { return nil }

        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = dayOfMonth
        return calendar.date(from: components)
    }

    /// Whole calendar days between two instants, midnight to midnight.
    ///
    /// Negative when `end` precedes `start`, which callers rely on rather than guard
    /// against — a target date in the past is a real state, not an error.
    static func wholeDays(from start: Date, to end: Date, in calendar: Calendar) -> Int {
        let first = calendar.startOfDay(for: start)
        let last = calendar.startOfDay(for: end)
        return calendar.dateComponents([.day], from: first, to: last).day ?? 0
    }
}
