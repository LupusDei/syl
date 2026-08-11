import CoreGraphics
import Foundation
import XCTest

@testable import Syl

/// **Wandering, and the promise that he can never lose the sky.**
///
/// > *"Wandering critical. Pinch drag zoom and select to view details."* — the Commander,
/// > 2026-08-11
///
/// The pan and the zoom are his own fingers and are not constrained by anything except one
/// rule: *the centre of the screen is always looking at part of the sky.* Everything
/// interesting about this file is that rule holding at the limits — where a fling stops,
/// what a pinch does to the point between his fingers, and whether the sky is exactly where
/// the layout put it on the frame he opens it.
final class ConstellationTransformTests: XCTestCase {
    private let phone = CGSize(width: 393, height: 852)

    private var sky: PreparedSky {
        SkyPreparer(now: ConstellationFixture.now).prepare(.fixture, size: phone)
    }

    private var centre: CGPoint { CGPoint(x: phone.width / 2, y: phone.height / 2) }

    // MARK: - The sky as it opens

    /// **The frame he opens it on must be the frame the layout decided, exactly.**
    ///
    /// The clamp runs on every gesture and on the first one too, so a bound that did not
    /// admit the identity would nudge the sky before he had touched anything — and a sky
    /// that moves on its own the moment you look at it is precisely the failure the whole
    /// deterministic layout exists to prevent. It is guaranteed by
    /// ``PreparedSky/contentBounds`` containing the centre of the screen, which is why that
    /// union is there and not a rounding-up.
    func testShouldLeaveTheSkyExactlyWhereItOpens() {
        let sky = sky
        XCTAssertEqual(
            ConstellationTransform.identity.clamped(
                within: sky.contentBounds, viewSize: sky.size),
            .identity)
    }

    /// And for a sky whose stars are all off to one side, which is the case that breaks it.
    func testShouldLeaveALopsidedSkyWhereItOpensToo() {
        let snapshot = ConstellationSnapshot(nodes: [
            ConstellationNode(
                id: "person.only", kind: .person, tier: .hot, confidence: 1,
                label: "The only one", anchorId: nil, learnedAt: nil)
        ])
        let sky = SkyPreparer(now: ConstellationFixture.now).prepare(snapshot, size: phone)

        XCTAssertEqual(
            ConstellationTransform.identity.clamped(
                within: sky.contentBounds, viewSize: sky.size),
            .identity,
            "a sky with one star in it was moved before he touched anything")
    }

    /// An empty sky is a real state — a brand new pairing — and a gesture on it must be a
    /// no-op rather than a fall through a hole.
    ///
    /// With nothing to look at, ``PreparedSky/contentBounds`` collapses to the single point
    /// at the centre of the screen, and the rule follows to its own limit: the only legal
    /// place to look is that point, so every drag and every pinch resolves back to it. The
    /// assertion is written as *the centre of the sky is under the centre of the screen*
    /// rather than as `contentBounds.contains(…)`, because a zero-area `CGRect` contains
    /// nothing at all — including its own corner.
    func testShouldSurviveAGestureOnASkyWithNothingInIt() {
        let sky = SkyPreparer(now: ConstellationFixture.now).prepare(.empty, size: phone)
        let wandered = ConstellationTransform.identity
            .panned(by: CGSize(width: 4_000, height: -9_000))
            .zoomed(by: 3, about: .zero)
            .clamped(within: sky.contentBounds, viewSize: sky.size)

        let looking = wandered.invert(centre)
        XCTAssertEqual(Double(looking.x), Double(centre.x), accuracy: 1e-6)
        XCTAssertEqual(Double(looking.y), Double(centre.y), accuracy: 1e-6)
    }

    // MARK: - Zoom

    func testShouldNeverZoomOutPastTheWholeSky() {
        for magnification in [0.9, 0.5, 0.01, 1e-9] {
            let zoomed = ConstellationTransform.identity.zoomed(by: magnification, about: centre)
            XCTAssertEqual(zoomed.scale, ConstellationTransform.minimumScale, accuracy: 1e-12)
        }
    }

    func testShouldNeverZoomInPastTheStatedCeiling() {
        var transform = ConstellationTransform.identity
        for _ in 0..<20 { transform = transform.zoomed(by: 1.6, about: centre) }
        XCTAssertEqual(transform.scale, ConstellationTransform.maximumScale, accuracy: 1e-12)
    }

    /// **Whatever is between his fingers stays between his fingers.**
    ///
    /// The commonest version of this zooms about the centre of the screen, which slides the
    /// thing he was looking at out from under his own hand.
    func testShouldHoldThePinchFocusExactlyStill() {
        let starts: [ConstellationTransform] = [
            .identity,
            ConstellationTransform(scale: 2.2, translation: CGSize(width: -140, height: 60)),
            ConstellationTransform(scale: 3.9, translation: CGSize(width: 500, height: -700)),
        ]
        let focuses = [CGPoint(x: 40, y: 90), centre, CGPoint(x: 380, y: 800)]

        for start in starts {
            for focus in focuses {
                for magnification in [1.05, 1.4, 0.7, 0.3] {
                    let zoomed = start.zoomed(by: magnification, about: focus)
                    let before = start.invert(focus)
                    let after = zoomed.invert(focus)
                    XCTAssertEqual(Double(before.x), Double(after.x), accuracy: 1e-9)
                    XCTAssertEqual(Double(before.y), Double(after.y), accuracy: 1e-9)
                }
            }
        }
    }

    /// A pinch that has not started yet must change nothing at all — the composition in the
    /// view applies this on every frame whether or not two fingers are down.
    func testShouldDoNothingWhenNoPinchIsHappening() {
        let start = ConstellationTransform(scale: 2.5, translation: CGSize(width: -80, height: 33))
        XCTAssertEqual(start.zoomed(by: 1, about: .zero), start)
        XCTAssertEqual(start.zoomed(by: 1, about: CGPoint(x: 900, y: -12)), start)
    }

    // MARK: - The bound

    /// **The rule itself, over a wide sweep of everything he could do.**
    func testShouldAlwaysKeepTheCentreOfTheScreenOnTheSky() {
        let sky = sky
        for scale in [0.4, 1.0, 1.7, 2.6, 4.0, 12.0] {
            for x in stride(from: -3_000.0, through: 3_000.0, by: 311) {
                for y in stride(from: -3_000.0, through: 3_000.0, by: 419) {
                    let wandered = ConstellationTransform(
                        scale: scale, translation: CGSize(width: x, height: y)
                    ).clamped(within: sky.contentBounds, viewSize: sky.size)

                    let looking = wandered.invert(centre)
                    XCTAssertTrue(
                        sky.contentBounds.insetBy(dx: -1e-6, dy: -1e-6).contains(looking),
                        "at scale \(scale), a drag to \(x),\(y) left him looking at \(looking)")
                }
            }
        }
    }

    /// **Every star can be brought exactly to the middle of the screen, and no further.**
    ///
    /// The other half of the bound, and the half that makes it usable rather than merely
    /// safe: a clamp that stopped short would strand the outermost memories against an edge
    /// where the card cannot be cleared of them.
    func testShouldLetHimBringAnyStarToTheCentreOfTheScreen() {
        let sky = sky
        for scale in [1.0, 2.0, 4.0] {
            for star in sky.stars {
                let wanted = ConstellationTransform(
                    scale: scale,
                    translation: CGSize(
                        width: centre.x - star.anchor.x * scale,
                        height: centre.y - star.anchor.y * scale))
                let allowed = wanted.clamped(within: sky.contentBounds, viewSize: sky.size)
                let landed = allowed.apply(star.anchor)

                XCTAssertEqual(Double(landed.x), Double(centre.x), accuracy: 1e-6)
                XCTAssertEqual(Double(landed.y), Double(centre.y), accuracy: 1e-6)
            }
        }
    }

    /// A fling stops. It does not follow him into the dark, and it does not spring back.
    func testShouldStopAFlingRatherThanFollowIt() {
        let sky = sky
        let flung = ConstellationTransform.identity
            .panned(by: CGSize(width: 99_999, height: -99_999))
            .clamped(within: sky.contentBounds, viewSize: sky.size)

        let visible = CGRect(origin: .zero, size: phone)
        let onScreen = sky.stars.filter { visible.contains(flung.apply($0.anchor)) }
        XCTAssertGreaterThan(
            onScreen.count, sky.stars.count / 5,
            "a fling left him with almost nothing on screen")
    }

    /// The axes are independent, so a diagonal drag that runs out sideways still slides
    /// downward — the sky follows the edge rather than sticking to it.
    func testShouldSlideAlongAnEdgeRatherThanStickToIt() {
        let sky = sky
        let far = ConstellationTransform.identity
            .panned(by: CGSize(width: 5_000, height: 40))
            .clamped(within: sky.contentBounds, viewSize: sky.size)

        XCTAssertEqual(Double(far.translation.height), 40, accuracy: 1e-9)
        XCTAssertLessThan(Double(far.translation.width), 5_000)
    }

    // MARK: - Making room for the card

    /// **The card must not cover what he touched** — for every star in the sky, not for the
    /// convenient ones.
    ///
    /// A card three hundred points tall over an eight-hundred-and-fifty-point screen leaves
    /// a band, and every anchor in the fixture has to be liftable into it. If the clamp and
    /// the card ever disagree, this is where it shows.
    func testShouldLiftEveryStarClearOfTheCard() {
        let sky = sky
        let top = ConstellationBand.headroom

        // Every card height from a two-line one up to the tallest the card is ever allowed
        // to be. **The tall end is the one that matters**: the taller the card, the further
        // the sky has to pan, and the sooner it meets the bound that stops it losing itself.
        //
        // Sweeping this instead of picking one number is what found the conflict. At two
        // thirds of the screen the two rules genuinely contradict — a star at the bottom
        // edge of what she knows can only ever be lifted to the middle of the glass, so a
        // card whose top is below the middle can never be got out from under. That is now
        // ``ConstellationBand/tallestCard(in:)``, and this is the assertion it exists for.
        for cardHeight in stride(
            from: 160.0, through: Double(ConstellationBand.tallestCard(in: phone)), by: 10) {
            let bottom = ConstellationBand.skyline(forCardOf: cardHeight, in: phone)

            // The promise is **not covered**, which is the card's own top edge. The skyline
            // above it is a chapter of air the sky aims for and does not always get, because
            // the bound on wandering outranks a comfort margin — and rightly: losing the sky
            // is worse than a star sitting a little close to the glass.
            let covered = ConstellationBand.cardTop(forCardOf: cardHeight, in: phone)

            for star in sky.stars {
                let made = ConstellationTransform.identity.revealing(
                    star.anchor, between: top, and: bottom,
                    within: sky.contentBounds, viewSize: sky.size)
                let y = made.apply(star.anchor).y

                XCTAssertLessThanOrEqual(
                    Double(y), Double(covered) + 1e-6,
                    "\(star.id) is UNDER a \(cardHeight)pt card, at \(y)")
                XCTAssertGreaterThanOrEqual(
                    Double(y), Double(top) - 1e-6,
                    "\(star.id) was shoved up behind the navigation bar to \(y)")
            }
        }
    }

    /// And the ceiling is a real card rather than a number small enough to be trivially
    /// safe — a "card" of two hundred points would satisfy the test above and be useless.
    func testShouldStillAllowACardBigEnoughToSayAnything() {
        let tallest = ConstellationBand.tallestCard(in: phone)
        XCTAssertGreaterThan(Double(tallest), Double(phone.height) * 0.40)
        XCTAssertLessThan(Double(tallest), Double(phone.height) * 0.50)

        // It is the *largest* height that works: at exactly this the card's top edge lands
        // on the deepest point any star can be brought to, and one step taller falls below
        // it. That is what makes it a bound rather than a cautious guess.
        XCTAssertEqual(
            Double(ConstellationBand.cardTop(forCardOf: tallest, in: phone)),
            Double(phone.height) / 2, accuracy: 1e-6)
        XCTAssertLessThan(
            Double(ConstellationBand.cardTop(forCardOf: tallest + 20, in: phone)),
            Double(phone.height) / 2)
    }

    /// It works zoomed in too, which is where a star is most likely to be badly placed.
    func testShouldLiftAStarClearOfTheCardWhileZoomedIn() {
        let sky = sky
        let bottom = phone.height - 300 - 40
        let close = ConstellationTransform(scale: 3.2, translation: .zero)
            .clamped(within: sky.contentBounds, viewSize: sky.size)

        for star in sky.stars {
            let made = close.revealing(
                star.anchor, between: 104, and: bottom,
                within: sky.contentBounds, viewSize: sky.size)
            XCTAssertLessThanOrEqual(Double(made.apply(star.anchor).y), Double(bottom) + 1e-6)
        }
    }

    /// **Most taps move nothing.** A screen that jumps when it did not need to reads as a
    /// mistake rather than as room being made.
    func testShouldNotMoveTheSkyForSomethingAlreadyInTheClear() {
        let sky = sky
        let start = ConstellationTransform.identity
        let alreadyClear = CGPoint(x: 200, y: 300)

        XCTAssertEqual(
            start.revealing(
                alreadyClear, between: 104, and: 512,
                within: sky.contentBounds, viewSize: sky.size),
            start)
    }

    /// It never moves further than it has to: after a lift the point sits exactly on the
    /// edge of the band it was outside of.
    func testShouldMoveNoFurtherThanTheCardActuallyTakes() {
        let sky = sky
        let bottom: CGFloat = 512
        let low = CGPoint(x: 200, y: 700)

        let made = ConstellationTransform.identity.revealing(
            low, between: 104, and: bottom, within: sky.contentBounds, viewSize: sky.size)

        XCTAssertEqual(Double(made.apply(low).y), Double(bottom), accuracy: 1e-6)
    }

    /// A card so tall there is no band left must leave the sky alone rather than invent a
    /// place to put it.
    func testShouldRefuseToMakeRoomThatDoesNotExist() {
        let sky = sky
        let start = ConstellationTransform(scale: 1.4, translation: CGSize(width: 10, height: 20))
        XCTAssertEqual(
            start.revealing(
                CGPoint(x: 100, y: 700), between: 600, and: 200,
                within: sky.contentBounds, viewSize: sky.size),
            start)
    }
}
