import CoreGraphics
import Foundation

/// What he touched.
enum ConstellationHit: Equatable, Hashable, Sendable {
    case star(String)
    case filament(String)

    var starId: String? {
        if case .star(let id) = self { return id }
        return nil
    }

    var filamentId: String? {
        if case .filament(let id) = self { return id }
        return nil
    }
}

/// Which star or filament a finger landed on. **Pure, and tested as such.**
///
/// ## Two rules, and both of them are corrections
///
/// **1. Against the anchor, never against where the star happens to be.**
///
/// A star hovers up to ``ConstellationMotion/ceiling`` points around its anchor, on periods
/// nothing else shares. Hit-testing against the drifting position means a tap lands or
/// misses depending on what time it is — intermittently, at a rate of a few percent, in a
/// way that is indistinguishable from the app ignoring him and impossible to reproduce on
/// purpose. The anchor is the truth; the motion is life on top of it, and life is not a
/// touch target. ``PreparedStar/anchor`` documents this from the other side.
///
/// The drift is not thrown away, though: it is added to the star's *reach*, so the star as
/// drawn is always inside its own target however far the hover has carried it.
///
/// **2. In view space, after the transform.**
///
/// A radius in sky space would shrink on screen as he zooms out, so the same star would get
/// harder to hit the further away it is — which is the opposite of what anyone wants and
/// exactly what a naive implementation does. ``fingerRadius`` is a **finger**, in points on
/// glass, at every scale. It only ever grows: when the star is drawn larger than a finger,
/// the drawn star is the target.
///
/// ## A star wins a tie
///
/// Stars are tested first and completely. If any star is within reach, no filament is
/// considered at all — when both are under his thumb he meant the star, because a star is
/// the thing he can see and a filament is the thing between them. Among stars, and among
/// filaments, the nearest wins; ties there are broken by id so the answer never depends on
/// what order the sky happened to be prepared in.
enum ConstellationHitTest {
    /// The radius of a fingertip, in view points. Apple's floor for a touch target is 44
    /// across, and this is its half.
    static let fingerRadius: Double = 22

    /// How near a filament counts as touched, in view points.
    ///
    /// Generous on purpose, and smaller than a star's: a line is one point wide and a
    /// one-point line is not a touch target, but a filament that grabbed as widely as a star
    /// would steal taps from the stars at its own ends.
    static let filamentReach: Double = 17

    /// What is under this point, or nothing.
    ///
    /// `point` is in view space — where his finger actually landed, on the glass.
    static func hit(
        at point: CGPoint,
        in sky: PreparedSky,
        transform: ConstellationTransform
    ) -> ConstellationHit? {
        if let star = nearestStar(to: point, in: sky, transform: transform) {
            return .star(star)
        }
        if let filament = nearestFilament(to: point, in: sky, transform: transform) {
            return .filament(filament)
        }
        return nil
    }

    // MARK: - Stars

    /// The nearest star within reach, by id.
    static func nearestStar(
        to point: CGPoint,
        in sky: PreparedSky,
        transform: ConstellationTransform
    ) -> String? {
        var best: (id: String, distance: Double)?

        for star in sky.stars {
            // Not drawn is not touchable. Nothing in the fixture or the wire reaches this —
            // the floor in `SkyFromMemory` sees to that — but a star at literally zero
            // brightness would otherwise be an invisible hole that swallows taps.
            guard star.alpha > PreparedSky.faintestDrawn else { continue }

            let centre = transform.apply(star.anchor)
            let distance = hypot(Double(point.x - centre.x), Double(point.y - centre.y))
            guard distance <= reach(of: star, scale: transform.scale) else { continue }

            if let current = best,
                (current.distance, current.id) <= (distance, star.id) { continue }
            best = (star.id, distance)
        }

        return best?.id
    }

    /// How far from a star's anchor still counts as touching it, in view points.
    ///
    /// A finger, or the star as actually drawn — whichever is larger. The drawn size is the
    /// core he can see plus the furthest its hover can ever carry it, both in view points,
    /// so at four times magnification the target grows with the star rather than being a
    /// fixed dot in the middle of something much bigger.
    static func reach(of star: PreparedStar, scale: Double) -> Double {
        let drawn = (star.coreRadius + ConstellationMotion.bound(depth: star.depth)) * scale
        return max(fingerRadius, drawn)
    }

    // MARK: - Filaments

    /// The nearest filament within reach, by id.
    static func nearestFilament(
        to point: CGPoint,
        in sky: PreparedSky,
        transform: ConstellationTransform
    ) -> String? {
        var best: (id: String, distance: Double)?

        for filament in sky.filaments {
            guard filament.alpha > PreparedSky.faintestDrawn else { continue }

            let distance = distance(from: point, to: filament, transform: transform)
            guard distance <= max(filamentReach, filament.width * transform.scale) else {
                continue
            }

            if let current = best,
                (current.distance, current.id) <= (distance, filament.id) { continue }
            best = (filament.id, distance)
        }

        return best?.id
    }

    /// How far a point is from a filament, in view space.
    ///
    /// **Two segments, not one, and the bow is why.** A filament is drawn as a quadratic
    /// curve because a straight line between two stars is a diagram and a curve is something
    /// hanging between them — and that bow carries the middle of a long thread up to eight
    /// percent of its own length away from the chord. On a four-hundred-point filament that
    /// is thirty points, so testing the chord would mean the middle of the thread he can see
    /// is not the thread he can touch.
    ///
    /// The curve's own midpoint is exactly halfway between the chord's midpoint and the
    /// control point, so `from → apex → to` follows the drawn line closely enough that the
    /// remaining error is far inside ``filamentReach``. It costs one more segment test.
    static func distance(
        from point: CGPoint,
        to filament: PreparedFilament,
        transform: ConstellationTransform
    ) -> Double {
        let from = transform.apply(filament.from)
        let to = transform.apply(filament.to)
        let apex = transform.apply(self.apex(of: filament))
        return min(
            distance(from: point, toSegment: from, to: apex),
            distance(from: point, toSegment: apex, to: to))
    }

    /// The midpoint of the drawn curve — where a filament looks like it is.
    static func apex(of filament: PreparedFilament) -> CGPoint {
        let dx = filament.to.x - filament.from.x
        let dy = filament.to.y - filament.from.y
        let midpoint = CGPoint(
            x: (filament.from.x + filament.to.x) / 2,
            y: (filament.from.y + filament.to.y) / 2)
        // The control point is `midpoint + (−dy, dx)·bow`, and a quadratic Bézier at t = ½
        // sits halfway between the chord's midpoint and its control point.
        return CGPoint(
            x: midpoint.x - dy * CGFloat(filament.bow) / 2,
            y: midpoint.y + dx * CGFloat(filament.bow) / 2)
    }

    /// Distance from a point to a line **segment** — not to the infinite line through it.
    ///
    /// The difference is the whole reason this is written out rather than borrowed: the
    /// infinite line is close to points a long way past either end, so a tap in empty space
    /// beyond a star would select the filament leaving it.
    static func distance(from point: CGPoint, toSegment a: CGPoint, to b: CGPoint) -> Double {
        let dx = Double(b.x - a.x)
        let dy = Double(b.y - a.y)
        let lengthSquared = dx * dx + dy * dy

        guard lengthSquared > 0 else {
            return hypot(Double(point.x - a.x), Double(point.y - a.y))
        }

        let t = min(max(
            (Double(point.x - a.x) * dx + Double(point.y - a.y) * dy) / lengthSquared, 0), 1)
        return hypot(
            Double(point.x - a.x) - t * dx,
            Double(point.y - a.y) - t * dy)
    }
}
