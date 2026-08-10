import Foundation
import SylKit

/// The order everything he owes reads in, and the headings that break it up.
///
/// ## Why this is a function and not a column
///
/// Proposal B refuses a priority ladder outright:
///
/// > Priority is a property of a moment, not of a task. A stored priority is stale
/// > within a day.
///
/// So there is nothing to read. The order is *computed* from three things the model
/// genuinely knows — when it is due, whether he pinned it, and when it was last touched.
/// This type reads no priority because none exists, and `TodoOrderingTests` asserts that
/// against the model rather than trusting a comment.
///
/// ## Why it is here rather than in the view
///
/// Same reason `TranscriptRhythm` is not inside `ChatView`: a rule buried in a `body`
/// cannot be asserted, and this one has a precedence question in it that reasonable
/// people answered differently — twice, in writing, before it was settled.
///
/// ## The precedence, and how it was settled
///
/// **Deadline first, then `pinned`, then recency.** In terms:
///
/// 1. Anything with a due date, before anything without one.
/// 2. Among dated to-dos, the soonest deadline first — and *nothing else*.
/// 3. Among to-dos that tie on the above, pinned first.
/// 4. Then the most recently touched.
///
/// The disagreement worth recording is at step 2. The device's SQL and the service's
/// `todos_agenda_idx` both led with `pinned DESC`, which reads as obvious — the pin is
/// the one durable signal of "this one matters", so surely it goes on top. It is wrong,
/// and the case that shows it is ordinary: pin *call the roofer* with no date, have *file
/// the taxes* due in two hours, and a pinned-first list puts the roofer above the taxes.
/// That is not the list honouring his pin, it is the list lying about what is urgent.
/// Proposal B calls `pinned` durable; it never calls it more important than a deadline,
/// and its whole argument for computing order at read time is that urgency belongs to the
/// moment rather than to the row. Settled by the epic lead, 2026-08-10.
///
/// So **`pinned` is an elevator, not an override**. It lifts a to-do above its equals,
/// which in practice means above the other undated ones — and since capture writes every
/// column except the text as null, that is where most of his to-dos live. The pin is not
/// inert; it simply cannot outrank a clock.
///
/// ## Agreement with the database is load-bearing, not tidiness
///
/// ``LocalStore/openTodos(limit:)`` orders by the same four terms, and that read takes a
/// **LIMIT**. SQLite therefore chooses *which* rows this function ever sees, so a
/// disagreement would not merely reorder a page — it would hand this function the wrong
/// hundred rows out of five hundred, which it would then arrange immaculately. Nothing
/// would look broken; to-dos would simply never appear. `TodoOrderingTests` asserts the
/// agreement against a real database rather than trusting the two to stay in step.
///
/// ## The last term is recency, not age
///
/// `updatedAt` **descending** — most recently touched first — which is worth stating
/// because "staleness" reads the other way. Capture is why. The capture field sits at the
/// head of this list, and a to-do he has just written down that sorted to the bottom of
/// five hundred undated rows would look exactly like a capture that did nothing.
enum TodoOrdering {
    /// The whole list, in reading order.
    ///
    /// **Stable**: rows tied on every term keep the order they arrived in, so a list
    /// re-sorted on each refresh does not visibly reshuffle. Swift's `sort` gives no such
    /// guarantee, hence the decorated index.
    static func order(_ todos: [Todo]) -> [Todo] {
        todos
            .enumerated()
            .sorted { lhs, rhs in
                if let decided = precedence(lhs.element, rhs.element) { return decided }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    /// Whether `lhs` sorts above `rhs`, or `nil` when every term ties.
    ///
    /// Separated out so the rule reads as four steps rather than as a sorting closure,
    /// and so `nil` — a genuine tie — is distinguishable from `false`.
    private static func precedence(_ lhs: Todo, _ rhs: Todo) -> Bool? {
        switch (lhs.dueAt, rhs.dueAt) {
        case let (left?, right?) where left != right:
            return left < right
        // A to-do with no date is not more urgent than one due this hour. SQLite's
        // default is the opposite — NULLs first — and it was a live defect that put every
        // undated to-do above the one due in an hour.
        case (nil, .some):
            return false
        case (.some, nil):
            return true
        default:
            break
        }

        if lhs.pinned != rhs.pinned { return lhs.pinned }
        if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
        return nil
    }

    // MARK: - Bands

    /// A heading in the list.
    ///
    /// Four, deliberately. Each answers a question he actually asks — *am I late, what is
    /// today, what is coming, what has no date at all* — and a fifth would start to be a
    /// taxonomy rather than a signpost. `Coming up` absorbs tomorrow and next month
    /// because the row prints its own date and a heading repeating it is noise.
    ///
    /// **There is no `Pinned` band, and its absence is the ruling above made visible.** A
    /// pinned band at the top would reintroduce pinned-first through the back door: a
    /// to-do due this morning would sit below one he pinned last March. The pin shows on
    /// the row instead, and lifts the row within its own band.
    enum Band: Equatable, Hashable, Sendable, CaseIterable {
        /// Its instant has passed and it is not finished. Named plainly — an assistant
        /// that softens "overdue" into "earlier" is managing his feelings about a fact.
        case overdue
        case today
        case comingUp
        /// Real and common. Proposal B's capture rule is that every column except the
        /// text is nullable, so these are the majority of what he owns — and they are
        /// precisely the ones the day spine can never show, which is why this screen
        /// exists at all.
        case undated

        var title: String {
            switch self {
            case .overdue: return "Overdue"
            case .today: return "Today"
            case .comingUp: return "Coming up"
            case .undated: return "No date"
            }
        }
    }

    /// One heading and the rows under it.
    struct Section: Identifiable, Equatable, Sendable {
        let band: Band
        let todos: [Todo]

        var id: Band { band }
    }

    /// The same order, with signposts in it.
    ///
    /// **Banding is a presentation of ``order(_:)``, never a reordering of it.** Read top
    /// to bottom the rows come out in exactly the flat sequence, which holds because the
    /// bands are monotonic in the leading sort terms — ascending `dueAt` through overdue,
    /// today and later, then the undated. `TodoOrderingTests` asserts the flattening
    /// identity against a shuffled fixture, so a band added later cannot quietly break it.
    ///
    /// Empty bands are dropped. A heading over nothing is a list telling him about its own
    /// structure instead of about his day.
    ///
    /// - Parameters:
    ///   - now: the instant "overdue" and "today" are measured against.
    ///   - calendar: injected so a test can pin the timezone. Banding is a wall-clock
    ///     question, and a test that reads the device calendar is one that passes in
    ///     Chicago and fails in Auckland.
    static func sections(
        for todos: [Todo],
        now: Date,
        calendar: Calendar = .current
    ) -> [Section] {
        let ordered = order(todos)
        guard !ordered.isEmpty else { return [] }

        let endOfToday = calendar.date(
            byAdding: .day,
            value: 1,
            to: calendar.startOfDay(for: now)
        ) ?? now

        var grouped: [Band: [Todo]] = [:]
        for todo in ordered {
            grouped[band(for: todo, now: now, endOfToday: endOfToday), default: []].append(todo)
        }

        // Driven by `allCases` rather than by a second hand-written list, so a band added
        // to the enum cannot be silently absent from the page.
        return Band.allCases.compactMap { band in
            guard let todos = grouped[band], !todos.isEmpty else { return nil }
            return Section(band: band, todos: todos)
        }
    }

    private static func band(for todo: Todo, now: Date, endOfToday: Date) -> Band {
        guard let dueAt = todo.dueAt else { return .undated }
        if dueAt < now { return .overdue }
        if dueAt < endOfToday { return .today }
        return .comingUp
    }
}
