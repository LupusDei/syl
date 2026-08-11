import SwiftUI
import UIKit
import SylKit

/// Her line, and the light that orbits it.
///
/// ## Why a ring here, when chat gets a waveform
///
/// ``SylRibbon`` is a horizontal waveform, and that is *chat's* idiom: a line of speech,
/// read left to right, sitting under the last message in a transcript — the visual
/// grammar of something being **said**. On the home screen there is no transcript. The
/// same shape stretched across the hero art crossed her face and the star behind it, and
/// read as an interruption rather than as presence.
///
/// A ring is a **halo, not an utterance**. It is centred on the meaning instead of
/// crossing the picture, it encloses rather than divides, and light travelling a closed
/// path reads as attention circling a thought — which is exactly what *"Thinking about
/// your week"* is. Every decision in this file is judged against that sentence.
///
/// ## Why it must never look like a progress indicator
///
/// A ring with light moving round it is one bad decision away from a download dialog,
/// and a spinner on the home screen would tell the Commander he is waiting for the app
/// rather than that Syl is thinking. Four things hold it off, and none of them is a
/// matter of taste:
///
/// 1. **The light travels; the ring does not spin.** The faint ring is continuous and
///    stationary. What moves is a bright head with a long fading tail sweeping along it.
/// 2. **The arc never closes.** ``HaloLight/arcSpan`` is capped well below a whole lap in
///    every state, and there is a test whose only job is to say so.
/// 3. **There are two arcs, at incommensurate rates.** A spinner is one arc at one rate.
///    Two that never come back into phase cannot resolve into a mechanism.
/// 4. **The speed is not constant.** Travelling at a constant *angular* rate around an
///    ellipse means moving slowly at the narrow ends and quickly along the flanks. That
///    rubato is free, it is physical, and no progress indicator has ever had it.
///
/// ## Why it owns the phrase rather than sitting behind it
///
/// The ring is sized from the phrase's measured bounds, so it has to know what the
/// phrase is; and it reserves the space it occupies as real layout padding, so nothing
/// above or below it can be overlapped. Both of those are properties of the pair, not of
/// a decoration applied to one of them. Owning the `Text` is what makes "nothing
/// collides" a fact about the layout instead of a promise about the numbers.
struct SylHalo: View {
    /// The line under her name. Whatever ``HomeSnapshot/phrase(for:)`` said, or the
    /// greeting when she is speaking and the phrase is deliberately nil.
    var phrase: String

    /// The state to render. Comes from ``SylKit/PresenceTimeline``, already decayed.
    var state: PresenceState

    /// Amplitude scalar from the presence frame, already clamped to `0...1`.
    var intensity: Double

    /// The width the ring may occupy — the screen's, not the phrase's.
    var availableWidth: CGFloat

    /// Forces the still halo. **Nil asks the environment, which is what the app always
    /// does.**
    ///
    /// `accessibilityReduceMotion` is read-only in `EnvironmentValues`, so an offscreen
    /// render has no way to ask for the still frame — and the still frame is one of the
    /// things the Commander asked to look at. Same escape hatch, for the same reason, as
    /// ``HomeView/scrolls`` and ``SylHero/prefersStill``.
    var prefersStill: Bool?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize

    /// The margin, scaled by Dynamic Type and then capped. See
    /// ``HaloGeometry/margin(scaled:)`` for why it is capped rather than merely scaled.
    @ScaledMetric(relativeTo: .subheadline) private var scaledMargin = HaloGeometry.baseMargin

    /// What SwiftUI actually laid the phrase out as, once it has told us.
    ///
    /// Unioned with the synchronous estimate rather than replacing it, so a disagreement
    /// between the two can only ever make the ring *larger*. The estimate is what an
    /// offscreen `ImageRenderer` gets — it renders in one pass, so a size that arrives by
    /// preference never reaches the drawing — and it is what the tests measure against.
    @State private var laidOut: CGSize = .zero

    /// Where the transition to `state` began, and what she looked like at that moment.
    /// Interpolating by hand for the reason ``SylRibbon`` documents: a `Canvas` reads
    /// plain values, and SwiftUI would snap a non-`Animatable` struct rather than blend it.
    @State private var from: RibbonAppearance = .forState(.absent)
    @State private var transitionStart: Date = .distantPast

    /// Whether the light is drawn as emitted light or as pigment.
    ///
    /// `plusLighter` is how you draw something glowing and it only works where there is
    /// darkness to add to. This screen is a starfield in one appearance and a bright
    /// painting in the other, so the rule ``SylRibbon`` arrived at applies unchanged:
    /// the dark appearance emits and the light appearance paints.
    private var additive: Bool { scheme == .dark }

    private var margin: CGFloat { HaloGeometry.margin(scaled: scaledMargin) }

    private var measure: CGFloat { HaloGeometry.textMeasure(in: availableWidth) }

    /// The phrase's lines: measured synchronously, then stretched to whatever SwiftUI
    /// reports if SwiftUI reports more.
    ///
    /// The stretch is one-way on purpose. If TextKit and SwiftUI ever disagree about where
    /// a line breaks, the ring gets *looser* than it needed to be — never tighter, which
    /// would be a ring drawn through the words.
    private var phraseLines: [CGSize] {
        let lines = PhraseMetrics.lines(of: phrase, within: measure, typeSize: typeSize)
        guard !lines.isEmpty else { return [] }

        let width = lines.map(\.width).max() ?? 0
        let height = lines.reduce(0) { $0 + $1.height }
        let horizontal = width > 0 ? max(1, laidOut.width / width) : 1
        let vertical = height > 0 ? max(1, laidOut.height / height) : 1
        guard horizontal > 1.0001 || vertical > 1.0001 else { return lines }

        return lines.map { CGSize(width: $0.width * horizontal, height: $0.height * vertical) }
    }

    private var geometry: HaloGeometry {
        HaloGeometry.around(lines: phraseLines, margin: margin, availableWidth: availableWidth)
    }

    /// Whether she is *doing* something. The ring is drawn only then — but the space it
    /// occupies is held whether or not it is lit, so the nameplate does not jump the moment
    /// she starts thinking. Constant geometry, varying light.
    private var lit: Bool { HomeSnapshot.isActive(state) }

    /// Whether the light holds still. The Commander's setting, unless a render overrode it.
    private var still: Bool { prefersStill ?? reduceMotion }

    var body: some View {
        // Once, into a local: `geometry` runs the phrase through CoreText, and reading the
        // property three times in one `body` would lay the text out three times.
        let geometry = self.geometry

        return Group {
            if geometry.fits {
                // The box IS the ring — the words are laid over it rather than padded out
                // to it. Sizing the box to the phrase's own frame instead would stretch
                // the ring of a two-word phrase out to the full measure, and "Here." would
                // be orbited by an ellipse three times wider than the word. The ring must
                // hug what it is about.
                Color.clear
                    .frame(width: geometry.footprint.width, height: geometry.footprint.height)
                    .background(alignment: .center) { ring }
                    .overlay { line.frame(width: measure) }
            } else {
                // No ring, and no space held for one. On the narrowest phone at the
                // largest type there is no ellipse that holds this phrase — see
                // ``HaloGeometry/fits`` — so the halo steps aside completely and the line
                // gets the whole width back, exactly as it read before this existed.
                line
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, SylTheme.Metric.gutter)
                    .padding(.vertical, SylTheme.Metric.step)
            }
        }
        .onChange(of: state) { _, _ in beginTransition() }
        .onAppear { beginTransition() }
        .animation(SylTheme.Motion.breathe, value: lit)
        .animation(SylTheme.Motion.breathe, value: phrase)
    }

    // MARK: - The words

    /// The line itself, styled exactly as the nameplate styled it before the ring existed.
    private var line: some View {
        Text(phrase)
            .font(.system(.subheadline, design: .serif))
            .tracking(PhraseMetrics.tracking)
            .foregroundStyle(SylTheme.Colour.inkSoft)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .contentTransition(.opacity)
            .animation(SylTheme.Motion.breathe, value: phrase)
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(key: PhraseSizeKey.self, value: proxy.size)
                }
            }
            .onPreferenceChange(PhraseSizeKey.self) { size in
                // Hopped rather than assigned directly: the preference callback is not
                // isolated to the main actor under strict concurrency, and `@State` is.
                Task { @MainActor in laidOut = size }
            }
    }

    // MARK: - The light

    @ViewBuilder
    private var ring: some View {
        if lit {
            haloCanvas
                .allowsHitTesting(false)
                // Decorative, and deliberately silent. The phrase it orbits already says
                // what she is doing, in words; a second announcement of the same fact is
                // how a screen reader turns one thought into two.
                .accessibilityHidden(true)
                .transition(.opacity)
        }
    }

    @ViewBuilder
    private var haloCanvas: some View {
        if still {
            // "The ring stays as a still halo, the travelling light stops." The breath is
            // kept for the reason `SylRibbon` keeps its own: it is a change in *luminance*,
            // not in position, which is what the setting is about — and without it the
            // still frame reads as an animation that broke rather than as light at rest.
            TimelineView(.animation(minimumInterval: 1.0 / 6.0)) { timeline in
                Canvas(opaque: false, rendersAsynchronously: false) { context, size in
                    let breath = 0.82 + 0.18 * sin(timeline.date.timeIntervalSinceReferenceDate / 5 * .pi * 2)
                    draw(in: &context, size: size, at: timeline.date, frozen: true, dim: breath)
                }
            }
        } else {
            TimelineView(.animation(minimumInterval: frameInterval)) { timeline in
                Canvas(opaque: false, rendersAsynchronously: false) { context, size in
                    draw(in: &context, size: size, at: timeline.date, frozen: false, dim: 1)
                }
            }
        }
    }

    /// Redraw rate, chosen from how fast the light is actually travelling.
    ///
    /// Derived rather than switched on the state: a lap that takes fifteen seconds does
    /// not need sixty frames of it every second, and asking the light how fast it is going
    /// cannot fall out of step with how fast it is going.
    private var frameInterval: Double {
        HaloLight.forState(state, intensity: intensity).turnsPerSecond < 0.12 ? 1.0 / 24.0 : 1.0 / 60.0
    }

    // MARK: - Drawing

    private func draw(in context: inout GraphicsContext, size: CGSize, at now: Date, frozen: Bool, dim: Double) {
        let appearance = currentAppearance(at: now)
        let light = HaloLight.from(appearance, intensity: intensity)
        guard light.brightness > 0.001 else { return }

        // The ring is inscribed in its own box, so its radii are not stated anywhere —
        // they are the box, less the room reserved for the glow to spill into. A ring that
        // read its size from a constant could disagree with the padding that made room
        // for it; this one cannot.
        let a = max(size.width / 2 - HaloGeometry.glowAllowance, 1)
        let b = max(size.height / 2 - HaloGeometry.glowAllowance, 1)
        let centre = CGPoint(x: size.width / 2, y: size.height / 2)

        let t = now.timeIntervalSinceReferenceDate
        // Counter-clockwise on screen: y grows downward, so a decreasing angle rises on
        // the right-hand side. Light that climbs reads as lift; light that falls reads as
        // drain.
        let head = frozen ? HaloLight.restingAngle : -t * light.turnsPerSecond * 2 * .pi
        let companionHead = frozen
            ? HaloLight.restingAngle + 2.4
            : -t * light.turnsPerSecond * HaloLight.companionRate * 2 * .pi + 2.4

        context.blendMode = additive ? .plusLighter : .normal

        // Painted light needs a little more of everything: additive passes compound toward
        // white on their own, ordinary alpha compositing does not.
        let halo = additive ? 1.0 : 1.25
        let brightness = light.brightness * dim

        drawPath(in: &context, centre: centre, a: a, b: b, light: light, gain: halo * brightness)

        drawTail(
            in: &context, centre: centre, a: a, b: b, light: light,
            head: head, span: light.arcSpan, gain: halo * brightness
        )
        drawTail(
            in: &context, centre: centre, a: a, b: b, light: light,
            head: companionHead,
            span: light.arcSpan * HaloLight.companionSpan,
            gain: halo * brightness * HaloLight.companionBrightness
        )

        // A slow flicker on the heads alone, at a rate coprime with the orbit, so the
        // brightest thing in the frame never repeats on the lap.
        let flicker = frozen ? 1 : 0.85 + 0.15 * sin(t * 2.7)

        drawHead(
            in: &context, centre: centre, a: a, b: b, light: light,
            head: head, brightness: brightness, scale: 1, flicker: flicker
        )
        // The companion gets a source of its own. Without one its leading edge is the butt
        // end of a stroke — a bright bar stopping dead, which is the single most mechanical
        // mark the first renders produced, and it sat right next to the arc that was doing
        // all the work of not looking mechanical.
        drawHead(
            in: &context, centre: centre, a: a, b: b, light: light,
            head: companionHead,
            brightness: brightness * HaloLight.companionBrightness,
            scale: 0.7, flicker: flicker
        )

        drawSparks(
            in: &context, centre: centre, a: a, b: b, light: light,
            head: head, span: light.arcSpan, brightness: brightness, t: frozen ? 0 : t
        )
    }

    /// The orbit itself: continuous, faint, and stationary.
    ///
    /// This is the half of the design that keeps the other half honest. Without a visible
    /// path the travelling arc is a comet with nowhere to be; with it, the arc is
    /// obviously *light moving along something that was already there*, which is the
    /// difference between an orbit and a sweep.
    private func drawPath(
        in context: inout GraphicsContext,
        centre: CGPoint, a: CGFloat, b: CGFloat,
        light: HaloLight, gain: Double
    ) {
        let path = Path(ellipseIn: CGRect(x: centre.x - a, y: centre.y - b, width: a * 2, height: b * 2))

        // Fainter as pigment than as emitted light. Painted at the same weight the ring
        // stops being a suggestion of a path and becomes a drawn ellipse — an outline with
        // a comet on it, which is a diagram rather than a halo.
        let presence = additive ? 0.30 : 0.17

        for (width, alpha) in Luminous.featherPasses(coreWidth: light.width * 0.62, painted: !additive) {
            for (colour, weight) in Luminous.tintLayers(warmth: light.warmth, desaturation: light.desaturation) {
                context.stroke(
                    path,
                    with: .color(colour.opacity(min(1, alpha * presence * weight * gain))),
                    style: StrokeStyle(lineWidth: width, lineCap: .round)
                )
            }
        }
    }

    /// The bright arc and its long fading tail.
    ///
    /// Drawn as short segments with falling opacity, because `GraphicsContext` has no
    /// gradient *along* a path. Two resolutions rather than one: the wide soft passes are
    /// stepped coarsely, since an opacity ladder is invisible through a thirteen-point
    /// stroke, and only the hot core is stepped finely. Perceptually identical to running
    /// everything at the fine resolution, at about half the strokes.
    private func drawTail(
        in context: inout GraphicsContext,
        centre: CGPoint, a: CGFloat, b: CGFloat,
        light: HaloLight, head: Double, span: Double, gain: Double
    ) {
        guard span > 0.0001, gain > 0.001 else { return }

        let sweep = span * 2 * .pi
        let tints = Luminous.tintLayers(warmth: light.warmth, desaturation: light.desaturation)
        let passes = Luminous.featherPasses(coreWidth: light.width, painted: !additive)

        func point(_ theta: Double) -> CGPoint {
            CGPoint(x: centre.x + a * cos(theta), y: centre.y + b * sin(theta))
        }

        // A small hot shoulder just behind the head, so the leading edge has a source
        // rather than being the brightest point of a uniform gradient. Much smaller as
        // pigment: additive passes have headroom above 1 and simply get brighter, where
        // alpha-composited ones clamp — several passes saturate to the same value at once
        // and the head comes out as a flat slab with a straight edge on it.
        let shoulder = additive ? 0.55 : 0.14

        /// How bright the tail is `u` of the way back from the head.
        ///
        /// A power curve rather than a linear ramp, so the tail arrives at nothing
        /// *smoothly* and there is no visible end to it — the failure being avoided is a
        /// tail that stops, which is the exact silhouette of a spinner's arc.
        func falloff(_ u: Double) -> Double {
            pow(max(0, 1 - u), 1.5) * (1 + shoulder * exp(-u * 9))
        }

        /// Lays one pass of the tail as `segments` abutting pieces of falling opacity.
        ///
        /// **Abutting, not overlapping — and that was a real bug, not a detail.** The first
        /// version had each segment run 50% into the next so their opacities would blend.
        /// Under `plusLighter` an overlap does not blend, it *adds*: every junction came out
        /// twice as bright as its neighbours and the tail rendered as a row of beads — a
        /// dashed arc going round a circle, which is the exact silhouette of the loading
        /// spinner this component may not be. Butt caps and exact abutment instead: no
        /// double-covered pixel anywhere, and at a few points a step the opacity ladder is
        /// a percent a rung and invisible.
        func lay(segments: Int, width: CGFloat, alpha: Double, cap: CGLineCap) {
            for index in 0..<segments {
                let u0 = Double(index) / Double(segments)
                let u1 = Double(index + 1) / Double(segments)
                let level = falloff((u0 + u1) / 2)
                guard level > 0.004 else { continue }

                var segment = Path()
                let steps = 3
                for step in 0...steps {
                    let u = u0 + (u1 - u0) * (Double(step) / Double(steps))
                    let position = point(head - u * sweep)
                    if step == 0 { segment.move(to: position) } else { segment.addLine(to: position) }
                }

                for (colour, weight) in tints {
                    context.stroke(
                        segment,
                        with: .color(colour.opacity(min(1, alpha * level * weight * gain))),
                        style: StrokeStyle(lineWidth: width, lineCap: cap, lineJoin: .round)
                    )
                }
            }
        }

        // Segments per unit of *arc*, not per tail — and that was the second beading bug.
        // A fixed count spread over the companion's much shorter sweep gave pieces a point
        // and a half long, and a butt join between two one-and-a-half-point pieces on a
        // curve is a seam you can see: the short arc came out dotted while the long one
        // beside it was perfectly smooth. Stepping by length makes every piece the same
        // size on screen whatever the arc is doing.
        let length = sweep * (a + b) / 2

        // The three widest, faintest passes are the glow and can be coarser — at six
        // points across, a step in opacity is invisible.
        //
        // **Butt caps on all of them, including the wide ones.** Round caps overlap by
        // half their own line width at every junction, which on a thirteen-point glow pass
        // cut into eight-point pieces is most of the segment covered twice — bands, in
        // either blend mode, and the painted appearance showed them as a ladder laid along
        // the tail. Whatever the blend mode, the rule is the same: no pixel drawn twice.
        for (index, pass) in passes.enumerated() {
            lay(
                segments: steps(along: length, every: index < 3 ? 6 : 3.5),
                width: pass.0,
                alpha: pass.1,
                cap: .butt
            )
        }
    }

    /// How many pieces to cut an arc of this length into, at roughly this many points each.
    private func steps(along length: CGFloat, every points: CGFloat) -> Int {
        min(max(Int(length / points), 6), 120)
    }

    /// A hot filament at the leading edge, so the light has a source.
    ///
    /// `plusLighter` where there is darkness to add to — the same ruling ``SylRibbon``
    /// makes about its filament, and a small genuinely additive core is what keeps the
    /// whole thing reading as light rather than as a drawn shape.
    ///
    /// **Where the ribbon's ruling does not survive is on a bright page.** Her hot core is
    /// `luminanceCore`, which resolves to pure white in the light appearance, and white
    /// added to a pale daylight painting is nothing at all — the first day render had a
    /// perfectly good tail with no source on the end of it. So on the painted side the
    /// head is her ordinary luminance laid down as pigment: the brightest mark on a dark
    /// ground, and the densest on a light one. It is the same idea about *contrast*, and
    /// the opposite instruction.
    private func drawHead(
        in context: inout GraphicsContext,
        centre: CGPoint, a: CGFloat, b: CGFloat,
        light: HaloLight, head: Double, brightness: Double, scale: Double, flicker: Double
    ) {
        let position = CGPoint(x: centre.x + a * cos(head), y: centre.y + b * sin(head))
        let previous = context.blendMode
        context.blendMode = additive ? .plusLighter : .normal
        let colour = additive ? SylTheme.Colour.luminanceCore : SylTheme.Colour.luminance
        let core = light.width * scale

        for (radius, alpha) in [(core * 2.6, 0.10), (core * 1.4, 0.26), (core * 0.55, 0.95)] {
            let dot = Path(
                ellipseIn: CGRect(
                    x: position.x - radius, y: position.y - radius,
                    width: radius * 2, height: radius * 2
                )
            )
            context.fill(
                dot,
                with: .color(colour.opacity(min(1, alpha * (additive ? 1.0 : 1.15) * brightness * flicker)))
            )
        }

        context.blendMode = previous
    }

    /// Sparks shed by `thinking` and thrown by `delighted`.
    ///
    /// **Shed by the travelling light, not scattered around the ring.** The first version
    /// placed them at fixed angles all the way round, and they read as dust in the room
    /// rather than as embers off a moving thing — motes that happened to share a screen
    /// with a comet. Anchoring them to the arc and letting them drift outward as they fade
    /// makes them a consequence of the light, which is the only reason they are worth
    /// drawing at all.
    ///
    /// Positions come from a hash of the index rather than a random number generator, so
    /// the field is stable frame to frame — sparks that re-randomise every frame read as
    /// television static. The same trick, and the same reason, as ``SylRibbon``.
    private func drawSparks(
        in context: inout GraphicsContext,
        centre: CGPoint, a: CGFloat, b: CGFloat,
        light: HaloLight, head: Double, span: Double, brightness: Double, t: TimeInterval
    ) {
        let count = Int(light.sparks * 14)
        guard count > 0 else { return }

        let sweep = span * 2 * .pi
        for index in 0..<count {
            let seed = Scatter.hash(index)

            // Each spark drifts outward on its own slow clock and fades on it too, so they
            // never blink in unison.
            let life = (t * (0.28 + seed * 0.4) + seed * 10).truncatingRemainder(dividingBy: 1)
            let fade = sin(.pi * life)

            // Born somewhere along the tail and left behind by it: the angle is fixed
            // relative to the head, so a spark sits still in the ring's frame while the
            // arc moves on past it.
            let angle = head - seed * sweep * 1.4
            let drift = 1 + 0.14 * life

            let point = CGPoint(
                x: centre.x + a * drift * cos(angle),
                y: centre.y + b * drift * sin(angle)
            )
            let dot = Path(ellipseIn: CGRect(x: point.x, y: point.y, width: 1.7, height: 1.7))
            context.fill(
                dot,
                with: .color(
                    (additive ? SylTheme.Colour.luminanceCore : SylTheme.Colour.luminance)
                        .opacity(fade * 0.55 * brightness)
                )
            )
        }
    }

    // MARK: - Interpolation

    /// The appearance to draw right now, eased from whatever she was.
    private func currentAppearance(at now: Date) -> RibbonAppearance {
        let target = RibbonAppearance.forState(state)
        let duration = RibbonAppearance.transitionDuration(to: state)
        guard duration > 0 else { return target }

        let elapsed = now.timeIntervalSince(transitionStart)
        return RibbonAppearance.lerp(from, target, RibbonAppearance.ease(elapsed / duration))
    }

    /// Freeze what she looks like *now* as the start of the next blend, so an interruption
    /// mid-transition blends from where she actually is rather than from where she was
    /// heading.
    private func beginTransition() {
        let now = Date()
        from = currentAppearance(at: now)
        transitionStart = now
    }
}

/// The laid-out size of the phrase, reported back up out of the `Text`.
private struct PhraseSizeKey: PreferenceKey {
    static let defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

/// What the phrase measures, without waiting for SwiftUI to lay it out.
///
/// ## Why measure it twice
///
/// SwiftUI reports a laid-out size through a preference, which arrives on the pass
/// *after* the one that needed it. On the device that costs one frame and nobody sees it.
/// Offscreen it costs everything: `ImageRenderer` draws in a single pass, so a ring that
/// waited for the preference would render at its minimum size in every design snapshot —
/// and the renders are how this component gets judged.
///
/// So the size is computed here, synchronously, from the same font the `Text` resolves to,
/// and the laid-out size is *unioned* with it when it arrives. A disagreement between
/// TextKit's line breaking and SwiftUI's can then only make the ring larger, never
/// smaller — and larger is a slightly loose halo where smaller is a ring drawn through
/// the words.
enum PhraseMetrics {
    /// Letter-spacing on her line. One number, used by the `Text` and by the measurement,
    /// because a measurement that assumes different tracking from the thing it is
    /// measuring is not a measurement.
    static let tracking: CGFloat = 2.2

    /// Each laid-out line of the phrase, top to bottom.
    ///
    /// The ring is sized from these rather than from the block around them — see
    /// ``HaloGeometry/around(lines:margin:availableWidth:)`` for the accessibility-size
    /// render that made the difference impossible to ignore.
    static func lines(of phrase: String, within width: CGFloat, typeSize: DynamicTypeSize) -> [CGSize] {
        guard !phrase.isEmpty, width > 0 else { return [] }

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byWordWrapping

        let attributed = NSAttributedString(
            string: phrase,
            attributes: [.font: font(for: typeSize), .kern: tracking, .paragraphStyle: paragraph]
        )

        let setter = CTFramesetterCreateWithAttributedString(attributed)
        let column = CGPath(
            rect: CGRect(x: 0, y: 0, width: width, height: .greatestFiniteMagnitude / 2),
            transform: nil
        )
        let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), column, nil)

        guard let laid = CTFrameGetLines(frame) as? [CTLine] else { return [] }
        return laid.map { line in
            var ascent: CGFloat = 0
            var descent: CGFloat = 0
            var leading: CGFloat = 0
            let advance = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)

            // The space at the end of a wrapped line is not ink, and a ring sized to
            // include it is off-centre by half a space and larger than it needed to be. At
            // the largest type that space is ten points, which was enough to push lines
            // past their own measure and out of the ellipse.
            let trailing = CTLineGetTrailingWhitespaceWidth(line)

            // Reported as measured, and deliberately **not** clamped to the measure. A
            // clamp there would be defensive in the wrong direction: it hides a line that
            // overran, and a ring built from the clamped number would be too small for the
            // words that are actually on screen. If a line overruns, the halo should see
            // it — and either grow, or stand down.
            return CGSize(
                width: ceil(advance - trailing),
                height: ceil(ascent + descent + leading)
            )
        }
    }

    /// The block the lines add up to. Derived from ``lines(of:within:typeSize:)`` rather
    /// than measured a second way, so the two can never disagree about how tall the phrase
    /// is — one of them sizes the ring and the other sizes the layout, and a screen where
    /// those two answers differ is a screen with a ring in the wrong place.
    static func bounds(of phrase: String, within width: CGFloat, typeSize: DynamicTypeSize) -> CGSize {
        let lines = lines(of: phrase, within: width, typeSize: typeSize)
        guard !lines.isEmpty else { return .zero }

        return CGSize(
            width: lines.map(\.width).max() ?? 0,
            height: lines.reduce(0) { $0 + $1.height }
        )
    }

    /// `.system(.subheadline, design: .serif)`, resolved through UIKit at a given type size.
    static func font(for typeSize: DynamicTypeSize) -> UIFont {
        let traits = UITraitCollection(preferredContentSizeCategory: contentSize(for: typeSize))
        let base = UIFont.preferredFont(forTextStyle: .subheadline, compatibleWith: traits)
        let descriptor = base.fontDescriptor.withDesign(.serif) ?? base.fontDescriptor
        return UIFont(descriptor: descriptor, size: base.pointSize)
    }

    /// SwiftUI's Dynamic Type sizes and UIKit's content size categories are the same
    /// ladder under two names, and neither framework offers the bridge.
    static func contentSize(for typeSize: DynamicTypeSize) -> UIContentSizeCategory {
        switch typeSize {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }
}

// MARK: - Previews

#Preview("Thinking") {
    ZStack {
        SylTheme.Veil()
        SylHalo(phrase: "Thinking about your week.", state: .thinking, intensity: 0.8, availableWidth: 393)
    }
    .frame(width: 393, height: 400)
    .environment(\.colorScheme, .dark)
}

#Preview("Manifest") {
    ZStack {
        SylTheme.Veil()
        SylHalo(phrase: "Here.", state: .manifest, intensity: 0.6, availableWidth: 393)
    }
    .frame(width: 393, height: 400)
    .environment(\.colorScheme, .dark)
}
