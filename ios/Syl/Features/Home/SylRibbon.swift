import SwiftUI
import SylKit

/// Syl, drawn as a ribbon of light.
///
/// ## Why a ribbon and not the figure in the concept art
///
/// Proposal F is emphatic that she is "a ribbon of light, not a face", and the entire
/// runtime argument rests on it: no lip-sync, no viseme set, no phoneme alignment, no
/// per-minute avatar service — "we are not simulating a mouth, we are making light
/// behave like sound." The humanlike figure in the concepts is F's `manifest` state,
/// which F budgets as a handful of *pre-rendered* set pieces shipped in the bundle.
///
/// So the figure becomes the ambient hero art, and this — the live, state-driven
/// layer — is the ribbon. That split is what lets real liveness ship today: F's open
/// question 4 records that nobody has authored the Rive artboard yet, and a `Canvas`
/// needs no artboard.
///
/// ## Why `Canvas` and not shape views
///
/// One `Canvas` issues the whole ribbon — feather passes and all — as a single drawing
/// pass with no view identity, no layout, and no diffing. The same thing built from
/// stacked `Path` views would allocate and diff a dozen views every frame, on a screen
/// that redraws continuously.
///
/// ## The feather
///
/// The soft edge is five concentric strokes of the same path at widening widths and
/// falling opacity, blended additively. That is Rive's vector-feathering trick done by
/// hand, and it costs a fraction of what a real blur costs — a blur is a full-surface
/// convolution every frame, and this is five stroke operations.
struct SylRibbon: View {
    /// The state to render. Comes from ``SylKit/PresenceTimeline``, already decayed.
    var state: PresenceState

    /// Amplitude scalar from the presence frame, already clamped to `0...1`.
    var intensity: Double

    /// Live audio envelope, `0...1`.
    ///
    /// Unbound for now, and deliberately part of the signature anyway: proposal F's P2
    /// taps `AVAudioEngine` for a two-band RMS envelope, and the *only* thing that
    /// needs to change here when it does is that this stops being zero. Leaving the
    /// seam open costs one parameter; retrofitting it would touch the whole renderer.
    var level: Double = 0

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    /// Whether she is drawn as emitted light or as pigment.
    ///
    /// `plusLighter` is how you draw something glowing, and it only works where there is
    /// darkness to add to. Over a pale veil every additive pass converges on white and
    /// she disappears — which is exactly what the first light-mode render showed. So the
    /// dark appearance emits and the light appearance paints, and the two use different
    /// alphas because the two do genuinely different things to a pixel.
    private var additive: Bool { scheme == .dark }

    /// Where the transition to `state` began, and what she looked like at that moment.
    /// Interpolating by hand rather than via `withAnimation` because a `Canvas` reads
    /// plain values — a `struct` of `Double`s is not `Animatable`, so SwiftUI would
    /// snap it and the ribbon would jump on every state change.
    @State private var from: RibbonAppearance = .forState(.absent)
    @State private var transitionStart: Date = .distantPast

    var body: some View {
        // `absent` is the default state, and the default is *nothing rendered*. Not a
        // zero-opacity view still ticking a timeline — actually nothing. This is the
        // cheapest and most important line in the file.
        if state == .absent {
            Color.clear.onAppear { beginTransition() }
        } else if reduceMotion {
            reducedGlyph
        } else {
            TimelineView(.animation(minimumInterval: frameInterval)) { timeline in
                Canvas(opaque: false, rendersAsynchronously: false) { context, size in
                    draw(in: &context, size: size, at: timeline.date)
                }
            }
            .onChange(of: state) { _, _ in beginTransition() }
            .onAppear { beginTransition() }
            .accessibilityHidden(true)
        }
    }

    // MARK: - Reduce Motion

    /// "A static glyph with an opacity breath and nothing else."
    ///
    /// Proposal F calls this out specifically and it is not a nicety — a glowing,
    /// darting ribbon is precisely the stimulus that setting exists for. The breath is
    /// kept because it is a change in *luminance*, not in position, which is what the
    /// setting is about; without it she would be a decal.
    private var reducedGlyph: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 8.0)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let breath = 0.55 + 0.25 * sin(t / 4 * .pi * 2)

            Canvas { context, size in
                var path = Path()
                let midY = size.height / 2
                path.move(to: CGPoint(x: size.width * 0.12, y: midY))
                path.addQuadCurve(
                    to: CGPoint(x: size.width * 0.88, y: midY),
                    control: CGPoint(x: size.width * 0.5, y: midY - size.height * 0.16)
                )

                for (width, alpha) in featherPasses(coreWidth: 2.2) {
                    context.stroke(
                        path,
                        with: .color(SylTheme.Colour.luminance.opacity(alpha * breath)),
                        style: StrokeStyle(lineWidth: width, lineCap: .round)
                    )
                }
            }
        }
        .accessibilityHidden(true)
    }

    // MARK: - Drawing

    private func draw(in context: inout GraphicsContext, size: CGSize, at now: Date) {
        let appearance = currentAppearance(at: now)
        guard appearance.brightness > 0.001 else { return }

        let t = now.timeIntervalSinceReferenceDate
        let phase = t * appearance.speed * .pi * 2

        let centre = centreline(size: size, appearance: appearance, phase: phase)
        let spine = polyline(centre)
        let body = ribbonBody(centre: centre, size: size, appearance: appearance)

        context.blendMode = additive ? .plusLighter : .normal

        // Painted light needs more of everything: additive passes compound toward white
        // on their own, ordinary alpha compositing does not.
        let halo = additive ? 0.55 : 1.15

        // The glow: wide, faint strokes of the centreline. This is the halo around her,
        // not the ribbon itself.
        for (width, alpha) in featherPasses(coreWidth: appearance.width) {
            for (colour, weight) in tintLayers(appearance) {
                context.stroke(
                    spine,
                    with: .color(colour.opacity(min(1, alpha * halo * weight * appearance.brightness))),
                    style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
                )
            }
        }

        // The body: a filled shape with real width, lit along its length. This is what
        // makes her a ribbon rather than a line on a chart.
        for (colour, weight) in tintLayers(appearance) {
            context.fill(
                body,
                with: .linearGradient(
                    Gradient(colors: [
                        colour.opacity(0.05 * weight * appearance.brightness),
                        colour.opacity(0.85 * weight * appearance.brightness),
                        colour.opacity(0.30 * weight * appearance.brightness),
                    ]),
                    startPoint: .zero,
                    endPoint: CGPoint(x: size.width, y: 0)
                )
            )
        }

        // A hot filament down the middle, so the light has a source rather than being
        // uniformly bright. Without it the body reads as a translucent sticker.
        //
        // In the light appearance the filament is the *only* genuinely additive mark —
        // a small hot core over painted pigment is what keeps her reading as light
        // rather than as a drawn shape.
        context.blendMode = .plusLighter
        context.stroke(
            spine,
            with: .color(SylTheme.Colour.luminanceCore.opacity((additive ? 0.55 : 0.85) * appearance.brightness)),
            style: StrokeStyle(lineWidth: max(1.0, appearance.width * 0.45), lineCap: .round)
        )
        context.blendMode = additive ? .plusLighter : .normal

        drawSparks(in: &context, size: size, appearance: appearance, phase: phase, t: t)
    }

    /// How many points the curve is sampled at.
    ///
    /// 240, not the 72 it started as, and the difference was visible immediately: at 72
    /// the turbulence term completed roughly nineteen oscillations across the width and
    /// was being sampled under four times per oscillation. That is textbook aliasing,
    /// and it rendered as a jagged EKG trace rather than as light. Sampling above the
    /// highest frequency present in the signal is not an optimisation to defer — it is
    /// the difference between the effect working and not.
    private static let samples = 240

    /// The centreline she is drawn along.
    ///
    /// Two harmonics rather than one, because a pure sine reads as a graph. The second
    /// is at a deliberately non-integer multiple (2.3×) so the two never line up into a
    /// repeating shape — the same coprime trick the veil's blooms use, for the same
    /// reason.
    private func centreline(size: CGSize, appearance: RibbonAppearance, phase: Double) -> [CGPoint] {
        let h = size.height
        let w = size.width
        let midY = h / 2 + h * appearance.rise

        // The audio envelope widens her swing. At `level == 0` this is exactly 1, so an
        // unbound level changes nothing.
        let audio = 1 + level * 0.85
        let amp = h * appearance.amplitude * (1 - appearance.straightness) * (0.45 + 0.55 * intensity) * audio

        return (0...Self.samples).map { step in
            let u = Double(step) / Double(Self.samples)

            // Tapers both ends to nothing, so she has no cut-off edges — she emerges
            // from the veil and returns to it.
            let envelope = sin(.pi * u)

            // `coil` tightens the wave toward the trailing end: the head holds still
            // and the tail curls in, which is what "coils inward, tail trailing" means.
            let k = appearance.waves * 2 * .pi * (1 + appearance.coil * u)

            var y = sin(k * u + phase) + 0.35 * sin(2.3 * k * u - phase * 1.7)
            y += appearance.turbulence * 0.5 * sin(4.1 * k * u + phase * 3.1)

            return CGPoint(x: w * u, y: midY + amp * envelope * y)
        }
    }

    /// The ribbon's outline: the centreline offset perpendicular to its own tangent, out
    /// and back.
    ///
    /// Offsetting along the *normal* rather than simply up and down in Y is what stops
    /// her looking like a thick line. Where the curve is steep, a vertical offset makes
    /// the band appear to pinch; a perpendicular one holds her width through the turn,
    /// which is how a physical ribbon behaves.
    private func ribbonBody(centre: [CGPoint], size: CGSize, appearance: RibbonAppearance) -> Path {
        guard centre.count > 2 else { return Path() }

        // Real width, not stroke width. A ribbon has a body; a line does not.
        let maxWidth = appearance.width * 7.5 * (0.55 + 0.45 * intensity)

        var top: [CGPoint] = []
        var bottom: [CGPoint] = []
        top.reserveCapacity(centre.count)
        bottom.reserveCapacity(centre.count)

        for index in centre.indices {
            let previous = centre[max(index - 1, 0)]
            let next = centre[min(index + 1, centre.count - 1)]

            var tx = next.x - previous.x
            var ty = next.y - previous.y
            let length = max(sqrt(tx * tx + ty * ty), 0.0001)
            tx /= length
            ty /= length

            let u = Double(index) / Double(centre.count - 1)
            // Tapers to a point at both ends. The 0.6 exponent holds her width further
            // toward the tips than a plain sine would — a ribbon narrows to a point,
            // it does not fade out over its whole length.
            let halfWidth = maxWidth * pow(sin(.pi * u), 0.6) / 2

            top.append(CGPoint(x: centre[index].x - ty * halfWidth, y: centre[index].y + tx * halfWidth))
            bottom.append(CGPoint(x: centre[index].x + ty * halfWidth, y: centre[index].y - tx * halfWidth))
        }

        var path = Path()
        path.addLines(top)
        path.addLines(bottom.reversed())
        path.closeSubpath()
        return path
    }

    private func polyline(_ points: [CGPoint]) -> Path {
        var path = Path()
        path.addLines(points)
        return path
    }

    /// Sparks shed by `thinking` and thrown by `delighted`.
    ///
    /// Positions come from a hash of the index rather than a random number generator,
    /// so the field is stable frame to frame — sparks that re-randomise every frame
    /// read as television static rather than embers.
    private func drawSparks(
        in context: inout GraphicsContext,
        size: CGSize,
        appearance: RibbonAppearance,
        phase: Double,
        t: TimeInterval
    ) {
        let count = Int(appearance.sparks * 20)
        guard count > 0 else { return }

        for index in 0..<count {
            let seed = Scatter.hash(index)
            let u = (seed.truncatingRemainder(dividingBy: 0.97) + 0.015)

            // Each spark drifts along its own slow arc and fades on its own clock, so
            // they never blink in unison.
            let life = (t * (0.35 + seed * 0.5) + seed * 10).truncatingRemainder(dividingBy: 1)
            let fade = sin(.pi * life)

            let envelope = sin(.pi * u)
            let k = appearance.waves * 2 * .pi * (1 + appearance.coil * u)
            let base = sin(k * u + phase) + 0.35 * sin(2.3 * k * u - phase * 1.7)

            let amp = size.height * appearance.amplitude * (0.45 + 0.55 * intensity)
            let scatter = (seed - 0.5) * size.height * 0.16 * life

            let point = CGPoint(
                x: size.width * u,
                y: size.height / 2 + size.height * appearance.rise + amp * envelope * base + scatter
            )

            let dot = Path(ellipseIn: CGRect(x: point.x, y: point.y, width: 1.7, height: 1.7))
            context.fill(
                dot,
                with: .color(SylTheme.Colour.luminanceCore.opacity(fade * 0.75 * appearance.brightness))
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
        let progress = RibbonAppearance.ease(elapsed / duration)
        return RibbonAppearance.lerp(from, target, progress)
    }

    /// Freeze what she looks like *now* as the start of the next blend.
    ///
    /// Sampling the current interpolated value rather than the previous state's target
    /// is what makes an interruption mid-transition look continuous: she blends from
    /// where she actually is, not from where she was heading.
    private func beginTransition() {
        let now = Date()
        from = currentAppearance(at: now)
        transitionStart = now
    }

    // MARK: - Helpers

    /// Widths and opacities of the five feather passes, outermost first.
    private func featherPasses(coreWidth: Double) -> [(CGFloat, Double)] {
        [
            (coreWidth * 6.0, 0.05),
            (coreWidth * 3.8, 0.09),
            (coreWidth * 2.4, 0.16),
            (coreWidth * 1.5, 0.32),
            (coreWidth * 1.0, 0.95),
        ]
    }

    /// The tint, as weighted layers.
    ///
    /// `Color.mix(with:by:)` would be the obvious tool and is iOS 18; this app targets
    /// 17. Additive layering gets the same result here because the blend mode is
    /// already `plusLighter` — weighting three strokes is arithmetically a mix.
    /// Negligible layers are dropped so the common case (cool, unsaturated) is a single
    /// stroke rather than three.
    private func tintLayers(_ appearance: RibbonAppearance) -> [(Color, Double)] {
        let warm = appearance.warmth
        let grey = appearance.desaturation
        let cool = max(0, 1 - warm - grey)

        return [
            (SylTheme.Colour.luminance, cool),
            (SylTheme.Colour.warmth, warm),
            (SylTheme.Colour.greyBlue, grey),
        ].filter { $0.1 > 0.01 }
    }

    /// Redraw rate, chosen per state.
    ///
    /// `idle` and `concerned` are slow by definition — a 0.1 Hz breath does not need 60
    /// frames a second, and this view is on screen whenever the app is. Everything else
    /// gets the display's rate. Throttling the two states she spends most of her life
    /// in is most of the battery story.
    private var frameInterval: Double {
        switch state {
        case .idle, .concerned, .absent: return 1.0 / 20.0
        default: return 1.0 / 60.0
        }
    }
}
