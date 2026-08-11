import GRDB
import SylKit
import XCTest

@testable import Syl

/// The sky on the device (`syl-ryp.1`, T004).
///
/// **Local-first is not suspended for a pretty screen.** The constellation opens
/// from disk, instantly and offline, or it is not part of this app. That is the
/// whole of what this file holds, plus the one decision that makes it correct:
/// the sky is stored as a SNAPSHOT and replaced whole, never merged row by row.
///
/// It rides a direct fetch rather than the sync feed, deliberately. `SyncEngine`
/// writes its cursor after every page whether or not anything in that page was
/// applied (`syl-011.9`, still open), so any resource type added to that feed
/// inherits the defect exactly — the Commander hit it within an hour on goals.
/// A bounded region with no per-row change events has nothing to gain from a
/// cursor and everything to lose from that one.
/// What a `@Sendable` gateway closure recorded, readable from the test.
private final class Recorded<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) { self.value = value }

    func set(_ next: Value) {
        lock.lock()
        defer { lock.unlock() }
        value = next
    }

    func get() -> Value {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

final class ConstellationStoreTests: XCTestCase {
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

    // MARK: - Fixtures

    private func star(
        id: String,
        kind: MemoryNodeKind = .fact,
        tier: MemoryTier = .hot,
        label: String = "Prefers Central time",
        confidence: Double = 0.9,
        anchor: Bool = false,
        anchorId: SylID? = nil
    ) -> MemoryStar {
        MemoryStar(
            id: id,
            kind: kind,
            tier: tier,
            label: label,
            body: nil,
            confidence: confidence,
            provenance: MemoryStarProvenance(
                species: .observed,
                assertedBy: "settings.json",
                reasoning: nil,
                learnedAt: Date(timeIntervalSince1970: 1_770_000_000)
            ),
            anchor: anchor,
            anchorId: anchorId,
            createdAt: Date(timeIntervalSince1970: 1_770_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_770_000_000)
        )
    }

    private func sky(
        generatedAt: Date = Date(timeIntervalSince1970: 1_770_000_100),
        stars: [MemoryStar],
        filaments: [MemoryFilament] = [],
        mayHaveMore: Bool = false
    ) -> MemoryConstellation {
        MemoryConstellation(
            generatedAt: generatedAt,
            bound: MemoryConstellationBound(
                stars: 60,
                starsReturned: stars.count,
                filamentsReturned: filaments.count,
                mayHaveMore: mayHaveMore,
                explanation: "A region of the live graph. This is NOT everything she remembers."
            ),
            stars: stars,
            filaments: filaments
        )
    }

    // MARK: - The shape of the table

    func testShouldCreateAConstellationTableOnAFreshDatabase() throws {
        let tables = try database.queue.read { db in
            try Set(String.fetchAll(db, sql: "SELECT name FROM sqlite_master WHERE type = 'table'"))
        }

        XCTAssertTrue(tables.contains("constellation"))
    }

    func testShouldMigrateAnExistingDatabaseWithoutLosingItsGoals() throws {
        // The v5 migration lands on devices that already hold data. A migration
        // that drops what came before is worse than no migration at all.
        let goal = Goal(
            id: "syl:goal:0198f2c3-0001-7000-8000-00000000d001",
            parentId: nil,
            title: "Ship the constellation",
            why: nil,
            targetDate: nil,
            metricKey: nil,
            targetValue: nil,
            cadenceDays: nil,
            status: .active,
            statusReason: nil,
            createdAt: Date(timeIntervalSince1970: 1_770_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_770_000_000)
        )
        try store.upsert([goal])

        try store.replaceConstellation(sky(stars: [star(id: "syl:memory_node:a")]))

        XCTAssertEqual(try store.goals().count, 1)
        XCTAssertEqual(try store.constellation()?.stars.count, 1)
    }

    // MARK: - Reading it back off disk

    func testShouldReadTheStoredSkyBackWithoutTheNetwork() throws {
        // The point of the whole task: it opens from disk.
        let anchor = star(id: "syl:memory_node:a", kind: .person, label: "Sadie", anchor: true)
        let orbiting = star(id: "syl:memory_node:b", anchorId: "syl:memory_node:a")
        let filament = MemoryFilament(
            id: "syl:memory_edge:c",
            from: anchor.id,
            to: orbiting.id,
            relation: "asserts",
            species: .observed,
            tier: .hot,
            confidence: 0.9,
            inferredConfidence: nil,
            reasoning: nil,
            assertedBy: "syl:memory_node:s",
            lastTouchedAt: Date(timeIntervalSince1970: 1_770_000_000)
        )

        try store.replaceConstellation(sky(stars: [anchor, orbiting], filaments: [filament]))
        let loaded = try XCTUnwrap(store.constellation())

        XCTAssertEqual(loaded.stars.count, 2)
        XCTAssertEqual(loaded.filaments.count, 1)
        // Every field the sky is drawn from survives the round trip through SQLite,
        // not merely the ids: brightness IS confidence and depth IS tier, so a
        // lossy write is an unreadable sky rather than a missing detail.
        XCTAssertEqual(loaded.stars.first(where: { $0.anchor })?.label, "Sadie")
        XCTAssertEqual(loaded.stars.first(where: { !$0.anchor })?.anchorId, anchor.id)
        XCTAssertEqual(loaded.stars.first(where: { !$0.anchor })?.confidence, 0.9)
        XCTAssertEqual(loaded.filaments.first?.species, .observed)
        XCTAssertNil(loaded.filaments.first?.inferredConfidence)
    }

    func testShouldKeepTheBoundSoTheDeviceNeverImpliesItHoldsEverything() throws {
        // `mayHaveMore` is the response's own statement about what it left out. A
        // device that kept the stars and discarded the bound would be free to
        // render "this is what she remembers" over a page of it.
        try store.replaceConstellation(
            sky(stars: [star(id: "syl:memory_node:a")], mayHaveMore: true)
        )

        let loaded = try XCTUnwrap(store.constellation())

        XCTAssertTrue(loaded.bound.mayHaveMore)
        XCTAssertEqual(loaded.bound.starsReturned, 1)
        XCTAssertTrue(loaded.bound.explanation.contains("NOT everything"))
    }

    func testShouldReportNoSkyAtAllRatherThanAnEmptyOneBeforeTheFirstFetch() throws {
        // Nil and empty render differently and only one of them is true. An empty
        // sky says "she remembers nothing about you" — a confident false statement
        // to make on a launch that has simply not reached the network yet.
        XCTAssertNil(try store.constellation())
    }

    // MARK: - Replace, never merge

    func testShouldReplaceTheWholeSkyRatherThanAccumulatingStarsAcrossFetches() throws {
        // THE decision this table exists to enforce, and the leak it prevents.
        //
        // The payload is a bounded REGION, not a row set. A star that drops out of
        // the region is not deleted server-side, so nothing ever tells the device
        // to remove it. Merge instead of replace and the local sky only ever
        // grows, diverging further from what the server would draw — and looking
        // perfectly correct the entire time.
        try store.replaceConstellation(
            sky(stars: [star(id: "syl:memory_node:a"), star(id: "syl:memory_node:b")])
        )
        try store.replaceConstellation(sky(stars: [star(id: "syl:memory_node:a")]))

        let loaded = try XCTUnwrap(store.constellation())

        XCTAssertEqual(loaded.stars.count, 1)
        XCTAssertEqual(loaded.stars.first?.id, "syl:memory_node:a")
    }

    func testShouldHoldExactlyOneSkyHoweverManyAreStored() throws {
        try store.replaceConstellation(sky(stars: [star(id: "syl:memory_node:a")]))
        try store.replaceConstellation(sky(stars: [star(id: "syl:memory_node:b")]))
        try store.replaceConstellation(sky(stars: [star(id: "syl:memory_node:c")]))

        let rows = try database.queue.read { db in
            try Int.fetchOne(db, sql: "SELECT count(*) FROM constellation") ?? 0
        }

        XCTAssertEqual(rows, 1)
    }

    // MARK: - Disk first, network second

    func testShouldOpenFromDiskWithoutTouchingTheNetwork() async throws {
        // Local-first, asserted rather than asserted-about: the gateway fails the
        // moment it is called, and the sky still opens.
        try store.replaceConstellation(sky(stars: [star(id: "syl:memory_node:a")]))
        let source = ConstellationSource(
            store: store,
            gateway: ConstellationGateway { _ in
                XCTFail("A cached read must not reach the network.")
                throw CocoaError(.fileNoSuchFile)
            }
        )

        XCTAssertEqual(try source.cached()?.stars.count, 1)
    }

    func testShouldKeepTheStoredSkyWhenARefreshFails() async throws {
        // A failed fetch must leave the last true thing on screen. Replacing it
        // with an empty field reads as "she has forgotten everything", which is
        // the same lie `GoalsViewModel` refuses when a read throws.
        try store.replaceConstellation(sky(stars: [star(id: "syl:memory_node:a")]))
        let source = ConstellationSource(
            store: store,
            gateway: ConstellationGateway { _ in throw CocoaError(.fileNoSuchFile) }
        )

        do {
            _ = try await source.refresh()
            XCTFail("The refresh was supposed to fail.")
        } catch {
            // Expected — what matters is what survived it.
        }

        XCTAssertEqual(try source.cached()?.stars.count, 1)
        XCTAssertEqual(try source.cached()?.stars.first?.id, "syl:memory_node:a")
    }

    func testShouldStoreWhatARefreshFetchedSoTheNextLaunchOpensOnIt() async throws {
        let fresh = sky(stars: [star(id: "syl:memory_node:b"), star(id: "syl:memory_node:c")])
        let source = ConstellationSource(
            store: store,
            gateway: ConstellationGateway { _ in fresh }
        )

        _ = try await source.refresh()

        // Read through a SECOND store over the same database — the question is
        // whether it reached the disk, not whether the object is still in hand.
        let reopened = LocalStore(database: database)
        XCTAssertEqual(try reopened.constellation()?.stars.count, 2)
    }

    func testShouldPassTheStarBoundThroughToTheRequest() async throws {
        let asked = Recorded<Int?>(nil)
        // Built outside the closure: the gateway is `@Sendable` and an XCTestCase
        // is not, so reaching back into `self` for a fixture will not compile.
        let answer = sky(stars: [star(id: "syl:memory_node:a")])
        let source = ConstellationSource(
            store: store,
            gateway: ConstellationGateway { stars in
                asked.set(stars)
                return answer
            }
        )

        _ = try await source.refresh(stars: 24)

        XCTAssertEqual(asked.get(), 24)
    }

    func testShouldRecordWhenTheSERVERDrewTheSkyRatherThanWhenTheDeviceStoredIt() throws {
        // The age of a memory view is a property of the answer, not of its
        // delivery. A device stamping its own clock would report a sky as fresh
        // because it was fetched a moment ago, however old the answer was.
        let drawnAt = Date(timeIntervalSince1970: 1_769_000_000)
        try store.replaceConstellation(
            sky(generatedAt: drawnAt, stars: [star(id: "syl:memory_node:a")])
        )

        let stored = try database.queue.read { db in
            try Date.fetchOne(db, sql: "SELECT generatedAt FROM constellation")
        }

        XCTAssertEqual(stored, drawnAt)
        XCTAssertEqual(try store.constellation()?.generatedAt, drawnAt)
    }
}
