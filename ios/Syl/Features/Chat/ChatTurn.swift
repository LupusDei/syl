import SwiftUI
import SylKit

/// One turn in the conversation.
///
/// ## The decision this file exists to carry (D1, `syl-008.3.7`)
///
/// **She is unboxed. He is boxed.**
///
/// Her turn is set as a *page*: full measure, no container, ink on the veil, with a
/// hairline light-rail down the left margin carrying her luminance. His turn is the
/// only boxed object on screen — glass, inset from the right, deliberately narrow.
///
/// A bubble is the worst possible container for a document, and her turns are about to
/// contain headings, ordered lists, tables and fenced code. Every one of those fights a
/// rounded rectangle: the code slab wants to scroll horizontally inside a box that is
/// already inside a vertical scroll view, and a table wants exactly the width the bubble
/// is denying it. The asymmetry is also simply true to the content — his messages are
/// one line and hers are twelve, and giving two wildly different shapes the same
/// container is the tell of a template.
///
/// The cost is honest: unboxed text loses the at-a-glance "who said this". Three things
/// pay for it — the rail, the alignment and measure split, and hers being ink-on-veil
/// while his sits on glass, which reads as a different plane.
struct ChatTurn: View {
    let group: MessageGroup
    let showsTime: Bool

    /// Index within the visible transcript, used only to stagger the first paint.
    var index: Int = 0

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isFromCommander: Bool { group.role == .user }

    var body: some View {
        Group {
            if isFromCommander {
                commanderTurn
            } else {
                sylTurn
            }
        }
        .frame(maxWidth: .infinity, alignment: isFromCommander ? .trailing : .leading)
        // One element per turn, announcing its speaker. Previously a turn was several
        // unlabelled elements and a stray number, so VoiceOver read the transcript as
        // undifferentiated text with no sense of who was talking.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    // MARK: - Her turn: a page

    private var sylTurn: some View {
        HStack(alignment: .top, spacing: SylTheme.Metric.step) {
            lightRail

            VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
                ForEach(group.messages) { message in
                    MessageBody(message: message)
                }

                if showsTime {
                    turnTime
                }
            }
            .frame(maxWidth: SylTheme.Metric.proseMeasure, alignment: .leading)
        }
    }

    /// The light-rail.
    ///
    /// This is `DaySpine`'s vocabulary carried into the transcript — the same hairline,
    /// the same luminance gradient — which is what "chat belongs to the same world"
    /// should mean. Painting bubbles in theme colours is not it.
    ///
    /// It fades toward the bottom rather than stopping on a hard edge, so a turn ends
    /// the way she ends everywhere else in this app: by dissolving.
    private var lightRail: some View {
        Capsule(style: .continuous)
            .fill(
                LinearGradient(
                    colors: [
                        SylTheme.Colour.luminance.opacity(0.55),
                        SylTheme.Colour.luminance.opacity(0.16),
                        SylTheme.Colour.luminance.opacity(0),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .frame(width: SylTheme.Metric.railWidth)
            // Decorative: the speaker is already announced in the turn's label, and a
            // VoiceOver user does not need to be told there is a line.
            .accessibilityHidden(true)
    }

    // MARK: - His turn: an object

    private var commanderTurn: some View {
        VStack(alignment: .trailing, spacing: SylTheme.Metric.snug) {
            VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
                ForEach(group.messages) { message in
                    MessageBody(message: message)
                }
            }
            .padding(.horizontal, SylTheme.Metric.step)
            .padding(.vertical, SylTheme.Metric.snug + 2)
            // Reduced presence: his object is present without competing with her page
            // for the eye. At full presence the specular rim reads as the brightest
            // thing on screen, which is the wrong hierarchy — he is the object, she is
            // the weather.
            .sylGlass(radius: SylTheme.Metric.cardRadius, presence: 0.55)
            // Capped rather than full-bleed. Today a long message runs edge to edge,
            // which on a wide window is a slab; the cap is what keeps it an object.
            .frame(maxWidth: commanderMeasure, alignment: .trailing)
            // A pending turn is visibly unfinished rather than indistinguishable from a
            // sent one.
            .opacity(group.isPending ? 0.62 : 1)

            if showsTime || group.isPending {
                turnTime
            }
        }
    }

    /// How wide his object may get.
    ///
    /// A share of the measure rather than a share of the screen, so it stays a
    /// conversational object on an iPad instead of growing into a second page.
    private var commanderMeasure: CGFloat { SylTheme.Metric.proseMeasure * 0.78 }

    // MARK: - Time

    /// The clock reading, outside the container.
    ///
    /// Adjutant's one clearly better layout idea. Inside the bubble the time competes
    /// with the words for the same rectangle; outside it, it is available without ever
    /// being read by accident.
    /// `inkSoft`, not `inkFaint`, and the render is why.
    ///
    /// `inkFaint` is the correct token for a label on *glass* — home uses it that way
    /// throughout. On the bare veil it fails, because the veil's blooms are composited
    /// `plusLighter`: the background under a given word is not the base colour, it is
    /// the base colour plus up to 60% of `luminanceCore`. A mid-tone like `inkFaint`
    /// (`#6C7A90` at night) has ample contrast against the base and almost none in the
    /// middle of a bloom. The first night render had a timestamp that simply was not
    /// there.
    ///
    /// This is the cost of D1: unboxing her put small text on a moving background, and
    /// small text on a moving background has to be a tone the background cannot reach.
    private var turnTime: some View {
        Text(timeText)
            .font(SylTheme.Typeface.numeral)
            .foregroundStyle(SylTheme.Colour.inkSoft)
            .accessibilityHidden(true)
    }

    private var timeText: String {
        let time = group.startedAt.formatted(date: .omitted, time: .shortened)
        return group.isPending ? "\(time) · sending" : time
    }

    // MARK: - Accessibility

    /// The whole turn as one sentence: who spoke, what they said, and when.
    ///
    /// The time is folded in rather than left as its own element, because a stray number
    /// read after a paragraph is a puzzle.
    private var accessibilityLabel: String {
        let speaker = isFromCommander ? "You said" : "Syl said"
        let time = group.startedAt.formatted(date: .omitted, time: .shortened)
        let state = group.isPending ? ", sending" : ""
        return "\(speaker), \(time)\(state). \(group.text)"
    }
}

/// The words themselves.
///
/// **This is the seam `T011` replaces.** Today it is a `Text`; when the markdown engine
/// lands (`syl-008.1`) the body becomes `MarkdownView(blocks:)` and nothing else in this
/// file changes. Isolating it to one view is what makes that a one-line change rather
/// than a rewrite of the turn layout.
private struct MessageBody: View {
    let message: Message

    var body: some View {
        Text(message.text)
            .font(SylTheme.Typeface.Prose.body)
            .lineSpacing(SylTheme.Metric.proseLineSpacing)
            .foregroundStyle(SylTheme.Colour.ink)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The rule between one day and the next.
///
/// The identical treatment as the home screen's date label — letterspaced caps between
/// hairlines. This is the cheapest single thing that makes chat read as the same
/// product, and until now the transcript printed no date at all, so yesterday at 9:14
/// and today at 9:14 were indistinguishable.
struct DayDivider: View {
    let day: Date
    var now: Date = Date()

    var body: some View {
        HStack(spacing: SylTheme.Metric.step) {
            hairline
            Text(TranscriptRhythm.dayLabel(for: day, now: now))
                .sylLabelStyle()
                // `inkSoft` for the same reason as ``ChatTurn/turnTime`` — letterspaced
                // caps are thin strokes, which lose to a bloom before body text does.
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .fixedSize()
            hairline
        }
        .padding(.vertical, SylTheme.Metric.snug)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(TranscriptRhythm.dayLabel(for: day, now: now))
    }

    private var hairline: some View {
        Rectangle()
            .fill(SylTheme.Colour.hairline)
            .frame(height: SylTheme.Metric.hair)
    }
}
