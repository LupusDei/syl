import CoreGraphics
import Foundation
import XCTest

@testable import Syl

/// **The Commander's requirement, expressed as a test rather than as a hope.**
///
/// > *"I know you want the placement to be deterministic and I agree, but once everything
/// > is placed, make it lifelike — have it hover and move around subtly."*
///
/// A star may drift *around* its anchor and must never travel *to* a new one. That
/// distinction is invisible in a screenshot and obvious after a minute of watching, which
/// is exactly the kind of defect that ships. So it is a bound that is asserted at every
/// scale of `t` this app will ever see, including the one it actually runs at — a
/// `timeIntervalSinceReferenceDate` is around 8×10⁸, and a motion term that accumulates is
/// perfectly well behaved for the first few seconds after launch.
final class ConstellationMotionTests: XCTestCase {
    /// Real seeds, from real ids, rather than 0…9 — a bug in the hash mixing would hide
    /// behind small consecutive integers.
    private let seeds = ConstellationSnapshot.fixture.nodes.map { ConstellationSeed.of($0.id) }

    /// Times to sweep: the first minutes after launch, an hour, a day, and the magnitude
    /// the clock is actually at, all at a step that is not a multiple of any period here.
    private var times: [TimeInterval] {
        var result: [TimeInterval] = []
        for step in 0..<2_000 {
            result.append(Double(step) * 0.37)
        }
        for base in [3_600.0, 86_400.0, 1_000_000.0, 800_000_000.0, -50_000.0] {
            for step in 0..<400 {
                result.append(base + Double(step) * 0.61)
            }
        }
        return result
    }

    // MARK: - The bound

    func testShouldNeverCarryAStarFurtherFromItsAnchorThanTheStatedBound() {
        for seed in seeds {
            for depth in [0.0, 0.12, 0.32, 0.66, 0.9, 1.0] {
                let bound = ConstellationMotion.bound(depth: depth)
                for t in times {
                    let offset = ConstellationMotion.offset(seed: seed, depth: depth, at: t)
                    let distance = hypot(Double(offset.width), Double(offset.height))
                    XCTAssertLessThanOrEqual(
                        distance, bound + 1e-9,
                        "seed \(seed) at depth \(depth) reached \(distance) at t=\(t)")
                }
            }
        }
    }

    func testShouldKeepEveryBoundUnderTheStatedCeiling() {
        for depth in stride(from: 0.0, through: 1.0, by: 0.01) {
            XCTAssertLessThanOrEqual(
                ConstellationMotion.bound(depth: depth), ConstellationMotion.ceiling)
        }
        // And the ceiling is actually reachable-ish, so it is a bound rather than a
        // number picked large enough to be meaningless.
        XCTAssertGreaterThan(ConstellationMotion.bound(depth: 1), ConstellationMotion.ceiling * 0.5)
    }

    /// **The bound and the layout floor, in one assertion — and the strongest thing this
    /// file says.**
    ///
    /// For every pair of stars in the sky: the gap between their anchors, less the two
    /// radii they are drawn at, less the furthest each may ever hover, is still positive.
    /// So no combination of `t` can make two stars touch, merge into one smeared point, or
    /// let one be mistaken for the other. That is what "drifts around its anchor, never
    /// travels to a new one" means once it is written down as arithmetic.
    ///
    /// It is also what caught the drift being raised too far: at eleven orbit slots two
    /// neighbours sat close enough that a four-point hover each way closed the gap to
    /// three, and this assertion said so before any render could have.
    func testShouldNeverDriftFarEnoughForTwoStarsToTouch() {
        let sky = SkyPreparer(now: ConstellationFixture.now)
            .prepare(.fixture, size: CGSize(width: 393, height: 852))

        var tightest = Double.greatestFiniteMagnitude
        for i in sky.stars.indices {
            for j in (i + 1)..<sky.stars.count {
                let a = sky.stars[i]
                let b = sky.stars[j]
                let gap = hypot(Double(a.anchor.x - b.anchor.x), Double(a.anchor.y - b.anchor.y))
                    - a.coreRadius - b.coreRadius
                    - ConstellationMotion.bound(depth: a.depth)
                    - ConstellationMotion.bound(depth: b.depth)
                tightest = min(tightest, gap)
            }
        }

        XCTAssertGreaterThan(
            tightest, 0,
            "two stars can be drawn touching at some instant — the drift is too large for the layout")
    }

    // MARK: - Depth parallax

    func testShouldDriftANearStarMoreThanAFarOne() {
        XCTAssertGreaterThan(
            ConstellationMotion.bound(depth: 1.0), ConstellationMotion.bound(depth: 0.3))
        XCTAssertGreaterThan(ConstellationMotion.bound(depth: 0), 0, "a far star froze")

        // And it is a real difference rather than a rounding one — the point of parallax is
        // that the eye can see it.
        XCTAssertGreaterThan(
            ConstellationMotion.bound(depth: 1.0) / ConstellationMotion.bound(depth: 0), 1.8)
    }

    // MARK: - Nothing ever pulses together

    /// No star's motion repeats at any of the base periods, because it is the sum of terms
    /// on two different ones — a loop the eye can find is a loop the eye starts waiting for.
    func testShouldNeverResynchroniseIntoAVisibleLoop() {
        let seed = ConstellationSeed.of("person.dad")
        let now = 800_000_000.0
        let here = ConstellationMotion.offset(seed: seed, depth: 1, at: now)

        for period in [13.0, 17.0, 29.0, 37.0, 60.0, 300.0] {
            let later = ConstellationMotion.offset(seed: seed, depth: 1, at: now + period)
            XCTAssertGreaterThan(
                hypot(Double(later.width - here.width), Double(later.height - here.height)),
                0.05,
                "the drift repeated itself after \(period)s")
        }
    }

    func testShouldGiveNoTwoStarsTheSameMotion() {
        let t = 12_345.6
        var seen: [CGSize] = []
        for seed in seeds.prefix(20) {
            let offset = ConstellationMotion.offset(seed: seed, depth: 1, at: t)
            for other in seen {
                XCTAssertGreaterThan(
                    hypot(Double(offset.width - other.width), Double(offset.height - other.height)),
                    0.001, "two stars moved in lockstep")
            }
            seen.append(offset)
        }
    }

    func testShouldMoveTheSameStarTheSameWayOnEveryLaunch() {
        let seed = ConstellationSeed.of("goal.novel")
        for t in [0.0, 91.7, 800_000_000.0] {
            XCTAssertEqual(
                ConstellationMotion.offset(seed: seed, depth: 0.66, at: t),
                ConstellationMotion.offset(seed: seed, depth: 0.66, at: t))
        }
    }

    // MARK: - Reduce Motion

    /// Every star sits exactly on its anchor — not on a frozen frame of the drift.
    ///
    /// The still has to read as *the same sky*, and it only can if the positions it shows
    /// are the ones the layout actually decided. If the still looked broken, the motion was
    /// carrying meaning it should not have been.
    func testShouldPinEveryStarAtItsAnchorWhenMotionIsReduced() {
        for seed in seeds {
            for depth in [0.0, 0.5, 1.0] {
                for t in [0.0, 3.2, 800_000_000.0] {
                    XCTAssertEqual(
                        ConstellationMotion.offset(seed: seed, depth: depth, at: t, moving: false),
                        .zero)
                }
            }
        }
    }

    func testShouldHoldEveryStarAtItsOwnBrightnessWhenMotionIsReduced() {
        for seed in seeds.prefix(10) {
            XCTAssertEqual(ConstellationMotion.breath(seed: seed, at: 41.3, moving: false), 1)
        }
    }

    // MARK: - The breath

    func testShouldKeepTheBreathWithinATenthEitherWay() {
        for seed in seeds {
            for t in times.prefix(600) {
                let breath = ConstellationMotion.breath(seed: seed, at: t)
                XCTAssertGreaterThanOrEqual(breath, 1 - ConstellationMotion.breathDepth - 1e-9)
                XCTAssertLessThanOrEqual(breath, 1 + ConstellationMotion.breathDepth + 1e-9)
            }
        }
    }
}
