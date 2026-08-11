import CoreGraphics
import Foundation
import SylKit

/// The ellipse a phrase is orbited by, and the space it claims — as pure numbers.
///
/// ## Why this is a value type and not arithmetic inside the `Canvas`
///
/// The same split as ``RibbonAppearance`` and for the same reason: a `Canvas` is
/// effectively untestable, so everything that could be *wrong* is lifted out of it. What
/// is left in the draw call is arithmetic that cannot be wrong in an interesting way.
///
/// Here the thing that can be wrong is containment, and it is not obvious:
///
/// ## An ellipse around a rectangle is not the rectangle inflated by a margin
///
/// The implementation that suggests itself — `semiMajor = halfWidth + margin`,
/// `semiMinor = halfHeight + margin` — leaves the rectangle's **corners outside**, because
/// an ellipse pulls in between its axes. On one short line it survives by luck, since the
/// margin is large next to a single line's height. At an accessibility size, where the
/// phrase wraps to three lines and is nearly as tall as it is wide, it fails by a wide
/// margin and slices through the words.
///
/// So the ellipse is solved for instead. For a target aspect `k = a/b`, containing the
/// point `(hw, hh)` needs `(hw/a)² + (hh/b)² ≤ 1`, and substituting `b = a/k` gives
/// `a = √(hw² + k²hh²)` exactly touching the corner. Every other number here is that one
/// line plus a clamp.
///
/// ## Why an ellipse rather than a circle
///
/// A single line of text is far wider than it is tall, and a circle drawn round it is
/// mostly empty sky above and below the words — the ring stops reading as *around the
/// message* and starts reading as a decoration the message happens to sit inside. The
/// aspect is taken from the phrase's own proportions, so a wrapped phrase pulls the ring
/// toward round on its own. That is the behaviour, not a special case: a taller block of
/// text asks for a rounder halo, and this arrives at one without being told.
struct HaloGeometry: Equatable {
    /// Horizontal semi-axis, in points.
    var semiMajor: CGFloat
    /// Vertical semi-axis, in points.
    var semiMinor: CGFloat
    /// The clear space actually kept around the words — the margin that was asked for, or
    /// as much of it as there was room for. See ``clearance(within:of:)``.
    var clearance: CGFloat = 0

    /// Whether this ring, and the room its glow needs, fit the width it was given.
    ///
    /// ## Why false is a real answer and not a failure
    ///
    /// At the largest Dynamic Type sizes the phrase is most of the screen in both
    /// directions, and there is simply no ellipse left that holds it: on a 393-point
    /// screen at `accessibility5` the words need a circle 159 points in radius and there
    /// are 156 to be had — with the margin already surrendered in full.
    ///
    /// So the halo stands down, and that is the *correct* behaviour rather than a
    /// concession. The ring exists to serve the phrase, and the last thing a reader who
    /// asked for the largest possible type needs is a decoration cropped by the edge of
    /// their screen drawn through the words they enlarged. The phrase stays, at its full
    /// width, exactly as it read before this component existed.
    ///
    /// **The clearance counts toward fitting, and that is deliberate.** A ring technically
    /// inside the screen but a point and a half off the letters is not a halo that fitted;
    /// it is a halo resting on the words, which is the one thing the geometry exists to
    /// prevent. Both failures land here, and both stand it down.
    var fits: Bool = true

    /// The widest the ring is allowed to get relative to its height.
    ///
    /// Without a ceiling, a one-line phrase — twelve times wider than it is tall — gives
    /// an ellipse so flat it reads as a slit rather than as an orbit. 2.6 is the point at
    /// which it still says *ring seen at an angle* and no longer says *underline*.
    static let maxAspect: CGFloat = 2.6

    /// Clearance between the ring's widest point and the edge of the screen.
    ///
    /// `glowAllowance` is the floor — below it the outermost feather is cut off square by
    /// the edge — and it is not enough on its own. A ring that reaches both edges is not a
    /// halo, it is a **frame**: at the largest type the first version spanned 365 points of
    /// a 393-point screen and read as a border drawn round the app. `chapter` is the same
    /// interval the nameplate already breathes by, so the ring sits inside the screen's own
    /// rhythm rather than against its edges.
    private static var edgeInset: CGFloat { max(glowAllowance, SylTheme.Metric.chapter) }

    /// Below this much clear space the ring is touching the words, and a ring touching the
    /// words is worse than no ring — so it stands down instead. See ``fits``.
    private static var minimumClearance: CGFloat { SylTheme.Metric.snug }

    /// The margin at the default type size: the clear space the ring keeps around the
    /// words, before Dynamic Type scales it.
    static let baseMargin: CGFloat = 15

    /// Room reserved outside the ring for its own glow to spill into.
    ///
    /// The feather is five concentric strokes, the widest at six times the core width, so
    /// a ring drawn exactly on the edge of its box loses the outer half of its halo to the
    /// clip — and a glow with a straight edge on it stops being a glow. Reserved in the
    /// *layout* rather than taken out of the radii, because taking it out of the radii
    /// would shrink the ellipse below the size containment was solved for and put the ring
    /// back through the words.
    ///
    /// A constant rather than a function of the current state's width: the widths differ
    /// per state, and a layout that resized as she changed state would make the nameplate
    /// twitch every time she started thinking. Sized against the widest state there is —
    /// there is a test that says so.
    static let glowAllowance: CGFloat = 14

    /// The ring around a phrase, given the phrase **line by line**.
    ///
    /// ## Why the lines and not the block
    ///
    /// This started out taking the phrase's bounding box, and the first accessibility-size
    /// render is what killed that. At the largest Dynamic Type the phrase wraps to three
    /// lines and its box is nearly square — and *the smallest ellipse containing a square
    /// is √2 larger than the square in both directions.* At 393 points wide there is no
    /// such ellipse to be had: the ring came back 437 points tall, ran off the top of the
    /// nameplate and crossed her face.
    ///
    /// But the phrase is not a square. It is three centred lines, and the corners of that
    /// box are **empty** — the last line of *"Thinking about your week."* is the word
    /// `week.`, half the width of the line above it, and the ellipse can pass straight
    /// through where its corners would have been without touching a letter. Containing
    /// what is actually drawn instead of the box around it takes that same case from
    /// 365×437 to something that fits on the screen with room to spare.
    ///
    /// The lesson generalises past this component: **a bounding box is a claim about
    /// where the ink might be, and for centred prose it is a very loose one.**
    ///
    /// - Parameters:
    ///   - lines: each laid-out line's size, top to bottom. Measured, never assumed.
    ///   - margin: clear space kept between the words and the ring, on every side.
    ///   - availableWidth: the width the ring should not exceed.
    static func around(lines: [CGSize], margin: CGFloat, availableWidth: CGFloat) -> HaloGeometry {
        let cap = max(availableWidth / 2 - edgeInset, 1)
        let ink = corners(of: lines, clearance: 0)

        // How much clear space there is actually room for. See ``clearance(within:of:)``:
        // asked for more than fits, the halo gives back exactly as much as it must and no
        // more, rather than keeping the gap it was asked for and running off the screen.
        let clearance = min(max(margin, 0), self.clearance(within: cap, of: ink))
        let corners = self.corners(of: lines, clearance: clearance)

        guard let widest = corners.map(\.x).max(), let tallest = corners.map(\.y).max() else {
            return HaloGeometry(semiMajor: 1, semiMinor: 1, clearance: clearance, fits: true)
        }

        // What the phrase's own proportions ask for: one line wants an ellipse, a wrapped
        // phrase moves toward round. Taken from the block, because this is a question
        // about the shape of the *message*, not about which corner sticks out furthest.
        // Never below 1: a ring taller than it is wide around a line of prose reads as an
        // egg on its end. The ceiling is applied once, below, with the other limit.
        let wanted = max(widest / tallest, 1)

        // The flattest ellipse that still fits the width. `a(k)` rises with `k`, so each
        // corner permits everything up to its own limit and the tightest one decides.
        // Closed form rather than a search: `a(k) = cap` solves for `k` directly.
        let limits = corners.compactMap { corner -> CGFloat? in
            guard corner.y > 0 else { return nil }
            guard corner.x < cap else { return 0 }
            return sqrt((cap * cap - corner.x * corner.x) / (corner.y * corner.y))
        }

        // A limit below 1 means no ellipse of any shape holds the words even with the
        // clearance surrendered in full. The ring is still solved — at its roundest, which
        // is the smallest it can be — and reported as not fitting, so the caller can stand
        // it down. **Containment is never traded away to make something fit**: a ring
        // running off the screen is a flaw, but a ring drawn *through* the sentence it
        // exists to serve is a defect, and a caller shown the second one has no way to
        // tell it apart from a bug.
        let aspect = min(max(min(wanted, limits.min() ?? maxAspect), 1), maxAspect)

        let semiMajor = corners
            .map { sqrt($0.x * $0.x + aspect * aspect * $0.y * $0.y) }
            .max() ?? 1

        return HaloGeometry(
            semiMajor: max(semiMajor, 1),
            semiMinor: max(semiMajor / aspect, 1),
            clearance: clearance,
            fits: semiMajor <= cap + 0.001 && clearance >= Self.minimumClearance
        )
    }

    /// The most clear space that can be kept around these words and still fit the screen.
    ///
    /// ## Why the margin has to be the thing that gives
    ///
    /// The roundest ring available is a circle of radius `cap`, so a phrase fits *at all*
    /// only while every line's far corner is inside that circle. At the largest Dynamic
    /// Type sizes the phrase is most of the screen wide already, and a margin scaled up to
    /// match the type pushes those corners outside it — at which point there is no ellipse
    /// of any shape that holds the words, and the ring runs off the edge.
    ///
    /// So the requested margin is a *wish*, and this is the room there is for it. Solving
    /// `(w/2 + m)² + (y + m)² = cap²` for `m` gives it in closed form, per line, and the
    /// tightest line decides — the same shape of answer as the aspect solve above.
    ///
    /// The result: the halo is as generous as the Commander's type size asks for, right up
    /// to the point where generosity would put the ring off the screen, and then it gives
    /// back exactly as much as it must. **Nothing is stated; the concession is computed
    /// from the phrase in front of it.**
    private static func clearance(within cap: CGFloat, of ink: [CGPoint]) -> CGFloat {
        ink.reduce(into: CGFloat.greatestFiniteMagnitude) { room, corner in
            let width = corner.x * 2
            let linear = width + 2 * corner.y
            let excess = corner.x * corner.x + corner.y * corner.y - cap * cap

            // Already outside the circle with no margin at all: there is no room to give.
            guard excess < 0 else {
                room = 0
                return
            }

            let root = (-linear + sqrt(linear * linear - 8 * excess)) / 4
            room = min(room, max(root, 0))
        }
    }

    /// The ring around a phrase treated as one solid block.
    ///
    /// The conservative reading of the same question — every corner of the box is held,
    /// whether or not there is a letter in it. Kept because a caller that has only a size
    /// is entitled to an answer, and because it is the right answer for a single line,
    /// where the box and the ink are the same thing.
    static func around(phrase: CGSize, margin: CGFloat, availableWidth: CGFloat) -> HaloGeometry {
        around(lines: [phrase], margin: margin, availableWidth: availableWidth)
    }

    /// One corner per line: the far corner, as an offset from the centre of the block.
    ///
    /// Floored above zero. A phrase that has not been measured yet is nothing at all for
    /// exactly one layout pass, and a zero here divides the aspect by nothing and hands
    /// the renderer a NaN — which draws as *nothing*, and looks precisely like the feature
    /// not working.
    private static func corners(of lines: [CGSize], clearance: CGFloat) -> [CGPoint] {
        let heights = lines.map { max($0.height, 0) }
        let total = heights.reduce(0, +)
        guard !lines.isEmpty, total > 0 else {
            return [CGPoint(x: max(clearance, 1), y: max(clearance, 1))]
        }

        var top = -total / 2
        return lines.indices.map { index in
            let bottom = top + heights[index]
            defer { top = bottom }

            return CGPoint(
                x: max(max(lines[index].width, 0) / 2 + clearance, 1),
                // The corner that is further from the centre line decides; for the middle
                // line of three that is whichever edge it straddles less evenly.
                y: max(max(abs(top), abs(bottom)) + clearance, 1)
            )
        }
    }

    /// How wide the phrase may be laid out, given the width of the screen it is on.
    ///
    /// **This is what makes the width cap above a policy rather than a rescue.** The ring
    /// needs room beside the words; the only place that room can come from is the words'
    /// own measure, so it is taken here, once, deliberately — rather than discovered at
    /// draw time when there is nothing left to do about it.
    ///
    /// A fraction rather than a constant: `chapter` on each side is right on a 393-point
    /// phone and leaves a 430-point one looking under-set, and the narrow phone needs the
    /// floor or the phrase wraps for no reason.
    static func textMeasure(in width: CGFloat) -> CGFloat {
        max(width - 2 * max(SylTheme.Metric.chapter, width * 0.16), 1)
    }

    /// The margin actually used, given what Dynamic Type made of ``baseMargin``.
    ///
    /// Scaled, then capped. Scaling is right — a 15-point gap around 42-point type reads
    /// as a collision — and past about half as much again the extra distance stops being
    /// breathing room and starts being a ring in a different postcode from its words.
    ///
    /// This is a question of *taste*, and it is the only one of the three limits on the
    /// margin that is. Whether there is room for the gap at all is answered by
    /// ``clearance(within:of:)``, from the phrase and the screen, and it overrides this.
    static func margin(scaled: CGFloat) -> CGFloat {
        min(scaled, baseMargin * 1.6)
    }

    /// Whether a point, taken from the ring's centre, lies inside it.
    func contains(_ point: CGPoint) -> Bool {
        guard semiMajor > 0, semiMinor > 0 else { return false }
        let x = point.x / semiMajor
        let y = point.y / semiMinor
        return x * x + y * y <= 1 + 1e-6
    }

    /// Whether a rectangle centred on the ring lies entirely inside it.
    ///
    /// Only the corner is checked, because only the corner can fail: on a centred
    /// axis-aligned rectangle every other point is nearer the centre than the corner is,
    /// in the norm this ellipse measures by.
    func encloses(halfWidth: CGFloat, halfHeight: CGFloat) -> Bool {
        contains(CGPoint(x: abs(halfWidth), y: abs(halfHeight)))
    }

    var aspect: CGFloat { semiMinor > 0 ? semiMajor / semiMinor : 0 }

    var size: CGSize { CGSize(width: semiMajor * 2, height: semiMinor * 2) }

    /// The whole component's footprint: the ring, and the room its glow spills into.
    ///
    /// **This is what makes "nothing overlaps" structural.** The Commander's constraint is
    /// that the ring may not touch the title above it or the orbs below it; the halo
    /// therefore occupies a real layout box exactly this size, and the stack it lives in
    /// cannot place anything inside it. The alternative — a ring drawn outside the layout,
    /// kept clear by everybody remembering to keep it clear — is a guarantee with a shelf
    /// life, and this project has a section about those.
    ///
    /// It is also what the `Canvas` is handed, which is why the renderer states no radii
    /// of its own: it takes them back out of the box it was given.
    var footprint: CGSize {
        CGSize(
            width: size.width + Self.glowAllowance * 2,
            height: size.height + Self.glowAllowance * 2
        )
    }
}

/// The travelling light, as pure numbers — derived from the ribbon's own state table.
///
/// ## Why it is derived rather than tuned again
///
/// ``RibbonAppearance/forState(_:)`` already answers "what is she like when she is
/// thinking", and it answers it in scalars that were tuned against proposal F's prose.
/// Restating that here as a second table would be two things that must agree, kept in
/// step by whoever remembers both — the failure mode this project has a section about.
/// So the halo reads the ribbon's numbers and maps them onto a circle, and a change to
/// how `thinking` feels moves both surfaces at once.
///
/// That is also the honest answer to "is it the same creature": it is not a resemblance,
/// it is the same state table with a different geometry over it.
struct HaloLight: Equatable {
    /// How much of the ring the bright arc covers, as a fraction of the whole.
    ///
    /// **Never 1, in any state.** A full uniform ring travelling at a constant rate is a
    /// progress spinner, and this must never be mistaken for one.
    var arcSpan: Double
    /// Laps per second of the leading edge.
    var turnsPerSecond: Double
    /// Overall opacity multiplier.
    var brightness: Double
    /// Core stroke width in points.
    var width: Double
    /// 0 is her cool light, 1 the warm note. Straight from the ribbon.
    var warmth: Double
    /// 0 is full colour, 1 fully toward grey-blue. Straight from the ribbon.
    var desaturation: Double
    /// How many sparks the orbit sheds.
    var sparks: Double

    /// The second arc, as a fraction of the first.
    ///
    /// ## This is the anti-spinner
    ///
    /// One arc of fixed length at a fixed rate is a loading indicator no matter how
    /// beautifully it is drawn. Two arcs of different lengths at *incommensurate* rates
    /// never return to the same relative phase, so the figure never repeats — light
    /// circulating, rather than a mechanism turning. 0.61 rather than 0.6 on purpose: a
    /// tidy ratio closes the loop in a handful of laps and the eye finds it.
    static let companionRate: Double = 0.61
    static let companionSpan: Double = 0.52
    static let companionBrightness: Double = 0.40

    /// Where the arc is frozen under Reduce Motion, in radians.
    ///
    /// Upper-left, which is where a light source belongs in almost every painted
    /// tradition — the still frame has to read as this object *at rest*, not as this
    /// object stopped. A head parked at the extreme right of the ellipse reads as an
    /// animation that halted mid-sweep.
    static let restingAngle: Double = -2.3

    /// The light in a given state, at a given intensity.
    static func forState(_ state: PresenceState, intensity: Double) -> HaloLight {
        from(RibbonAppearance.forState(state), intensity: intensity)
    }

    /// The mapping from ribbon scalars onto a closed path.
    ///
    /// `waves` is "how many full waves span the canvas" — tight and busy at the top of
    /// the range, long and slow at the bottom. On a circle the same quantity is arc
    /// length, inverted: `thinking` gets a short quick dash, `manifest` gets a long slow
    /// sweep that nearly closes. Nothing new is invented; the axis is reinterpreted.
    static func from(_ appearance: RibbonAppearance, intensity: Double) -> HaloLight {
        let level = min(max(intensity, 0), 1)

        return HaloLight(
            // Bounded well below a whole lap at both ends. The ceiling is the invariant
            // that keeps this off the loading-dialog side of the line, and it started at
            // 0.62 — which the `manifest` render settled: an arc past about half the ring
            // reads as *most of a circle with a gap in it*, and a circle with a gap in it
            // is a spinner whatever colour it is and however slowly it turns.
            arcSpan: min(max(0.55 / max(appearance.waves, 0.2), 0.10), 0.46)
                * (0.68 + 0.32 * level),
            // 0.42 turns the ribbon's phase rate into something a lap can be read at:
            // `thinking` lands near two and a half seconds a lap, which is quick enough
            // to look like thought and slow enough that the eye can follow one arc round.
            turnsPerSecond: appearance.speed * 0.42 * (0.72 + 0.48 * level),
            brightness: appearance.brightness * (0.58 + 0.42 * level),
            // Capped before it is scaled. The ribbon can afford a wide mark because it has
            // a *body* — a filled shape with real width, lit along its length. A ring has
            // only a stroke, and `manifest`'s 4.5 points of it came back as a band rather
            // than a filament: thick, closed, and mechanical.
            width: min(appearance.width, 3.2) * 0.9,
            warmth: appearance.warmth,
            desaturation: appearance.desaturation,
            sparks: appearance.sparks
        )
    }
}
