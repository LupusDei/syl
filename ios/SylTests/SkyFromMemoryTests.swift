import XCTest

@testable import Syl
@testable import SylKit

/// The seam between the sky she remembers and the sky he sees.
///
/// Two squads built the halves in parallel and neither crossed the middle. The squad that
/// built the read flagged three traps waiting in that crossing; each one is a test here,
/// because a trap named in a handover message and not asserted is a trap.
final class SkyFromMemoryTests: XCTestCase {

    /// Depth is age, and the optional date is the wrong one.
    ///
    /// `provenance.learnedAt` is nil for every unattested star. Mapping depth off it would
    /// render the oldest unconnected memories as brand new — the exact lie the depth axis
    /// exists to avoid. `createdAt` is non-optional, so the missing case does not exist
    /// rather than being handled.
    func testShouldTakeDepthFromCreatedAtRatherThanTheOptionalProvenanceDate() {
        let born = try! Instant.parse("2021-03-04T09:00:00.000Z")
        let sky = SkyFromMemory.snapshot(from: constellation(stars: [
            star(id: "syl:memory:0198f2c4-0001-7000-8000-00000000e001", createdAt: born)
        ]))

        XCTAssertEqual(
            sky.nodes.first?.learnedAt,
            born,
            "an ancient unattested memory must not render as brand new"
        )
    }

    /// A star she barely holds must look weak, not absent.
    ///
    /// Unattested confidence is the weight law's floor — around `1e-9`, not zero, because
    /// decay approaches zero and never arrives. Drawn linearly that is not faint, it is
    /// invisible: the star exists, takes a slot, and renders as nothing. And a star that
    /// renders as nothing is indistinguishable from one she has forgotten, which is a
    /// claim this app is not allowed to make by accident.
    func testShouldKeepTheFaintestMemoryVisible() {
        let sky = SkyFromMemory.snapshot(from: constellation(stars: [
            star(id: "syl:memory:0198f2c4-0001-7000-8000-00000000e001", confidence: 1e-9)
        ]))

        let confidence = sky.nodes.first?.confidence ?? 0
        XCTAssertGreaterThan(confidence, 0.02, "forgotten and barely-held must not look the same")
        XCTAssertLessThan(confidence, 0.2, "and barely-held must still look barely held")
    }

    /// The floor lifts the invisible without flattening the visible.
    ///
    /// If it clamped everything the sky would lose the one property worth drawing.
    func testShouldLeaveAConfidentMemoryExactlyAsConfidentAsItIs() {
        let sky = SkyFromMemory.snapshot(from: constellation(stars: [
            star(id: "syl:memory:0198f2c4-0001-7000-8000-00000000e001", confidence: 0.83)
        ]))

        XCTAssertEqual(sky.nodes.first?.confidence ?? 0, 0.83, accuracy: 0.0001)
    }

    /// An anchor and an orphan both carry no `anchorId`, and they are not the same star.
    func testShouldCarryTheAnchorLinkThroughUnchanged() {
        let sky = SkyFromMemory.snapshot(from: constellation(stars: [
            star(id: "syl:person:0198f2c4-0002-7000-8000-00000000e002", kind: .person, anchor: true),
            star(
                id: "syl:fact:0198f2c4-0003-7000-8000-00000000e003",
                anchorId: "syl:person:0198f2c4-0002-7000-8000-00000000e002"
            ),
            star(id: "syl:decision:0198f2c4-0004-7000-8000-00000000e004", kind: .decision),
        ]))

        XCTAssertNil(sky.nodes[0].anchorId, "an anchor orbits nothing")
        XCTAssertNotNil(sky.nodes[1].anchorId)
        XCTAssertNil(sky.nodes[2].anchorId, "an orphan is placed, not dropped")
        XCTAssertEqual(sky.nodes.count, 3)
    }

    /// The stamp is the server's, not the moment the phone read it.
    ///
    /// A sky drawn from disk on a plane is honestly from Tuesday. Stamping it `now` on
    /// read would make every stale sky claim to be current.
    func testShouldKeepTheServersOwnStampRatherThanTheMomentItWasRead() {
        let generated = try! Instant.parse("2026-08-09T07:00:00.000Z")
        let sky = SkyFromMemory.snapshot(from: constellation(stars: [], generatedAt: generated))

        XCTAssertEqual(sky.capturedAt, generated)
    }

    // MARK: - Harness

    private func star(
        id: SylID,
        kind: MemoryNodeKind = .memory,
        confidence: Double = 0.5,
        anchor: Bool = false,
        anchorId: SylID? = nil,
        createdAt: Date = try! Instant.parse("2026-08-09T07:00:00.000Z")
    ) -> MemoryStar {
        MemoryStar(
            id: id,
            kind: kind,
            tier: .hot,
            label: "something",
            body: nil,
            confidence: confidence,
            provenance: MemoryStarProvenance(
                species: .unattested,
                assertedBy: nil,
                reasoning: nil,
                learnedAt: nil
            ),
            anchor: anchor,
            anchorId: anchorId,
            createdAt: createdAt,
            updatedAt: createdAt
        )
    }

    private func constellation(
        stars: [MemoryStar],
        generatedAt: Date = try! Instant.parse("2026-08-09T07:00:00.000Z")
    ) -> MemoryConstellation {
        MemoryConstellation(
            generatedAt: generatedAt,
            bound: MemoryConstellationBound(
                stars: stars.count,
                starsReturned: stars.count,
                filamentsReturned: 0,
                mayHaveMore: false,
                explanation: "test"
            ),
            stars: stars,
            filaments: []
        )
    }
}
