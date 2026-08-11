import CoreGraphics
import Foundation
import XCTest

@testable import Syl

/// **A tap must land where he aimed.**
///
/// Everything here is pure arithmetic on a finished sky, which is the point: the two rules
/// that make touching a field of drifting points of light feel reliable are both invisible
/// in a screenshot and both cheap to assert.
///
/// 1. **Against the anchor, never against where the star has drifted to.** A star hovers
///    around its anchor on periods nothing else shares, so hit-testing the drifting position
///    would make a tap land or miss depending on what time it is — a few percent of the
///    time, unreproducibly, indistinguishable from the app ignoring him.
/// 2. **In view space, after the transform.** A radius in sky space shrinks on the glass as
///    he zooms out, so the same star would get harder to hit the further away it is.
final class ConstellationHitTestTests: XCTestCase {
    private let phone = CGSize(width: 393, height: 852)

    private var sky: PreparedSky {
        SkyPreparer(now: ConstellationFixture.now).prepare(.fixture, size: phone)
    }

    // MARK: - Stars

    /// Every single star in the fixture, tapped dead on its anchor.
    func testShouldFindEveryStarTappedAtItsAnchor() {
        let sky = sky
        for star in sky.stars {
            XCTAssertEqual(
                ConstellationHitTest.hit(at: star.anchor, in: sky, transform: .identity),
                .star(star.id),
                "\(star.id) could not be touched at its own anchor")
        }
    }

    /// **The star as drawn is always inside its own target, at every instant and every
    /// scale.**
    ///
    /// This is the anchor rule expressed as the thing it actually buys. The hit test does
    /// not know what time it is — it cannot, it takes no `t` — so the guarantee has to be
    /// that the reach around the anchor covers everywhere the hover can carry the star. If
    /// the drift ever grew past the reach, a tap on the star he can see would miss the star
    /// he is aiming at.
    ///
    /// **What this actually guards, found by breaking it:** at today's numbers a fingertip
    /// alone already exceeds the furthest the hover can reach at every legal scale, so the
    /// drift term in ``ConstellationHitTest/reach(of:scale:)`` is currently redundant.
    /// Deleting it alone changes no behaviour and no test. Deleting it *and* shrinking the
    /// finger turns this red. That is the point: it is the assertion tying the three
    /// constants together, so the day someone raises the drift, or the maximum zoom, or
    /// trims the touch target, the relationship fails here rather than as an intermittent
    /// missed tap nobody can reproduce.
    func testShouldReachEverywhereTheHoverCanCarryAStar() {
        let sky = sky
        for star in sky.stars {
            for scale in [1.0, 1.5, 2.5, 4.0] {
                let reach = ConstellationHitTest.reach(of: star, scale: scale)
                let drift = ConstellationMotion.bound(depth: star.depth) * scale
                XCTAssertGreaterThan(
                    reach, drift,
                    "\(star.id) at \(scale)× can drift \(drift) out of a \(reach) target")
            }
        }
    }

    /// And the drifted star really is inside the target, taken from the motion itself rather
    /// than from the bound that describes it.
    ///
    /// **Every star, not a convenient one, and zoomed in as well as out.** A single bright
    /// anchor proves nothing here: it is drawn large, so its own core covers most of the
    /// hover before the fingertip is even consulted. The stars that could actually break
    /// this are the faint ones, whose cores are under a point across.
    func testShouldStillFindAStarTheHoverHasCarriedAway() {
        let sky = sky

        for transform in [ConstellationTransform.identity, closeIn(on: sky)] {
            for star in sky.stars {
                for step in 0..<40 {
                    let t = Double(step) * 3.7
                    let offset = ConstellationMotion.offset(
                        seed: star.seed, depth: star.depth, at: t)
                    let drawn = transform.apply(
                        CGPoint(
                            x: star.anchor.x + offset.width, y: star.anchor.y + offset.height))

                    XCTAssertEqual(
                        ConstellationHitTest.hit(at: drawn, in: sky, transform: transform),
                        .star(star.id),
                        "\(star.id) at t=\(t): the star he can see was not the one he touched")
                }
            }
        }
    }

    /// The sky at full magnification, still legally placed.
    private func closeIn(on sky: PreparedSky) -> ConstellationTransform {
        ConstellationTransform(scale: ConstellationTransform.maximumScale, translation: .zero)
            .clamped(within: sky.contentBounds, viewSize: sky.size)
    }

    /// **A finger stays a finger however far he zooms out.**
    ///
    /// Swept below the minimum scale on purpose: this is a property of the function, not
    /// something the clamp happens to be hiding.
    func testShouldKeepTheTargetAFingerAtEveryScale() {
        let sky = sky
        for star in sky.stars {
            for scale in [0.1, 0.5, 1.0, 2.0, 4.0] {
                XCTAssertGreaterThanOrEqual(
                    ConstellationHitTest.reach(of: star, scale: scale),
                    ConstellationHitTest.fingerRadius)
            }
        }
    }

    /// A tap between two neighbours goes to the one it is nearer, and the mirrored tap goes
    /// to the other. Anything else and a star in a crowded cluster is unreachable.
    func testShouldGiveATapBetweenTwoStarsToTheNearerOne() {
        let sky = sky
        let pair = closestPair(in: sky)
        let a = pair.0
        let b = pair.1

        func between(_ fraction: CGFloat) -> CGPoint {
            CGPoint(
                x: a.anchor.x + (b.anchor.x - a.anchor.x) * fraction,
                y: a.anchor.y + (b.anchor.y - a.anchor.y) * fraction)
        }

        XCTAssertEqual(
            ConstellationHitTest.hit(at: between(0.35), in: sky, transform: .identity),
            .star(a.id))
        XCTAssertEqual(
            ConstellationHitTest.hit(at: between(0.65), in: sky, transform: .identity),
            .star(b.id))
    }

    // MARK: - Filaments

    /// **A filament is drawn as a curve, and it has to be touchable where it is drawn.**
    ///
    /// The bow is a fraction of a thread's own length, so it grows with the sky. On a
    /// pocket-sized fixture the middle of the drawn line is under ten points off its chord —
    /// inside a generous reach, so a chord-only implementation would have looked fine. On a
    /// six-hundred-point thread, which is one rotation or one larger region away, the same
    /// fraction is thirty, and the middle of the line he can see stops being the line he can
    /// touch.
    ///
    /// So the mechanism is asserted on a thread built for the purpose rather than on
    /// whichever one the fixture happens to contain. **A test that only holds at today's
    /// scale is a test that will be deleted at tomorrow's.**
    func testShouldFindALongFilamentWhereItIsDrawnRatherThanOnItsChord() {
        let long = PreparedFilament(
            id: "long", from: CGPoint(x: 40, y: 400), to: CGPoint(x: 640, y: 400),
            fromId: "a", toId: "b", fromSeed: 1, toSeed: 2, fromDepth: 1, toDepth: 1,
            species: .inferred, alpha: 0.5, width: 0.75, bow: 0.15)
        let sky = PreparedSky(
            stars: [], filaments: [long], size: CGSize(width: 680, height: 852),
            contentBounds: CGRect(x: 40, y: 340, width: 600, height: 120))

        let apex = ConstellationHitTest.apex(of: long)
        let chordMidpoint = CGPoint(x: 340, y: 400)

        XCTAssertGreaterThan(
            hypot(apex.x - chordMidpoint.x, apex.y - chordMidpoint.y),
            ConstellationHitTest.filamentReach * 2,
            "this filament is not bowed enough for the test to mean anything")

        XCTAssertEqual(
            ConstellationHitTest.hit(at: apex, in: sky, transform: .identity),
            .filament(long.id),
            "the middle of the drawn curve is not touchable")

        // And the chord's own midpoint — where a naive implementation would have put the
        // line — is now empty sky, which is the whole point.
        XCTAssertNil(
            ConstellationHitTest.hit(at: chordMidpoint, in: sky, transform: .identity),
            "the chord is being treated as though it were the line")
    }

    /// The most bowed real thread in the fixture is touchable at its own middle too.
    func testShouldFindTheMostBowedRealFilamentAtItsMiddle() {
        let sky = sky
        let bowed = try! XCTUnwrap(
            sky.filaments
                .filter { hypot($0.to.x - $0.from.x, $0.to.y - $0.from.y) > 150 }
                .filter {
                    // A star legitimately wins the tie in the middle of a cluster, and that
                    // would be testing the tie rule rather than the curve.
                    ConstellationHitTest.nearestStar(
                        to: ConstellationHitTest.apex(of: $0), in: sky, transform: .identity)
                        == nil
                }
                .max(by: { deviation(of: $0) < deviation(of: $1) }))

        XCTAssertGreaterThan(deviation(of: bowed), 4, "nothing in the fixture is bowed at all")
        XCTAssertEqual(
            ConstellationHitTest.hit(
                at: ConstellationHitTest.apex(of: bowed), in: sky, transform: .identity),
            .filament(bowed.id))
    }

    /// Every filament in the sky is reachable somewhere along its own drawn line.
    func testShouldMakeEveryFilamentTouchableAtItsMiddle() {
        let sky = sky
        for filament in sky.filaments {
            let apex = ConstellationHitTest.apex(of: filament)
            XCTAssertLessThan(
                ConstellationHitTest.distance(from: apex, to: filament, transform: .identity),
                0.001,
                "\(filament.id) is not on its own curve")

            // A star may legitimately win here — the middle of a short radial thread can sit
            // inside a cluster — but *something* must answer.
            XCTAssertNotNil(
                ConstellationHitTest.hit(at: apex, in: sky, transform: .identity),
                "\(filament.id) has a middle nothing responds to")
        }
    }

    /// **A star wins a tie**, and the tie is not hypothetical: a filament touches its own
    /// endpoint star, so a tap there is inside both targets by construction.
    func testShouldGiveTheStarTheTapWhenAFilamentIsEquallyClose() {
        let sky = sky
        var tested = 0

        for filament in sky.filaments {
            guard let star = sky.stars.first(where: { $0.id == filament.fromId }) else { continue }

            // Ten points along the thread from the star: certainly on the filament, and
            // certainly within a finger of the star.
            let apex = ConstellationHitTest.apex(of: filament)
            let length = hypot(apex.x - star.anchor.x, apex.y - star.anchor.y)
            guard length > 20 else { continue }
            let point = CGPoint(
                x: star.anchor.x + (apex.x - star.anchor.x) / length * 10,
                y: star.anchor.y + (apex.y - star.anchor.y) / length * 10)

            XCTAssertLessThanOrEqual(
                ConstellationHitTest.distance(from: point, to: filament, transform: .identity),
                ConstellationHitTest.filamentReach,
                "\(filament.id) was not actually within reach, so this proves nothing")

            XCTAssertEqual(
                ConstellationHitTest.hit(at: point, in: sky, transform: .identity)?.starId != nil,
                true,
                "a filament took a tap that was inside a star at \(point)")
            tested += 1
        }

        XCTAssertGreaterThan(tested, 20, "the tie case was barely exercised")
    }

    // MARK: - Nothing

    /// A tap on empty sky is an answer, not a miss: it puts the card away.
    func testShouldFindNothingInEmptySky() {
        let sky = sky
        let empty = try! XCTUnwrap(emptyPoint(in: sky), "the fixture sky has no empty pixel")
        XCTAssertNil(ConstellationHitTest.hit(at: empty, in: sky, transform: .identity))
    }

    func testShouldFindNothingAWholeScreenAwayFromTheSky() {
        XCTAssertNil(
            ConstellationHitTest.hit(
                at: CGPoint(x: -900, y: -900), in: sky, transform: .identity))
    }

    /// **Never a hole that swallows taps.** Something too faint to be drawn must also be too
    /// faint to be touched, or the sky acquires invisible targets.
    func testShouldNotFindAThingItDidNotDraw() {
        let ghost = PreparedSky(
            stars: [
                PreparedStar(
                    id: "ghost", label: "invisible", anchor: CGPoint(x: 200, y: 400), seed: 1,
                    depth: 1, confidence: 0, alpha: 0, coreRadius: 3, isAnchor: false,
                    tint: .cool, hasSpikes: false)
            ],
            filaments: [],
            size: phone,
            contentBounds: CGRect(x: 200, y: 400, width: 0, height: 0))

        XCTAssertNil(
            ConstellationHitTest.hit(
                at: CGPoint(x: 200, y: 400), in: ghost, transform: .identity))
    }

    // MARK: - After the transform

    /// **The target moves with the sky.** If it did not, wandering would break touching —
    /// which is the failure that makes a pan-and-zoom screen feel haunted.
    func testShouldFollowTheStarWhenHeWanders() {
        let sky = sky
        let star = try! XCTUnwrap(sky.stars.first { $0.id == "goal.novel" })
        let wandered = ConstellationTransform.identity
            .zoomed(by: 2.5, about: CGPoint(x: 196, y: 426))
            .panned(by: CGSize(width: -60, height: 90))
            .clamped(within: sky.contentBounds, viewSize: sky.size)

        XCTAssertEqual(
            ConstellationHitTest.hit(
                at: wandered.apply(star.anchor), in: sky, transform: wandered),
            .star(star.id))

        // And the place it used to be is now somewhere else entirely.
        let moved = hypot(
            wandered.apply(star.anchor).x - star.anchor.x,
            wandered.apply(star.anchor).y - star.anchor.y)
        XCTAssertGreaterThan(
            Double(moved), ConstellationHitTest.fingerRadius * 2,
            "the sky did not move far enough for this test to say anything")
        XCTAssertNotEqual(
            ConstellationHitTest.hit(at: star.anchor, in: sky, transform: wandered),
            .star(star.id),
            "the tap was still tested against the sky's own coordinates")
    }

    // MARK: - Segments

    func testShouldMeasureToTheSegmentRatherThanToTheLineThroughIt() {
        let a = CGPoint(x: 0, y: 0)
        let b = CGPoint(x: 100, y: 0)

        XCTAssertEqual(
            ConstellationHitTest.distance(from: CGPoint(x: 50, y: 8), toSegment: a, to: b),
            8, accuracy: 1e-9)
        // A point far beyond the end is far away, not on the line.
        XCTAssertEqual(
            ConstellationHitTest.distance(from: CGPoint(x: 400, y: 0), toSegment: a, to: b),
            300, accuracy: 1e-9)
        // A segment of no length is a point.
        XCTAssertEqual(
            ConstellationHitTest.distance(from: CGPoint(x: 3, y: 4), toSegment: a, to: a),
            5, accuracy: 1e-9)
    }

    // MARK: - Harness

    private func deviation(of filament: PreparedFilament) -> Double {
        let apex = ConstellationHitTest.apex(of: filament)
        let midpoint = CGPoint(
            x: (filament.from.x + filament.to.x) / 2, y: (filament.from.y + filament.to.y) / 2)
        return hypot(Double(apex.x - midpoint.x), Double(apex.y - midpoint.y))
    }

    private func closestPair(in sky: PreparedSky) -> (PreparedStar, PreparedStar) {
        var best: (PreparedStar, PreparedStar, Double) = (sky.stars[0], sky.stars[1], .infinity)
        for i in sky.stars.indices {
            for j in (i + 1)..<sky.stars.count {
                let a = sky.stars[i]
                let b = sky.stars[j]
                let gap = hypot(Double(a.anchor.x - b.anchor.x), Double(a.anchor.y - b.anchor.y))
                if gap < best.2 { best = (a, b, gap) }
            }
        }
        return (best.0, best.1)
    }

    private func emptyPoint(in sky: PreparedSky) -> CGPoint? {
        for x in stride(from: 6.0, through: Double(phone.width) - 6, by: 7) {
            for y in stride(from: 6.0, through: Double(phone.height) - 6, by: 7) {
                let point = CGPoint(x: x, y: y)
                if ConstellationHitTest.hit(at: point, in: sky, transform: .identity) == nil {
                    return point
                }
            }
        }
        return nil
    }
}
