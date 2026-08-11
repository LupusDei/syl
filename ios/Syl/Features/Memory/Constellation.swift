import SwiftUI

/// What she remembers, drawn as a sky.
///
/// **Nodes are stars. Edges are filaments. Confidence is the brightness. Tier is the
/// depth.** That is not decoration chosen to match the app — it is the honest rendering of
/// a model where nothing is deleted and everything fades. A memory system whose edges
/// decay asymptotically toward zero and never arrive is not a database diagram; it is a
/// night sky, and this is the one dataset in the project whose semantics *are* light.
///
/// The Commander decided this personally, over the recommendation to build the admin
/// instrument first, and set the bar himself: *"It's possible it won't be super useful, but
/// I'll have useful things in the admin tools. What I want for the app is beauty."* So
/// there is no filter bar here, no search field, no legend and no node count. Each of those
/// would make it more useful and would break the thing he asked for.
///
/// ## One `Canvas`, not a view per star
///
/// ``MoteField`` draws forty soft points on coprime periods in a single canvas at 24fps,
/// and ``SylRibbon`` draws a 240-point filament the same way. This is those two techniques
/// pointed at real data. A `View` per node would put hundreds of SwiftUI identities on
/// screen for something that is fundamentally a drawing — `syl-008` already paid for
/// treating a drawing problem as a view problem, twice, in crashes.
///
/// ## Emitted light, or pigment
///
/// The same split ``SylRibbon`` documents at length. `plusLighter` is how you draw
/// something glowing and it only works where there is darkness to add to; over a pale veil
/// every additive pass converges on white and the sky disappears. So the dark appearance
/// *is* a night sky, and the light appearance is an engraved star chart — the same
/// composition, the same positions, the same brightnesses, drawn in ink instead of light.
///
/// ## Nothing here is computed
///
/// Every position, brightness and thickness arrived in ``PreparedSky``, built once off the
/// main actor. This function does arithmetic on a finished value and nothing else, because
/// it runs twenty-four times a second.
struct Constellation: View {
    /// The finished sky. See ``SkyPreparer``.
    var sky: PreparedSky

    /// What clock this sky is on. ``ConstellationTime/live`` everywhere but a render.
    var time: ConstellationTime = .live

    /// Where he is standing. Applied to the drawing context, so a magnified sky is
    /// **redrawn** at that scale rather than a rasterised one blown up — every star stays
    /// as crisp at four times as it is at one.
    var transform: ConstellationTransform = .identity

    /// What he touched, and what that lights. See ``ConstellationEmphasis``.
    var emphasis: ConstellationEmphasis = .none

    /// What to do when VoiceOver activates a star or a filament. The touch path does its
    /// own hit-testing in ``ConstellationView``; this is the same selection, reached by
    /// somebody who cannot aim at a point of light.
    var onSelect: (ConstellationHit) -> Void = { _ in }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    /// Whether she is drawn as emitted light or as pigment. See ``SylRibbon/additive``.
    private var additive: Bool { scheme == .dark }

    var body: some View {
        Group {
            if reduceMotion || time == .pinned {
                // **Pinned, and not a frozen frame of the motion.**
                //
                // Every star sits exactly on its anchor, so the still is a photograph of
                // the same sky rather than a degraded one. If it looked broken, the motion
                // was carrying meaning it should not have been — which is the test, and it
                // is the reason there is no `TimelineView` on this branch at all rather
                // than a paused one.
                canvas(at: 0, moving: false)
            } else if case .frozen(let instant) = time {
                canvas(at: instant, moving: true)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 24.0)) { timeline in
                    canvas(at: timeline.date.timeIntervalSinceReferenceDate, moving: true)
                }
            }
        }
        // **A `Canvas` is invisible to VoiceOver.** Not partially, not badly — a canvas is
        // one opaque rectangle with no children, so without this the screen whose entire
        // purpose is to be looked at does not exist at all for anyone who cannot look at
        // it. That is worse here than it would be anywhere else in the app, not more
        // forgivable.
        //
        // `accessibilityChildren` is the modifier built for exactly this: it hangs
        // synthetic elements off a drawing. Each one sits where its star actually is on
        // glass, so the rotor order and the explore-by-touch positions agree with the
        // picture, and each carries her own words for the thing plus where it came from.
        //
        // The container keeps a label and no count. A number of stars would be a dashboard
        // statistic on a screen whose doors are documented as *not statistics* — and it
        // would be the only place in the app that told him how much she knows.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("The constellation of what she remembers")
        .accessibilityChildren {
            ConstellationVoice(sky: sky, transform: transform, onSelect: onSelect)
        }
    }

    private func canvas(at t: TimeInterval, moving: Bool) -> some View {
        // The canvas's own size is deliberately unused. Every coordinate in a
        // ``PreparedSky`` is already absolute, in the size it was laid out for — and the
        // screen re-prepares when that changes, rather than the drawing rescaling a sky
        // built for something else.
        Canvas(opaque: false, rendersAsynchronously: false) { context, _ in
            draw(in: &context, at: t, moving: moving)
        }
    }

    // MARK: - Drawing

    private func draw(in context: inout GraphicsContext, at t: TimeInterval, moving: Bool) {
        guard !sky.isEmpty else { return }

        context.blendMode = additive ? .plusLighter : .normal

        // **Where he is standing, applied to the context rather than to the coordinates.**
        //
        // Translate then scale, in that order, which is `view = sky · s + t` — the same
        // arithmetic ``ConstellationTransform/apply(_:)`` does for the hit test, so a tap
        // and a pixel can never disagree about where a star is.
        //
        // Doing it here rather than with a `scaleEffect` on the view is the whole point: a
        // `scaleEffect` magnifies the rasterised canvas and a four-times sky comes back
        // soft. This re-runs the drawing at the new scale, so a star is as crisp close up
        // as it is far away — and it means the hover, the glow and the filament widths all
        // magnify together, which is what approaching something actually looks like.
        context.translateBy(x: transform.translation.width, y: transform.translation.height)
        context.scaleBy(x: transform.scale, y: transform.scale)

        // Filaments first. They are behind the stars because a thread passing over a star
        // reads as a scratch on the lens.
        for filament in sky.filaments {
            drawFilament(filament, in: &context, at: t, moving: moving)
        }

        for star in sky.stars {
            drawStar(star, in: &context, at: t, moving: moving)
        }
    }

    /// Where a star actually is this frame: its anchor, plus a bounded hover.
    private func point(anchor: CGPoint, seed: Int, depth: Double, at t: TimeInterval, moving: Bool) -> CGPoint {
        let offset = ConstellationMotion.offset(seed: seed, depth: depth, at: t, moving: moving)
        return CGPoint(x: anchor.x + offset.width, y: anchor.y + offset.height)
    }

    // MARK: - Stars

    private func drawStar(_ star: PreparedStar, in context: inout GraphicsContext, at t: TimeInterval, moving: Bool) {
        let centre = point(anchor: star.anchor, seed: star.seed, depth: star.depth, at: t, moving: moving)
        let breath = ConstellationMotion.breath(seed: star.seed, at: t, moving: moving)

        // The selection, as a weight on the light rather than as a ring drawn round it.
        // Capped at one, and floored for the one he touched — see
        // ``ConstellationEmphasis/floor(forStar:)``, which is there because a faint memory
        // multiplied by anything is still faint.
        let alpha = max(
            min(1, star.alpha * breath * emphasis.weight(forStar: star.id, additive: additive)),
            emphasis.floor(forStar: star.id))
        guard alpha > PreparedSky.faintestDrawn else { return }

        let core = star.coreRadius * emphasis.swell(forStar: star.id)

        // **A glow and an ink bleed are not the same size.**
        //
        // Emitted light spills a long way and gets brighter as it does. Pigment does not:
        // a wide pale wash over pale paper is a smudge, which is exactly what the first
        // daylight render came back as — every star sitting in its own milky thumbprint. So
        // the light appearance keeps a much tighter, weaker halo, and lets the core carry
        // the star.
        let halo = core * (additive ? 7.5 : 3.6)
        let spill = additive ? 1.0 : 0.55

        // The glow, as one radial gradient rather than as concentric discs.
        //
        // The ribbon feathers with five widening strokes because it is feathering a
        // *line*, and a stroke is the only tool that has. A point has a better one: a
        // single shaded fill with a smooth falloff, which costs one operation and has no
        // banding — four stacked discs at these radii show their own edges.
        let glow = haloColour(star.tint)
        context.fill(
            Path(ellipseIn: CGRect(
                x: centre.x - halo, y: centre.y - halo, width: halo * 2, height: halo * 2)),
            with: .radialGradient(
                Gradient(stops: [
                    .init(color: glow.opacity(alpha * 0.70 * spill), location: 0.00),
                    .init(color: glow.opacity(alpha * 0.30 * spill), location: 0.16),
                    .init(color: glow.opacity(alpha * 0.09 * spill), location: 0.42),
                    .init(color: glow.opacity(0), location: 1.00),
                ]),
                center: centre, startRadius: 0, endRadius: halo
            )
        )

        // Diffraction spikes: the one detail that makes a point of light read as a star
        // rather than as a dot. Kept for the anchors and the few brightest things she is
        // certain of, because on every star they would be a texture instead of an accent.
        //
        // **They were nine core-radii long, hairline-hard and at a flat opacity, and the
        // first render came back looking like a screen full of gun sights.** A real spike
        // is bright at the star and gone by its tip. Two gradient strokes buy exactly that
        // and cost the same as the two flat ones did.
        // Spikes are rare by design, and the one he touched earns a pair whether or not it
        // was born with them. It is the difference between a bright dot and a star, spent
        // on the single thing he asked about.
        if star.hasSpikes || emphasis.selection == .star(star.id) {
            drawSpikes(at: centre, core: core, colour: glow, alpha: alpha, in: &context)
        }

        // The core. White-hot at night whatever the star's colour, because that is what a
        // bright point of light does to an eye and to a sensor: the colour lives in the
        // glow around it. In daylight there is nothing to add to, so the core is the
        // pigment and the glow is its wash.
        context.fill(
            Path(ellipseIn: CGRect(
                x: centre.x - core, y: centre.y - core, width: core * 2, height: core * 2)),
            with: .color(coreColour(star.tint).opacity(min(1, alpha * (additive ? 0.95 : 0.88))))
        )
    }

    /// Four rays out of a star, each fading to nothing well before its tip.
    ///
    /// The gradient runs across the whole span rather than along the stroke — which is what
    /// a `GraphicsContext` shading actually is — so each spike is drawn as its own stroke
    /// with a three-stop symmetric ramp. Bright where the star is, clear at both ends.
    private func drawSpikes(
        at centre: CGPoint,
        core: Double,
        colour: Color,
        alpha: Double,
        in context: inout GraphicsContext
    ) {
        let reach = core * 4.2
        let peak = colour.opacity(alpha * (additive ? 0.42 : 0.26))
        let stops = Gradient(stops: [
            .init(color: colour.opacity(0), location: 0.0),
            .init(color: peak, location: 0.5),
            .init(color: colour.opacity(0), location: 1.0),
        ])
        let width = max(0.5, core * 0.16)

        var horizontal = Path()
        horizontal.move(to: CGPoint(x: centre.x - reach, y: centre.y))
        horizontal.addLine(to: CGPoint(x: centre.x + reach, y: centre.y))
        context.stroke(
            horizontal,
            with: .linearGradient(
                stops,
                startPoint: CGPoint(x: centre.x - reach, y: centre.y),
                endPoint: CGPoint(x: centre.x + reach, y: centre.y)),
            style: StrokeStyle(lineWidth: width, lineCap: .round)
        )

        var vertical = Path()
        vertical.move(to: CGPoint(x: centre.x, y: centre.y - reach))
        vertical.addLine(to: CGPoint(x: centre.x, y: centre.y + reach))
        context.stroke(
            vertical,
            with: .linearGradient(
                stops,
                startPoint: CGPoint(x: centre.x, y: centre.y - reach),
                endPoint: CGPoint(x: centre.x, y: centre.y + reach)),
            style: StrokeStyle(lineWidth: width, lineCap: .round)
        )
    }

    // MARK: - Filaments

    /// A thread between two things she connected.
    ///
    /// **`observed` has a hot core and `inferred` is only its own halo.** That is the whole
    /// distinction, and it is deliberately not a dash pattern or a second colour: a dashed
    /// line reads as user interface, and a second hue would need a key. Something she was
    /// told is a filament with light in it; something she worked out is a suggestion of one.
    private func drawFilament(
        _ filament: PreparedFilament,
        in context: inout GraphicsContext,
        at t: TimeInterval,
        moving: Bool
    ) {
        let alpha = max(
            min(1, filament.alpha * emphasis.weight(forFilament: filament.id, additive: additive)),
            emphasis.floor(forFilament: filament.id))
        guard alpha > PreparedSky.faintestDrawn else { return }

        let from = point(
            anchor: filament.from, seed: filament.fromSeed, depth: filament.fromDepth,
            at: t, moving: moving)
        let to = point(
            anchor: filament.to, seed: filament.toSeed, depth: filament.toDepth,
            at: t, moving: moving)

        // The bow. A straight line between two stars is a diagram; a curve is something
        // hanging between them.
        let dx = to.x - from.x
        let dy = to.y - from.y
        let midpoint = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)
        let control = CGPoint(
            x: midpoint.x - dy * CGFloat(filament.bow),
            y: midpoint.y + dx * CGFloat(filament.bow)
        )

        var path = Path()
        path.move(to: from)
        path.addQuadCurve(to: to, control: control)

        // The feather, mined from ``SylRibbon``: concentric strokes of one path at widening
        // widths and falling opacity, blended additively. A real blur is a full-surface
        // convolution every frame; this is three stroke operations.
        let colour = filamentColour(filament.species)
        for (widthScale, alphaScale) in Self.featherPasses {
            context.stroke(
                path,
                with: .color(colour.opacity(min(1, alpha * alphaScale))),
                style: StrokeStyle(
                    lineWidth: filament.width * widthScale, lineCap: .round, lineJoin: .round)
            )
        }

        // The core pass, and only for what he actually said. This is the line that makes an
        // observed edge look like it has light *in* it.
        //
        // A **selected** filament gets one too, whichever species it is. That is not the
        // observed/inferred distinction leaking: the distinction lives in the weight and in
        // the gossamer, and both survive here. A thread he has picked out and asked about
        // has to be the brightest line on the screen, and an inferred one drawn only as its
        // own halo cannot be, however much it is multiplied.
        if filament.species == .observed || emphasis.selection == .filament(filament.id) {
            context.stroke(
                path,
                with: .color(
                    coreColour(.cool).opacity(min(1, alpha * (additive ? 0.55 : 0.40)))),
                style: StrokeStyle(lineWidth: filament.width * 0.5, lineCap: .round)
            )
        }
    }

    /// Widths and opacities of the feather passes, outermost first.
    private static let featherPasses: [(CGFloat, Double)] = [
        (5.0, 0.055),
        (2.9, 0.115),
        (1.0, 0.62),
    ]

    // MARK: - Colour

    private func haloColour(_ tint: StarTint) -> Color {
        switch tint {
        case .cool: return SylTheme.Colour.luminance
        case .warm: return SylTheme.Colour.warmth
        case .dim: return SylTheme.Colour.greyBlue
        }
    }

    private func coreColour(_ tint: StarTint) -> Color {
        additive ? SylTheme.Colour.luminanceCore : haloColour(tint)
    }

    private func filamentColour(_ species: ConstellationSpecies) -> Color {
        species == .observed ? SylTheme.Colour.luminance : SylTheme.Colour.greyBlue
    }
}

/// What clock a sky is drawn on.
///
/// `ImageRenderer` has no run loop to drive a `TimelineView` with, and
/// `accessibilityReduceMotion` is a read-only environment value — so an offscreen render
/// can neither catch a chosen frame of the hover nor ask for the Reduce Motion still. Both
/// are the two things most worth looking at on this screen, so both are states the view
/// can be asked for by name.
///
/// It is deliberately not a `Bool` pair: `pinned` is not "frozen at zero". The pinned sky
/// puts every star on its anchor, which is a *different picture* from any frame of the
/// motion, and the whole of `syl-ryp.3` turns on that difference.
enum ConstellationTime: Equatable, Sendable {
    /// Driven by a `TimelineView` at 24fps. What the app uses.
    case live
    /// One chosen instant of the hover. For renders.
    case frozen(TimeInterval)
    /// Every star on its anchor — exactly what Reduce Motion draws.
    case pinned
}

// MARK: - Previews

#Preview("Night") {
    ZStack {
        SylTheme.Veil()
        Constellation(sky: SkyPreparer(now: ConstellationFixture.now)
            .prepare(.fixture, size: CGSize(width: 393, height: 852)))
    }
    .environment(\.colorScheme, .dark)
}

#Preview("Day") {
    ZStack {
        SylTheme.Veil()
        Constellation(sky: SkyPreparer(now: ConstellationFixture.now)
            .prepare(.fixture, size: CGSize(width: 393, height: 852)))
    }
    .environment(\.colorScheme, .light)
}
