import XCTest

@testable import Syl
@testable import SylKit

/// The seam between the sky she remembers and the sky he sees.
///
/// Two squads built the halves in parallel and neither crossed the middle. The squad that
/// built the read flagged three traps waiting in that crossing; each one is a test here,
/// because a trap named in a handover message and not asserted is a trap.
final class SkyFromMemoryTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        database = try SylDatabase.inMemory()
        store = LocalStore(database: database)
    }

    override func tearDown() {
        store = nil
        database = nil
        super.tearDown()
    }


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

    // MARK: - What the card is made of

    /// **Provenance is the whole content of the card**, and dropping it here would leave the
    /// card with nothing to say but the label the sky had already drawn.
    func testShouldCarryProvenanceThroughToTheCard() {
        let learned = try! Instant.parse("2026-05-01T12:00:00.000Z")
        let sky = SkyFromMemory.snapshot(from: constellation(stars: [
            star(
                id: "syl:fact:0198f2c4-0005-7000-8000-00000000e005",
                provenance: MemoryStarProvenance(
                    species: .observed, assertedBy: "Dad", reasoning: nil, learnedAt: learned),
                body: "The longer version, in her words.")
        ]))

        let node = try! XCTUnwrap(sky.nodes.first)
        XCTAssertEqual(node.provenance.species, .observed)
        XCTAssertEqual(node.provenance.assertedBy, "Dad")
        XCTAssertEqual(node.provenance.learnedAt, learned)
        XCTAssertEqual(node.body, "The longer version, in her words.")
    }

    /// `unattested` is not a species of edge and must not be flattened into `observed` —
    /// which would have the card claim somebody said something nobody said.
    func testShouldKeepUnattestedAsItsOwnThing() {
        let sky = SkyFromMemory.snapshot(from: constellation(stars: [
            star(id: "syl:memory:0198f2c4-0006-7000-8000-00000000e006")
        ]))

        XCTAssertEqual(sky.nodes.first?.provenance.species, .unattested)
        XCTAssertEqual(
            ConstellationWords.provenance(
                species: .unattested, assertedBy: nil),
            "Nothing yet says where this came from.")
    }

    /// **Her reasoning, verbatim.** The only place the inference engine ever explains itself
    /// to him, carried across the seam without a single character changed.
    func testShouldCarryAFilamentsReasoningAcrossVerbatim() {
        let reasoning = "The Mandarin hour and the cello hour are the same hour on a Tuesday."
        let touched = try! Instant.parse("2026-04-02T09:30:00.000Z")
        let sky = SkyFromMemory.snapshot(from: constellation(
            stars: [],
            filaments: [
                MemoryFilament(
                    id: "syl:edge:0198f2c4-0007-7000-8000-00000000e007",
                    from: "a", to: "b",
                    relation: "set_it_down_for",
                    species: .inferred,
                    tier: .hot,
                    confidence: 0.54,
                    inferredConfidence: 0.71,
                    reasoning: reasoning,
                    assertedBy: nil,
                    lastTouchedAt: touched
                )
            ]))

        let edge = try! XCTUnwrap(sky.edges.first)
        XCTAssertEqual(edge.reasoning, reasoning)
        XCTAssertEqual(edge.relation, "set_it_down_for")
        XCTAssertEqual(edge.touchedAt, touched)
    }

    // MARK: - Harness

    private func star(
        id: SylID,
        kind: MemoryNodeKind = .memory,
        confidence: Double = 0.5,
        anchor: Bool = false,
        anchorId: SylID? = nil,
        createdAt: Date = try! Instant.parse("2026-08-09T07:00:00.000Z"),
        provenance: MemoryStarProvenance = MemoryStarProvenance(
            species: .unattested, assertedBy: nil, reasoning: nil, learnedAt: nil),
        body: String? = nil
    ) -> MemoryStar {
        MemoryStar(
            id: id,
            kind: kind,
            tier: .hot,
            label: "something",
            body: body,
            confidence: confidence,
            provenance: provenance,
            anchor: anchor,
            anchorId: anchorId,
            createdAt: createdAt,
            updatedAt: createdAt
        )
    }

    private func constellation(
        stars: [MemoryStar],
        filaments: [MemoryFilament] = [],
        generatedAt: Date = try! Instant.parse("2026-08-09T07:00:00.000Z")
    ) -> MemoryConstellation {
        MemoryConstellation(
            generatedAt: generatedAt,
            bound: MemoryConstellationBound(
                stars: stars.count,
                starsReturned: stars.count,
                filamentsReturned: filaments.count,
                mayHaveMore: false,
                explanation: "test"
            ),
            stars: stars,
            filaments: filaments
        )
    }

    /// The defect that shipped, and the reason this distinction exists.
    ///
    /// The first build with this screen called a route thirty minutes younger than the
    /// running service. Every fetch 404'd, the adapter shrugged and returned an empty sky,
    /// and the Commander was told **"I have not learned anything about you worth keeping"**
    /// over thirty real memories.
    ///
    /// Empty is a statement. Unreachable is the app having no idea. Rendering the first
    /// over the second tells him she has forgotten him, when the phone simply could not ask.
    func testShouldNotClaimSheKnowsNothingWhenItSimplyCouldNotAsk() async {
        struct Unreachable: Error {}
        let source = SkyFromMemory.source(
            ConstellationSource(
                store: store,
                gateway: ConstellationGateway { _ in throw Unreachable() }
            )
        )

        let sky = await source()

        XCTAssertTrue(sky.unreachable, "a failed read must say so")
        XCTAssertTrue(sky.isEmpty, "and it still has no stars to draw")
    }

    /// The other half, or the flag would simply always be on.
    func testShouldCallAGenuinelyEmptyGraphEmptyRatherThanUnreachable() async {
        let empty = constellation(stars: [])
        let source = SkyFromMemory.source(
            ConstellationSource(
                store: store,
                gateway: ConstellationGateway { _ in empty }
            )
        )

        let sky = await source()

        XCTAssertFalse(sky.unreachable, "she answered; she just knows nothing yet")
        XCTAssertTrue(sky.isEmpty)
    }
}
