import SylKit
import XCTest

@testable import Syl

/// Where From Syl's rows come from: disk first, the server behind it (`syl-015.4.3`,
/// T013).
///
/// Every case here goes through a stub gateway rather than a server, because the
/// questions are about what the device does with an answer — and with the absence of
/// one — rather than about the wire, which `SylKit` already covers.
final class FromSylSourceTests: XCTestCase {
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

    // MARK: - A good answer

    func testShouldStoreAFetchedPage() async throws {
        let source = SendingSource(store: store, gateway: .stub(page: SendingFixtures.page()))

        _ = try await source.refresh()

        XCTAssertEqual(try store.sendings().map(\.id), SendingFixtures.newestFirstIDs)
    }

    func testShouldReadTheStoredSendingsWithNoNetworkAtAll() async throws {
        let source = SendingSource(store: store, gateway: .stub(page: SendingFixtures.page()))
        _ = try await source.refresh()

        let offline = SendingSource(store: store, gateway: .offline)

        XCTAssertEqual(try offline.cached().count, 3, "the surface opens from disk")
    }

    // MARK: - A bad answer

    /// **A failed fetch leaves what is on screen exactly where it is.**
    ///
    /// The alternative is a surface that empties itself because the tailnet is down,
    /// which reads as *she has taken them back* — and these are the one thing in the app
    /// that nothing is allowed to take back.
    func testShouldLeaveTheStoredSendingsAloneWhenTheFetchFails() async throws {
        let source = SendingSource(store: store, gateway: .stub(page: SendingFixtures.page()))
        _ = try await source.refresh()

        let broken = SendingSource(store: store, gateway: .offline)
        do {
            _ = try await broken.refresh()
            XCTFail("a failed fetch must be reported, not swallowed")
        } catch {
            // Expected — the caller decides what to do, and what it does is nothing.
        }

        XCTAssertEqual(try store.sendings().count, 3)
    }

    /// **An empty page is an answer, not a failure.** She has sent him nothing yet is a
    /// true thing the surface is allowed to say; it must not arrive as an error, and it
    /// must not be confused with never having asked.
    func testShouldTreatAnEmptyPageAsAnAnswerRatherThanAFailure() async throws {
        let empty = SendingPage(items: [], nextCursor: nil, hasMore: false)
        let source = SendingSource(store: store, gateway: .stub(page: empty))

        let fetched = try await source.refresh()

        XCTAssertTrue(fetched.isEmpty)
        XCTAssertTrue(try store.sendings().isEmpty)
    }

    // MARK: - The video that lands later

    /// The words arrive first and the video minutes afterwards, with **no frame to say
    /// so** — the phone finds out by asking. A row still pending after the page has
    /// landed is asked about by name.
    func testShouldAskAgainAboutASendingThatWasStillPending() async throws {
        let pending = SendingFixtures.sending(suffix: "d001", state: .pending)
        try store.replaceSendings(SendingPage(items: [pending], nextCursor: nil, hasMore: false))

        let ready = SendingFixtures.sending(
            suffix: "d001", state: .ready, video: SendingFixtures.video())
        let gateway = SendingGateway.stub(
            page: SendingPage(items: [pending], nextCursor: nil, hasMore: false),
            byID: [SendingFixtures.sendingID("d001"): ready])
        let source = SendingSource(store: store, gateway: gateway)

        _ = try await source.refresh()

        let stored = try XCTUnwrap(try store.sendings().first)
        XCTAssertEqual(stored.state, .ready)
        XCTAssertEqual(stored.video?.hasThumbnail, true)
    }

    /// A row the page already answered for is not asked about a second time. One
    /// foreground pass, one request per thing that is genuinely still unknown.
    func testShouldNotAskAgainAboutASendingThePageAlreadyResolved() async throws {
        try store.replaceSendings(
            SendingPage(
                items: [SendingFixtures.sending(suffix: "d002", state: .pending)],
                nextCursor: nil, hasMore: false))

        let resolved = SendingFixtures.sending(
            suffix: "d002", state: .ready, video: SendingFixtures.video())
        let recorder = SendingGateway.Recorder()
        let source = SendingSource(
            store: store,
            gateway: .stub(
                page: SendingPage(items: [resolved], nextCursor: nil, hasMore: false),
                recorder: recorder))

        _ = try await source.refresh()

        let asked = await recorder.asked
        XCTAssertTrue(asked.isEmpty, "the page already said what happened to it")
    }

    /// One sending that cannot be re-read must not take the refresh down with it. The
    /// page has already been stored by then, and losing it to a follow-up request would
    /// be the surface emptying itself over a detail.
    func testShouldKeepTheStoredPageWhenAFollowUpAskFails() async throws {
        let pending = SendingFixtures.sending(suffix: "d003", state: .pending)
        try store.replaceSendings(SendingPage(items: [pending], nextCursor: nil, hasMore: false))

        let source = SendingSource(
            store: store,
            gateway: SendingGateway(
                page: { _, _ in SendingPage(items: [pending], nextCursor: nil, hasMore: false) },
                one: { _ in throw AttachmentFetchError.offline }))

        let fetched = try await source.refresh()

        XCTAssertEqual(fetched.count, 1)
        XCTAssertEqual(try store.sendings().first?.state, .pending)
    }
}

// MARK: - Stubs

extension SendingGateway {
    /// Counts the sendings that were asked about by name.
    actor Recorder {
        private(set) var asked: [SylID] = []
        func record(_ id: SylID) { asked.append(id) }
    }

    static func stub(
        page: SendingPage,
        byID: [SylID: Sending] = [:],
        recorder: Recorder? = nil
    ) -> SendingGateway {
        SendingGateway(
            page: { _, _ in page },
            one: { id in
                await recorder?.record(id)
                guard let found = byID[id] else { throw AttachmentFetchError.offline }
                return found
            }
        )
    }
}
