import Foundation
import SylKit

@testable import Syl

/// Builders for the goal surfaces' tests.
///
/// Shared rather than repeated in four files because every one of these tests turns on a
/// *date*, and four copies of a date builder is four chances for one of them to read the
/// device calendar and start failing in Auckland. The calendar here is pinned, IANA, and
/// never a fixed offset — the project's constraint 5, which exists because an offset is a
/// property of an instant rather than of a place.
enum GoalFixtures {
    /// A real zone with real DST, so a span that crosses a boundary is exercised rather
    /// than assumed away by UTC.
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        if let zone = TimeZone(identifier: "America/Chicago") { calendar.timeZone = zone }
        return calendar
    }

    /// Midday on a `YYYY-MM-DD`, in ``calendar``. Midday rather than midnight so a test
    /// that shifts by a few hours does not silently cross a day boundary.
    static func day(_ text: LocalDate, hour: Int = 12) -> Date {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        precondition(parts.count == 3, "day() takes YYYY-MM-DD")
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = hour
        return calendar.date(from: components) ?? Date(timeIntervalSinceReferenceDate: 0)
    }

    static func goal(
        id: SylID = GoalFixtures.rootGoalID,
        parentId: SylID? = nil,
        title: String = "Run a marathon",
        why: String? = "Because I said I would, out loud, to someone who remembers.",
        targetDate: LocalDate? = "2026-12-31",
        metricKey: String? = nil,
        targetValue: Double? = nil,
        cadenceDays: Int? = 7,
        status: GoalStatus = .active,
        statusReason: String? = nil,
        createdAt: Date = GoalFixtures.day("2026-01-01"),
        updatedAt: Date? = nil
    ) -> Goal {
        Goal(
            id: id,
            parentId: parentId,
            title: title,
            why: why,
            targetDate: targetDate,
            metricKey: metricKey,
            targetValue: targetValue,
            cadenceDays: cadenceDays,
            status: status,
            statusReason: statusReason,
            createdAt: createdAt,
            updatedAt: updatedAt ?? createdAt
        )
    }

    static func todo(
        id: SylID,
        text: String = "Twelve miles, easy pace",
        goalId: SylID? = GoalFixtures.rootGoalID,
        status: TodoStatus = .done,
        dueAt: Date? = nil,
        pinned: Bool = false,
        createdAt: Date = GoalFixtures.day("2026-01-02"),
        updatedAt: Date? = nil,
        completedAt: Date? = nil
    ) -> Todo {
        Todo(
            id: id,
            text: text,
            goalId: goalId,
            dueAt: dueAt,
            pinned: pinned,
            status: status,
            source: .commander,
            delegatedJobId: nil,
            createdAt: createdAt,
            updatedAt: updatedAt ?? completedAt ?? createdAt,
            completedAt: completedAt
        )
    }

    static let rootGoalID: SylID = "syl:goal:0198f2c3-0001-7000-8000-00000000d001"

    /// Ids that differ only in one field, so a test can make several without inventing
    /// UUIDs by hand. Still well formed — `SylIDs.isWellFormed` is asserted elsewhere and
    /// a fixture that quietly fails it would make those tests lie.
    static func todoID(_ ordinal: Int) -> SylID {
        String(format: "syl:todo:0198f2c2-%04x-7000-8000-00000000c001", ordinal)
    }

    static func goalID(_ ordinal: Int) -> SylID {
        String(format: "syl:goal:0198f2c3-%04x-7000-8000-00000000d001", ordinal)
    }
}
