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

    /// Parsed markdown for **this turn's** messages, in order.
    ///
    /// Deliberately a small array and not the transcript-wide dictionary. SwiftUI
    /// compares a row's stored values to decide whether to re-render it, so holding the
    /// whole map here made every update deep-compare every message's markdown, once per
    /// row — quadratic work on the main thread, which presents as the app freezing and
    /// then being killed by the watchdog.
    var blocks: [[MarkdownBlock]] = []

    /// True when this turn is queued and the connection is not up, so "sending" would
    /// be a lie. Derived rather than stored: there is no failure state on a message yet
    /// (`syl-008.3.8`), and inventing one in the view would be worse than saying only
    /// what is actually known.
    var isStalled: Bool = false

    /// Runs the outbox. Nil where retrying is meaningless.
    var retry: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isFromCommander: Bool { group.role == .user }

    /// The blocks for one message, positionally. The array is built from
    /// `group.messages` in the loader, so index alignment holds — and the fallback means
    /// a mismatch degrades to plain text rather than losing the words.
    private func blocks(at index: Int, fallback message: Message) -> [MarkdownBlock] {
        index < blocks.count ? blocks[index] : [.paragraph(message.text)]
    }

    var body: some View {
        // The one place a transcript row is counted. See `ChatRowCensus` for why this
        // question needs a counter when the parse cost next door needed a stopwatch.
        let _ = ChatRowCensus.recordRowBuild()
        Group {
            if isFromCommander {
                commanderTurn
            } else {
                sylTurn
            }
        }
        .frame(maxWidth: .infinity, alignment: isFromCommander ? .trailing : .leading)
        // A container of elements rather than one merged element — and the change is
        // `syl-008.6`'s, so the reason is worth stating.
        //
        // A turn *used* to be `.combine`d whole, which was right when a turn was only
        // words: it read as one sentence announcing its speaker, instead of several
        // unlabelled fragments and a stray number. But `.combine` flattens its
        // descendants into a single non-actionable element, so the moment a turn can
        // contain a picture, combining it makes the picture an unreachable noun in the
        // middle of a sentence — and does the same to the "Try again" control.
        //
        // So the *prose* is still one element per message, still labelled with the
        // speaker and the time (see ``MessageBody``), and an attachment sits beside it
        // as its own focusable thing that says what it is. The transcript still reads as
        // a conversation; the things in it can now be reached.
        .accessibilityElement(children: .contain)
        .contextMenu {
            Button {
                // The RAW text, not the rendered text. Once markdown renders, copying
                // what is on screen would strip the structure that makes it worth
                // copying — a plan pasted without its list is not a plan.
                UIPasteboard.general.string = group.text
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }

            if let retry, isStalled {
                Button {
                    retry()
                } label: {
                    Label("Try again", systemImage: "arrow.clockwise")
                }
            }
        }
    }

    // MARK: - Her turn: a page

    private var sylTurn: some View {
        HStack(alignment: .top, spacing: SylTheme.Metric.step) {
            lightRail

            VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
                ForEach(Array(group.messages.enumerated()), id: \.element.id) { index, message in
                    MessageBody(
                        blocks: blocks(at: index, fallback: message),
                        attachments: message.attachments,
                        // Only the first message in the turn carries the "Syl said,
                        // 9:14" preamble. Repeating it on every message would read the
                        // speaker's name once per paragraph.
                        label: index == 0 ? accessibilityLabel(for: message) : message.text
                    )
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
                ForEach(Array(group.messages.enumerated()), id: \.element.id) { index, message in
                    MessageBody(
                        blocks: blocks(at: index, fallback: message),
                        // Inside the glass, not beside it. His turn is an object, and a
                        // picture he sent is part of that object rather than a thing
                        // floating next to it.
                        attachments: message.attachments,
                        label: index == 0 ? accessibilityLabel(for: message) : message.text
                    )
                }
            }
            .padding(.horizontal, SylTheme.Metric.step)
            .padding(.vertical, SylTheme.Metric.snug + 2)
            // Reduced presence: his object is present without competing with her page
            // for the eye. At full presence the specular rim reads as the brightest
            // thing on screen, which is the wrong hierarchy — he is the object, she is
            // the weather.
            .sylGlass(radius: SylTheme.Metric.cardRadius, presence: 0.55)
            // A stalled turn is outlined in `warmth` — the palette's single warm note,
            // held in reserve for exactly this. It is the only non-cool colour that
            // appears anywhere in the app, so it reads as "attend to this" without a
            // word, and without the alarm of red.
            .overlay {
                if isStalled {
                    RoundedRectangle(cornerRadius: SylTheme.Metric.cardRadius, style: .continuous)
                        .strokeBorder(SylTheme.Colour.warmth.opacity(0.75), lineWidth: 1)
                }
            }
            // Capped rather than full-bleed. Today a long message runs edge to edge,
            // which on a wide window is a slab; the cap is what keeps it an object.
            .frame(maxWidth: commanderMeasure, alignment: .trailing)
            // A pending turn is visibly unfinished rather than indistinguishable from a
            // sent one.
            .opacity(group.isPending ? 0.62 : 1)

            if isStalled {
                stalledNote
            } else if showsTime || group.isPending {
                turnTime
            }
        }
    }

    /// Said plainly, with the recovery attached.
    ///
    /// "Waiting to send" rather than "Failed": the intent is durable in the outbox and
    /// will go out on its own when the tailnet returns. Calling that a failure would be
    /// both untrue and needlessly alarming — but saying nothing leaves him believing a
    /// message landed when it did not.
    private var stalledNote: some View {
        Button {
            retry?()
        } label: {
            HStack(spacing: SylTheme.Metric.tight) {
                Text("Waiting to send")
                Text("·")
                Text("Try again").underline()
            }
            .sylLabelStyle()
            .foregroundStyle(SylTheme.Colour.warmth)
            .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Waiting to send. Try again.")
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

    /// The turn's opening, as one sentence: who spoke, when, and what they said.
    ///
    /// The time is folded in rather than left as its own element, because a stray number
    /// read after a paragraph is a puzzle. Only the *first* message in a turn gets it —
    /// see the call site.
    private func accessibilityLabel(for message: Message) -> String {
        let speaker = isFromCommander ? "You said" : "Syl said"
        let time = group.startedAt.formatted(date: .omitted, time: .shortened)
        let state = group.isPending ? ", sending" : ""
        return "\(speaker), \(time)\(state). \(spoken(message))"
    }

    /// What the turn actually said, for someone who cannot see it.
    ///
    /// A message may now carry pictures and no words at all (`syl-008.8`), and the
    /// obvious label then reads "You said, 9:14." followed by silence — which announces
    /// that something was sent while withholding the only thing it was. What it carried
    /// IS what he said.
    private func spoken(_ message: Message) -> String {
        guard message.text.isEmpty else { return message.text }

        let images = message.attachments.filter { $0.kind == .image }.count
        let videos = message.attachments.filter { $0.kind == .video }.count

        var parts: [String] = []
        if images > 0 { parts.append(images == 1 ? "A picture" : "\(images) pictures") }
        if videos > 0 { parts.append(videos == 1 ? "A video" : "\(videos) videos") }
        // Nothing at all should be unreachable — the service refuses an empty message
        // with no attachments — but a label is the wrong place to assert that.
        return parts.isEmpty ? "No message" : parts.joined(separator: ", ")
    }
}

/// One message: the words as she wrote them, and anything they carried.
///
/// The blocks arrive already parsed — `ChatSnapshotLoader` does that off the main actor,
/// per message and cached by id. This view never touches the parser.
///
/// The prose is one combined VoiceOver element and the attachments are siblings; see the
/// note on ``ChatTurn/body``. Empty text renders nothing at all rather than an empty
/// paragraph's worth of leading, because a message that is only a picture is a real and
/// ordinary thing.
private struct MessageBody: View {
    let blocks: [MarkdownBlock]
    var attachments: [Attachment] = []
    var label: String = ""

    private var hasProse: Bool {
        !blocks.isEmpty && !(blocks.count == 1 && blocks == [.paragraph("")])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
            if hasProse {
                MarkdownView(blocks: blocks)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(label)
            }

            AttachmentStrip(attachments: attachments)
        }
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
