import SwiftUI

/// The visual language, in one place.
///
/// Before this file the app styled itself ad hoc — `Color(.secondarySystemBackground)`
/// here, a literal `16` there, and `AccentColor.colorset` shipped empty so every accent
/// resolved to stock system blue. That is fine for a shell and wrong for a character.
/// Syl is a *presence*, and a presence that is assembled from defaults reads as a form.
///
/// ## Why these values
///
/// The concept art is unanimous on one thing even where it disagrees on everything
/// else: Syl lives in a pale, luminous, cool haze — silver-blue light, deep slate ink,
/// and almost no saturated colour anywhere. Nothing here is a brand palette bolted on;
/// it is the fog she is drawn in.
///
/// ## Every colour is defined for both appearances
///
/// Dark mode is not an inversion. In the light appearance she is morning fog; in the
/// dark she is the same light seen at night, which means the *ink* flips but the
/// luminance does not — light stays light. Defining only the light values and letting
/// the system guess produces grey mush at night, which is the one thing this palette
/// cannot survive.
enum SylTheme {}

// MARK: - Colour

extension SylTheme {
    /// Semantic colours. Computed rather than stored so there is no global mutable
    /// state for Swift 6's concurrency checker to object to.
    enum Colour {
        /// The top of the veil — where the light comes from.
        ///
        /// Not white. An additive bloom needs headroom above the base to read as light
        /// at all: paint a glow over `#F4F7FB` and it clips to pure white, taking the
        /// whole composition with it. Measured, not guessed — the first light-mode
        /// render came back as a blank page.
        static var veil: Color { dynamic(light: 0xE8EFF8, dark: 0x0B1220) }

        /// The bottom of the veil. The gradient between the two is the whole backdrop.
        static var veilDeep: Color { dynamic(light: 0xC9D6E8, dark: 0x05080F) }

        /// Headings and anything that must be read at a glance.
        static var ink: Color { dynamic(light: 0x2E3D57, dark: 0xE6EDF8) }

        /// Body text and supporting detail.
        ///
        /// The light value was `0x5A6A82` and measured **3.7:1** against `veilDeep` —
        /// under the 4.5:1 floor for ordinary text. Deepened to clear it.
        ///
        /// It mattered more than one token usually would. After `inkFaint` was found
        /// dissolving into the veil's blooms, `inkSoft` became *the* answer for small
        /// text on bare veil, and `syl-011` put it on four new surfaces on that advice.
        /// The failure was only reachable at the **dark end of the light gradient**,
        /// which is why looking at renders never caught it: a bloom lightens the ground
        /// and makes the contrast better, so every eye-check landed on the easy case.
        ///
        /// Found by `SylThemeContrastTests` within a minute of it existing, and by
        /// nothing else in a day of building against this token.
        static var inkSoft: Color { dynamic(light: 0x4A5A72, dark: 0xA9B7CC) }

        /// Labels, timestamps, the things present but not asking to be read.
        static var inkFaint: Color { dynamic(light: 0x8D9AAF, dark: 0x6C7A90) }

        /// Her light.
        ///
        /// Markedly more saturated in the light appearance, which looks wrong written
        /// down and is right on screen. Light is *additive*: against near-black a pale
        /// blue at low alpha reads as a glow, and against a pale ground the same colour
        /// is invisible — there is nothing for it to add to. The light appearance
        /// therefore renders her as pigment rather than as emission, and pigment has to
        /// carry actual chroma to be seen.
        static var luminance: Color { dynamic(light: 0x5E93CE, dark: 0x8FB6DF) }

        /// The hottest point of her light, at the core of a stroke.
        static var luminanceCore: Color { dynamic(light: 0xFFFFFF, dark: 0xDCEBFF) }

        /// Interactive accents. Used sparingly — almost nothing here is tappable-blue.
        static var accent: Color { dynamic(light: 0x6E97C8, dark: 0x9CC2E8) }

        /// Frosted card fill. Sits over the veil, never over a solid colour.
        static var card: Color { dynamic(light: 0xFFFFFF, dark: 0x9DB6D8).opacity(0.42) }

        /// Hairlines: the spine, card edges, the ring around an unfilled marker.
        static var hairline: Color { dynamic(light: 0x5A6A82, dark: 0xA9B7CC).opacity(0.22) }

        /// The one warm note in the palette. Scarcity is the point: if warmth appears
        /// everywhere it stops meaning "this needs you now".
        ///
        /// ## The light value is pigment, not emission — and it was not, until now
        ///
        /// This carried `0xE8B98A` in the light appearance: essentially the same pale
        /// peach as the night value, which is exactly the mistake ``luminance`` above
        /// documents at length and was explicitly fixed for. Against a near-black ground
        /// a pale warm tint reads as a glow; against the pale veil it reads as almost
        /// nothing, because there is nothing for it to add to.
        ///
        /// It went unnoticed for a simple reason: warmth had only ever been used **on
        /// glass** — a `NoteCard`, a badge capsule — where the fill supplies its own
        /// ground and a pale tone survives. The moment `syl-011` put it on bare veil as
        /// small text, two squads independently reported it as the weakest thing on the
        /// screen. Home being forced to night until `syl-011.6` is why nobody met it
        /// sooner.
        ///
        /// So the light appearance is now a deep amber with real chroma, chosen to clear
        /// 4.5:1 against the **darkest** part of the light veil (`veilDeep`), not merely
        /// against its lightest. `SylThemeContrastTests` asserts that, because a palette
        /// rule stated only in prose is a rule the next token will also miss.
        static var warmth: Color { dynamic(light: 0x8A4A0F, dark: 0xF0C79C) }

        /// `concerned` desaturates toward this rather than toward grey — a spren
        /// dimming, not a UI greying out.
        static var greyBlue: Color { dynamic(light: 0x8496AE, dark: 0x6F8098) }
    }
}

// MARK: - Typography

extension SylTheme {
    /// Type scale.
    ///
    /// The display face is the system serif (New York). Every concept sets her name in
    /// a high-contrast serif, and New York is the closest thing shipped on the device —
    /// which means no bundled font file, no licence, correct optical sizing at every
    /// weight, and Dynamic Type for free. A bundled display face would buy a little
    /// fidelity and cost all four.
    ///
    /// Every size is expressed relative to a text style, so Dynamic Type scales the
    /// whole screen. Fixed point sizes would make the largest accessibility sizes
    /// unreadable, and this is a screen someone reads at 06:00 without glasses.
    enum Typeface {
        /// Her name. The one piece of real display type on the screen.
        static var display: Font { .system(.largeTitle, design: .serif, weight: .regular) }

        /// Section headings inside the day.
        static var title: Font { .system(.title3, design: .serif, weight: .regular) }

        /// What she is doing or saying, under her name.
        static var subtitle: Font { .system(.subheadline, design: .default, weight: .regular) }

        /// A row on the spine.
        static var item: Font { .system(.body, design: .default, weight: .medium) }

        /// The line under a row.
        static var detail: Font { .system(.subheadline, design: .default, weight: .regular) }

        /// Times, counts, anything numeric that should not reflow as digits change.
        static var numeral: Font { .system(.footnote, design: .default, weight: .regular).monospacedDigit() }

        /// Letterspaced small-caps labels — `TODAY · 16 MAY`, `GOALS`. Apply with
        /// ``SwiftUI/View/sylLabelStyle()``, which adds the tracking and the casing.
        static var label: Font { .system(.caption2, design: .default, weight: .semibold) }

        /// The scale for *block* content — what rendered markdown is set in.
        ///
        /// The tokens above describe a screen assembled from labelled parts: a name, a
        /// row, a caption. They have no answer for a heading with a paragraph under it,
        /// because until `syl-008` nothing in this app rendered a document. Syl writes
        /// documents — plans, briefs, comparisons, code — and a renderer with no scale to
        /// aim at will invent one at every call site. That is how a screen ends up with
        /// five heading sizes and no hierarchy.
        ///
        /// Everything here is relative to a text style, so Dynamic Type still scales the
        /// whole page. Nothing here introduces a new colour or a new face — prose reuses
        /// the same serif, the same ink, the same luminance. It is the *existing* voice
        /// applied to longer form, which is the entire point: her writing must look like
        /// the rest of her, not like a Markdown widget dropped into the app.
        enum Prose {
            /// A top-level heading in her writing.
            ///
            /// Deliberately the same face and size as ``Typeface/title`` — the section
            /// headings on the home screen. A heading inside a message is not more
            /// important than a heading on the day, and giving it its own larger size
            /// would make every reply shout. Structure comes from space and weight
            /// contrast, not from scale.
            static var heading: Font { .system(.title3, design: .serif, weight: .regular) }

            /// A second-level heading. The serif, one step down, still not bold.
            static var subheading: Font { .system(.headline, design: .serif, weight: .regular) }

            /// Body copy. The reading size, and the one that must never be sacrificed.
            static var body: Font { .system(.body, design: .default, weight: .regular) }

            /// Fenced code.
            ///
            /// A step *down* from body rather than level with it. A monospaced face runs
            /// optically larger than a proportional one at the same point size, so
            /// matching the numbers would make code louder than the sentence explaining
            /// it. Stepping down lands them on the same apparent weight — and it buys
            /// roughly eight more characters per line before a slab needs scrolling,
            /// which on a 390pt screen is the difference between reading a line and
            /// dragging it.
            static var code: Font { .system(.footnote, design: .monospaced, weight: .regular) }

            /// Inline code, inside a run of prose.
            ///
            /// One style larger than the fenced slab, for the same optical reason in
            /// reverse: a `chip` sitting mid-sentence next to body text must not read as
            /// a hole in the line. `.callout` under `.body` is the pairing that
            /// disappears.
            static var codeInline: Font { .system(.callout, design: .monospaced, weight: .regular) }

            /// A quoted passage. Italic, and coloured `inkSoft` by the renderer — quiet
            /// twice over, because a quote is something she is *relaying*, not saying.
            static var quote: Font { .system(.body, design: .default, weight: .regular).italic() }

            /// Table cells, and any dense tabular run.
            ///
            /// Monospaced digits, always: a column of figures that reflows as the values
            /// change is not a table, it is a list that jitters.
            static var table: Font { .system(.footnote, design: .default, weight: .regular).monospacedDigit() }

            /// The marker on an ordered list item — `9.` then `10.`.
            ///
            /// Monospaced digits so the text column does not step sideways when the list
            /// crosses ten. This is the single most common visible defect in hand-rolled
            /// markdown renderers and it costs one modifier to avoid.
            static var marker: Font { .system(.body, design: .default, weight: .regular).monospacedDigit() }
        }
    }
}

extension View {
    /// The letterspaced upper-case label treatment used throughout the concepts.
    ///
    /// Tracking is applied here rather than baked into the `Font` because `Font`
    /// carries no tracking — it has to be a view modifier, and putting it in one place
    /// stops six call sites inventing six different values.
    func sylLabelStyle() -> some View {
        self
            .font(SylTheme.Typeface.label)
            .tracking(1.6)
            .textCase(.uppercase)
    }
}

// MARK: - Metrics

extension SylTheme {
    /// Spacing, radii and the few fixed dimensions.
    ///
    /// A four-point rhythm. Not because four is magic, but because a single rhythm
    /// applied everywhere is what makes a screen feel composed rather than assembled,
    /// and because a named step is a decision somebody can argue with where a literal
    /// `14` is not.
    enum Metric {
        static let hair: CGFloat = 1
        static let tight: CGFloat = 4
        static let snug: CGFloat = 8
        static let step: CGFloat = 12
        static let gutter: CGFloat = 20
        static let loose: CGFloat = 28
        static let chapter: CGFloat = 40

        /// Card corner. Continuous, always — a circular corner next to this much soft
        /// light reads as a hard edge.
        static let cardRadius: CGFloat = 22

        /// The dot on the spine.
        static let markerSize: CGFloat = 11

        /// Apple's floor for anything tappable. Rows are padded up to it even when the
        /// text alone is shorter.
        static let minimumTouchTarget: CGFloat = 44

        /// A fenced code slab.
        ///
        /// Deliberately *not* ``cardRadius``. A card is an object on the surface; a code
        /// block is an element inside a document. Giving it the card corner makes a
        /// paragraph of shell commands read as a widget someone can tap, which it is not.
        static let codeRadius: CGFloat = 14

        /// The widest a line of her prose may be set.
        ///
        /// Irrelevant on an iPhone and essential the first day this runs in an iPad or
        /// Mac window, where an unconstrained text column becomes a 1000pt line the eye
        /// cannot track back from. Typography's own answer is roughly 60–75 characters;
        /// at this body size that is about here.
        static let proseMeasure: CGFloat = 640

        /// Extra leading inside a paragraph of her writing.
        ///
        /// SwiftUI's default leading is tuned for labels and single lines. A twelve-line
        /// research brief set at the default reads as a wall; opening it up is the
        /// cheapest legibility win available and costs one modifier.
        static let proseLineSpacing: CGFloat = 5

        /// The light-rail down the left margin of her turn — the transcript's answer to
        /// the day's spine, and the cue that replaces a bubble as "this is Syl speaking".
        static let railWidth: CGFloat = 1.5
    }
}

// MARK: - Motion

extension SylTheme {
    /// The motion vocabulary.
    ///
    /// Named curves rather than inline `.easeInOut` at forty call sites, because a
    /// screen where everything moves at a slightly different rate reads as *busy*,
    /// and a screen where everything shares three rates reads as *alive*. This is the
    /// difference between animated and animate**d**.
    ///
    /// Nothing here is bouncy. Springs with visible overshoot are cheerful and wrong
    /// for her — Syl is weather, not a bouncing ball. Every curve below settles.
    enum Motion {
        /// Anything the Commander's own finger caused. Must feel instant.
        static var responsive: Animation { .spring(response: 0.32, dampingFraction: 0.86) }

        /// Content arriving or rearranging: rows, cards, state changes.
        static var settle: Animation { .spring(response: 0.55, dampingFraction: 0.92) }

        /// Large layout shifts — the day expanding as it empties.
        static var drift: Animation { .spring(response: 0.95, dampingFraction: 0.95) }

        /// A slow reveal, used when something appears without being asked for.
        static var breathe: Animation { .easeInOut(duration: 1.6) }

        /// Staggered entrance delay per index, capped so a long list does not take a
        /// second and a half to finish arriving.
        static func stagger(_ index: Int, step: Double = 0.055, cap: Double = 0.44) -> Double {
            min(Double(index) * step, cap)
        }
    }
}

// MARK: - Glass

extension SylTheme {
    /// A frosted pane.
    ///
    /// Real glass is not a translucent rectangle. Three things separate it from one,
    /// and all three are cheap:
    ///
    /// 1. **A specular edge.** Light catches the rim — brighter at the top-left where
    ///    the veil's light source is, fading to nothing at the opposite corner. A
    ///    uniform border is the single clearest tell of fake glass.
    /// 2. **An inner bloom.** A soft light gathers just inside the top edge, as it
    ///    would in something with actual thickness.
    /// 3. **A shadow that is coloured, not black.** Black shadow under pale blue glass
    ///    reads as dirt. This one is the veil's own deep tone.
    struct Glass: ViewModifier {
        var radius: CGFloat = Metric.cardRadius
        /// Raises the whole effect. Lower for surfaces that must recede.
        var presence: Double = 1.0

        func body(content: Content) -> some View {
            content
                .background {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .fill(.ultraThinMaterial)
                        .overlay {
                            RoundedRectangle(cornerRadius: radius, style: .continuous)
                                .fill(Colour.card.opacity(0.5 * presence))
                        }
                        .overlay {
                            // The inner bloom: light gathered under the top edge.
                            RoundedRectangle(cornerRadius: radius, style: .continuous)
                                .fill(
                                    LinearGradient(
                                        colors: [
                                            Colour.luminanceCore.opacity(0.38 * presence),
                                            .clear,
                                        ],
                                        startPoint: .top,
                                        endPoint: .center
                                    )
                                )
                                .blendMode(.plusLighter)
                        }
                        .overlay {
                            // The specular rim, brightest where the light is.
                            RoundedRectangle(cornerRadius: radius, style: .continuous)
                                .strokeBorder(
                                    LinearGradient(
                                        colors: [
                                            Colour.luminanceCore.opacity(0.85 * presence),
                                            Colour.luminance.opacity(0.18 * presence),
                                            .clear,
                                        ],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    ),
                                    lineWidth: 0.9
                                )
                        }
                }
                .shadow(
                    color: Colour.veilDeep.opacity(0.30 * presence),
                    radius: 22 * presence,
                    y: 10 * presence
                )
        }
    }
}

extension View {
    /// Frost this view. See ``SylTheme/Glass``.
    func sylGlass(radius: CGFloat = SylTheme.Metric.cardRadius, presence: Double = 1.0) -> some View {
        modifier(SylTheme.Glass(radius: radius, presence: presence))
    }
}

// MARK: - Backdrop

extension SylTheme {
    /// The veil: the living light every Syl surface sits on.
    ///
    /// ## Why it moves
    ///
    /// A static gradient is a *background*. Three slow, independently drifting blooms
    /// are *weather* — and weather is what makes the screen worth reopening when
    /// nothing on it has changed. The periods below (23s, 31s, 41s) are deliberately
    /// coprime, so the three never resynchronise into a visible pulse. A loop the eye
    /// can find is a loop the eye starts waiting for.
    ///
    /// ## Why it is cheap
    ///
    /// One `TimelineView` at 15 fps driving three radial gradients. The motion is far
    /// below the rate at which anyone perceives steps, so the frames saved are free —
    /// and this view is on screen constantly, which is exactly where a full-rate
    /// redraw would show up as battery.
    ///
    /// Reduce Motion pins it to a still frame. The composition still works, because it
    /// was composed rather than left to the animation to make interesting.
    struct Veil: View {
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.colorScheme) private var scheme

        /// How hard the blooms are driven.
        ///
        /// Appearance-dependent because additive light behaves completely differently
        /// against the two bases. Against near-black there is enormous headroom and the
        /// glow is the whole atmosphere; against a pale base the same values clip
        /// instantly to white. Half strength in light is what keeps the light appearance
        /// luminous rather than blown.
        private var bloomScale: Double { scheme == .dark ? 1.0 : 0.42 }

        var body: some View {
            ZStack {
                LinearGradient(
                    colors: [Colour.veil, Colour.veilDeep],
                    startPoint: .top,
                    endPoint: .bottom
                )

                if reduceMotion {
                    blooms(at: 0)
                } else {
                    TimelineView(.animation(minimumInterval: 1.0 / 15.0, paused: false)) { timeline in
                        blooms(at: timeline.date.timeIntervalSinceReferenceDate)
                    }
                }
            }
            .ignoresSafeArea()
        }

        /// Three blooms on coprime periods. `t` is seconds; at `t == 0` this is the
        /// composed still used for Reduce Motion.
        @ViewBuilder
        private func blooms(at t: TimeInterval) -> some View {
            ZStack {
                bloom(
                    colour: Colour.luminanceCore.opacity(0.60 * bloomScale),
                    centre: UnitPoint(x: 0.70 + 0.06 * sin(t / 23 * .pi * 2),
                                      y: 0.24 + 0.04 * cos(t / 31 * .pi * 2)),
                    radius: 430
                )
                bloom(
                    colour: Colour.luminance.opacity(0.34 * bloomScale),
                    centre: UnitPoint(x: 0.20 + 0.07 * cos(t / 31 * .pi * 2),
                                      y: 0.62 + 0.05 * sin(t / 41 * .pi * 2)),
                    radius: 360
                )
                bloom(
                    colour: Colour.accent.opacity(0.18 * bloomScale),
                    centre: UnitPoint(x: 0.52 + 0.09 * sin(t / 41 * .pi * 2),
                                      y: 0.88 + 0.03 * cos(t / 23 * .pi * 2)),
                    radius: 320
                )
            }
            .blendMode(.plusLighter)
        }

        private func bloom(colour: Color, centre: UnitPoint, radius: CGFloat) -> some View {
            RadialGradient(colors: [colour, .clear], center: centre, startRadius: 0, endRadius: radius)
        }
    }
}

// MARK: - Colour plumbing

private extension SylTheme {
    /// Builds an appearance-reactive colour from two hex literals.
    ///
    /// `UIColor`'s dynamic provider is used rather than an asset catalogue colour set
    /// because it keeps the value beside the reasoning. An asset catalogue puts the
    /// number in a JSON file nobody reads and the justification in a comment nobody can
    /// find from it.
    static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

private extension UIColor {
    /// 0xRRGGBB, opaque. Private on purpose — hex belongs in ``SylTheme`` and nowhere
    /// else, so that the palette cannot be extended from a call site.
    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
