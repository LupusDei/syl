import CoreGraphics
import Foundation
import XCTest

@testable import Syl

/// **A tap on a star selects that star, and selecting a star never zooms.**
///
/// The Commander, 2026-08-11: *"If I tap the base node I get the memory to pop up. But if I
/// tap another node, no memory pops up and the whole thing starts zooming in without end."*
///
/// Two separate claims are defended here, because the report bundles them and they are not
/// the same defect:
///
/// 1. **Every star is hittable**, at every scale, on his own graph — which is a hub with
///    thirty-two spokes and nothing else, a shape ``ConstellationSnapshot/fixture`` does not
///    have and therefore never checked.
/// 2. **Selection pans; only his fingers zoom.** This is the invariant, and it is written as
///    an invariant rather than as a test of the mechanism on purpose: the last time this
///    screen ran away, the symptom named the wrong subsystem for an hour.
final class ConstellationTouchTests: XCTestCase {

    private let phone = CGSize(width: 393, height: 852)

    private var sky: PreparedSky {
        SkyPreparer(now: ConstellationFixture.now)
            .prepare(.hubAndSpokes, size: phone, chrome: .phone)
    }

    // MARK: - Every star, at every scale

    /// A finger on a star's drawn position selects **that** star. Every star, swept.
    ///
    /// The tap is placed by putting the anchor through the very transform the drawing uses,
    /// which is the only definition of "where the star is on the glass" that this screen has
    /// — the `Canvas`, the hit test and the VoiceOver elements all read it.
    func testShouldSelectEveryStarTappedAtItsDrawnPosition() {
        let sky = sky
        XCTAssertEqual(sky.stars.count, 33, "the fixture is his graph, or this proves nothing")

        for scale in [1.0, 2.5, 4.0] {
            let transform = ConstellationTransform.identity
                .zoomed(by: scale, about: CGPoint(x: phone.width / 2, y: phone.height / 2))
                .clamped(within: sky.contentBounds, viewSize: sky.size)

            for star in sky.stars {
                let onGlass = transform.apply(star.anchor)
                XCTAssertEqual(
                    ConstellationHitTest.hit(at: onGlass, in: sky, transform: transform),
                    .star(star.id),
                    "at \(scale)x a tap on \(star.id) at \(onGlass) did not select it")
            }
        }
    }

    /// A tap a finger's width off a star still finds it — the touch target is a finger, not a
    /// three-point core.
    func testShouldSelectAStarTappedNearRatherThanExactlyOnIt() {
        let sky = sky
        let transform = ConstellationTransform.identity

        for star in sky.stars {
            let onGlass = transform.apply(star.anchor)
            let nudged = CGPoint(x: onGlass.x, y: onGlass.y - 6)
            XCTAssertNotNil(
                ConstellationHitTest.hit(at: nudged, in: sky, transform: transform),
                "six points above \(star.id) found nothing at all")
        }
    }

    /// And the hub — the one star he says *does* work — is not special.
    func testShouldSelectTheHubLikeAnyOtherStar() {
        let sky = sky
        let hub = try? XCTUnwrap(sky.stars.first { $0.id == "source.conversation" })

        XCTAssertEqual(
            ConstellationHitTest.hit(
                at: hub?.anchor ?? .zero, in: sky, transform: .identity),
            .star("source.conversation"))
    }

    // MARK: - Selection never zooms

    /// **The invariant.** Making room for a card is a pan and only a pan.
    ///
    /// Swept over every star and both ends of the scale range, because a reveal that
    /// preserved scale at one and lost it at four would be exactly the bug he described.
    func testShouldNeverChangeTheScaleWhenMakingRoomForACard() {
        let sky = sky

        for scale in [1.0, 2.0, 4.0] {
            let resting = ConstellationTransform.identity
                .zoomed(by: scale, about: CGPoint(x: phone.width / 2, y: phone.height / 2))
                .clamped(within: sky.contentBounds, viewSize: sky.size)

            for star in sky.stars {
                let revealed = resting.revealing(
                    star.anchor,
                    between: ConstellationBand.headroom(sky.chrome),
                    and: ConstellationBand.skyline(
                        forCardOf: 320, in: sky.size, chrome: sky.chrome),
                    within: sky.contentBounds,
                    viewSize: sky.size)

                XCTAssertEqual(
                    revealed.scale, resting.scale, accuracy: 1e-9,
                    "revealing \(star.id) changed the scale from \(resting.scale)")
            }
        }
    }

    /// **A gesture still under his fingers must not be written into stored state.**
    ///
    /// `ConstellationView.live` is the stored transform with the in-flight pinch composed on
    /// top. `makeRoom` used to assign `live.revealing(…)` back to `transform`, which stores
    /// the pinch — so the next read of `live` composes it again, and the one after that
    /// composes it again. This is that arithmetic, run by hand: it is the whole of why the
    /// screen must write `transform.revealing(…)`.
    func testShouldNotCompoundAPinchThatIsStillInFlight() {
        let focus = CGPoint(x: 196, y: 426)
        let pinch = 1.5
        let stored = ConstellationTransform.identity

        // What he sees while pinching.
        let live = stored.zoomed(by: pinch, about: focus)
        XCTAssertEqual(live.scale, 1.5, accuracy: 1e-9)

        // Correct: the card's arrival pans the *stored* sky, and the pinch composes on top of
        // the result exactly once, however many times the card re-measures itself.
        var correct = stored
        for _ in 0..<3 {
            correct = correct.panned(by: CGSize(width: 0, height: -20))
        }
        XCTAssertEqual(
            correct.zoomed(by: pinch, about: focus).scale, live.scale, accuracy: 1e-9,
            "panning must not change what a pinch in flight resolves to")

        // The defect, for the record: storing `live` re-applies the pinch on every read, and
        // three redraws take a one-and-a-half times pinch to the ceiling.
        var baked = stored
        for _ in 0..<3 {
            baked = baked.zoomed(by: pinch, about: focus)
        }
        XCTAssertGreaterThan(
            baked.scale, live.scale,
            "if this is not larger, the arithmetic in this test no longer models the defect")
    }

    // MARK: - Nothing is an answer

    /// A tap on empty sky selects nothing, which is how the card is put away.
    func testShouldSelectNothingOnEmptySky() {
        XCTAssertNil(
            ConstellationHitTest.hit(
                at: CGPoint(x: 2, y: 2), in: sky, transform: .identity),
            "the top corner of a sky inset by a navigation bar holds nothing")
    }
}
