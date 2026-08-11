import SwiftUI

/// What he touched, as a subject the card can describe.
///
/// Deliberately the *prepared* values rather than the ids: the card is a pure function of a
/// finished sky, exactly as the drawing is, so it can be rendered offscreen and looked at
/// without a store, a network or a view model behind it.
enum ConstellationSubject: Equatable {
    case star(PreparedStar)
    case filament(PreparedFilament)
}

extension PreparedSky {
    /// The thing a hit refers to, or nil if the sky no longer holds it — a refresh between
    /// the tap and the card is not an error and must not be a crash.
    func subject(for hit: ConstellationHit) -> ConstellationSubject? {
        switch hit {
        case .star(let id):
            return stars.first { $0.id == id }.map(ConstellationSubject.star)
        case .filament(let id):
            return filaments.first { $0.id == id }.map(ConstellationSubject.filament)
        }
    }
}

/// One card, for one thing she knows.
///
/// ## A star: her words, when, and **from what**
///
/// Provenance is not an advanced feature and it is not a footnote at the bottom. It is the
/// answer to the only question that matters about a memory — *why do you think that?* — and
/// the spec's own success criterion is that he can answer it about any single memory in two
/// taps. So it is a sentence, in her register, not a `source:` field with a value after it.
///
/// ## A filament: what it relates, and — when she inferred it — **her reasoning, verbatim**
///
/// This is the only surface in the entire app where the inference engine explains itself.
/// It gets the light rail from the transcript, the same one that means *this is Syl
/// speaking* everywhere else, and her own prose face. Set as a labelled field it would read
/// as debug output that happened to contain a sentence; set like this it reads as her
/// saying it, which is what it is.
///
/// ## What is deliberately not here
///
/// No percentage, no confidence bar, no id, no node kind badge with a colour key. Every one
/// of those is an instrument reading, the admin is where instruments live, and a bar chart
/// on a night sky would be the first piece of dashboard in an app whose doors are documented
/// as *not statistics*.
struct ConstellationCard: View {
    var subject: ConstellationSubject

    /// The tallest this card may grow before it starts scrolling inside itself. The screen
    /// sets it from its own height; the default is a sane phone.
    var ceiling: CGFloat = 460

    /// Closing it. Tapping empty sky does the same thing; this is the one that is visible.
    var onDismiss: () -> Void = {}

    /// Reports the height it settled at, so the sky can pan the selection clear of exactly
    /// that much. See ``ConstellationTransform/revealing(_:between:and:within:viewSize:)``.
    var onHeight: (CGFloat) -> Void = { _ in }

    var body: some View {
        // **It hugs what is on it, and scrolls only when the screen runs out.**
        //
        // Two renders were spent on this and both failures were the same mistake wearing
        // different clothes. A bare `ScrollView` is greedy: the first image came back with
        // the card filling the entire screen and nothing legible on it. The obvious fix —
        // `.frame(maxHeight:)` around the lot — looked like a cap and is actually the
        // opposite. **`maxHeight` makes a view FLEXIBLE up to that height**, so the `VStack`
        // holding the card above the home indicator handed it every one of those points and
        // the card sat in a field of empty glass with its text at the top.
        //
        // So there is no cap on the card at all. `ViewThatFits` takes the plain stack while
        // it fits the screen, which is every ordinary text size; only when her reasoning at
        // an accessibility size genuinely runs past the glass does it fall to the scrolling
        // branch — and *that* one carries the fixed height, where a fixed height is right.
        ViewThatFits(in: .vertical) {
            content
            ScrollView {
                content
            }
            .scrollIndicators(.hidden)
            .frame(height: ceiling)
        }
        .padding(SylTheme.Metric.gutter)
        .frame(maxWidth: SylTheme.Metric.proseMeasure, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        // **In the corner, not in the flow.** A forty-four-point touch target standing in a
        // row beside a twelve-point caption makes the caption's row forty-four points tall,
        // and those thirty spare points are the difference between a card that hugs its own
        // words and one that has to scroll them — see ``ConstellationBand/tallestCard(in:)``,
        // which is a hard ceiling rather than a preference.
        .overlay(alignment: .topTrailing) { dismiss }
        .sylGlass()
        .background {
            // Measured rather than assumed. The sky pans the selection above whatever this
            // turns out to be, and a card whose height was guessed would either cover the
            // star at the largest Dynamic Type sizes or shove the sky further than it
            // needed to at the smallest.
            GeometryReader { proxy in
                Color.clear
                    .onAppear { onHeight(proxy.size.height) }
                    .onChange(of: proxy.size.height) { _, height in onHeight(height) }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
            caption
                // Room for the close control, which floats in the corner rather than
                // standing in this row.
                .padding(.trailing, SylTheme.Metric.chapter)

            switch subject {
            case .star(let star): starBody(star)
            case .filament(let filament): filamentBody(filament)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - The caption

    private var caption: some View {
        Text(captionText)
            .sylLabelStyle()
            .foregroundStyle(SylTheme.Colour.inkSoft)
            .accessibilityHidden(true)
    }

    private var captionText: String {
        switch subject {
        case .star(let star):
            return "\(ConstellationWords.kind(star.detail.kind)) · \(ConstellationWords.tier(star.detail.tier))"
        case .filament(let filament):
            // Whether she was told it or worked it out is the single most interesting thing
            // about a thread, so it is the caption rather than a line buried below.
            return filament.species == .observed ? "Observed" : "Inferred"
        }
    }

    private var dismiss: some View {
        Button(action: onDismiss) {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .frame(
                    width: SylTheme.Metric.minimumTouchTarget,
                    height: SylTheme.Metric.minimumTouchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.trailing, SylTheme.Metric.snug)
        .padding(.top, SylTheme.Metric.snug)
        .accessibilityLabel("Close")
    }

    // MARK: - A star

    @ViewBuilder
    private func starBody(_ star: PreparedStar) -> some View {
        Text(star.label)
            .font(SylTheme.Typeface.title)
            .foregroundStyle(SylTheme.Colour.ink)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)

        if let body = star.detail.body, !body.isEmpty {
            Text(body)
                .font(SylTheme.Typeface.Prose.body)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .lineSpacing(SylTheme.Metric.proseLineSpacing)
                .fixedSize(horizontal: false, vertical: true)
        }

        provenance(
            sentence: ConstellationWords.provenance(
                species: star.detail.species, assertedBy: star.detail.assertedBy),
            certainty: ConstellationWords.certainty(star.confidence),
            when: ConstellationWords.learned(star.detail.learnedAt))

        if let reasoning = star.detail.reasoning, !reasoning.isEmpty {
            herWords(reasoning)
        }
    }

    // MARK: - A filament

    @ViewBuilder
    private func filamentBody(_ filament: PreparedFilament) -> some View {
        let detail = filament.detail

        // What it relates, as a line rather than as three fields. The relation is set in
        // her prose face between the two things it joins, so the row reads as a sentence
        // she would say — `Kate · knows · Dad` would read as a row in a table.
        VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
            Text(detail.fromLabel)
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)
            Text(ConstellationWords.relation(detail.relation))
                .sylLabelStyle()
                .foregroundStyle(SylTheme.Colour.luminance)
            Text(detail.toLabel)
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)

        provenance(
            sentence: ConstellationWords.origin(of: filament.species),
            certainty: ConstellationWords.certainty(detail.confidence),
            when: ConstellationWords.touched(detail.touchedAt))

        if let reasoning = detail.reasoning, !reasoning.isEmpty {
            herWords(reasoning)
        }
    }

    // MARK: - Shared parts

    /// Where it came from, how strongly she holds it, and when — in that order, because the
    /// first is the question and the other two qualify the answer.
    private func provenance(sentence: String, certainty: String, when: String?) -> some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
            Text(sentence)
                .font(SylTheme.Typeface.item)
                .foregroundStyle(SylTheme.Colour.ink)
            Text(certainty)
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
            if let when {
                Text(when)
                    .font(SylTheme.Typeface.numeral)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    /// Her reasoning, **verbatim**, in the transcript's own vocabulary for *this is Syl
    /// speaking*: the light rail down the left margin and her prose face beside it.
    ///
    /// Not a quoted block and not a labelled field. She is not relaying this and she is not
    /// reporting it — she concluded it, and this is the one place in the app she gets to say
    /// why.
    private func herWords(_ reasoning: String) -> some View {
        Text(reasoning)
            .font(SylTheme.Typeface.Prose.body)
            .foregroundStyle(SylTheme.Colour.ink)
            .lineSpacing(SylTheme.Metric.proseLineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, SylTheme.Metric.step + SylTheme.Metric.railWidth)
            // **An overlay, not an `HStack`, and the first render is why.** A `Capsule` with
            // only a width is greedy in the other axis, so in a row it stretched the card a
            // whole paragraph taller than its own text — invisibly, because the rail fades
            // to nothing before it gets there. As an overlay the sentence decides the
            // height and the rail follows it, which is the right way round anyway.
            .overlay(alignment: .leading) {
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
                    // Decorative: she is already announced by "she worked this out", and a
                    // VoiceOver user does not need to be told there is a line.
                    .accessibilityHidden(true)
            }
            .padding(.top, SylTheme.Metric.tight)
            .accessibilityElement(children: .combine)
    }

}

/// Where the card leaves room for the sky.
///
/// **Not on ``ConstellationCard`` itself**, because a `View` is main-actor isolated in Swift
/// 6 and so are its statics — and this arithmetic is wanted from a pure test and from the
/// render harness, neither of which has any business being on the main actor to ask a
/// question about two numbers.
///
/// One place, used by the screen and by the render, because the two drifting apart is
/// exactly how a render comes to show a picture the device never draws — and this feature is
/// *accepted* on its renders.
enum ConstellationBand {
    /// Room at the top for the navigation bar and her title. Matches
    /// ``ConstellationLayout/topInset``, the same clearance measured from the other side — a
    /// star tucked under a chrome element is a star he cannot see or touch.
    static let headroom: CGFloat = 104

    /// Where the top edge of a card this tall actually falls. **The hard line** — anything
    /// below it is covered.
    static func cardTop(forCardOf height: CGFloat, in size: CGSize) -> CGFloat {
        size.height - height - SylTheme.Metric.step
    }

    /// Where the sky *aims* to put a selection: clear of the card's edge with a chapter of
    /// air above it, so the star is not pressed against the glass it was just uncovered
    /// from. Best effort — the bound on wandering has the last word, and
    /// ``tallestCard(in:)`` is what guarantees the last word is still good enough.
    static func skyline(forCardOf height: CGFloat, in size: CGSize) -> CGFloat {
        cardTop(forCardOf: height, in: size) - SylTheme.Metric.chapter
    }

    /// **The card may never take more than the sky can pan out from under it.**
    ///
    /// The two rules of this screen meet here, and they very nearly contradicted each other.
    /// The bound on wandering says the centre of the screen is always on the sky, so the
    /// deepest a star can ever be brought is *exactly* the middle of the glass — a star at
    /// the bottom edge of what she knows can be lifted to the centre and no further. A card
    /// whose **top edge** sits below that centre is therefore a card that some memories can
    /// never be got out from under, however far he drags.
    ///
    /// `ConstellationTransformTests` found it by sweeping card heights instead of assuming
    /// one, at two thirds of the screen, on Kate's cluster. Nothing about it was visible in
    /// a render: at ordinary text sizes the card is nowhere near this tall and every star
    /// clears comfortably. It would have arrived as *the card covers the star sometimes, for
    /// some people, at some text sizes* — the shape of bug that takes a week.
    ///
    /// So this is the ceiling, and past it the card scrolls inside itself rather than
    /// growing. It is enforced by **giving the card no more room than this to be proposed**,
    /// not by a `maxHeight` on the card — see ``ConstellationCard``, where that mistake cost
    /// two renders: `maxHeight` makes a view *flexible* up to that height, which is the
    /// opposite of a cap.
    static func tallestCard(in size: CGSize) -> CGFloat {
        max(200, size.height / 2 - SylTheme.Metric.step)
    }
}

// MARK: - Previews

#Preview("A star") {
    let sky = SkyPreparer(now: ConstellationFixture.now)
        .prepare(.fixture, size: CGSize(width: 393, height: 852))
    return ZStack {
        SylTheme.Veil().ignoresSafeArea()
        VStack {
            Spacer()
            if let star = sky.stars.first(where: { $0.id == "memory.dad.workshop" }) {
                ConstellationCard(subject: .star(star))
                    .padding(SylTheme.Metric.step)
            }
        }
    }
    .environment(\.colorScheme, .dark)
}

#Preview("A filament she inferred") {
    let sky = SkyPreparer(now: ConstellationFixture.now)
        .prepare(.fixture, size: CGSize(width: 393, height: 852))
    return ZStack {
        SylTheme.Veil().ignoresSafeArea()
        VStack {
            Spacer()
            if let filament = sky.filaments.first(where: { $0.id == "e.kate.mandarin" }) {
                ConstellationCard(subject: .filament(filament))
                    .padding(SylTheme.Metric.step)
            }
        }
    }
    .environment(\.colorScheme, .dark)
}
