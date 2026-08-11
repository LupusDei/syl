import SwiftUI
import SylKit

/// One to-do, and the little that belongs beside it.
///
/// ## What this row is not
///
/// It is not a form. Proposal B's refusals — no priority ladder, no tags, no contexts, no
/// energy levels, no areas — are refusals about *capture*, and a row that renders a
/// control for each of them would smuggle the whole taxonomy back in at review time. So
/// nothing here is editable. The row shows what is true and offers no fields.
///
/// It does not offer completion either, and that is a scope line rather than an
/// oversight: finishing a thing lives on the day's spine (`syl-011.2`), and a second
/// completion affordance built here would be a second path to the same intent — the
/// mistake `plan.md` R1 names about the write transport, repeated in the UI.
///
/// ## Why the goal is one line and one string
///
/// A to-do's goal is context, so it reads as a caption rather than as a field with a
/// value. And it arrives already resolved: see ``TodoListRow`` for why a row holding a
/// map to look itself up in is the shape that cost the Commander two crashes in
/// `syl-008`.
///
/// ## Colour on the bare veil
///
/// Secondary text here is `inkSoft`, never `inkFaint`. The veil's blooms composite
/// `plusLighter`, so the ground under a word is the base *plus* up to 60% of
/// `luminanceCore`; `inkFaint` is a mid-tone with ample contrast against the base and
/// almost none in the middle of a bloom. The first night render of chat had a timestamp
/// that simply was not there. `inkFaint` is for text on glass, and this list is unboxed.
struct TodoRow: View {
    let row: TodoListRow
    /// Whether this row is one he is late on. Decided by the band rather than recomputed
    /// per row against a clock the row would have to hold.
    var isOverdue: Bool = false

    private var todo: Todo { row.todo }

    /// The gap between the text and the caption under it. Scaled, because at the largest
    /// accessibility sizes a fixed three points closes to nothing between two much taller
    /// lines.
    @ScaledMetric(relativeTo: .body) private var captionGap: CGFloat = 3

    var body: some View {
        VStack(alignment: .leading, spacing: captionGap) {
            Text(todo.text)
                .font(SylTheme.Typeface.item)
                .foregroundStyle(SylTheme.Colour.ink)
                .multilineTextAlignment(.leading)
                // Without this a to-do whose text is a paragraph — an explicit edge case
                // in the spec — is truncated to one line by the enclosing stack.
                .fixedSize(horizontal: false, vertical: true)

            if hasCaption {
                caption
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, SylTheme.Metric.snug)
        // A row is a target even where nothing is tappable yet: it keeps the rhythm of
        // the list at the floor Apple sets, so the day the spine's affordance arrives
        // here the layout does not have to move.
        .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
        // One element, not four. A VoiceOver user swiping through five hundred to-dos
        // should hear five hundred stops, not two thousand.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var hasCaption: Bool {
        row.dueLabel != nil || row.goalTitle != nil || todo.pinned
    }

    /// The quiet things under the text: when it is due, whether it is pinned, what goal
    /// it serves.
    ///
    /// ## Why `ViewThatFits` rather than one `HStack`
    ///
    /// It *was* one `HStack`, and the accessibility-size render showed exactly what that
    /// costs: the date wrapped to three lines while the goal collapsed to `Fini…`. A goal
    /// truncated to four characters is not context, it is a smudge — and this row's whole
    /// job at that size is to stay readable.
    ///
    /// So: one line while one line fits, and the goal drops to its own full-width line
    /// when it does not. The second branch is last and unconstrained, so something always
    /// fits and there is no case where this renders nothing.
    private var caption: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: SylTheme.Metric.snug) {
                facts
                goal
            }

            VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
                HStack(spacing: SylTheme.Metric.snug) { facts }
                goal
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// When it is due and whether it is pinned — short, and always together.
    @ViewBuilder
    private var facts: some View {
        Group {
            if let dueLabel = row.dueLabel {
                // The palette's one warm note, and it is scarce on purpose: if warmth
                // appears anywhere else it stops meaning "this needs you now".
                //
                // **Semibold when overdue, and that is legibility rather than emphasis.**
                // `warmth` is a pale peach designed to glow additively against near-black,
                // and in the light appearance it is the same pale tone against a near-white
                // veil. The first day render of this screen had "Was due Sun, Aug 9" sitting
                // at the edge of readable. Extra mass fixes it without touching a shared
                // token that reads correctly everywhere it is used on glass. The words
                // "Was due" carry the meaning on their own, so nothing here is colour-only.
                Text(dueLabel)
                    .font(isOverdue
                        ? SylTheme.Typeface.numeral.weight(.semibold)
                        : SylTheme.Typeface.numeral)
                    .foregroundStyle(isOverdue ? SylTheme.Colour.warmth : SylTheme.Colour.inkSoft)
            }

            if todo.pinned {
                // The word as well as the glyph. A lone pin under a to-do with no date and
                // no goal read as a stray mark rather than as a label — visible in the
                // first render, invisible in every assertion. It is a quiet `Label` rather
                // than a capsule badge because the pin is an elevator, not an override: it
                // has already lost to every deadline by the time this row is drawn, and a
                // capsule shouting PINNED would overstate what it did.
                Label("Pinned", systemImage: "pin.fill")
                    .font(SylTheme.Typeface.numeral)
                    .foregroundStyle(SylTheme.Colour.accent)
                    .accessibilityHidden(true)
            }

        }
    }

    /// The goal this serves, if it serves one. Context, not a field — and never a control:
    /// a goal's own screen belongs to `syl-011.5`, and a tappable caption here would be a
    /// second route to it with no back button of its own.
    @ViewBuilder
    private var goal: some View {
        if let goalTitle = row.goalTitle {
            Label(goalTitle, systemImage: "sparkle")
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .labelStyle(.titleAndIcon)
                // Wraps rather than truncates. `lineLimit(1)` was here and the
                // accessibility render turned "Finish the north valley work" into
                // `Fini…`, which is not context.
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Everything the eye gets from the row, in the order it reads.
    private var accessibilityLabel: String {
        var parts: [String] = [todo.text]
        if let dueLabel = row.dueLabel {
            parts.append(isOverdue ? "overdue, \(dueLabel)" : dueLabel)
        }
        if todo.pinned { parts.append("pinned") }
        if let goalTitle = row.goalTitle { parts.append("towards \(goalTitle)") }
        return parts.joined(separator: ", ")
    }
}
