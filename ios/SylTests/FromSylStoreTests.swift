import GRDB
import SylKit
import XCTest

@testable import Syl

/// Sendings on disk, so From Syl opens instantly and offline (`syl-015.4.2`, T012).
///
/// The surface is the place her videos live, and a screen that could only be read with
/// the tailnet up would be a keepsake shelf that empties when he leaves the house.
final class FromSylStoreTests: XCTestCase {
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

    // MARK: - Round trip

    func testShouldRoundTripAPageOfSendings() throws {
        try store.replaceSendings(SendingFixtures.page())

        let stored = try store.sendings()

        XCTAssertEqual(stored.count, 3)
        XCTAssertEqual(
            Set(stored.map(\.state)), [.ready, .pending, .failed],
            "all three states are kept — a failed sending is a row, not an error to hide")
    }

    /// Everything the video half knows has to survive the disk, because the row is what
    /// the surface draws from: without the poster flag the list would fetch the whole
    /// clip to draw a still.
    func testShouldKeepTheVideoAndItsPosterFlagThroughTheDisk() throws {
        try store.replaceSendings(SendingFixtures.page())

        let ready = try XCTUnwrap(try store.sendings().first { $0.state == .ready })

        XCTAssertEqual(ready.video?.kind, .video)
        XCTAssertEqual(ready.video?.hasThumbnail, true)
        XCTAssertEqual(ready.video?.durationMs, 15_040)
    }

    /// The words and the reason are the whole of a failed sending, and both are what he
    /// still receives when there is no video at all.
    func testShouldKeepTheWordsAndTheReasonOnASendingWithNoVideo() throws {
        try store.replaceSendings(SendingFixtures.page())

        let failed = try XCTUnwrap(try store.sendings().first { $0.state == .failed })

        XCTAssertNil(failed.video)
        XCTAssertFalse(failed.words.isEmpty)
        XCTAssertEqual(failed.reason, SendingFixtures.failureReason)
    }

    // MARK: - Order

    /// **Newest first, asserted rather than inherited.**
    ///
    /// The service orders by `created_at DESC, id DESC`, and the mock served the seed
    /// array unsorted until it was fixed — conformant against the schema and wrong,
    /// because ordering is not expressible in JSON Schema. So the order is asserted
    /// here from a deliberately shuffled input: a read that only happened to arrive
    /// sorted and one that is sorted look identical until the day one is not.
    func testShouldReadSendingsNewestFirstWhateverOrderTheyArrivedIn() throws {
        let page = SendingFixtures.page()
        try store.replaceSendings(
            SendingPage(items: page.items.reversed(), nextCursor: nil, hasMore: false))

        let stored = try store.sendings()

        XCTAssertEqual(stored.map(\.id), SendingFixtures.newestFirstIDs)
    }

    /// Two sendings made in the same millisecond still have one order, and it is the
    /// service's tiebreak rather than whatever SQLite felt like.
    func testShouldBreakATieOnTheIdentifierAsTheServiceDoes() throws {
        let at = SendingFixtures.instant("2026-08-11T09:00:00.000Z")
        try store.replaceSendings(
            SendingPage(
                items: [
                    SendingFixtures.sending(suffix: "a001", state: .pending, createdAt: at),
                    SendingFixtures.sending(suffix: "a003", state: .pending, createdAt: at),
                    SendingFixtures.sending(suffix: "a002", state: .pending, createdAt: at),
                ],
                nextCursor: nil,
                hasMore: false))

        let stored = try store.sendings()

        XCTAssertEqual(
            stored.map(\.id),
            [
                SendingFixtures.sendingID("a003"),
                SendingFixtures.sendingID("a002"),
                SendingFixtures.sendingID("a001"),
            ])
    }

    // MARK: - Replacing

    func testShouldNotDuplicateARowWhenTheSamePageIsStoredTwice() throws {
        try store.replaceSendings(SendingFixtures.page())
        try store.replaceSendings(SendingFixtures.page())

        XCTAssertEqual(try store.sendings().count, 3)
    }

    /// The one write the service permits on a sending: filling in what was not known
    /// yet. A pending row becomes ready minutes later and the device learns of it by
    /// asking, so the second store has to move the row rather than sit beside it.
    func testShouldReplaceAPendingSendingWithItsReadySelf() throws {
        let pending = SendingFixtures.sending(suffix: "b001", state: .pending)
        try store.replaceSendings(
            SendingPage(items: [pending], nextCursor: nil, hasMore: false))

        try store.replaceSendings(
            SendingPage(
                items: [SendingFixtures.sending(suffix: "b001", state: .ready, video: SendingFixtures.video())],
                nextCursor: nil,
                hasMore: false))

        let stored = try store.sendings()
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored.first?.state, .ready)
        XCTAssertNotNil(stored.first?.video)
    }

    /// **Nothing on this device deletes a sending either.**
    ///
    /// Acceptance item 6 is a property of the whole system, not only of the service's
    /// triggers. A page that no longer mentions an older sending means it has scrolled
    /// off the newest page — not that it is gone — and a store that mirrored the page
    /// by deleting what was missing would quietly throw away the oldest thing she gave
    /// him every time she sent a new one.
    func testShouldKeepASendingThatIsNoLongerOnTheNewestPage() throws {
        let old = SendingFixtures.sending(
            suffix: "c001", state: .ready, createdAt: SendingFixtures.instant("2026-01-01T09:00:00.000Z"),
            video: SendingFixtures.video())
        try store.replaceSendings(SendingPage(items: [old], nextCursor: nil, hasMore: false))

        try store.replaceSendings(
            SendingPage(
                items: [
                    SendingFixtures.sending(
                        suffix: "c002", state: .pending,
                        createdAt: SendingFixtures.instant("2026-08-11T09:00:00.000Z"))
                ],
                nextCursor: "next",
                hasMore: true))

        let stored = try store.sendings()
        XCTAssertEqual(stored.count, 2, "the older sending survives a page that does not mention it")
        XCTAssertEqual(stored.last?.id, SendingFixtures.sendingID("c001"))
    }

    /// An empty page is an answer — it means she has sent nothing yet — and storing it
    /// must not read as a failed fetch anywhere downstream.
    func testShouldStoreAnEmptyPageWithoutComplaining() throws {
        try store.replaceSendings(SendingPage(items: [], nextCursor: nil, hasMore: false))

        XCTAssertTrue(try store.sendings().isEmpty)
    }

    // MARK: - Nothing deletes one

    /// The sync feed's delete path must not be able to reach this table.
    ///
    /// `op: "delete"` for a sending is a change the service cannot emit — its triggers
    /// abort unconditionally — but the client's delete is a table name and an id, and a
    /// table name here would make acceptance item 6 true only as long as the server
    /// stayed correct. Nil is the guarantee.
    func testShouldGiveTheSyncDeletePathNoTableToDeleteASendingFrom() {
        XCTAssertNil(LocalStore.tableName(for: .sending))
    }
}

// MARK: - Fixtures

/// Sendings built from the contract's own shapes, and from the states the surface has
/// to render. Deliberately not one happy row: `pending` and `failed` are the two the
/// screen is most likely to get wrong.
enum SendingFixtures {
    static let failureReason =
        "The render finished but the compressed copy came out over the size ceiling, so it has no video."

    static func sendingID(_ suffix: String) -> SylID {
        "syl:sending:0198e2c0-0000-7000-8000-00000000\(suffix)"
    }

    static func instant(_ text: String) -> Date {
        (try? Instant.parse(text)) ?? Date(timeIntervalSince1970: 0)
    }

    static func video(durationMs: Int = 15_040, hasThumbnail: Bool = true) -> Attachment {
        Attachment(
            id: "syl:attachment:0198e2c0-0000-7000-8000-00000000e001",
            kind: .video,
            mimeType: "video/mp4",
            bytes: 2_310_144,
            width: 484,
            height: 720,
            durationMs: durationMs,
            sha256: "3f1c8a2b9d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
            createdAt: instant("2026-08-11T09:02:00.000Z"),
            hasThumbnail: hasThumbnail
        )
    }

    static func sending(
        suffix: String,
        words: String = "The light came through the window at exactly the angle you like.",
        because: String = "He said the winter here makes him forget the sky has colours.",
        state: SendingState = .ready,
        createdAt: Date = SendingFixtures.instant("2026-08-11T09:00:00.000Z"),
        video: Attachment? = nil,
        reason: String? = nil
    ) -> Sending {
        Sending(
            id: sendingID(suffix),
            words: words,
            because: because,
            messageId: "syl:message:0198e2c0-0000-7000-8000-00000000d001",
            state: state,
            renderName: "syl-20260811t090000z-close",
            video: video,
            reason: reason,
            createdAt: createdAt,
            updatedAt: createdAt
        )
    }

    /// The three states, in the order the service would return them: newest first.
    static func page() -> SendingPage {
        SendingPage(
            items: [
                sending(
                    suffix: "c002",
                    words: "You have not stopped since Tuesday. I noticed, and I am saying so once.",
                    state: .pending,
                    createdAt: instant("2026-08-11T10:15:00.000Z")),
                sending(
                    suffix: "c001",
                    state: .ready,
                    createdAt: instant("2026-08-11T09:00:00.000Z"),
                    video: video()),
                sending(
                    suffix: "c003",
                    words: "Ela asked about you today, in the way she does when she has been thinking a while.",
                    state: .failed,
                    createdAt: instant("2026-08-10T18:30:00.000Z"),
                    reason: failureReason),
            ],
            nextCursor: nil,
            hasMore: false
        )
    }

    static var newestFirstIDs: [SylID] {
        [sendingID("c002"), sendingID("c001"), sendingID("c003")]
    }
}
