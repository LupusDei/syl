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
struct DaySpine: View {
    var moments: [DayMoment]
    var now: Date
    /// Fires when a row is tapped. Completion lands later; the affordance is here so
    /// the layout is built around a real touch target rather than gaining one after.
    var onSelect: (DayMoment) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(moments.enumerated()), id: \.element.id) { index, moment in
                SpineRow(
                    moment: moment,
                    isFirst: index == 0,
                    isLast: index == moments.count - 1,
                    onSelect: onSelect
                )
                .transition(
                    .asymmetric(
                        insertion: .opacity.combined(with: .move(edge: .leading)),
                        removal: .opacity
                    )
                )
            }
        }
        .animation(SylTheme.Motion.settle, value: moments)
    }
}

/// One item, threaded onto the line.
private struct SpineRow: View {
    let moment: DayMoment
    let isFirst: Bool
    let isLast: Bool
    let onSelect: (DayMoment) -> Void

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
        Button {
            onSelect(moment)
        } label: {
            HStack(alignment: .top, spacing: SylTheme.Metric.step) {
                thread
                content
                Spacer(minLength: 0)
            }
            .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Opens this item")
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
            Text(moment.title)
                .font(SylTheme.Typeface.item)
                .foregroundStyle(moment.standing == .done ? SylTheme.Colour.inkFaint : SylTheme.Colour.ink)
                .strikethrough(moment.standing == .done, color: SylTheme.Colour.inkFaint)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: SylTheme.Metric.snug) {
                if let at = moment.at {
                    Text(at, format: .dateTime.hour().minute())
                        .font(SylTheme.Typeface.numeral)
                        .foregroundStyle(SylTheme.Colour.inkFaint)
                }

                if moment.late {
                    Badge(text: "Late", tint: SylTheme.Colour.warmth)
                }
                if moment.pinned {
                    Badge(text: "Pinned", tint: SylTheme.Colour.accent)
                }
            }
        }
        .padding(.vertical, SylTheme.Metric.step)
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

        return parts.joined(separator: ", ")
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
