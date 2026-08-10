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
    /// `var` so ``HomeSnapshot/marking(_:as:)`` can settle a row in place. Nothing else
    /// moves it — it is otherwise derived from disk on every rebuild.
    var standing: Standing
    let origin: Origin
    let urgent: Bool
    let late: Bool
    let pinned: Bool

    /// When he asked Syl to move this, if he has and she has not answered yet.
    ///
    /// **This is an instant he chose, never one the device computed.** `at` above still
    /// holds the time the server last stated, unmoved, because the server owns a
    /// deferral's new instant (plan D2, constraint 4). Rendering `at + 15 minutes` here
    /// would look right on screen and be a time that exists nowhere else — and a phone
    /// that was wiped would take it with it.
    ///
    /// Sliced out of ``LocalStore/deferralRequests()`` **in the loader**, so the row
    /// carries one optional date rather than a map covering the whole list. `syl-008`
    /// shipped the opposite and it cost the Commander two crashes.
    var deferralAskedAt: Date?

    /// Why the last thing he asked of this row did not happen, in one line.
    ///
    /// On the row rather than in a banner: a refusal that names a to-do from the top of
    /// the screen makes him hunt for which one, and the whole point of naming it is that
    /// hearing the wrong title is the last place a wrong id is catchable.
    var refusal: String?
}

extension DayMoment {
    /// Whether Done may be offered.
    ///
    /// A finished row keeps its place for a beat so the completion can be read, and for
    /// that beat it must not be completable again — the store would refuse it by name,
    /// which is correct and would still read as the app having gone wrong.
    var mayBeCompleted: Bool { standing != .done }

    /// Whether Later may be offered.
    ///
    /// Reminders only: the contract has no deferral for a to-do. And **not while one is
    /// already in flight** — a second ask mints a second idempotency key, which the server
    /// would honour as a second deferral and land the reminder half an hour late instead
    /// of fifteen minutes. That is the failure `Outbox.Kind` documents, arriving through
    /// the UI rather than through a retry, and it is invisible here precisely because D2
    /// forbids the row from showing a new time: he would have no way to tell.
    ///
    /// A rule with that much consequence does not belong inside a `body`, where nothing
    /// can assert it.
    var mayBeDeferred: Bool {
        origin == .reminder && deferralAskedAt == nil && mayBeCompleted
    }
}

/// What a row says when Syl refused what he asked of it.
///
/// A translation, not a rendering of `Error`. `LocalStoreError`'s own text names the
/// item — `"Book the dentist" is already finished` — which is exactly right coming from
/// the store and wrong on a row that is already showing that title two lines up. Here it
/// is the row that supplies the subject and this that supplies the verb.
enum DayRefusal {
    /// One line, always. Silence is the failure this exists to prevent, so an error it
    /// has never seen still gets a sentence rather than nothing.
    static func phrase(for error: Error) -> String {
        guard let refusal = error as? LocalStoreError else { return "That did not go through" }

        switch refusal {
        case .todoAlreadyFinished, .reminderAlreadyFinished:
            return "Already finished"
        case .noSuchTodo, .noSuchReminder:
            return "No longer on this device"
        case .todoHasNotReachedSylYet:
            // `syl-011.1.8`. Completing a capture the server has never heard of would
            // undo itself on the next sweep, so it is refused rather than lost — and
            // that has to read as a "not yet", because it is one.
            return "Not with Syl yet — this one completes once she has it"
        case .emptyCapture:
            return "There was nothing to write down"
        }
    }
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

    /// Open to-dos that are **not** on today's spine — the ones with no date, and the
    /// dated ones belonging to another day.
    ///
    /// This is the number on the door at the foot of the day, and it is the whole reason
    /// undated to-dos stop being invisible: the spine can only show things with a time,
    /// so without a count of what it cannot show, "everything else" is a door with no
    /// indication that there is anything behind it.
    var openElsewhere: Int = 0

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

    /// Whether Syl is *doing* something, as opposed to merely being present.
    ///
    /// The home screen uses this to decide whether the ribbon is drawn at all. `idle` is
    /// deliberately not active: she is there, she is lit, and she is not working — which
    /// is the majority of the time and should look like rest rather than like a process
    /// running.
    static func isActive(_ state: PresenceState) -> Bool {
        switch state {
        case .listening, .thinking, .speaking, .alert, .delighted, .manifest: return true
        case .absent, .idle, .concerned: return false
        }
    }

    /// Builds the spine from what is on disk.
    ///
    /// Sorting puts undated items last rather than first: an undated to-do has no place
    /// on a timeline, and floating it to the top would push the next actual commitment
    /// below the fold. It still appears, because a text-only to-do "appears in the right
    /// places" is one of proposal B's ten named guarantees.
    ///
    /// `deferralsAskedAt` is handed in whole and **sliced here, once per row**, rather
    /// than queried per row in a `body`. Keys are canonical because the contract permits
    /// either hex case for an id, and a bare `==` would quietly lose the marker.
    /// - Parameter openTodoCount: how many open to-dos exist in total, which is **not**
    ///   `todos.count` when the read was windowed. Defaults to counting the to-dos handed
    ///   in, which is correct exactly when the caller passed everything. It exists so the
    ///   door at the foot of the day cannot say "100 open" forever once he passes a
    ///   hundred — a number that stops being true precisely when it starts mattering.
    static func build(
        reminders: [Reminder],
        todos: [Todo],
        now: Date,
        calendar: Calendar = .current,
        deferralsAskedAt: [SylID: Date] = [:],
        openTodoCount: Int? = nil
    ) -> HomeSnapshot {
        let dayStart = calendar.startOfDay(for: now)
        let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) ?? now

        var moments: [DayMoment] = []
        /// Open to-dos that earned a place on today's spine. Counted rather than filtered
        /// again afterwards, so the two can never disagree about what "on the spine"
        /// means.
        var todosOnSpine = 0

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
                    pinned: false,
                    deferralAskedAt: deferralsAskedAt[SylIDs.canonical(reminder.id)]
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

            todosOnSpine += 1
            moments.append(
                DayMoment(
                    id: todo.id,
                    title: todo.text,
                    at: todo.dueAt,
                    standing: todo.dueAt.map { $0 <= now ? .due : .upcoming } ?? .upcoming,
                    origin: .todo,
                    urgent: false,
                    late: false,
                    pinned: todo.pinned,
                    // Deliberately never consulted for a to-do: the contract has no
                    // deferral for one, so a key that happened to collide must not put
                    // an affordance on a row that cannot honour it.
                    deferralAskedAt: nil
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

        return recomposed(
            moments,
            greeting: greeting(at: now, calendar: calendar),
            // Clamped at zero rather than trusted to be positive. The count and the
            // window are two reads a moment apart, so a to-do completed between them
            // would otherwise put "-1 open" on his home screen.
            openElsewhere: max(
                (openTodoCount ?? todos.filter { $0.status == .open }.count) - todosOnSpine,
                0
            )
        )
    }

    /// Everything derived from the spine, derived once.
    ///
    /// `remaining`, the note and Syl's prominence are all functions of the rows. Anything
    /// that changes a row has to go back through here, or the count above the day starts
    /// disagreeing with the rows under it — which is precisely the self-contradicting
    /// state the preview data was fixed for.
    /// `openElsewhere` is threaded THROUGH rather than recomputed, and that is the whole
    /// reason it is a parameter. This runs again every time a row is marked done, and it
    /// has no to-dos to count — only the spine. Recomputing here would silently reset the
    /// door's count to zero the first time he finishes anything.
    private static func recomposed(
        _ moments: [DayMoment],
        greeting: String,
        openElsewhere: Int
    ) -> HomeSnapshot {
        let remaining = moments.filter { $0.standing != .done }.count

        return HomeSnapshot(
            moments: moments,
            remaining: remaining,
            note: note(from: moments),
            prominence: prominence(remaining: remaining),
            greeting: greeting,
            openElsewhere: openElsewhere
        )
    }

    /// Moves one row's standing without re-reading disk.
    ///
    /// ## Why completion needs this at all
    ///
    /// Both stores drop a finished item on the next read: `openTodos` filters on
    /// `status = open`, and `upcomingReminders` filters `completed` and `cancelled` out.
    /// So a plain refresh after a completion makes the row *vanish* — no confirmation,
    /// nothing to check, and no moment in which he could tell he tapped the wrong one.
    ///
    /// This is the settling instead: the row stays exactly where it is and turns
    /// finished — struck through, its marker gone quiet, the count above the day already
    /// ticked down — and only then does it leave, on ``SylTheme/Motion/settle``. The
    /// held beat *is* the confirmation, which is what a list with no undo owes him.
    ///
    /// Ids are compared canonically. A bare `==` against a differently-cased id would
    /// mark nothing at all, and look identical to a tap that never registered.
    func marking(_ id: SylID, as standing: DayMoment.Standing) -> HomeSnapshot {
        let target = SylIDs.canonical(id)
        let moved = moments.map { moment -> DayMoment in
            guard SylIDs.canonical(moment.id) == target else { return moment }
            var moment = moment
            moment.standing = standing
            return moment
        }
        return Self.recomposed(moved, greeting: greeting, openElsewhere: openElsewhere)
    }

    /// Attaches each refusal to its own row, and takes off any that is no longer held.
    ///
    /// One pass over the spine, in the model. The alternative — handing every row the
    /// whole map and letting each look itself up in `body` — is the quadratic render
    /// `syl-008` shipped, and the reason risk R4 is written down.
    func applying(refusals: [SylID: String]) -> HomeSnapshot {
        var updated = self
        updated.moments = moments.map { moment in
            var moment = moment
            moment.refusal = refusals[SylIDs.canonical(moment.id)]
            return moment
        }
        return updated
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

        // Read once, whole, and sliced per row inside `build`. A row that held the map
        // and looked itself up while drawing is R4 — the defect `syl-008` shipped.
        return HomeSnapshot.build(
            reminders: try store.upcomingReminders(after: dayStart, limit: 50),
            todos: try store.openTodos(limit: 100),
            now: now,
            calendar: calendar,
            deferralsAskedAt: try store.deferralRequests(),
            // A real `COUNT(*)`, because the read above is windowed at a hundred and the
            // door's count must not stop being true at a hundred and one.
            openTodoCount: try store.openTodoCount()
        )
    }
}
