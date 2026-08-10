import Foundation
import SylKit

/// One row of the transcript: either a turn, or the rule that separates one day from
/// the next.
///
/// The view renders this list rather than deciding as it goes. Interleaving "is this a
/// new day" logic into a `ForEach` body is how a transcript ends up printing two
/// dividers for one midnight, or none at all across a month.
enum TranscriptRow: Identifiable, Equatable {
    /// A day boundary. The associated value is the *start* of that day, so the label is
    /// derived rather than carried.
    case day(Date)

    /// A run of consecutive messages from one speaker. `showsTime` is false when the
    /// turn follows close enough behind the previous one that a clock reading would be
    /// noise.
    case turn(MessageGroup, showsTime: Bool)

    var id: String {
        switch self {
        case .day(let start): return "day-\(start.timeIntervalSinceReferenceDate)"
        case .turn(let group, _): return "turn-\(group.id)"
        }
    }
}

/// How the transcript reads down the page: where the days break, and when a time is
/// worth printing.
///
/// ## Why this is not in `MessageGrouping`
///
/// Grouping answers "whose words are these, and are they one thought" — a question
/// about the messages. This answers "how does the page read" — a question about the
/// page. They change for different reasons: grouping changes if the model changes,
/// rhythm changes if the design changes. Keeping them apart is why `MessageGrouping`
/// could stay untouched through a full visual rebuild.
enum TranscriptRhythm {
    /// Build the rows.
    ///
    /// - Parameters:
    ///   - groups: turns in ascending time order, as `MessageGrouping` produces them.
    ///   - calendar: injected so a test can pin the timezone. A test that reads the
    ///     device calendar is a test that fails when someone runs it in Auckland.
    static func rows(for groups: [MessageGroup], calendar: Calendar = .current) -> [TranscriptRow] {
        var rows: [TranscriptRow] = []
        var previousDay: Date?
        var previousEndedAt: Date?

        for group in groups {
            let day = calendar.startOfDay(for: group.startedAt)

            // A divider on the first group too. The top of the transcript is a day
            // boundary in every sense that matters — it is the moment the reader needs
            // the date most, because nothing above it establishes one.
            if day != previousDay {
                rows.append(.day(day))
                previousDay = day
            }

            rows.append(.turn(group, showsTime: showsTime(group, after: previousEndedAt)))
            previousEndedAt = group.endedAt
        }

        return rows
    }

    /// Whether this turn prints a clock reading.
    ///
    /// Reuses `MessageGrouping.maximumGap` deliberately rather than picking a second
    /// number. Two thresholds that mean "long enough to be a new thought" will drift
    /// apart the first time one of them is tuned, and then the transcript groups on one
    /// rule and timestamps on another — which reads as a bug nobody can name.
    ///
    /// A turn that opens a new day needs no special case: the previous turn ended
    /// yesterday, so the gap clears the threshold on its own.
    private static func showsTime(_ group: MessageGroup, after previousEndedAt: Date?) -> Bool {
        guard let previousEndedAt else { return true }
        return group.startedAt.timeIntervalSince(previousEndedAt) > MessageGrouping.maximumGap
    }

    /// The label on a day rule — `TODAY`, `YESTERDAY`, or a date.
    ///
    /// Relative naming for the two days a person actually thinks in, and an explicit
    /// date beyond that. "3 days ago" is worse than a date: it forces arithmetic to
    /// answer a question the date answers directly.
    static func dayLabel(for day: Date, now: Date, calendar: Calendar = .current) -> String {
        if calendar.isDate(day, inSameDayAs: now) { return "Today" }

        if let yesterday = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: now)),
           calendar.isDate(day, inSameDayAs: yesterday) {
            return "Yesterday"
        }

        // Within the same year the year is noise; across a year boundary it is the
        // whole point.
        let sameYear = calendar.component(.year, from: day) == calendar.component(.year, from: now)
        return day.formatted(
            sameYear
                ? .dateTime.weekday(.abbreviated).day().month(.wide)
                : .dateTime.day().month(.wide).year()
        )
    }
}
