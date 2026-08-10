import SwiftUI

/// Slow drifting motes of light.
///
/// The thing that separates "a nice gradient" from "somewhere that exists" is almost
/// always particulate: dust in a sunbeam, plankton in water, snow in a streetlight. The
/// eye reads suspended particles as depth and as *air*, and it does it pre-attentively —
/// nobody looks at this and thinks "ah, motes", they just stop reading the screen as
/// flat.
///
/// ## Kept honest
///
/// This is the single easiest thing in the whole design to overdo, and an overdone
/// version is glitter. Three rules hold it back:
///
/// - **Few.** Forty at most, and they are almost transparent.
/// - **Slow.** A mote crosses the screen in about a minute. Nothing here twinkles.
/// - **Behind everything.** The field never sits over text. It is atmosphere, not
///   decoration, and the moment it competes with content it has failed.
///
/// Reduce Motion removes it entirely rather than freezing it. A frozen speckle field is
/// just noise over the veil — the motion was the entire point, so with the motion gone
/// there is nothing worth keeping.
struct MoteField: View {
    /// How many motes. Scaled down by the caller when Syl is small.
    var count: Int = 34

    /// Overall opacity, so the field can recede when the day is busy.
    var presence: Double = 1

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion || presence < 0.02 {
            Color.clear
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 24.0)) { timeline in
                Canvas { context, size in
                    draw(in: &context, size: size, at: timeline.date.timeIntervalSinceReferenceDate)
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    private func draw(in context: inout GraphicsContext, size: CGSize, at t: TimeInterval) {
        context.blendMode = .plusLighter

        for index in 0..<count {
            let seedX = Scatter.hash(index &* 3)
            let seedY = Scatter.hash(index &* 3 &+ 1)
            let seedRate = Scatter.hash(index &* 3 &+ 2)

            // Each mote rises on its own clock and wraps. Periods differ per mote, so
            // the field never pulses as a group.
            let period = 45 + seedRate * 40
            let progress = ((t / period) + seedY).truncatingRemainder(dividingBy: 1)

            // A slow lateral sway, so they drift rather than track straight up.
            let sway = sin(t / (11 + seedRate * 7) * .pi * 2 + seedX * 6) * 14

            let point = CGPoint(
                x: size.width * seedX + sway,
                y: size.height * (1 - progress)
            )

            // Fade in and out at the ends of the run — a mote that pops into existence
            // at the bottom edge draws the eye straight to the bug.
            let fade = sin(.pi * progress)
            let radius = 0.8 + seedRate * 1.5

            let dot = Path(
                ellipseIn: CGRect(
                    x: point.x - radius, y: point.y - radius,
                    width: radius * 2, height: radius * 2
                )
            )

            context.fill(
                dot,
                with: .color(SylTheme.Colour.luminanceCore.opacity(fade * 0.30 * presence))
            )
        }
    }
}
