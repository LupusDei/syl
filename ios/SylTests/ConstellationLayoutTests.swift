import CoreGraphics
import XCTest

@testable import Syl

/// The layout is the one part of this screen that can be argued about with numbers.
///
/// Everything else on the constellation is accepted by looking at it. This file exists to
/// pin the two properties that looking at it *cannot* check: that the sky is in the same
/// place on the next launch as it was on this one, and that no two stars are ever drawn on
/// top of each other.
final class ConstellationLayoutTests: XCTestCase {
    private let size = CGSize(width: 393, height: 852)
    private var layout: ConstellationLayout { ConstellationLayout(size: size) }

    // MARK: - The same sky, every launch

    /// **The seed is pinned to numbers computed in another process, in another language.**
    ///
    /// That is the only honest way to test "identical every launch" from inside one
    /// process. These three values came from a Python implementation of FNV-1a run at the
    /// terminal; if the Swift ever disagrees with them the sky has moved.
    ///
    /// The failure this guards against is specific and quiet: `String.hashValue` is seeded
    /// per process in Swift, so a layout built on it would rearrange itself on every launch
    /// and pass every same-process test ever written about it.
    func testShouldSeedFromTheNodeIdIdenticallyInEveryProcess() {
        XCTAssertEqual(ConstellationSeed.of("person.dad"), 278_954_243)
        XCTAssertEqual(ConstellationSeed.of("goal.novel"), 520_492_524)
        XCTAssertEqual(ConstellationSeed.of("fact.kate.cello"), 1_006_966_438)
        XCTAssertEqual(ConstellationSeed.of(""), 470_244_593)
    }

    func testShouldGiveTheSamePointForTheSameSnapshotEveryTime() {
        let first = layout.place(.fixture)
        let second = layout.place(.fixture)

        XCTAssertEqual(first.count, second.count)
        for (id, placement) in first {
            XCTAssertEqual(placement.point, second[id]?.point, "\(id) moved between placements")
        }
    }

    /// The order nodes arrive in is a property of a database read, not of the sky.
    func testShouldPlaceTheSameNodesIdenticallyWhateverOrderTheyArriveIn() {
        let straight = layout.place(.fixture)

        var shuffled = ConstellationSnapshot.fixture
        shuffled.nodes.reverse()
        let reversed = layout.place(shuffled)

        for (id, placement) in straight {
            XCTAssertEqual(
                placement.point, reversed[id]?.point,
                "\(id) moved when the snapshot arrived in a different order")
        }
    }

    // MARK: - Nothing lands on top of anything

    /// **Exhaustive rather than sampled, at every anchor count this screen can have.**
    ///
    /// Every pair of slots is compared, for every field size from two anchors to
    /// twenty-four, so this is a proof and not evidence — and it is a proof of the thing
    /// the whole layout rests on: two anchors are never closer than the slot spacing less
    /// twice the jitter each may wander by, in the direction the ellipse squashes hardest.
    func testShouldKeepEveryAnchorSlotApartFromEveryOtherAtEveryCount() {
        let (_, rx, ry) = layout.field
        let minorAxis = Double(min(rx, ry))

        for count in 2...24 {
            let spacing = ConstellationLayout.minimumSlotSpacing(of: count)
            let survives = spacing * (1 - 2 * ConstellationLayout.slotJitter)

            XCTAssertGreaterThan(
                survives * minorAxis, 32,
                "\(count) anchors packed closer than a cluster can survive")
        }

        // A lone anchor stands in the middle rather than at 0.7 of the way out along
        // whichever axis the packing happens to start on.
        XCTAssertEqual(ConstellationLayout.slotInUnitDisc(0, of: 1), .zero)
    }

    func testShouldNeverPlaceTwoNodesOnTopOfEachOther() {
        let placements = layout.place(.fixture)
        let points = placements.values.map(\.point)
        XCTAssertEqual(points.count, ConstellationSnapshot.fixture.nodes.count)

        var closest = Double.greatestFiniteMagnitude
        for i in points.indices {
            for j in (i + 1)..<points.count {
                closest = min(closest, hypot(
                    Double(points[i].x - points[j].x), Double(points[i].y - points[j].y)))
            }
        }

        // Comfortably more than the widest star's core, and more than twice the furthest
        // any star may ever drift.
        XCTAssertGreaterThan(closest, 11, "two stars are closer than a star is wide")
    }

    /// The rule that makes the previous test hold for *any* data rather than for this
    /// fixture: a cluster never reaches more than 45% of the way to the next anchor, so two
    /// clusters are separated by a tenth of the distance between their anchors however many
    /// nodes either one collects.
    func testShouldKeepEveryClusterInsideItsOwnTerritory() {
        let snapshot = ConstellationSnapshot.fixture
        let placements = layout.place(snapshot)
        let anchors = snapshot.nodes.filter(\.isAnchor).compactMap { placements[$0.id] }

        for node in snapshot.nodes {
            guard
                let anchorId = node.anchorId,
                let anchor = placements[anchorId],
                let placement = placements[node.id]
            else { continue }

            let nearest = anchors
                .filter { $0.id != anchor.id }
                .map { hypot(Double($0.point.x - anchor.point.x), Double($0.point.y - anchor.point.y)) }
                .min() ?? .greatestFiniteMagnitude

            let reach = hypot(
                Double(placement.point.x - anchor.point.x),
                Double(placement.point.y - anchor.point.y))

            XCTAssertLessThanOrEqual(
                reach,
                min(ConstellationLayout.maximumOrbit, nearest * ConstellationLayout.territoryFraction)
                    + 0.001,
                "\(node.id) reached outside \(anchorId)'s territory")
        }
    }

    /// A node whose anchor is not in this region stands on its own. Nothing is dropped —
    /// this system supersedes and demotes, it does not discard.
    func testShouldPlaceANodeWhoseAnchorIsMissingRatherThanDropIt() {
        let orphan = ConstellationNode(
            id: "fact.orphan", kind: .fact, tier: .hot, confidence: 0.8,
            label: "Something about nobody", anchorId: "person.absent", learnedAt: nil)
        let snapshot = ConstellationSnapshot(nodes: [orphan], edges: [])

        let placements = layout.place(snapshot)
        XCTAssertEqual(placements.count, 1)
        XCTAssertEqual(placements["fact.orphan"]?.isAnchor, true)
    }

    func testShouldDrawEveryStarInsideTheFieldItWasGiven() {
        for placement in layout.place(.fixture).values {
            XCTAssertGreaterThan(placement.point.x, 0)
            XCTAssertLessThan(placement.point.x, size.width)
            XCTAssertGreaterThan(placement.point.y, 0)
            XCTAssertLessThan(placement.point.y, size.height)
        }
    }

    // MARK: - Confidence is the radius

    func testShouldPutACertainMemoryCloserToItsAnchorThanADoubtfulOne() {
        XCTAssertLessThan(
            ConstellationLayout.orbitFraction(confidence: 0.95, lap: 0),
            ConstellationLayout.orbitFraction(confidence: 0.30, lap: 0))
    }

    func testShouldNeverPutAnOrbiterOnItsAnchorOrOnTheTerritoryEdge() {
        for step in 0...100 {
            let fraction = ConstellationLayout.orbitFraction(
                confidence: Double(step) / 100, lap: 0)
            XCTAssertGreaterThan(fraction, 0.35)
            XCTAssertLessThan(fraction, 1.0)
        }
    }

    // MARK: - Brightness is confidence, depth is tier

    /// **No buckets.** A hundred different confidences give a hundred different
    /// brightnesses; quantising them into three visual classes would throw away the one
    /// property that makes this data worth drawing.
    func testShouldMapConfidenceStraightToBrightnessWithNoBands() {
        var seen = Set<Double>()
        var previous = -1.0

        for step in 0...100 {
            let confidence = Double(step) / 100
            let alpha = ConstellationLayout.alpha(confidence: confidence, depth: 1)
            XCTAssertGreaterThan(alpha, previous, "brightness flattened at \(confidence)")
            previous = alpha
            seen.insert(alpha)
        }

        XCTAssertEqual(seen.count, 101, "two different confidences drew the same brightness")
    }

    func testShouldSinkAnOlderMemoryFurtherBackThanARecentOne() {
        let now = ConstellationFixture.now
        let recent = ConstellationLayout.depth(
            tier: .hot, learnedAt: now.addingTimeInterval(-86_400), now: now)
        let old = ConstellationLayout.depth(
            tier: .hot, learnedAt: now.addingTimeInterval(-300 * 86_400), now: now)

        XCTAssertGreaterThan(recent, old)
        XCTAssertEqual(ConstellationLayout.depth(tier: .hot, learnedAt: nil, now: now), 1.0)
    }

    /// Age moves a node inside its band and can never move it out of one. A `cold` memory
    /// from five years ago must still sit in front of a `suppressed` one learned today,
    /// because tier is what depth *means*.
    func testShouldNeverLetATierCrossAnother() {
        let now = ConstellationFixture.now
        let ancient = now.addingTimeInterval(-4_000 * 86_400)

        let oldestHot = ConstellationLayout.depth(tier: .hot, learnedAt: ancient, now: now)
        let newestCold = ConstellationLayout.depth(tier: .cold, learnedAt: now, now: now)
        let oldestCold = ConstellationLayout.depth(tier: .cold, learnedAt: ancient, now: now)
        let newestSuppressed = ConstellationLayout.depth(
            tier: .suppressed, learnedAt: now, now: now)

        XCTAssertGreaterThan(oldestHot, newestCold)
        XCTAssertGreaterThan(oldestCold, newestSuppressed)
        XCTAssertGreaterThan(newestSuppressed, 0, "suppressed is dimmest, never absent")
    }

    /// Suppressed is not gone. It has to be *there* if he goes looking and invisible when
    /// he is not — constraint 6, drawn.
    ///
    /// Stated as a **ratio against a live memory** rather than as an absolute, because the
    /// absolute is a tuning number that moved the first time anyone looked at a render and
    /// the relationship is what the constraint actually means.
    func testShouldStillDrawASuppressedMemoryFaintlyRatherThanNotAtAll() {
        let now = ConstellationFixture.now
        let faint = ConstellationLayout.alpha(
            confidence: 0.17,
            depth: ConstellationLayout.depth(tier: .suppressed, learnedAt: now, now: now))
        let live = ConstellationLayout.alpha(
            confidence: 0.95,
            depth: ConstellationLayout.depth(tier: .hot, learnedAt: now, now: now))

        XCTAssertGreaterThan(faint, 0.02, "a suppressed memory was drawn as nothing at all")
        XCTAssertLessThan(faint, live / 5, "a suppressed memory was as loud as a live one")
    }

    func testShouldDrawAnAnchorLargerThanWhatOrbitsIt() {
        let anchor = ConstellationLayout.coreRadius(confidence: 0.8, depth: 1, isAnchor: true)
        let orbiter = ConstellationLayout.coreRadius(confidence: 0.8, depth: 1, isAnchor: false)
        XCTAssertGreaterThan(anchor, orbiter)
    }

    // MARK: - The prepared sky

    func testShouldPrepareEveryNodeAndEveryDrawableEdge() {
        let sky = SkyPreparer(now: ConstellationFixture.now)
            .prepare(.fixture, size: size)

        XCTAssertEqual(sky.stars.count, ConstellationSnapshot.fixture.nodes.count)
        XCTAssertEqual(sky.filaments.count, ConstellationSnapshot.fixture.edges.count)
        XCTAssertEqual(sky.size, size)
    }

    /// Far first, so a near star is drawn over the haze behind it rather than under it.
    func testShouldOrderStarsFromFurthestToNearest() {
        let sky = SkyPreparer(now: ConstellationFixture.now).prepare(.fixture, size: size)
        XCTAssertEqual(sky.stars.map(\.depth), sky.stars.map(\.depth).sorted())
    }

    /// He must be able to tell, from looking and without a key, which parts of what she
    /// knows he told her and which she worked out.
    func testShouldDrawWhatSheWorkedOutFainterThanWhatHeSaid() {
        let observed = SkyPreparer.filamentAlpha(species: .observed, confidence: 0.8, haze: 1)
        let inferred = SkyPreparer.filamentAlpha(species: .inferred, confidence: 0.8, haze: 1)

        XCTAssertGreaterThan(observed, inferred * 2, "the two species were not far enough apart")
        XCTAssertGreaterThan(inferred, 0.01, "an inferred edge was drawn as nothing")

        // And a tether inside a cluster is quieter than a line across the sky, so forty
        // radial spokes cannot drown the handful of threads that make it a constellation.
        XCTAssertLessThan(
            SkyPreparer.filamentAlpha(
                species: .observed, confidence: 0.8, haze: 1, betweenAnchors: false),
            observed)
    }

    func testShouldPrepareNothingForAnEmptySnapshotOrAZeroSizedField() {
        XCTAssertTrue(SkyPreparer().prepare(.empty, size: size).isEmpty)
        XCTAssertTrue(SkyPreparer().prepare(.fixture, size: .zero).isEmpty)
    }
}
