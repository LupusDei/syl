import SwiftUI
import SylKit

/// One goal, told the truth about.
///
/// ## The rule this whole file exists to keep
///
/// **No percentage. Anywhere.** No progress ring, no completion fraction, no "three of
/// five done" implying a denominator nobody set, no chart of a made-up number. There is
/// deliberately no percent-complete column on the server or on the device, so a
/// percentage here could only ever be **invented by this view** — which is exactly why
/// the plan says to treat one in a diff as a defect.
///
/// What appears instead is evidence:
///
/// > A goal's progress is the set of things that actually happened and were linked to it.
/// > If nothing has happened, the system says nothing has happened — which is true, and
/// > which a self-reported 60% would have hidden.
///
/// ## Where the warmth goes
///
/// `warmth` is the palette's single warm note and its scarcity is the point: *"if warmth
/// appears anywhere else it stops meaning this needs you now"*. It is spent **once on
/// this screen**, on the silence marker, and on nothing else. Not on the arithmetic —
/// the arithmetic is two numbers he is entitled to read for himself, and colouring one of
/// them is how two numbers become a verdict.
struct GoalDetailView: View {
    var snapshot: GoalDetailSnapshot

    /// Set false only for offscreen rendering. See `HomeView.scrolls`.
    var scrolls: Bool = true

    /// Read for one thing only: the target line, which is three short runs on a row and
    /// cannot stay a row at the accessibility sizes. See ``targetLine(_:)``.
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ZStack {
            SylTheme.Veil()
                .ignoresSafeArea()
            MoteField(count: 20, presence: 0.6)
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
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.loose) {
            header
            riskSection
            evidenceSection
            if !snapshot.evidence.commitments.isEmpty { commitments }
            if !snapshot.children.isEmpty { children }
        }
        .frame(maxWidth: SylTheme.Metric.proseMeasure, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.top, SylTheme.Metric.step)
        .padding(.bottom, SylTheme.Metric.chapter)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
            // The horizon — derived from the target date and never stored (T028) — and
            // what state the goal is in, as one run rather than as three views on a row.
            // An `HStack` of labels cannot wrap, so at the accessibility sizes
            // `BEYOND A YEAR · SET DOWN` would hyphenate itself across the screen. One
            // string wraps, and it is one thing to read out loud as well.
            Text(
                snapshot.goal.status == .active
                    ? snapshot.horizonLabel
                    : "\(snapshot.horizonLabel) · \(snapshot.standingLabel)"
            )
            .goalSectionLabel()

            // Nesting: the parent link is visible, and it is a door back up rather than a
            // caption. Registered on the same stack the list registered, so it works from
            // any depth.
            if let parent = snapshot.parent {
                NavigationLink(value: GoalRoute(id: parent.id)) {
                    HStack(spacing: SylTheme.Metric.tight) {
                        Image(systemName: "arrow.turn.left.up")
                            .font(.system(size: 11, weight: .semibold))
                            .accessibilityHidden(true)
                        Text("Part of \(parent.title)")
                            .font(SylTheme.Typeface.detail)
                            .multilineTextAlignment(.leading)
                    }
                    .foregroundStyle(SylTheme.Colour.accent)
                    .frame(minHeight: SylTheme.Metric.minimumTouchTarget, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the goal this one sits under")
            }

            // The one piece of real display type on this screen, as her name is on home.
            Text(snapshot.goal.title)
                .font(SylTheme.Typeface.display)
                .foregroundStyle(SylTheme.Colour.ink)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            // `why` is the only optional field Syl should ever push for, and it is set in
            // the quote face because it is his own words being read back to him rather
            // than anything the app is asserting.
            if let why = snapshot.goal.why, !why.isEmpty {
                Text(why)
                    .font(SylTheme.Typeface.Prose.quote)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .lineSpacing(SylTheme.Metric.proseLineSpacing)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let day = snapshot.targetDay {
                targetLine(day)
            }

            // T027. The label above already said "Set down"; this is the sentence that
            // makes it a decision rather than a failure. No warmth, no dimmed title, no
            // strikethrough — the goal is not diminished for having been put down.
            if let note = snapshot.standingNote {
                Text(note)
                    .font(SylTheme.Typeface.detail)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let reason = snapshot.goal.statusReason, !reason.isEmpty {
                Text(reason)
                    .font(SylTheme.Typeface.Prose.quote)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// `TARGET · 31 December 2026 · 213 days from now.`
    ///
    /// **It stacks at the accessibility sizes, and that is not optional.** Three runs
    /// sharing one row across a 393pt screen leaves each about a hundred points at AX5,
    /// and the render came back reading `TAR-GET  De-cem-ber 31, 2026  213 days from now`
    /// — every one of the three hyphenated mid-word. Dynamic Type to the largest size is
    /// NFR3, and this is the shape that breaks it.
    @ViewBuilder
    private func targetLine(_ day: Date) -> some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: SylTheme.Metric.tight))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: SylTheme.Metric.snug))

        layout {
            Text("Target")
                .sylLabelStyle()
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
            Text(day, format: .dateTime.day().month(.wide).year())
                .font(SylTheme.Typeface.numeral)
                .foregroundStyle(SylTheme.Colour.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let note = snapshot.targetNote {
                // "That date has passed" is arithmetic on a calendar. "Overdue" would be
                // a judgement, and it is not one this screen is entitled to make.
                Text(note)
                    .font(SylTheme.Typeface.numeral)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Risk

    @ViewBuilder
    private var riskSection: some View {
        if !snapshot.risk.isQuiet {
            VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
                if let silence = snapshot.risk.silence {
                    SilenceNote(sentence: silence.sentence)
                }
                if let arithmetic = snapshot.risk.arithmetic {
                    ArithmeticNote(arithmetic: arithmetic)
                }
            }
        }
    }

    // MARK: - Evidence

    private var evidenceSection: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
            Text("What has happened")
                .goalSectionLabel()

            if snapshot.evidence.nothingHasHappened {
                nothingHasHappened
            } else {
                EvidenceThread(
                    entries: snapshot.evidence.entries,
                    earlier: snapshot.evidence.earlier
                )
            }
        }
    }

    /// **The most important empty state in the app.**
    ///
    /// It is the honest answer, and an honest answer that looks like a failed load
    /// teaches him to distrust the one screen that is not lying to him. So it is set as a
    /// statement — the title face, full ink, the same weight the clear day gets on home —
    /// rather than as grey placeholder text in the middle of a box.
    private var nothingHasHappened: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
            Text(snapshot.evidence.headline ?? "")
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)

            Text(snapshot.evidence.explanation ?? "")
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .lineSpacing(SylTheme.Metric.proseLineSpacing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Commitments

    /// Still open, and deliberately **not** counted against what has happened.
    ///
    /// Two lists, never one divided by the other. The moment "three closed" sits beside
    /// "five open" as a pair of numbers meant to be read together, there is a fraction on
    /// screen whatever it is labelled — so these carry no count at all, and the list is
    /// its own length.
    private var commitments: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
            Text("Still open")
                .goalSectionLabel()

            VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
                ForEach(snapshot.evidence.commitments) { commitment in
                    CommitmentRow(commitment: commitment)
                }
            }
            .padding(SylTheme.Metric.gutter)
            .frame(maxWidth: .infinity, alignment: .leading)
            .sylGlass(presence: 0.55)
        }
    }

    // MARK: - Nesting

    private var children: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
            Text("Underneath")
                .goalSectionLabel()

            ForEach(snapshot.children) { child in
                NavigationLink(value: GoalRoute(id: child.id)) {
                    HStack(spacing: SylTheme.Metric.step) {
                        Text(child.title)
                            .font(SylTheme.Typeface.item)
                            .foregroundStyle(SylTheme.Colour.ink)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(SylTheme.Colour.inkFaint)
                            .accessibilityHidden(true)
                    }
                    .padding(.horizontal, SylTheme.Metric.gutter)
                    .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .sylGlass(presence: 0.5)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens this goal")
            }
        }
    }
}

// MARK: - Silence

extension View {
    /// A letterspaced section label that **wraps rather than truncating**.
    ///
    /// `sylLabelStyle` adds 1.6pt of tracking, and tracking is not folded into the ideal
    /// width SwiftUI lays a `Text` out against — so at the accessibility sizes a two-word
    /// label inside a card gets clipped to `THE ARITHME…` while there is still room below
    /// it. Found in the AX5 render; invisible at every other size.
    func goalSectionLabel() -> some View {
        self
            .sylLabelStyle()
            .foregroundStyle(SylTheme.Colour.inkSoft)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Silence

/// The clock, and the one place `warmth` is spent on this screen.
///
/// Silence is what the goal asked for being measured against what happened — it declared
/// a cadence and nothing has been linked for longer than it. That is the definition of
/// "this needs you now", which is the only thing `warmth` is allowed to mean.
private struct SilenceNote: View {
    let sentence: String

    var body: some View {
        HStack(alignment: .top, spacing: SylTheme.Metric.step) {
            Circle()
                .fill(SylTheme.Colour.warmth)
                .frame(width: SylTheme.Metric.markerSize, height: SylTheme.Metric.markerSize)
                .overlay {
                    Circle().stroke(SylTheme.Colour.luminanceCore.opacity(0.7), lineWidth: 1)
                }
                .padding(.top, 3)
                .accessibilityHidden(true)

            Text(sentence)
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.ink)
                .lineSpacing(SylTheme.Metric.proseLineSpacing)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
        .padding(SylTheme.Metric.gutter)
        .sylGlass()
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Arithmetic

/// Two numbers, and not a word that draws the conclusion from them.
///
/// **No colour, no badge, no bar, no marker on a track.** Every one of those is a verdict
/// wearing a graphic, and every one of them is wrong in the cases the numbers are not —
/// the week he was ill, the fortnight the work was blocked, the month he decided the goal
/// was worth less than he had thought. The numbers survive all three. So the required
/// rate and the observed rate are set in exactly the same ink, at exactly the same
/// weight, one under the other, and he draws his own conclusion.
private struct ArithmeticNote: View {
    let arithmetic: GoalRisk.Arithmetic

    var body: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
            // `inkSoft` like every other section label here — it was `inkFaint`, and in the
            // day render it was the one heading you had to look for rather than read.
            Text("The arithmetic")
                .goalSectionLabel()

            Text(arithmetic.required)
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.ink)
                .fixedSize(horizontal: false, vertical: true)

            Text(arithmetic.observed)
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(SylTheme.Metric.gutter)
        .sylGlass(presence: 0.55)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - The thread of what happened

/// What happened, on a thread — the same filament the day is strung on.
///
/// Reusing the spine's vocabulary is the point rather than a shortcut: this *is* a
/// timeline, and a goal that renders its history in the language the day already uses is
/// what makes the two screenshot as one product.
private struct EvidenceThread: View {
    let entries: [GoalEvidence.Entry]
    let earlier: Int

    private let threadWidth: CGFloat = 26

    @ScaledMetric(relativeTo: .body) private var markerCentreFromTop: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                row(entry, isFirst: index == 0, isLast: index == entries.count - 1)
            }

            if earlier > 0 {
                // The depth of the history, stated. Not a denominator — nothing on this
                // screen is divided by it.
                Text("and \(earlier) more before that")
                    .font(SylTheme.Typeface.numeral)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .padding(.leading, threadWidth + SylTheme.Metric.step)
                    .padding(.top, SylTheme.Metric.snug)
            }
        }
    }

    /// One thing that happened, threaded.
    ///
    /// The filament is an **overlay on the text**, not a sibling of it, and that is
    /// load-bearing. A segment drawn as a sibling asks for `maxHeight: .infinity`, which
    /// makes the row greedy for vertical space — inside a scroll view that is invisible,
    /// and the moment the content is shorter than its container the three entries spread
    /// themselves over the whole screen with a hundred points of thread between them. As
    /// an overlay the thread is sized by the text, which is what it is a thread *of*.
    private func row(_ entry: GoalEvidence.Entry, isFirst: Bool, isLast: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.text)
                    .font(SylTheme.Typeface.item)
                    .foregroundStyle(SylTheme.Colour.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                Text(entry.at, format: .dateTime.day().month(.abbreviated).year())
                    .font(SylTheme.Typeface.numeral)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
            }
            // The padding belongs to the *text*, not to the row. Outside it, the filament
            // stopped short at every row boundary and the timeline rendered as eight
            // separate stubs. `DaySpine` puts it in exactly this place, for the same
            // reason.
            .padding(.vertical, SylTheme.Metric.snug)
            .padding(.leading, threadWidth + SylTheme.Metric.step)
            .overlay(alignment: .topLeading) {
                thread(isFirst: isFirst, isLast: isLast)
            }

            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(entry.text), \(entry.at.formatted(date: .abbreviated, time: .omitted))")
    }

    private func thread(isFirst: Bool, isLast: Bool) -> some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                segment.opacity(isFirst ? 0 : 1)
                    .frame(height: markerCentreFromTop)
                segment.opacity(isLast ? 0 : 1)
            }

            // The same dot the day spine draws for something done. Everything on this
            // thread is done — that is what makes it evidence.
            Circle()
                .fill(SylTheme.Colour.luminance.opacity(0.55))
                .frame(
                    width: SylTheme.Metric.markerSize * 0.62,
                    height: SylTheme.Metric.markerSize * 0.62
                )
                .offset(y: markerCentreFromTop - SylTheme.Metric.markerSize * 0.31)
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
}

// MARK: - Commitments

private struct CommitmentRow: View {
    let commitment: GoalEvidence.Commitment

    var body: some View {
        HStack(alignment: .top, spacing: SylTheme.Metric.step) {
            // An unfilled ring: linked, and nothing has happened on it yet. The same
            // marker the day spine uses for something upcoming.
            Circle()
                .stroke(SylTheme.Colour.hairline, lineWidth: 1.2)
                .frame(
                    width: SylTheme.Metric.markerSize * 0.86,
                    height: SylTheme.Metric.markerSize * 0.86
                )
                .padding(.top, 5)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(commitment.text)
                    .font(SylTheme.Typeface.item)
                    .foregroundStyle(SylTheme.Colour.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: SylTheme.Metric.snug) {
                    if let due = commitment.dueAt {
                        Text(due, format: .dateTime.day().month(.abbreviated))
                            .font(SylTheme.Typeface.numeral)
                            .foregroundStyle(SylTheme.Colour.inkFaint)
                    }
                    if commitment.pinned {
                        // `pinned` is the one durable signal proposal B keeps. There is no
                        // priority beside it because none is stored.
                        Text("Pinned")
                            .sylLabelStyle()
                            .foregroundStyle(SylTheme.Colour.accent)
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .frame(minHeight: SylTheme.Metric.minimumTouchTarget, alignment: .top)
        .accessibilityElement(children: .combine)
    }
}
