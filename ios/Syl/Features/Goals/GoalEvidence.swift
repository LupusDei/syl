import Foundation
import SylKit

/// What has actually happened on a goal, and when.
///
/// ## The refusal this type exists to enforce
///
/// Proposal B: *"Self-reported percentages are fiction and they decay. Progress is
/// evidenced."* There is no percent-complete column on the server, none on the device,
/// and none here — so a percentage could only ever be **invented by the UI**, which is
/// exactly why the thing the UI is handed is a list of events rather than a number.
///
/// > A goal's progress is the set of things that actually happened and were linked to it:
/// > to-dos closed, events attended, sessions logged, measurements recorded, artifacts
/// > produced. If nothing has happened, the system says nothing has happened — which is
/// > true, and which a self-reported 60% would have hidden.
///
/// Closed to-dos are the only one of those five the device holds today. The others get
/// cases on ``Entry/Kind`` when they arrive; nothing else about this shape changes.
///
/// ## Evidence is not the same as commitment
///
/// An **open** to-do linked to a goal is an intention, not an event. Counting it as
/// progress would be the self-report this design refuses, one indirection away — so it
/// lives in ``commitments``, separately, and the two are never divided by one another.
/// The moment either becomes the denominator of the other there is a percentage on
/// screen, whatever it is called.
///
/// ## Pure, and computed off the main actor
///
/// No I/O, no store, no view. `GoalSnapshotLoader` runs it on a detached task and the
/// main actor only ever assigns the result — D5, and the lesson `syl-008` paid two
/// crashes for: a projection re-derived per row in a `body` is a projection re-derived
/// once per frame per row.
struct GoalEvidence: Equatable, Sendable {

    /// One thing that happened.
    struct Entry: Identifiable, Equatable, Sendable {
        /// What kind of thing it was.
        ///
        /// One case today because the device holds one kind of evidence today. It is an
        /// enum rather than a `Bool` or nothing at all because the *next* kind — a
        /// session logged, a measurement recorded — must not require the view to be
        /// rewritten around it.
        enum Kind: Equatable, Sendable {
            case todoClosed
        }

        var id: SylID
        var kind: Kind
        /// His own words for it. Never a summary and never truncated here — the view
        /// decides how much of a paragraph it can show.
        var text: String
        var at: Date
    }

    /// Something linked and still open.
    ///
    /// Carries `pinned` and `dueAt` and nothing else, because there is nothing else:
    /// proposal B refuses a priority ladder, so `pinned` is the one durable bit of "this
    /// one matters" and there is no stored priority to read.
    struct Commitment: Identifiable, Equatable, Sendable {
        var id: SylID
        var text: String
        var dueAt: Date?
        var pinned: Bool
    }

    /// What happened, newest first, bounded by the window.
    var entries: [Entry] = []

    /// How many more lie behind the window.
    ///
    /// The depth of the history, never a denominator. A goal worked at for a year has
    /// hundreds of closed to-dos and the screen cannot show them all — but showing nine
    /// and implying that is all of them is its own small lie.
    var earlier: Int = 0

    /// Every closed thing, whether or not it fits the window.
    var total: Int = 0

    /// Still-open commitments. **Not evidence.**
    var commitments: [Commitment] = []

    var lastActivityAt: Date?
    var firstActivityAt: Date?

    /// The one question this whole surface is built to answer honestly.
    var nothingHasHappened: Bool { entries.isEmpty }

    // MARK: - The empty case, in words

    /// What a goal with no evidence says, in her voice.
    ///
    /// This is the sentence the epic turns on. It must read as a **statement** rather
    /// than as a failed load — the empty state here is the honest one, and an empty state
    /// that looks broken teaches him to distrust the screen that is telling him the
    /// truth.
    var headline: String? {
        nothingHasHappened ? "Nothing has happened yet." : nil
    }

    /// The line under it, and there are two of them because there are two ways to have no
    /// evidence — and one sentence covering both would contradict the list underneath it.
    var explanation: String? {
        guard nothingHasHappened else { return nil }
        if commitments.isEmpty {
            return "Nothing is linked to this goal, so there is nothing to show you. "
                + "I would rather say that than invent a number."
        }
        return "Things are linked to this goal, but none of them has finished. "
            + "That is the whole of what I know."
    }

    // MARK: - Projection

    /// Project a goal's evidence from the to-dos linked to it.
    ///
    /// - Parameters:
    ///   - goal: the goal in question. Used only to check the link, so a caller that
    ///     hands over a wider list gets its own slice back rather than the whole device's
    ///     history filed under one title.
    ///   - todos: candidate to-dos. `LocalStore.todos(goalId:)` already filters, and this
    ///     filters again — cheaply, and it is the difference between a bug and a defect.
    ///   - window: how many entries the caller intends to render.
    static func project(goal: Goal, todos: [Todo], window: Int = 8) -> GoalEvidence {
        let linked = todos.filter { todo in
            guard let goalId = todo.goalId else { return false }
            return SylIDs.areEqual(goalId, goal.id)
        }

        var closed: [Entry] = []
        closed.reserveCapacity(linked.count)
        for todo in linked where todo.status == .done {
            closed.append(
                Entry(
                    id: todo.id,
                    kind: .todoClosed,
                    text: todo.text,
                    // The column is nullable and rows predating it carry nothing. Dropping
                    // such a row loses evidence; dating it "now" invents some. `updatedAt`
                    // is the honest fallback — for a closed row, it is when it closed.
                    at: todo.completedAt ?? todo.updatedAt
                )
            )
        }

        // Newest first, tie-broken by id so two things closed in the same second render
        // in the same order every time. A list that reshuffles between loads reads as a
        // bug even when every element is correct.
        closed.sort { lhs, rhs in
            lhs.at == rhs.at ? lhs.id > rhs.id : lhs.at > rhs.at
        }

        // `dropped` appears in neither list on purpose: setting something down is not
        // progress toward the goal, and it is not still owed either. `proposed` is
        // structure Syl inferred rather than an explicit ask, and its UI is deliberately
        // out of scope for this epic — rendering it beside things he actually asked for
        // would present a guess as a commitment.
        var open: [Commitment] = []
        for todo in linked where todo.status == .open {
            open.append(
                Commitment(id: todo.id, text: todo.text, dueAt: todo.dueAt, pinned: todo.pinned))
        }

        return GoalEvidence(
            entries: Array(closed.prefix(max(window, 0))),
            earlier: max(closed.count - max(window, 0), 0),
            total: closed.count,
            commitments: open,
            lastActivityAt: closed.first?.at,
            firstActivityAt: closed.last?.at
        )
    }
}
