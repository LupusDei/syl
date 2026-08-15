import Foundation
import SylKit

/// Everything one goal's screen renders, prepared in one go.
///
/// The same value backs a row in the list and the whole of the detail screen. That is
/// deliberate: it is what makes tapping a goal **instant**, with no second load and no
/// spinner — NFR1 — because the screen he is opening was already computed when the list
/// was.
///
/// Every field is a small value. Nothing here is a collection covering the whole list,
/// which is the shape `syl-008` shipped into a transcript and paid for with two watchdog
/// terminations (plan R4). A row compares its own eight entries and no more.
struct GoalDetailSnapshot: Identifiable, Equatable, Sendable {
    var goal: Goal
    var horizon: GoalHorizon
    var evidence: GoalEvidence
    var risk: GoalRisk

    /// The parent link — **the title, not the parent.** A row holding a whole `Goal` for
    /// its parent would hold that parent's evidence too, once per child.
    var parent: Link?

    /// What is nested under this one.
    var children: [Link] = []

    /// Midnight on the target date, in the loader's calendar. Nil when there is no target
    /// date, or when the one stored cannot be read.
    var targetDay: Date?

    /// Whole days from now to the target. Negative once it has passed.
    var daysUntilTarget: Int?

    /// Whole days since the last thing happened, or since the goal was made when nothing
    /// ever has.
    var daysSinceActivity: Int

    var id: SylID { goal.id }

    /// A goal named, and nothing else about it.
    struct Link: Identifiable, Equatable, Sendable {
        var id: SylID
        var title: String
        var status: GoalStatus
    }

    // MARK: - The copy

    /// The horizon, as it is written on screen.
    ///
    /// `GoalHorizon` alone cannot answer this. `life` covers both "no target date at all"
    /// and "a target more than a year out", and only one of those is honestly described as
    /// having no end date — the first render of the list printed
    /// `NO END DATE · Jun 1, 2027` on a goal that plainly had one. The horizon is still
    /// derived and still never stored; this is the sentence for it.
    var horizonLabel: String {
        targetDay == nil ? "No end date" : horizon.label
    }

    /// What the list says under a goal's title.
    ///
    /// **Only for an active goal.** "Last moved two hundred days ago" under something he
    /// consciously set down is a reproach, and this app does not do those.
    var activityLine: String {
        guard goal.status == .active else { return standingLabel }
        guard evidence.lastActivityAt != nil else { return "Nothing linked yet" }

        switch daysSinceActivity {
        case ..<1: return "Something moved today"
        case 1: return "Last moved yesterday"
        default: return "Last moved \(daysSinceActivity) days ago"
        }
    }

    /// The word for what state this goal is in.
    ///
    /// `abandoned` is **"Set down"** and never "Abandoned", "Failed" or "Dropped".
    /// Proposal B made the state first-class precisely because *"the reason people abandon
    /// goal systems is accumulated guilt — a list of things they have silently failed
    /// at"*, and the label is where that either survives or does not. Setting something
    /// down is a decision he made, and the word for it should sound like one.
    var standingLabel: String {
        switch goal.status {
        case .active: return "Active"
        case .dormant: return "Not now"
        case .achieved: return "Done"
        case .abandoned: return "Set down"
        case .proposed: return "Suggested"
        }
    }

    /// The sentence under that word, on the detail screen. Nil while a goal is simply
    /// running — there is nothing to explain about a goal that is just his.
    var standingNote: String? {
        switch goal.status {
        case .active:
            return nil
        case .dormant:
            return "Not now is a real answer. This one is parked, with everything on it intact."
        case .achieved:
            return "This one is finished."
        case .abandoned:
            return "You set this one down. Nothing that happened on it has been deleted, "
                + "and you can pick it back up whenever you want it."
        case .proposed:
            return "Syl inferred this one from something you said. It is not yours until you "
                + "say so."
        }
    }

    /// What the target date line says, when there is one.
    ///
    /// A date that has passed is stated as a date that has passed. That is arithmetic on
    /// a calendar, not a judgement — the judgement would be calling it *overdue*.
    ///
    /// **Only while the goal is active.** The date itself still shows on anything he set
    /// down or parked, because it is part of what the goal was; the *countdown* does not,
    /// because a ticking clock on something he decided to stop is the accumulated guilt
    /// this whole surface is built to avoid. Found by looking at the set-down render,
    /// which said "92 days from now" under "You set this one down".
    var targetNote: String? {
        guard goal.status == .active else { return nil }
        guard let days = daysUntilTarget else { return nil }
        switch days {
        case ..<0: return "That date has passed."
        case 0: return "That is today."
        case 1: return "Tomorrow."
        default: return "\(days) days from now."
        }
    }
}

/// The goals screen, prepared in one go.
struct GoalListSnapshot: Equatable, Sendable {
    var sections: [Section] = []

    /// How many goals exist, which is not how many this snapshot carries.
    var goalCount: Int = 0

    /// Whether the window stopped short of the whole set (`syl-o319`).
    ///
    /// Surfaced rather than merely recorded. A `hasMore` nobody draws is the same defect
    /// as no `hasMore` at all, wearing a field name — see `GoalListView`.
    var hasMore: Bool = false

    var isEmpty: Bool { sections.isEmpty }

    /// A run of goals in the same state.
    struct Section: Identifiable, Equatable, Sendable {
        var status: GoalStatus
        var title: String
        var rows: [GoalDetailSnapshot]

        var id: String { status.rawValue }
    }

    /// The order the states read in: what is live, then what is parked, then what is
    /// history.
    ///
    /// **Nothing is hidden.** `abandoned` sits last because a page reads from the live
    /// things down to the finished ones, not because it is being buried — it keeps its
    /// own heading, its own rows and, when opened, all of its evidence.
    static let order: [GoalStatus] = [.active, .dormant, .proposed, .achieved, .abandoned]

    static func title(for status: GoalStatus) -> String {
        switch status {
        case .active: return "Active"
        case .dormant: return "Not now"
        case .proposed: return "Suggested"
        case .achieved: return "Done"
        case .abandoned: return "Set down"
        }
    }

    /// What the screen says when he has no goals at all. A statement, not a shrug.
    static let emptyHeadline = "No goals yet."
    static let emptyExplanation =
        "Tell her what you are working toward. She will keep it, and she will tell you the "
        + "truth about whether it is moving."
}

/// Reads every goal from disk and projects it — **off the main actor**.
///
/// The pattern is `ChatSnapshotLoader`'s, and so is the reason: reading the rows,
/// decoding each payload and projecting evidence takes long enough to drop frames if it
/// happens on the main actor. `Sendable` and free of any view or view-model reference, so
/// it genuinely leaves the main actor rather than being hopped back by an implicit
/// capture.
///
/// ## The read pattern, stated rather than hidden
///
/// One query for the goals, then one for each goal's to-dos. That is N+1, knowingly: the
/// alternative is an aggregate read added to `LocalStore`, and at the number of goals a
/// person actually keeps — tens, not thousands — an indexed lookup per goal on a
/// background task once per screen open is not worth the seam. If a goal list ever grows
/// past a few hundred, this is the line to change, and it is one line.
struct GoalSnapshotLoader: Sendable {
    let store: LocalStore
    var now: Date
    var calendar: Calendar = .current
    /// How much evidence a screen intends to show at once.
    var window: Int = 8

    /// How many goals the screen carries at once (`syl-o319`).
    ///
    /// Named here rather than left to `LocalStore.goals(limit:)`'s default, because a
    /// default is a number nobody chose for this screen and nothing can report reaching.
    /// Two hundred is generous for a person's goals and the point is that going past it
    /// is now *said* rather than silently absorbed.
    var limit: Int = 200

    func load() throws -> GoalListSnapshot {
        // One more than we intend to show, the same trick `openTodos` uses, and its
        // existence is the exact answer to "is there more" (`syl-o319`).
        //
        // This read used to take the default 200 and say nothing on reaching it, which
        // was two defects rather than one. The visible half is a list that stops with no
        // indication. **The invisible half is worse**: these same rows build the
        // parent/child index below, so a child whose parent sorted past the window lost
        // its parent link — a goal quietly orphaned in the UI while its row was on disk
        // the whole time, which reads as corrupted data rather than as a cap.
        // Named `page` rather than `window`, which is already this type's evidence count.
        let page = try store.goals(limit: limit + 1)
        let hasMore = page.count > limit
        let goals = hasMore ? Array(page.prefix(limit)) : page

        // Case-insensitive keys throughout. The contract permits either hex case and the
        // service accepts both, so two spellings of one parent id must not orphan a child.
        var byId: [SylID: Goal] = [:]
        byId.reserveCapacity(goals.count)
        for goal in goals { byId[SylIDs.canonical(goal.id)] = goal }

        var childrenByParent: [SylID: [GoalDetailSnapshot.Link]] = [:]
        for goal in goals {
            guard let parentId = goal.parentId else { continue }
            childrenByParent[SylIDs.canonical(parentId), default: []]
                .append(.init(id: goal.id, title: goal.title, status: goal.status))
        }

        let snapshots = try goals.map { goal -> GoalDetailSnapshot in
            // **The one cap in `syl-o319` that is left as a cap, with its reason.**
            //
            // `LocalStore.todos(goalId:)` orders `dueAt IS NULL, dueAt, pinned DESC,
            // updatedAt DESC` and `GoalEvidence.project` takes `window` (8) from the
            // FRONT of that order. So the rows a 200-cap can drop are the tail, and the
            // tail is never what evidence shows — the eight are identical whether the
            // read stops at 200 or returns two thousand.
            //
            // Disclosure here would therefore be reporting a truncation with no visible
            // consequence, which is its own small dishonesty: a note that says "there is
            // more" beside a projection that was never trying to show it. If evidence
            // ever counts, samples, or reaches past the front of this order, this line
            // stops being safe and needs the `limit + 1` treatment the goals read above
            // now has.
            let todos = try store.todos(goalId: goal.id)
            let evidence = GoalEvidence.project(goal: goal, todos: todos, window: window)
            let risk = GoalRisk.project(
                goal: goal, evidence: evidence, now: now, calendar: calendar)

            let targetDay = goal.targetDate.flatMap { GoalCalendar.day($0, in: calendar) }
            let parent = goal.parentId
                .flatMap { byId[SylIDs.canonical($0)] }
                .map { GoalDetailSnapshot.Link(id: $0.id, title: $0.title, status: $0.status) }

            return GoalDetailSnapshot(
                goal: goal,
                horizon: GoalHorizon.derive(for: goal, calendar: calendar),
                evidence: evidence,
                risk: risk,
                parent: parent,
                children: childrenByParent[SylIDs.canonical(goal.id)] ?? [],
                targetDay: targetDay,
                daysUntilTarget: targetDay.map {
                    GoalCalendar.wholeDays(from: now, to: $0, in: calendar)
                },
                daysSinceActivity: GoalCalendar.wholeDays(
                    from: evidence.lastActivityAt ?? goal.createdAt, to: now, in: calendar)
            )
        }

        // Sections in a fixed order, and an empty one is dropped rather than rendered as a
        // heading with nothing under it.
        let sections = GoalListSnapshot.order.compactMap { status -> GoalListSnapshot.Section? in
            let rows = snapshots.filter { $0.goal.status == status }
            guard !rows.isEmpty else { return nil }
            return GoalListSnapshot.Section(
                status: status,
                title: GoalListSnapshot.title(for: status),
                rows: rows
            )
        }

        return GoalListSnapshot(
            sections: sections,
            // A real `COUNT(*)`, not the window's size, for the same reason
            // `TodoListSnapshot` gives: a number derived from a window stops being true
            // exactly when it starts mattering.
            goalCount: try store.goalCount(),
            hasMore: hasMore
        )
    }
}
