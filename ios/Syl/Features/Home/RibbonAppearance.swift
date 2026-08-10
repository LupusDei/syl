import Foundation
import SylKit

/// How the ribbon looks in a given presence state — as pure numbers.
///
/// ## Why this is a struct of scalars and not a switch inside the renderer
///
/// Two reasons, and the second is the one that matters.
///
/// The first is that a state change has to be *interpolated*. Syl snapping from `idle`
/// to `thinking` between one frame and the next reads as a glitch, not as a thought;
/// what sells her as alive is that she takes a moment to become the next thing. You
/// cannot interpolate a `switch`. You can interpolate a bag of `Double`s.
///
/// The second is testability. The renderer is a `Canvas` and is therefore effectively
/// untestable, so everything that could be wrong is pulled out of it and put here,
/// where ``lerp(_:_:_:)`` and ``forState(_:)`` are ordinary pure functions with
/// ordinary unit tests. What is left in the `Canvas` is arithmetic that cannot be
/// wrong in an interesting way.
///
/// ## Colour is two scalars, not a `Color`
///
/// `warmth` and `desaturation` rather than a stored colour, because the palette is
/// appearance-reactive: a `Color` captured here would have to resolve light-or-dark at
/// the moment it was stored, and would then be wrong the instant the appearance
/// changed. Scalars interpolate cleanly and let the renderer mix live theme colours at
/// draw time, which stays correct in both appearances for free.
struct RibbonAppearance: Equatable, Sendable {
    /// Peak swing, as a fraction of the canvas height.
    var amplitude: Double
    /// How many full waves span the canvas. Higher is tighter.
    var waves: Double
    /// Phase advance per second. Higher is faster.
    var speed: Double
    /// Curls the ribbon inward along its length, tightening toward one end.
    var coil: Double
    /// Blends toward a straight line. At 1 she stops meandering entirely.
    var straightness: Double
    /// High-frequency deviation riding on the main curve — a lost smooth line.
    var turbulence: Double
    /// How many sparks she sheds, 0 for none.
    var sparks: Double
    /// Vertical offset as a fraction of height. Negative rises, positive droops.
    var rise: Double
    /// Overall opacity multiplier.
    var brightness: Double
    /// Core stroke width in points.
    var width: Double
    /// 0 is her cool light, 1 is the warm note reserved for `alert` and `delighted`.
    var warmth: Double
    /// 0 is full colour, 1 is fully toward grey-blue. Only `concerned` moves this.
    var desaturation: Double

    /// Every scalar at rest. Used as the base that each state modifies, so a new state
    /// only has to state what is *different* about it.
    static let neutral = RibbonAppearance(
        amplitude: 0.10, waves: 1.2, speed: 0.10, coil: 0, straightness: 0,
        turbulence: 0, sparks: 0, rise: 0, brightness: 0.5, width: 2.0,
        warmth: 0, desaturation: 0
    )

    /// The nine states, as described in proposal F.
    ///
    /// The values are tuned to the prose there rather than invented: `idle` is a "long
    /// lazy drift, wide low-amplitude curve" breathing at roughly 0.1 Hz; `thinking` is
    /// a "tight fast orbit" that "loses the smooth curve, sheds sparks"; `alert` goes
    /// "straight and sharp, stops meandering entirely"; `concerned` "droops, slows,
    /// sits low".
    static func forState(_ state: PresenceState) -> RibbonAppearance {
        var a = neutral

        switch state {
        case .absent:
            // Never rendered — the view returns early. Zeroed anyway so that a caller
            // who ignores that still draws nothing rather than something faint.
            a.brightness = 0
            a.amplitude = 0
            a.sparks = 0

        case .idle:
            // 0.1 Hz is the brief, and it is slow enough to be genuinely ignorable.
            // "It must be possible to read the whole screen without noticing her."
            a.amplitude = 0.16
            a.waves = 1.0
            a.speed = 0.10
            a.brightness = 0.34
            a.width = 1.8

        case .listening:
            // Coils inward toward the microphone, tail trailing. Brightens, stays cool.
            a.amplitude = 0.20
            a.waves = 1.5
            a.speed = 0.34
            a.coil = 0.75
            a.brightness = 0.62
            a.width = 2.2

        case .thinking:
            a.amplitude = 0.24
            a.waves = 2.6
            a.speed = 0.95
            a.turbulence = 0.42
            a.sparks = 0.55
            a.brightness = 0.70
            a.width = 2.0

        case .speaking:
            // Unfurls and undulates. The pulse itself is not here — it comes from the
            // live audio level, which the renderer applies on top. See `SylRibbon`.
            a.amplitude = 0.28
            a.waves = 1.7
            a.speed = 0.55
            a.brightness = 0.78
            a.width = 2.6

        case .alert:
            a.amplitude = 0.06
            a.waves = 0.8
            a.speed = 0.18
            a.straightness = 0.86
            a.brightness = 1.0
            a.width = 3.0
            a.warmth = 0.85

        case .delighted:
            a.amplitude = 0.32
            a.waves = 2.2
            a.speed = 1.25
            a.sparks = 1.0
            a.rise = -0.10
            a.brightness = 0.92
            a.width = 2.4
            a.warmth = 0.55

        case .concerned:
            a.amplitude = 0.10
            a.waves = 0.85
            a.speed = 0.05
            a.rise = 0.11
            a.brightness = 0.40
            a.width = 1.9
            a.desaturation = 0.80

        case .manifest:
            // Until the pre-rendered set pieces exist, manifestation is a bloom: she
            // gathers, brightens and slows. Deliberately not an attempt at a figure —
            // a bad figure is worse than an honest glow, and proposal F budgets the
            // real thing as pre-rendered art rather than something to fake at runtime.
            a.amplitude = 0.13
            a.waves = 0.6
            a.speed = 0.16
            a.brightness = 1.0
            a.width = 4.5
        }

        return a
    }

    /// Straight-line blend. `t` is clamped, so callers cannot overshoot into nonsense.
    static func lerp(_ from: RibbonAppearance, _ to: RibbonAppearance, _ t: Double) -> RibbonAppearance {
        let k = min(max(t, 0), 1)
        func mix(_ a: Double, _ b: Double) -> Double { a + (b - a) * k }

        return RibbonAppearance(
            amplitude: mix(from.amplitude, to.amplitude),
            waves: mix(from.waves, to.waves),
            speed: mix(from.speed, to.speed),
            coil: mix(from.coil, to.coil),
            straightness: mix(from.straightness, to.straightness),
            turbulence: mix(from.turbulence, to.turbulence),
            sparks: mix(from.sparks, to.sparks),
            rise: mix(from.rise, to.rise),
            brightness: mix(from.brightness, to.brightness),
            width: mix(from.width, to.width),
            warmth: mix(from.warmth, to.warmth),
            desaturation: mix(from.desaturation, to.desaturation)
        )
    }

    /// Ease-in-out applied to transition progress.
    ///
    /// A linear blend between two states looks mechanical — she arrives at the new
    /// state at full speed and stops dead. Smoothstep starts and ends at rest, which is
    /// what makes the change read as her *becoming* something rather than being swapped.
    static func ease(_ t: Double) -> Double {
        let k = min(max(t, 0), 1)
        return k * k * (3 - 2 * k)
    }

    /// How long a state change takes.
    ///
    /// Not uniform, because the states do not mean the same kind of thing. `alert` has
    /// to arrive immediately or it is not an alert. Settling *back* to `idle` is slow
    /// on purpose: a fast decay reads as her being switched off, and the whole point of
    /// the decay ladder is that she fades rather than vanishes.
    static func transitionDuration(to state: PresenceState) -> TimeInterval {
        switch state {
        case .alert: return 0.22
        case .delighted: return 0.35
        case .thinking, .listening, .speaking: return 0.45
        case .manifest: return 0.90
        case .idle, .concerned, .absent: return 1.10
        }
    }
}
