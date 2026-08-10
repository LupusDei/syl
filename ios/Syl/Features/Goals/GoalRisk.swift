import Foundation
import SylKit

/// The two things about a goal that can be **computed** rather than felt.
///
/// ## Silence
///
/// `now − last linked activity > cadence_days`. The goal itself declared the cadence, so
/// this is not a threshold Syl imposed — it is the goal being held to what it asked for.
///
/// ## Arithmetic, and why it is never a verdict
///
/// Required rate against observed rate, reported as **both numbers**:
///
/// > "You need four a week and you have averaged one for three weeks" is arithmetic.
///
/// "Behind" is not. Neither is a red badge, an amber chip, or a progress bar with a
/// marker on it. Every one of those draws the conclusion for him from two numbers he can
/// read himself, and every one of them is wrong in the cases the numbers are not —
/// the week he was ill, the fortnight the work was blocked, the month he decided the goal
/// was worth less than he thought. The numbers survive all three. A verdict does not.
///
/// ## Degrade to nothing, never to a guess
///
/// A goal with no cadence, no target date, a target already past, or a unit this device
/// cannot measure produces **no signal at all**. That is the same rule the whole surface
/// runs on: a signal invented from a missing field is the percentage problem wearing a
/// different hat, and it is worse, because it looks like it came from somewhere.
struct GoalRisk: Equatable, Sendable {

    /// Nothing has been linked for longer than the goal asked for.
    struct Silence: Equatable, Sendable {
        /// Whole days since the last linked activity — or since the goal was made, when
        /// nothing has ever been linked to it.
        var days: Int
        var cadenceDays: Int
        /// When the last thing happened. **Nil when nothing ever has**, which is a
        /// different sentence and a different fact.
        var since: Date?

        var sentence: String {
            guard since != nil else {
                return "Nothing has ever been linked to this. "
                    + "It has been \(days) days since you made it."
            }
            let asked = cadenceDays == 1 ? "every day" : "every \(cadenceDays) days"
            return "Nothing has been linked for \(days) days. This one asks for something \(asked)."
        }
    }

    /// Two rates, and nothing derived from comparing them.
    ///
    /// Deliberately stores the inputs alongside the results. A view handed only the two
    /// rates would be tempted to divide them; a view handed the days, the count and the
    /// target has everything it needs to write the sentence out in full instead.
    struct Arithmetic: Equatable, Sendable {
        /// What the goal is counting toward.
        var target: Double
        /// How many things have actually happened.
        var done: Int
        /// `target − done`, floored at zero.
        var remaining: Double
        /// Whole days from now to the target date. Always at least one.
        var daysRemaining: Int
        /// Whole days the goal has existed. Always at least ``GoalRisk/observationFloor``.
        var daysObserved: Int

        var requiredPerWeek: Double {
            remaining / (Double(daysRemaining) / 7)
        }

        var observedPerWeek: Double {
            Double(done) / (Double(daysObserved) / 7)
        }

        /// The first number, in words.
        ///
        /// No date in the sentence: the target date is already on the screen above it, and
        /// repeating it here would mean formatting a date inside a value type, which drags
        /// a locale into something that has to be identical every time it is rendered.
        var required: String {
            guard remaining > 0 else { return "You have reached \(Self.number(target))." }
            return "To reach \(Self.number(target)) you need \(Self.number(requiredPerWeek)) a week."
        }

        /// The second number, in words. Note what is *not* here: no comparison to the
        /// first, no adverb, no colour.
        var observed: String {
            "Over the last \(daysObserved) days you have averaged "
                + "\(Self.number(observedPerWeek)) a week."
        }

        /// One decimal place, and only when it carries information.
        ///
        /// Formatted through `String(format:)` rather than `.formatted(.number)` so the
        /// separator is the same character in every environment the tests and the screen
        /// run in. A rate that renders `2.8` under test and `2,8` on the device is a rate
        /// nobody can assert on.
        static func number(_ value: Double) -> String {
            let rounded = (value * 10).rounded() / 10
            if rounded == rounded.rounded() { return String(Int(rounded)) }
            return String(format: "%.1f", rounded)
        }
    }

    var silence: Silence?
    var arithmetic: Arithmetic?

    /// Nothing computable to say. The common case, and a perfectly good one.
    var isQuiet: Bool { silence == nil && arithmetic == nil }

    /// Every sentence this risk produces, for a view to lay out and for a test to check
    /// for verdicts.
    var sentences: [String] {
        [silence?.sentence, arithmetic?.required, arithmetic?.observed].compactMap { $0 }
    }

    /// The shortest history an observed weekly rate may be extrapolated from.
    ///
    /// One closed to-do on the day a goal is made is not "seven a week"; it is one thing.
    /// A weekly rate computed from a single day is a guess with a decimal point in it,
    /// which is the most convincing kind.
    static let observationFloor = 7

    // MARK: - Projection

    static func project(
        goal: Goal,
        evidence: GoalEvidence,
        now: Date,
        calendar: Calendar = .current
    ) -> GoalRisk {
        // **The tone requirement, enforced here rather than in the view.**
        //
        // Risk on a goal he consciously set down, or parked, or already finished is
        // exactly the accumulated guilt proposal B made `abandoned` first-class to avoid:
        // "the reason people abandon goal systems is accumulated guilt — a list of things
        // they have silently failed at". A view could forget this. A projection cannot.
        guard goal.status == .active else { return GoalRisk() }

        return GoalRisk(
            silence: silence(for: goal, evidence: evidence, now: now, calendar: calendar),
            arithmetic: arithmetic(for: goal, evidence: evidence, now: now, calendar: calendar)
        )
    }

    private static func silence(
        for goal: Goal,
        evidence: GoalEvidence,
        now: Date,
        calendar: Calendar
    ) -> Silence? {
        // No cadence is not a cadence of seven. There is no sensible default here, and an
        // invented threshold produces an invented alarm.
        guard let cadence = goal.cadenceDays, cadence > 0 else { return nil }

        // A goal nothing has ever been linked to is the case a plain "days since last
        // activity" would miss entirely — there is no last activity. The day it was made
        // is the honest clock for it.
        let reference = evidence.lastActivityAt ?? goal.createdAt
        let days = GoalCalendar.wholeDays(from: reference, to: now, in: calendar)

        // `>` and not `>=`: a cadence of seven days asks for something *every* seven days,
        // so the seventh day is the day it is due rather than the day it is late.
        guard days > cadence else { return nil }

        return Silence(days: days, cadenceDays: cadence, since: evidence.lastActivityAt)
    }

    private static func arithmetic(
        for goal: Goal,
        evidence: GoalEvidence,
        now: Date,
        calendar: Calendar
    ) -> Arithmetic? {
        guard let targetValue = goal.targetValue, targetValue > 0 else { return nil }

        // **A unit this device cannot observe.**
        //
        // A goal measured in miles has a target of five hundred *miles*, and the only
        // thing on the phone to count is closed to-dos. Counting those against it would
        // report "you have averaged one mile a week" from data that never mentioned a
        // mile. When measurements become evidence in their own right, this gate is where
        // they arrive.
        guard goal.metricKey == nil else { return nil }

        guard
            let targetDate = goal.targetDate,
            let deadline = GoalCalendar.day(targetDate, in: calendar)
        else { return nil }

        // A target date already past, or falling today, leaves no whole weeks to divide
        // by. Any number produced here would be an artefact of the division rather than a
        // fact about the goal.
        let daysRemaining = GoalCalendar.wholeDays(from: now, to: deadline, in: calendar)
        guard daysRemaining >= 1 else { return nil }

        let daysObserved = GoalCalendar.wholeDays(from: goal.createdAt, to: now, in: calendar)
        guard daysObserved >= observationFloor else { return nil }

        return Arithmetic(
            target: targetValue,
            done: evidence.total,
            remaining: max(targetValue - Double(evidence.total), 0),
            daysRemaining: daysRemaining,
            daysObserved: daysObserved
        )
    }
}
