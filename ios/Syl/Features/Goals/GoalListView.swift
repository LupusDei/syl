import SwiftUI
import SylKit

/// Where a goal is opened from. A dedicated type rather than `SylID` — which is a bare
/// `String` — so this stack's destination cannot be claimed by any other string somebody
/// pushes onto it later.
struct GoalRoute: Hashable, Sendable {
    var id: SylID
}

/// His goals, behind the Goals orb.
///
/// ## What this screen refuses to show
///
/// No percentage, no progress ring, no completion fraction, no bar. Not because they were
/// forgotten — because proposal B refuses them: *"Self-reported percentages are fiction
/// and they decay. Progress is evidenced."* The only thing on a row that speaks to
/// movement is a sentence about when something last happened, and when nothing has, it
/// says that.
///
/// ## Nothing is hidden, including what he set down
///
/// The sections run live → parked → history, and `abandoned` keeps its own heading at the
/// foot rather than being filtered out. It is titled **"Set down"**, because the reason
/// people abandon goal systems is accumulated guilt, and a list that quietly deletes what
/// you stopped doing is the same thing as a list that shames you for it — both teach you
/// not to look.
struct GoalListView: View {
    /// Nil until the first load lands. Renders as the bare veil, which is neither a
    /// spinner nor a false "no goals yet".
    var snapshot: GoalListSnapshot?

    /// Set false only for offscreen rendering. `ImageRenderer` lays out nothing inside a
    /// `ScrollView`, exactly as `HomeView` and `ChatView` both record.
    var scrolls: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            SylTheme.Veil()
                .ignoresSafeArea()
            MoteField(count: 24, presence: 0.7)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            if scrolls {
                ScrollView {
                    content
                }
                .scrollIndicators(.hidden)
            } else {
                VStack(spacing: 0) {
                    content
                    Spacer(minLength: 0)
                }
            }
        }
        .animation(reduceMotion ? nil : SylTheme.Motion.settle, value: snapshot)
        .navigationTitle("Goals")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                // The serif, as on chat's bar. A stock system title here is the single
                // most visible way a new screen announces that it belongs to a different
                // app from the rest of Syl.
                Text("Goals")
                    .font(SylTheme.Typeface.title)
                    .foregroundStyle(SylTheme.Colour.ink)
                    .accessibilityAddTraits(.isHeader)
            }
        }
        .toolbarBackground(.hidden, for: .navigationBar)
        .navigationDestination(for: GoalRoute.self) { route in
            // Every goal on this screen was projected when the list was, so pushing one is
            // an assignment rather than a load. That is what keeps NFR1 — no spinner on
            // open — true of the detail screen as well as of this one.
            if let row = snapshot?.row(id: route.id) {
                GoalDetailView(snapshot: row)
            } else {
                GoalNotHere()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let snapshot {
            if snapshot.isEmpty {
                empty
            } else {
                LazyVStack(alignment: .leading, spacing: SylTheme.Metric.loose) {
                    ForEach(snapshot.sections) { section in
                        GoalSection(section: section)
                    }
                }
                .padding(.horizontal, SylTheme.Metric.gutter)
                .padding(.top, SylTheme.Metric.step)
                .padding(.bottom, SylTheme.Metric.chapter)
            }
        }
    }

    /// No goals at all. The same voice as the clear day and the empty conversation: a
    /// statement about the world, not a report about the app.
    private var empty: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
            Text(GoalListSnapshot.emptyHeadline)
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)

            Text(GoalListSnapshot.emptyExplanation)
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.vertical, SylTheme.Metric.chapter)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - A section

private struct GoalSection: View {
    let section: GoalListSnapshot.Section

    var body: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
            // `inkSoft`, not `inkFaint`. This heading sits on the bare veil, whose blooms
            // composite `plusLighter` — a mid-tone label vanishes entirely where a bloom
            // passes under it.
            Text(section.title)
                .goalSectionLabel()

            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                    NavigationLink(value: GoalRoute(id: row.id)) {
                        GoalRow(snapshot: row, isFirst: index == 0)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// One goal, as a door.
///
/// ## Why this is not a glass card
///
/// It was, and the day render is what changed it. `sylGlass` composites
/// `.ultraThinMaterial`, which against the pale veil samples the fog and darkens it —
/// beautiful as one `NoteCard` on home, and as a column of eight it turned the whole
/// screen into grey slabs. That is the exact failure ``SylTheme/Glass`` names in its own
/// documentation, arrived at from the other direction: not fake glass, but too much real
/// glass.
///
/// So a goal row uses the day spine's idiom instead — content on the bare veil, separated
/// by a hairline. It reads the same in both appearances, it scales to two hundred rows
/// without compositing two hundred materials, and it is what makes this screen and Today
/// look like they were drawn by the same hand.
private struct GoalRow: View {
    let snapshot: GoalDetailSnapshot
    let isFirst: Bool

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(alignment: .top, spacing: SylTheme.Metric.step) {
            VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
                // Nesting, T028: the parent link is visible on the child, so the
                // hierarchy is legible without the list having to be a tree — which at
                // accessibility sizes is twelve characters per line of indent.
                if let parent = snapshot.parent {
                    // `inkSoft`, not `inkFaint`. Everything on this row sits on the bare
                    // veil, whose blooms composite `plusLighter` — a mid-tone label
                    // vanishes entirely where a bloom passes under it. Hierarchy here
                    // comes from size and tracking rather than from tone.
                    Text("Under \(parent.title)")
                        .font(SylTheme.Typeface.numeral)
                        .foregroundStyle(SylTheme.Colour.inkSoft)
                        .lineLimit(1)
                }

                Text(snapshot.goal.title)
                    .font(SylTheme.Typeface.title)
                    .foregroundStyle(SylTheme.Colour.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                // The horizon — derived from the target date rather than stored — and the
                // date itself. Stacked at the accessibility sizes for the reason the
                // detail screen's target line is: two runs on one row across 393pt
                // hyphenate themselves mid-word once the type is large enough.
                horizonLine

                // The one line on this row that speaks to movement — and it is a
                // sentence about a date, never a number about a fraction.
                Text(snapshot.activityLine)
                    .font(SylTheme.Typeface.detail)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .accessibilityHidden(true)
                .padding(.top, SylTheme.Metric.snug)
        }
        .padding(.vertical, SylTheme.Metric.step)
        .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
        // A rule above every row but the first, so the section reads as one run rather
        // than as a stack of separate objects.
        .overlay(alignment: .top) {
            if !isFirst {
                Rectangle()
                    .fill(SylTheme.Colour.hairline)
                    .frame(height: SylTheme.Metric.hair)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Opens this goal")
    }

    @ViewBuilder
    private var horizonLine: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: SylTheme.Metric.tight))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: SylTheme.Metric.snug))

        layout {
            Text(snapshot.horizonLabel)
                .sylLabelStyle()
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .fixedSize(horizontal: false, vertical: true)

            if let day = snapshot.targetDay {
                Text(day, format: .dateTime.day().month(.abbreviated).year())
                    .font(SylTheme.Typeface.numeral)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var accessibilityLabel: String {
        var parts: [String] = [snapshot.goal.title]
        if let parent = snapshot.parent { parts.append("under \(parent.title)") }
        parts.append(snapshot.horizonLabel)
        parts.append(snapshot.activityLine)
        return parts.joined(separator: ", ")
    }
}

/// A goal the list no longer holds.
///
/// Reachable only if a goal is removed by a sync landing between the tap and the push. It
/// says so rather than showing a blank screen, because a blank screen reads as a crash.
struct GoalNotHere: View {
    var body: some View {
        ZStack {
            SylTheme.Veil().ignoresSafeArea()

            VStack(spacing: SylTheme.Metric.snug) {
                Text("That goal is not here any more.")
                    .font(SylTheme.Typeface.title)
                    .foregroundStyle(SylTheme.Colour.ink)
                Text("It may have been removed while you were looking at the list.")
                    .font(SylTheme.Typeface.detail)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .multilineTextAlignment(.center)
            }
            .padding(SylTheme.Metric.gutter)
            .accessibilityElement(children: .combine)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
    }
}

// MARK: - The screen

/// Owns the goals screen's lifecycle; `GoalListView` stays a pure function of values.
///
/// The same split `HomeScreen` makes, for the same reason: a view with no observable
/// objects of its own can be constructed and rendered in a test without booting the app's
/// object graph.
struct GoalsScreen: View {
    @StateObject private var model: GoalsViewModel

    init(store: LocalStore) {
        _model = StateObject(wrappedValue: GoalsViewModel(store: store))
    }

    var body: some View {
        GoalListView(snapshot: model.snapshot)
            .task { await model.refresh() }
    }
}

extension GoalListSnapshot {
    /// The row for a goal, wherever it sits.
    ///
    /// Linear, and called once per navigation rather than once per frame — the cost of an
    /// index would be a second structure to keep in step with this one.
    func row(id: SylID) -> GoalDetailSnapshot? {
        for section in sections {
            if let match = section.rows.first(where: { SylIDs.areEqual($0.id, id) }) {
                return match
            }
        }
        return nil
    }
}
