import CoreGraphics
import Foundation

/// The life in the sky. **A pure function of time, and bounded.**
///
/// The Commander's addition to the design, in his words: *"I know you want the placement
/// to be deterministic and I agree, but once everything is placed, make it lifelike — have
/// it hover and move around subtly."*
///
/// So the anchor is truth and this is life. The distinction is easy to lose and impossible
/// to see in a screenshot, which is why it is a **bound that is asserted** rather than a
/// property that is hoped for:
///
/// > **No value of `t` may carry a star further than ``bound(depth:)`` from its anchor,**
/// > and that bound is smaller than half the closest two stars ever get. A star drifts
/// > *around* its position; it can never travel *to* another one.
///
/// The bound is structural rather than clamped. Every term is a sine of a constant times
/// `t`, and the weights of the terms sum to one — so there is nothing here that can
/// integrate, accumulate or wander, at `t = 0` or at `t = 10⁹`. A clamp would hide an
/// accumulating term by pinning the star to the edge of its leash; this cannot have one.
///
/// ## Why nothing ever pulses together
///
/// The base periods are pairwise coprime seconds — 13, 17, 29, 37 — which is the app's
/// existing vocabulary, from the veil's three blooms and the mote field's rise. On top of
/// that each star stretches its own periods by a factor drawn from its seed, so no two
/// stars share a period at all and the field can never resynchronise into a loop the eye
/// starts waiting for.
enum ConstellationMotion {
    /// The largest drift, in points, before depth scales it down.
    ///
    /// Small deliberately. This is a hover, not a float: at arm's length it reads as the
    /// air moving rather than as anything travelling.
    ///
    /// The number is not the whole story and it is the *periods* that decide whether this
    /// reads as alive. Three points of travel spread over forty seconds is below the
    /// threshold at which anyone would notice it is happening at all; the same three points
    /// over about ten is a hover. So the amplitude stays small and the primary periods are
    /// the shortest thing in the app's motion vocabulary rather than the longest.
    static let driftAmplitude: Double = 3.0

    /// The absolute ceiling on how far any star may ever be from its anchor, in points.
    ///
    /// Stated as a number so it can be asserted against the layout's separation floor
    /// rather than eyeballed. Nothing in this file is allowed to exceed it.
    static let ceiling: Double = 4.3

    /// How much of the drift a star at this depth gets.
    ///
    /// Near stars move more than far ones. It is the cheapest thing that turns a flat
    /// field into a space — the same reason a car window shows the fence tearing past and
    /// the hills barely moving — and it costs one multiply.
    static func parallax(depth: Double) -> Double {
        0.45 + 0.55 * min(max(depth, 0), 1)
    }

    /// The furthest a star at this depth can ever be from its anchor, in points.
    ///
    /// Both axes are bounded by the per-axis amplitude, so the corner case is the diagonal.
    static func bound(depth: Double) -> Double {
        driftAmplitude * parallax(depth: depth) * 2.0.squareRoot()
    }

    /// Where a star is, relative to its anchor, at time `t`.
    ///
    /// `moving` is Reduce Motion, inverted: when it is false this returns exactly zero, so
    /// every star sits on its anchor and the sky becomes a photograph of itself rather
    /// than a degraded version of one.
    static func offset(seed: Int, depth: Double, at t: TimeInterval, moving: Bool = true) -> CGSize {
        guard moving else { return .zero }

        let amplitude = driftAmplitude * parallax(depth: depth)

        // Four independent phases and four period stretches, all from the node's own seed.
        let phaseX = Scatter.hash(seed &* 11 &+ 1) * 2 * .pi
        let phaseY = Scatter.hash(seed &* 11 &+ 2) * 2 * .pi
        let phaseRollX = Scatter.hash(seed &* 11 &+ 3) * 2 * .pi
        let phaseRollY = Scatter.hash(seed &* 11 &+ 4) * 2 * .pi

        let driftX = 13.0 + Scatter.hash(seed &* 11 &+ 5) * 11
        let driftY = 17.0 + Scatter.hash(seed &* 11 &+ 6) * 13
        let rollX = 29.0 + Scatter.hash(seed &* 11 &+ 7) * 15
        let rollY = 37.0 + Scatter.hash(seed &* 11 &+ 8) * 17

        // The weights sum to exactly one per axis. That is the bound, and it is the reason
        // there is no clamp anywhere in this function.
        let dx = amplitude * (0.62 * sin(2 * .pi * t / driftX + phaseX)
            + 0.38 * sin(2 * .pi * t / rollX + phaseRollX))
        let dy = amplitude * (0.62 * cos(2 * .pi * t / driftY + phaseY)
            + 0.38 * sin(2 * .pi * t / rollY + phaseRollY))

        return CGSize(width: dx, height: dy)
    }

    /// How much a star's breath is, as a multiplier on its brightness.
    ///
    /// Luminance, not position — the thing that makes a point of light read as *on fire*
    /// rather than printed. Small: a tenth either way, on a period nothing else uses.
    ///
    /// Off entirely under Reduce Motion, following ``MoteField`` rather than
    /// ``SylRibbon``: the ribbon keeps its breath because it is one object, and a whole
    /// field of independently pulsing points is exactly the busy-but-technically-still
    /// stimulus that setting exists to remove.
    static func breath(seed: Int, at t: TimeInterval, moving: Bool = true) -> Double {
        guard moving else { return 1 }
        let phase = Scatter.hash(seed &* 17 &+ 3) * 2 * .pi
        let period = 7.0 + Scatter.hash(seed &* 17 &+ 4) * 11
        return 1 + breathDepth * sin(2 * .pi * t / period + phase)
    }

    /// How far the breath swings either side of one.
    static let breathDepth = 0.10
}
