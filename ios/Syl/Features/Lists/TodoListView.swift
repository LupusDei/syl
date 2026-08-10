import SwiftUI
import SylKit

/// Everything he owes, including the things that have no day.
///
/// ## Why this screen exists at all
///
/// The day spine can only ever show things with a time. A to-do may have none — capture
/// writes every column except the text as null, on purpose — so until this screen those
/// to-dos existed on the server and appeared nowhere on the phone. They were not hidden
/// by a bug; they were unrepresentable.
///
/// ## No loading state, and that is a requirement rather than a nicety
///
/// FR1: every surface renders from the local database. `TodoListViewModel` assigns a
/// finished ``TodoListSnapshot`` built off the main actor, so the first frame is either
/// his to-dos or the honest empty state — never a spinner. NFR1 says a spinner on open
/// fails this epic regardless of how many beads are closed.
///
/// ## Why a `LazyVStack` and not a `List`
///
/// `List` brings the system's own separators, insets and fills, which are stock colours
/// in a screen whose acceptance criterion is that it has none (NFR5) — and it renders as
/// a table, which is precisely what the empty state is written to avoid being. A
/// `LazyVStack` builds only the rows on screen, which is what five hundred to-dos
/// scrolling without dropped frames actually requires (NFR2).
///
/// The veil is drawn but the motes are not. Ambient drift is right on a screen he looks
/// at; under a fast scroll it is motion competing with motion, and it costs frames on the
/// one surface with a stated frame budget.
struct TodoListView: View {
    var snapshot: TodoListSnapshot
    /// Writes one. See ``CaptureField``.
    var onCapture: (String) -> Void = { _ in }
    /// Nil when the screen is not presented modally, in which case no close control is
    /// drawn rather than one that goes nowhere.
    var onClose: (() -> Void)?

    /// Set false only for offscreen rendering — `ImageRenderer` lays out nothing inside a
    /// `ScrollView`, so a render harness gets an empty page. Found by looking at the first
    /// render of the home screen, which came back as backdrop and no content at all.
    var scrolls: Bool = true

    var body: some View {
        ZStack {
            SylTheme.Veil()

            if scrolls {
                ScrollView {
                    content
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)
            } else {
                // Top-aligned, because a `ZStack` centres its children and the first
                // render of the empty state came back with "Nothing is owed" floating in
                // the middle of the page — which is not where the real screen puts it. A
                // harness that lies about layout is worse than no harness.
                content.frame(maxHeight: .infinity, alignment: .top)
            }
        }
    }

    private var content: some View {
        LazyVStack(alignment: .leading, spacing: SylTheme.Metric.gutter, pinnedViews: []) {
            header

            // The head of the list, so the thing he most often wants to do is never more
            // than one tap from where he already is (T016). Above the rows rather than
            // floating over them: a bar pinned to the bottom would cover the last to-do
            // on a short list, and this screen's whole job is that nothing is invisible.
            CaptureField(onCapture: onCapture)

            if snapshot.isClear {
                clear
            } else {
                ForEach(snapshot.sections) { section in
                    band(section)
                }
                if snapshot.hasMore {
                    truncationNote
                }
            }
        }
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.top, SylTheme.Metric.gutter)
        .padding(.bottom, SylTheme.Metric.chapter)
    }

    // MARK: - Chrome

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: SylTheme.Metric.step) {
            Text("Everything open")
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)

            Spacer(minLength: 0)

            if !snapshot.isClear {
                Text("\(snapshot.openCount)")
                    .font(SylTheme.Typeface.numeral)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .contentTransition(.numericText())
                    .animation(SylTheme.Motion.settle, value: snapshot.openCount)
                    .accessibilityLabel("\(snapshot.openCount) open")
            }

            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(SylTheme.Colour.inkSoft)
                        .frame(
                            width: SylTheme.Metric.minimumTouchTarget,
                            height: SylTheme.Metric.minimumTouchTarget
                        )
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
        }
    }

    // MARK: - The list

    private func band(_ section: TodoListSection) -> some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
            Text(section.band.title)
                .sylLabelStyle()
                // `inkSoft`, not `inkFaint`. This text sits on the bare veil, whose
                // blooms composite `plusLighter` — a mid-tone disappears in the middle of
                // one. `inkFaint` is for text on glass.
                //
                // Every heading takes the same colour, including OVERDUE. It was drawn in
                // `warmth` first and the day render showed why not: warmth is a pale peach
                // built to glow against near-black, and at caption size on a near-white
                // veil it is the weakest text on the screen — the one heading that most
                // needs to be read. Structure looks uniform; the warmth lives on the rows
                // beneath, beside the words that say the same thing.
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .padding(.bottom, SylTheme.Metric.tight)
                .accessibilityAddTraits(.isHeader)

            ForEach(section.rows) { row in
                TodoRow(row: row, isOverdue: section.band == .overdue)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Said out loud rather than left as a silent `LIMIT`.
    ///
    /// A list that quietly stopped at five hundred would be the drop this project forbids
    /// wearing a query's clothes — and it would be invisible exactly when it mattered,
    /// because the rows it hid are the ones sorted last.
    private var truncationNote: some View {
        Text("Showing the first \(snapshot.rows.count) of \(snapshot.openCount).")
            .font(SylTheme.Typeface.numeral)
            .foregroundStyle(SylTheme.Colour.inkSoft)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, SylTheme.Metric.snug)
    }

    // MARK: - Nothing owed

    /// The empty state, in the voice `EmptyConversation` and `HomeView.clearDay` already
    /// established: two lines, no illustration, no starter chips.
    ///
    /// It is a clear day rather than an empty table, and that is the whole point. Every
    /// to-do app on earth renders an empty list as a void with grey text in the middle — a
    /// quiet day styled as a failure to have content. Here the second line points at the
    /// capture field directly above it, so the one thing worth doing from this state is
    /// already on screen.
    private var clear: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
            Text("Nothing is owed")
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)

            Text("Not one thing outstanding. Write it down when that changes and I will keep it.")
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, SylTheme.Metric.step)
        .transition(.opacity.combined(with: .scale(scale: 0.98)))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Previews

#Preview("Full") {
    TodoListView(snapshot: .preview(), onClose: {})
}

#Preview("Clear") {
    TodoListView(snapshot: TodoListSnapshot(), onClose: {})
}

extension TodoListSnapshot {
    /// Preview and render-harness data. **Not** test data — the tests build theirs from
    /// real model types through `build`, which is the code path that matters.
    ///
    /// It goes through `build` too, so a preview cannot drift into showing an arrangement
    /// the real screen could never produce.
    static func preview(now: Date = .now, calendar: Calendar = .current) -> TodoListSnapshot {
        let goal = Goal(
            id: "syl:goal:0198f2c0-0001-7000-8000-00000000c001",
            parentId: nil,
            title: "Finish the north valley work",
            why: nil,
            targetDate: nil,
            metricKey: nil,
            targetValue: nil,
            cadenceDays: nil,
            status: .active,
            statusReason: nil,
            createdAt: now,
            updatedAt: now
        )

        func todo(
            _ index: Int,
            _ text: String,
            dueOffsetHours: Double?,
            pinned: Bool = false,
            goalId: SylID? = nil
        ) -> Todo {
            Todo(
                id: "syl:todo:0198f2c0-0001-7000-8000-\(String(format: "%012d", index))",
                text: text,
                goalId: goalId,
                dueAt: dueOffsetHours.map { now.addingTimeInterval($0 * 3600) },
                pinned: pinned,
                status: .open,
                source: .commander,
                delegatedJobId: nil,
                createdAt: now.addingTimeInterval(-86_400 * Double(index)),
                updatedAt: now.addingTimeInterval(-3600 * Double(index)),
                completedAt: nil
            )
        }

        return build(
            todos: [
                todo(1, "Call the roofer back about the north valley flashing", dueOffsetHours: -26, goalId: goal.id),
                todo(2, "Send the signed quote", dueOffsetHours: -2),
                todo(3, "Collect the prescription", dueOffsetHours: 5),
                todo(4, "Book the car in for its service", dueOffsetHours: 78),
                todo(5, "Read the thing she found on sleep debt", dueOffsetHours: nil, pinned: true),
                todo(6, "Ask about the gutter guard", dueOffsetHours: nil, goalId: goal.id),
                todo(7, "Replace the hall bulb", dueOffsetHours: nil),
            ],
            goals: [goal],
            now: now,
            calendar: calendar
        )
    }
}
