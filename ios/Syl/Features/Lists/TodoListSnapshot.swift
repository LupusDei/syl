import Foundation
import SylKit

/// One row of the list, with everything that row needs and nothing that it does not.
///
/// ## Why the goal is a `String?` and not a `Goal`, a map, or a lookup
///
/// **`syl-008` shipped exactly the opposite and it cost the Commander two crashes.**
/// Every `ChatTurn` was handed `[SylID: [MarkdownBlock]]` — the whole transcript's parsed
/// markdown — so SwiftUI's "did this row's stored values change" comparison deep-compared
/// the entire conversation, once per row, on the main thread, on every state change
/// including each keystroke. It presents as the app freezing and then being killed,
/// because a main thread that stops answering long enough is a watchdog termination
/// rather than a slow screen.
///
/// The same shape was available here and is refused: a row holding `[SylID: Goal]` to look
/// its own title out of, or a `LocalStore` to query in its `body`. Both are quadratic and
/// both look perfectly reasonable in a diff. The slicing happens once, in the loader, off
/// the main actor, and a row compares one optional string.
struct TodoListRow: Identifiable, Equatable, Sendable {
    let todo: Todo
    /// The goal this serves, in one line. `nil` when it serves none, which is most of
    /// them — capture creates a to-do with a `goalId` of null by design.
    let goalTitle: String?
    /// When it is due, already in words. `nil` when it has no date.
    ///
    /// Formatted in the loader rather than in the row for the same reason the goal title
    /// is resolved there: a `body` should assign, not compute. It also lets the phrasing
    /// depend on the band — "14:00" under *Today* and "Was due Friday" under *Overdue*
    /// say more than one universal format could, and the row does not have to hold a
    /// clock to work out which it is.
    let dueLabel: String?

    var id: SylID { todo.id }
}

/// A heading and the rows under it.
struct TodoListSection: Identifiable, Equatable, Sendable {
    let band: TodoOrdering.Band
    let rows: [TodoListRow]

    var id: TodoOrdering.Band { band }
}

/// Everything the list renders, prepared in one go.
///
/// The same contract as `ChatSnapshot` and `HomeSnapshot`: a `Sendable` value built off
/// the main actor and assigned in one hop, so the main actor only ever does the cheap
/// part. That is what makes FR1 — every surface renders from the local database with no
/// loading state — true rather than aspirational.
struct TodoListSnapshot: Equatable, Sendable {
    var sections: [TodoListSection] = []
    /// Every open to-do on the device, counted rather than inferred from `sections`,
    /// which is windowed.
    var openCount: Int = 0
    /// True when more open to-dos exist than this snapshot carries.
    ///
    /// Exact, not a guess: the loader asks for one row beyond the window and discards it,
    /// the same trick `ChatSnapshotLoader` uses for "is there older history". A list that
    /// silently stopped at five hundred would be the quiet drop this project forbids,
    /// wearing a `LIMIT`'s clothes.
    var hasMore: Bool = false

    /// Nothing owed. The list's best state, and composed as one.
    var isClear: Bool { sections.isEmpty }

    /// The rows, flat, in reading order. For tests and for the accessibility rotor —
    /// never for rendering, which goes through `sections` so the headings survive.
    var rows: [TodoListRow] { sections.flatMap(\.rows) }
}

extension TodoListSnapshot {
    /// Builds the list from what is on disk.
    ///
    /// Pure, so the whole of it is testable without a database or a view: hand it to-dos
    /// and goals and it returns the page.
    ///
    /// - Parameters:
    ///   - openCount: how many open to-dos exist in total, which is **not**
    ///     `todos.count` when the read was windowed. Defaults to the window's own size,
    ///     which is correct exactly when the caller passed everything.
    static func build(
        todos: [Todo],
        goals: [Goal],
        now: Date,
        calendar: Calendar = .current,
        openCount: Int? = nil,
        hasMore: Bool = false
    ) -> TodoListSnapshot {
        // Built once. A per-row lookup against `goals` would be O(rows × goals), which is
        // the same quadratic mistake as handing the row the collection — just spelled
        // with a `first(where:)` instead of a dictionary.
        //
        // Canonicalised on both sides because the contract permits either hex case for an
        // id, so a raw string compare silently loses the goal on half the rows.
        var titles: [SylID: String] = [:]
        titles.reserveCapacity(goals.count)
        for goal in goals {
            titles[SylIDs.canonical(goal.id)] = goal.title
        }

        let sections = TodoOrdering.sections(for: todos, now: now, calendar: calendar)
            .map { section in
                TodoListSection(
                    band: section.band,
                    rows: section.todos.map { todo in
                        TodoListRow(
                            todo: todo,
                            goalTitle: todo.goalId.flatMap { titles[SylIDs.canonical($0)] },
                            dueLabel: dueLabel(
                                for: todo, in: section.band, now: now, calendar: calendar
                            )
                        )
                    }
                )
            }

        return TodoListSnapshot(
            sections: sections,
            openCount: openCount ?? todos.count,
            hasMore: hasMore
        )
    }

    /// When a to-do is due, said the way its band needs it said.
    ///
    /// Three phrasings, because one would be wrong twice:
    ///
    ///   * **Today** prints the time alone. Repeating today's date under a heading that
    ///     already says *Today* is the interface narrating itself.
    ///   * **Overdue** leads with `Was due`, so the row states the fact rather than
    ///     leaving a bare date for him to do the arithmetic on. Named plainly — an
    ///     assistant that softens this is managing his feelings about a fact. Something
    ///     overdue *today* gives the time instead of the date: the first render of this
    ///     screen said "Was due Mon, Aug 10" at ten o'clock on Monday the tenth, which is
    ///     true, useless, and reads as a bug.
    ///   * **Coming up** prints the date, and the time **only when there is one**. The
    ///     service stores a due date as an instant, so a date-only deadline arrives as
    ///     local midnight; printing "00:00" beside it would invent a precision the to-do
    ///     does not have.
    private static func dueLabel(
        for todo: Todo,
        in band: TodoOrdering.Band,
        now: Date,
        calendar: Calendar
    ) -> String? {
        guard let dueAt = todo.dueAt else { return nil }

        let time = dueAt.formatted(date: .omitted, time: .shortened)
        let day = dueAt.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))

        switch band {
        case .undated:
            return nil
        case .today:
            return time
        case .overdue:
            return calendar.isDate(dueAt, inSameDayAs: now) ? "Was due \(time)" : "Was due \(day)"
        case .comingUp:
            // A date-only deadline arrives as local midnight, because the service stores
            // a due date as an instant. Printing "00:00" beside it would invent a
            // precision the to-do does not have.
            guard dueAt != calendar.startOfDay(for: dueAt) else { return day }
            return "\(day), \(time)"
        }
    }
}

// MARK: - Loading

/// Reads the list from disk — **off the main actor**.
///
/// Same contract as `ChatSnapshotLoader` and `HomeSnapshotLoader`: `Sendable`, holding no
/// view or view-model reference, so it can genuinely leave the main actor rather than
/// being hopped back by an implicit capture.
struct TodoListLoader: Sendable {
    let store: LocalStore
    var now: Date = Date()
    var calendar: Calendar = .current

    /// How many rows the page carries.
    ///
    /// Five hundred because NFR2 names five hundred, and because the window has to be
    /// bigger than the number it is meant to survive — a cap at exactly the target would
    /// make the requirement untestable at its own boundary.
    var limit: Int = 500

    func load() throws -> TodoListSnapshot {
        // One more than we intend to show. Its existence is the exact answer to "is there
        // more", and it is discarded immediately.
        let window = try store.openTodos(limit: limit + 1)
        let hasMore = window.count > limit

        return TodoListSnapshot.build(
            todos: hasMore ? Array(window.prefix(limit)) : window,
            goals: try store.goals(),
            now: now,
            calendar: calendar,
            // A real `COUNT(*)`, not the window's size. "247 open" that quietly means
            // "500, and we stopped counting" is the kind of small lie this app spends its
            // comments refusing to tell.
            openCount: try store.openTodoCount(),
            hasMore: hasMore
        )
    }
}
