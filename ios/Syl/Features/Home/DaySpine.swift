import SwiftUI
import SylKit

/// The day, as a thread of light.
///
/// ## Where this departs from the concept art, and why
///
/// The timeline concept alternates items left and right of a centred spine. It is the
/// most beautiful of the five and the layout does not survive contact with a real
/// device:
///
/// - **Dynamic Type breaks it.** Two columns at accessibility sizes leaves roughly
///   twelve characters per line. This screen is read at 06:00, sometimes without
///   glasses, and it is the first thing the app shows.
/// - **VoiceOver reading order becomes a guess.** Alternating sides means the visual
///   order and the accessibility order stop agreeing, and the fix is manual ordering
///   that then has to be maintained forever.
/// - **Real titles are not three words.** "Gratitude & breath" fits; "Call the roofer
///   back about the north valley flashing" does not, in half a screen.
///
/// So the thread moves to the leading edge and the content runs beside it. The visual
/// signature — a luminous vertical line with the day threaded onto it — is exactly
/// preserved, which is what made the concept good. What is lost is the symmetry, and
/// symmetry was the part that was costing legibility.
///
/// ## The affordances (`syl-011.2`)
///
/// The row used to carry one anonymous `onSelect` and a comment saying completion landed
/// later. This is later, and what replaced it is deliberately **not** a bare tap on the
/// row. Two named intents, two visible controls, two labelled accessibility actions:
///
/// - **Done** on everything. A to-do and a reminder both finish, through different store
///   helpers, and both settle rather than vanish.
/// - **Later** on a reminder only, because the contract has no deferral for a to-do.
///
/// A whole-row tap that quietly completed something would be the wrong shape twice over:
/// this screen is opened dozens of times a day so a mis-tap is a certainty, and a
/// VoiceOver user would be left to infer what activating the row means. The row is an
/// element that *carries* actions; it is not itself a button.
struct DaySpine: View {
    var moments: [DayMoment]
    var now: Date
    /// He finished it. The store decides whether that is allowed.
    var onComplete: (DayMoment) -> Void = { _ in }
    /// He asked Syl to move it. **Never a new time** — see ``DayMoment/deferralAskedAt``.
    var onPostpone: (DayMoment) -> Void = { _ in }
    /// He has read what she refused and wants it off the row.
    var onDismissRefusal: (DayMoment) -> Void = { _ in }

    /// Motion is a scarce resource here and a nuisance to some. Under Reduce Motion a row
    /// still arrives and leaves — silently ignoring a completion would be worse — but it
    /// fades rather than sliding in from the edge.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(moments.enumerated()), id: \.element.id) { index, moment in
                SpineRow(
                    moment: moment,
                    isFirst: index == 0,
                    isLast: index == moments.count - 1,
                    onComplete: onComplete,
                    onPostpone: onPostpone,
                    onDismissRefusal: onDismissRefusal
                )
                .transition(.asymmetric(insertion: arrival, removal: .opacity))
            }
        }
        // The curve a finished row leaves on. `marking(_:as:)` puts it in `done` first,
        // so what this animates is the departure *after* the confirmation, not instead
        // of it.
        .animation(SylTheme.Motion.settle, value: moments)
    }

    private var arrival: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .leading))
    }
}

/// One item, threaded onto the line.
private struct SpineRow: View {
    let moment: DayMoment
    let isFirst: Bool
    let isLast: Bool
    let onComplete: (DayMoment) -> Void
    let onPostpone: (DayMoment) -> Void
    let onDismissRefusal: (DayMoment) -> Void

    /// At the accessibility sizes the controls move under the text instead of beside it.
    ///
    /// Two 44pt targets on the trailing edge cost 88pt, which at `AX5` leaves a title
    /// about four characters wide. This screen is read at 06:00 without glasses; the
    /// affordances give up the row before the words do.
    @Environment(\.dynamicTypeSize) private var typeSize

    /// The thread's column. Wide enough for the marker's halo without pushing the text
    /// so far right that a long title loses a whole word to it.
    private let threadWidth: CGFloat = 34

    /// Distance from the top of the row to the centre of the title's first line.
    ///
    /// The marker has to sit beside the *first line of the title*, not in the middle of
    /// the row — a two-line title otherwise drags its node halfway down the row and the
    /// thread stops reading as a sequence of moments. `@ScaledMetric` because the title
    /// is `.body`: at accessibility sizes the first line moves down, and a fixed offset
    /// would leave every marker floating above its text.
    @ScaledMetric(relativeTo: .body) private var markerCentreFromTop: CGFloat = 23

    var body: some View {
        HStack(alignment: .top, spacing: SylTheme.Metric.step) {
            thread

            VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
                content
                if typeSize.isAccessibilitySize {
                    actions
                }
            }

            Spacer(minLength: 0)

            if !typeSize.isAccessibilitySize {
                actions
            }
        }
        .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
        // One element carrying named actions, rather than three focus stops whose
        // relationship a VoiceOver user has to reconstruct. `.ignore` is what keeps the
        // controls out of the rotor as separate buttons; they are reachable as the row's
        // actions instead, which is where they belong.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        // Named, distinct, and in the same words the visible controls carry. A VoiceOver
        // user gets "Done" and "Later" as actions on the row rather than a tap whose
        // meaning has to be inferred from the fact that the row is a button.
        .accessibilityActions {
            if moment.mayBeCompleted {
                Button("Done") { onComplete(moment) }
            }
            if moment.mayBeDeferred {
                Button("Later, by \(ReminderNotification.snoozeMinutes) minutes") {
                    onPostpone(moment)
                }
            }
            if moment.refusal != nil {
                Button("Dismiss what Syl said") { onDismissRefusal(moment) }
            }
        }
    }

    // MARK: - Actions

    private var actions: some View {
        HStack(spacing: SylTheme.Metric.tight) {
            if moment.mayBeDeferred {
                RowAction(symbol: "clock.arrow.circlepath", title: "Later") {
                    onPostpone(moment)
                }
            }
            if moment.mayBeCompleted {
                RowAction(symbol: "checkmark", title: "Done") { onComplete(moment) }
            }
        }
    }

    // MARK: - Thread

    private var thread: some View {
        ZStack(alignment: .top) {
            // The line runs the full height of the row and is faded out at the ends of
            // the list, so the thread reads as one continuous filament rather than as
            // a stack of separate segments with seams between them.
            VStack(spacing: 0) {
                segment.opacity(isFirst ? 0 : 1)
                    .frame(height: markerCentreFromTop)
                segment.opacity(isLast ? 0 : 1)
            }

            SpineMarker(standing: moment.standing, urgent: moment.urgent)
                .offset(y: markerCentreFromTop - SylTheme.Metric.markerSize / 2)
        }
        .frame(width: threadWidth)
    }

    private var segment: some View {
        Rectangle()
            .fill(
                LinearGradient(
                    colors: [
                        SylTheme.Colour.luminance.opacity(0.45),
                        SylTheme.Colour.luminance.opacity(0.18),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .frame(width: 1.2)
            .frame(maxHeight: .infinity)
    }

    // MARK: - Content

    private var content: some View {
        VStack(alignment: .leading, spacing: 3) {
            // `inkSoft` for a finished row, not `inkFaint`, and the render is why.
            //
            // This is the `syl-008` lesson arriving on the other screen: the day sits on
            // the **bare veil**, whose blooms composite `plusLighter`, so the ground under
            // a given word is the base colour plus up to 60% of `luminanceCore`. A
            // mid-tone has ample contrast against the base and almost none in the middle
            // of a bloom. Struck through at `inkFaint` the settled row was simply gone —
            // which destroys the point of settling at all. The completed state is the
            // confirmation, and a confirmation nobody can read is a row that vanished
            // with extra steps.
            Text(moment.title)
                .font(SylTheme.Typeface.item)
                .foregroundStyle(moment.standing == .done ? SylTheme.Colour.inkSoft : SylTheme.Colour.ink)
                .strikethrough(moment.standing == .done, color: SylTheme.Colour.inkSoft)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: SylTheme.Metric.snug) {
                // Also `inkSoft`, for the same reason as the title above — and it matters
                // most on a deferred row, where this is the *original* time and the whole
                // claim being made is that it still stands. A claim rendered in a tone
                // the background can reach is a claim that is sometimes not there.
                if let at = moment.at {
                    Text(at, format: .dateTime.hour().minute())
                        .font(SylTheme.Typeface.numeral)
                        .foregroundStyle(SylTheme.Colour.inkSoft)
                }

                if moment.late {
                    Badge(text: "Late", tint: SylTheme.Colour.warmth)
                }
                if moment.pinned {
                    Badge(text: "Pinned", tint: SylTheme.Colour.accent)
                }
            }

            if moment.deferralAskedAt != nil {
                deferralNote
            }
            if let refusal = moment.refusal {
                refusalNote(refusal)
            }
        }
        .padding(.vertical, SylTheme.Metric.step)
    }

    /// He asked. She has not answered. **The time above has not moved and must not.**
    ///
    /// This is the one place in the app where the optimistic render is deliberately
    /// weaker than it could be. Showing "10:15" — the fifteen minutes the device knows
    /// perfectly well it asked for — would look right and be an instant that exists
    /// nowhere: the server owns a deferral's new time, and it may refuse the ask outright
    /// with `DEFERRAL_NOT_LATER`. So the row states exactly what is known, which is that
    /// he asked and it has not landed yet.
    ///
    /// `accent`, not `warmth`. Nothing is wrong here; something is in flight. Warmth is
    /// the palette's one warm note and it is spent on a refusal, one line down.
    private var deferralNote: some View {
        Text("Waiting on Syl to move this")
            .sylLabelStyle()
            .foregroundStyle(SylTheme.Colour.accent)
            // It must wrap, never truncate. At `AX3` this line came back as "WAITING ON
            // SYL…", which is not a shortened version of the sentence — it is a different
            // and worse claim, because what is missing is the half that says the time
            // above has not moved.
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// What she refused, beside the thing it is about.
    ///
    /// The `syl-008` treatment, reused as the epic asks: `warmth` — the palette's single
    /// warm note, held in reserve for exactly this — outlining the note rather than
    /// filling it, so it reads as "attend to this" without the alarm of red.
    ///
    /// On the row and not in a banner. A message at the top of the screen saying a to-do
    /// was already finished makes him hunt for which one, and the naming is the whole
    /// reason the store refuses by name in the first place.
    private func refusalNote(_ refusal: String) -> some View {
        Button {
            onDismissRefusal(moment)
        } label: {
            // One line where there is room, two where there is not — and the interpunct
            // goes with the single line, because a separator alone on a row separates
            // nothing. Left as one `HStack` at `AX3` this hyphenated the recovery across
            // the break — "DIS-MISS" — which is the sort of thing only a render finds.
            VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
                if typeSize.isAccessibilitySize {
                    Text(refusal)
                    Text("Dismiss").underline()
                } else {
                    HStack(spacing: SylTheme.Metric.tight) {
                        Text(refusal)
                        Text("·")
                        Text("Dismiss").underline()
                    }
                }
            }
            .sylLabelStyle()
            .foregroundStyle(SylTheme.Colour.warmth)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, SylTheme.Metric.snug)
            .padding(.vertical, SylTheme.Metric.tight)
            .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(SylTheme.Colour.warmth.opacity(0.75), lineWidth: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHidden(true)
    }

    private var accessibilityLabel: String {
        var parts: [String] = [moment.title]

        switch moment.standing {
        case .done: parts.append("completed")
        case .due: parts.append(moment.late ? "was due earlier, late" : "due now")
        case .upcoming: break
        }

        if let at = moment.at {
            parts.append(at.formatted(date: .omitted, time: .shortened))
        }
        if moment.pinned { parts.append("pinned") }

        // Said the same way it is drawn: a deferral was asked for, and the time read out
        // a moment ago is still the one that stands.
        if moment.deferralAskedAt != nil {
            parts.append("waiting on Syl to move this, still at this time until she answers")
        }
        if let refusal = moment.refusal {
            parts.append(refusal)
        }

        return parts.joined(separator: ", ")
    }
}

/// One control on a row: a glyph in a ring, padded out to Apple's floor.
///
/// Icon-only on purpose. A row already carries a title that can run to two lines at the
/// reading size, and two word-labelled buttons beside it would take the title down to a
/// column. The words are not lost — they are the row's accessibility actions, which is
/// the surface where a label is actually read rather than merely displayed.
private struct RowAction: View {
    let symbol: String
    /// Kept as the button's own label so this reads correctly even if a caller stops
    /// merging the row into one element.
    let title: String
    let action: () -> Void

    private var tint: Color { SylTheme.Colour.accent }

    /// The ring grows with the type it sits beside. A fixed 32pt disc next to `AX3` body
    /// text reads as a decoration rather than a control — small enough that it stops
    /// looking like the thing you are meant to press.
    @ScaledMetric(relativeTo: .body) private var ring: CGFloat = 32

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(.subheadline, design: .default, weight: .regular))
                .foregroundStyle(tint)
                .frame(width: ring, height: ring)
                .background { Circle().fill(tint.opacity(0.12)) }
                .overlay { Circle().stroke(tint.opacity(0.34), lineWidth: 0.8) }
                // The ring starts at 32pt because a 44pt disc beside body text reads as a
                // button bar. The *target* is still 44pt — the frame around it is what
                // Apple's floor is actually about.
                .frame(
                    minWidth: SylTheme.Metric.minimumTouchTarget,
                    minHeight: SylTheme.Metric.minimumTouchTarget
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}

/// The node on the thread.
///
/// Three appearances, and the pulse belongs to exactly one of them. Anything overdue
/// pulses; nothing else moves. Motion on the spine is a scarce resource — if every
/// marker breathed, the one that actually needs attention would be invisible.
private struct SpineMarker: View {
    let standing: DayMoment.Standing
    let urgent: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var size: CGFloat { SylTheme.Metric.markerSize }

    var body: some View {
        ZStack {
            // The halo. Only the live marker has one, and it is what makes "now" findable
            // in a glance down the thread.
            if standing == .due {
                Circle()
                    .fill(tint.opacity(0.22))
                    .frame(width: size * 2.6, height: size * 2.6)
                    .blur(radius: 5)
            }

            switch standing {
            case .done:
                Circle()
                    .fill(SylTheme.Colour.luminance.opacity(0.55))
                    .frame(width: size * 0.62, height: size * 0.62)

            case .due:
                Circle()
                    .fill(tint)
                    .frame(width: size, height: size)
                    .overlay {
                        Circle().stroke(SylTheme.Colour.luminanceCore.opacity(0.9), lineWidth: 1)
                    }

            case .upcoming:
                Circle()
                    .stroke(SylTheme.Colour.hairline, lineWidth: 1.2)
                    .background(Circle().fill(SylTheme.Colour.veil.opacity(0.6)))
                    .frame(width: size * 0.86, height: size * 0.86)
            }
        }
        .modifier(Pulse(active: standing == .due && !reduceMotion))
    }

    private var tint: Color {
        urgent ? SylTheme.Colour.warmth : SylTheme.Colour.luminance
    }
}

/// A slow two-second swell. Deliberately not a flash.
private struct Pulse: ViewModifier {
    let active: Bool
    @State private var on = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(active && on ? 1.14 : 1.0)
            .opacity(active && on ? 1.0 : 0.82)
            .animation(
                active ? .easeInOut(duration: 2).repeatForever(autoreverses: true) : .default,
                value: on
            )
            .onAppear { on = true }
    }
}

/// A small capsule label. Used sparingly — two on one row is already too many.
private struct Badge: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .sylLabelStyle()
            .foregroundStyle(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background {
                Capsule().fill(tint.opacity(0.14))
            }
            .overlay {
                Capsule().stroke(tint.opacity(0.30), lineWidth: 0.8)
            }
    }
}
