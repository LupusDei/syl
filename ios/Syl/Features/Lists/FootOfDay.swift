import SwiftUI

/// The foot of the day: write one down, and the door to everything else.
///
/// ## Why both live here and why they live *there*
///
/// Capture at the foot of the day and at the head of the list means the thing he most
/// often wants to do is never more than one tap from where he already is. Proposal B's
/// argument is that a capture costing a journey is a capture that does not happen — the
/// tax is collected at the moment of lowest motivation, so the tax has to be nothing.
///
/// The door is *below* the field rather than above it because writing something down is
/// the more frequent of the two, and because "everything else" is where he looks when
/// today is done — which is, by construction, after he has read the day above it.
///
/// ## Why it is a view of its own rather than six lines inside `HomeView`
///
/// Two reasons, and the second is the real one.
///
/// 1. `HomeView` is being edited by three squads this week, and a small named view is a
///    one-line diff there instead of a fifty-line one.
/// 2. **It is the only way to look at it.** `HomeView`'s hero is sized to one whole
///    screen, so an offscreen `ImageRenderer` pass — whatever height it is given — draws
///    the hero and clips everything under it. The day and its foot have never appeared in
///    a whole-screen render and cannot. A component renders on its own, and the design
///    harness that caught three real defects in `syl-008` only works on things it can
///    actually draw.
struct FootOfDay: View {
    /// How many open to-dos are **not** on today's spine. Zero draws the door without a
    /// number rather than drawing "0 open".
    var openElsewhere: Int
    var onCapture: (String) -> Void = { _ in }
    var onOpenList: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
            CaptureField(onCapture: onCapture)
            door
        }
    }

    private var door: some View {
        Button(action: onOpenList) {
            HStack(spacing: SylTheme.Metric.snug) {
                // A row, not a caption — and that is a correction the night render forced.
                //
                // It was first drawn in `sylLabelStyle` and `inkSoft`, matching the day's
                // section labels. In the night image the words sat in the middle of one of
                // the veil's blooms and simply were not there: "EVERYTHING" survived at
                // the left edge and "ELSE 7 OPEN" dissolved. This is the `inkFaint`
                // problem from `docs/CONTEXT.md` reaching one step further up the palette,
                // because letterspaced caption2 has so little mass that even `inkSoft`
                // loses against a `plusLighter` composite.
                //
                // The right fix is not another colour, it is admitting what this is. A
                // label describes the thing under it; this is a **door**, and the one
                // thing a door must be is findable. So it takes the weight and the ink of
                // the rows above it and reads as one more item on the day — which is
                // exactly what "everything else" is.
                Text("Everything else")
                    .font(SylTheme.Typeface.item)
                    .foregroundStyle(SylTheme.Colour.ink)

                // The count is absent when there is nothing behind the door, in the same
                // spirit as the Today orb: a quiet day must not be dressed up as an empty
                // one. The door itself stays either way — navigation that disappears is
                // worse than navigation that is quiet, and a door he cannot find is how
                // undated to-dos became invisible in the first place.
                if openElsewhere > 0 {
                    Text("\(openElsewhere) open")
                        // Medium rather than regular, for the same reason the label above
                        // moved up a size: small text on the veil needs mass, not a
                        // different colour. Monospaced digits are kept — the numeric
                        // transition would jitter the label beside it otherwise.
                        .font(SylTheme.Typeface.numeral.weight(.medium))
                        .foregroundStyle(SylTheme.Colour.inkSoft)
                        .contentTransition(.numericText())
                        .animation(SylTheme.Motion.settle, value: openElsewhere)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(SylTheme.Colour.inkSoft)
            }
            .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            openElsewhere > 0 ? "Everything else, \(openElsewhere) open" : "Everything else"
        )
        .accessibilityHint("Opens every open to-do, including the ones with no date")
    }
}

#Preview("With a backlog") {
    ZStack {
        SylTheme.Veil()
        FootOfDay(openElsewhere: 7).padding(SylTheme.Metric.gutter)
    }
}
