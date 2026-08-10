import Foundation
import SylKit

/// One thing on the day's spine.
struct DayMoment: Identifiable, Equatable, Sendable {
    /// Where a moment sits relative to now.
    enum Standing: Equatable, Sendable {
        case done
        /// Its instant has passed and it is not finished. Reminders that fire late land
        /// here and *stay* here — a late reminder is never quietly dropped off the
        /// spine, which is constraint 4 rendered as a layout rule.
        case due
        case upcoming
    }

    enum Origin: Equatable, Sendable {
        case reminder
        case todo
    }

    let id: SylID
    let title: String
    /// Nil for a to-do with no due time. Those are real and common — proposal B's
    /// capture rule is that every column except the text is nullable — so the spine has
    /// to render an undated item without inventing a time for it.
    let at: Date?
    let standing: Standing
    let origin: Origin
    let urgent: Bool
    let late: Bool
    let pinned: Bool
}

/// The one thing worth saying, if there is one.
///
/// Deliberately derived from data we actually hold rather than filled with an
/// affirmation. The concept art shows a "Gentle Reminder" card with a line of gentle
/// copy in it; inventing that copy on the client would be Syl saying something she did
/// not say. When there is nothing to report this is `nil` and no card is drawn —
/// "silence is a valid answer", including visually.
struct DayNote: Equatable, Sendable {
    enum Tone: Equatable, Sendable {
        case late
        case urgent
    }

    let tone: Tone
    let text: String
}

/// Everything the home screen renders, prepared in one go.
///
/// Follows `ChatSnapshot`'s shape deliberately: a `Sendable` value built off the main
/// actor and assigned in one hop, so the main actor only ever does the cheap part.
struct HomeSnapshot: Equatable, Sendable {
    var moments: [DayMoment] = []
    /// Items not yet finished. Drives ``prominence(remaining:)``.
    var remaining: Int = 0
    var note: DayNote?
    /// How much of the screen Syl herself gets, `0...1`.
    var prominence: Double = 1
    /// Time-of-day greeting, e.g. "Good morning".
    var greeting: String = ""

    /// Nothing left today. The screen's best state, and composed as such.
    var isClear: Bool { remaining == 0 }
}

// MARK: - The rules

extension HomeSnapshot {
    /// How much room Syl gets, given how much the Commander has left to do.
    ///
    /// ## This is the idea the whole screen is built on
    ///
    /// Presence scales *inversely* with load. A busy morning pushes her to the margin
    /// and gives the day the screen; an empty day lets her fill it. The point is
    /// stated in the master plan's §9 and it has never had a visual form:
    ///
    /// > A day where Syl says nothing because nothing needed saying is a *success*,
    /// > and the system should be built so that it reads as one.
    ///
    /// Every to-do app on earth renders an empty list as a void with grey text in the
    /// middle — a quiet day styled as a failure to have content. Here the empty state
    /// is the most beautiful thing the app does, so a clear day *looks* like the
    /// achievement it is. That is the difference between an app that tolerates silence
    /// and one that rewards it.
    ///
    /// Asymptotic rather than a step table, and it never reaches its floor — the same
    /// shape as the edge-confidence decay in constraint 6, for the same reason: a hard
    /// clamp at five items would make four and forty look identical, and they are not.
    static func prominence(remaining: Int) -> Double {
        guard remaining > 0 else { return 1 }
        return 0.36 + 0.64 * exp(-0.62 * Double(remaining))
    }

    /// Time-of-day greeting.
    ///
    /// Bounded by the same wall-clock reasoning as everything else in this project:
    /// computed from the Commander's calendar, never from a UTC hour.
    static func greeting(at instant: Date, calendar: Calendar = .current) -> String {
        switch calendar.component(.hour, from: instant) {
        case 0..<5: return "Still awake"
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        case 17..<22: return "Good evening"
        default: return "Good night"
        }
    }

    /// What Syl is doing, in words, under her name.
    ///
    /// This is the single best idea in the concept art — "Thinking about your week" and
    /// "May your path be gentle" sitting quietly under her name — and it is better than
    /// it first looks. The ribbon says what she is doing in *light*, which is legible
    /// only if you already know the vocabulary. This says the same thing in language,
    /// so the character is not a puzzle on first launch, and it gives VoiceOver
    /// something true to read for a state that is otherwise purely visual.
    ///
    /// `absent` and `speaking` return nil on purpose. `absent` is not on screen at all;
    /// `speaking` is already accompanied by her actual words, and captioning that with
    /// "Speaking" is the kind of label that makes an interface feel like a machine
    /// narrating itself.
    static func phrase(for state: PresenceState) -> String? {
        switch state {
        case .absent, .speaking: return nil
        case .idle: return "Here if you need me."
        case .listening: return "Listening."
        case .thinking: return "Thinking about your week."
        case .alert: return "This one needs you now."
        case .delighted: return "That one is done."
        case .concerned: return "Something is slipping."
        case .manifest: return "Here."
        }
    }

    /// Builds the spine from what is on disk.
    ///
    /// Sorting puts undated items last rather than first: an undated to-do has no place
    /// on a timeline, and floating it to the top would push the next actual commitment
    /// below the fold. It still appears, because a text-only to-do "appears in the right
    /// places" is one of proposal B's ten named guarantees.
    static func build(
        reminders: [Reminder],
        todos: [Todo],
        now: Date,
        calendar: Calendar = .current
    ) -> HomeSnapshot {
        let dayStart = calendar.startOfDay(for: now)
        let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) ?? now

        var moments: [DayMoment] = []

        for reminder in reminders {
            let instant = reminder.nextFireAt
            guard instant >= dayStart, instant < dayEnd else { continue }

            let finished = reminder.completedAt != nil
                || reminder.deliveryState == .completed
                || reminder.deliveryState == .cancelled

            moments.append(
                DayMoment(
                    id: reminder.id,
                    title: reminder.text,
                    at: instant,
                    standing: finished ? .done : (instant <= now ? .due : .upcoming),
                    origin: .reminder,
                    urgent: reminder.urgent,
                    late: reminder.late,
                    pinned: false
                )
            )
        }

        for todo in todos {
            guard todo.status == .open || todo.status == .proposed else { continue }

            // A to-do earns a place on *today's* spine by being due today or by being
            // pinned. Everything else belongs to the list, not to the day — otherwise
            // the spine becomes the backlog and stops answering "what now".
            let dueToday = todo.dueAt.map { $0 >= dayStart && $0 < dayEnd } ?? false
            guard dueToday || todo.pinned else { continue }

            moments.append(
                DayMoment(
                    id: todo.id,
                    title: todo.text,
                    at: todo.dueAt,
                    standing: todo.dueAt.map { $0 <= now ? .due : .upcoming } ?? .upcoming,
                    origin: .todo,
                    urgent: false,
                    late: false,
                    pinned: todo.pinned
                )
            )
        }

        moments.sort { lhs, rhs in
            switch (lhs.at, rhs.at) {
            case let (l?, r?): return l < r
            case (nil, _?): return false
            case (_?, nil): return true
            case (nil, nil): return lhs.title < rhs.title
            }
        }

        let remaining = moments.filter { $0.standing != .done }.count

        return HomeSnapshot(
            moments: moments,
            remaining: remaining,
            note: note(from: moments),
            prominence: prominence(remaining: remaining),
            greeting: greeting(at: now, calendar: calendar)
        )
    }

    /// The single most worth-saying thing, or nothing.
    ///
    /// One card at most, always. Two cards is a feed, and a feed is how a helpful thing
    /// becomes noise — the risk the master plan names as the one that actually kills
    /// this product.
    private static func note(from moments: [DayMoment]) -> DayNote? {
        if let late = moments.first(where: { $0.late && $0.standing != .done }) {
            return DayNote(tone: .late, text: "\(late.title) — this was due earlier. I was late.")
        }
        if let urgent = moments.first(where: { $0.urgent && $0.standing == .due }) {
            return DayNote(tone: .urgent, text: urgent.title)
        }
        return nil
    }
}

// MARK: - Loading

/// Reads the day from disk — **off the main actor**.
///
/// Same contract as `ChatSnapshotLoader`, and for the same reason: `Sendable`, holding
/// no view or view-model reference, so it can genuinely leave the main actor instead of
/// being hopped back by an implicit capture.
struct HomeSnapshotLoader: Sendable {
    let store: LocalStore
    var now: Date = Date()
    var calendar: Calendar = .current

    func load() throws -> HomeSnapshot {
        // Reminders are fetched from the start of the day, not from `now`, so anything
        // that already fired today still appears — as `due` if unfinished, `done` if
        // handled. Fetching from `now` would make a missed reminder vanish, which is
        // the one behaviour this project forbids.
        let dayStart = calendar.startOfDay(for: now)

        return HomeSnapshot.build(
            reminders: try store.upcomingReminders(after: dayStart, limit: 50),
            todos: try store.openTodos(limit: 100),
            now: now,
            calendar: calendar
        )
    }
}
