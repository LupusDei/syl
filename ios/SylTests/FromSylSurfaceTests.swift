import SwiftUI
import SylKit
import XCTest

@testable import Syl

/// From Syl, as a projection (`syl-015.4.4`, T014a).
///
/// `SendingListSnapshot` is a pure function of the rows on disk and the clock, so every
/// question the screen can get wrong is answerable without SwiftUI: what order the
/// keepsakes read in, which of them offer a video, and — the one that matters most —
/// whether a sending with no video still says what she said.
final class FromSylSnapshotTests: XCTestCase {
    /// His zone, not the machine's. A test that used the runner's would pass in Chicago
    /// and fail in CI, and the bug it is meant to catch is exactly a date rendered in
    /// the wrong one.
    private let zone = TimeZone(identifier: "America/Chicago") ?? .gmt
    private let now = SendingFixtures.instant("2026-08-11T14:00:00.000Z")

    // MARK: - Order

    /// **Newest first, asserted rather than inherited.** The store orders, the service
    /// orders, and this orders again — because the mock served this list unsorted for a
    /// while and was schema-conformant the entire time.
    func testShouldReadNewestFirst() {
        let snapshot = project(SendingFixtures.page().items.reversed())

        XCTAssertEqual(snapshot.rows.map(\.id), SendingFixtures.newestFirstIDs)
    }

    // MARK: - The three states

    /// A ready sending offers her face and the tap that plays it.
    func testShouldOfferTheVideoOnAReadySending() {
        let row = project([
            SendingFixtures.sending(suffix: "e001", state: .ready, video: SendingFixtures.video())
        ]).rows.first

        XCTAssertEqual(row?.standing, .ready)
        XCTAssertNotNil(row?.still, "the poster is what the row draws")
        XCTAssertEqual(row?.isPlayable, true)
        XCTAssertNil(row?.note, "a ready sending needs nothing explained")
    }

    /// **A sending with no video yet is not an error.** It shows her words and the date
    /// and offers nothing to tap — a broken play affordance over nothing at all is worse
    /// than none.
    func testShouldShowAPendingSendingWithItsWordsAndNoVideoAffordance() {
        let row = project([SendingFixtures.sending(suffix: "e002", state: .pending)]).rows.first

        XCTAssertEqual(row?.standing, .rendering)
        XCTAssertNil(row?.still)
        XCTAssertEqual(row?.isPlayable, false)
        XCTAssertFalse(row?.words.isEmpty ?? true)
    }

    /// The words were never contingent on the video. A failed render costs the video and
    /// nothing else.
    func testShouldShowAFailedSendingsWordsAllTheSame() {
        let row = project([
            SendingFixtures.sending(
                suffix: "e003", state: .failed, reason: SendingFixtures.failureReason)
        ]).rows.first

        XCTAssertEqual(row?.standing, .failed)
        XCTAssertEqual(row?.words, SendingFixtures.sending(suffix: "e003").words)
        XCTAssertEqual(row?.isPlayable, false)
    }

    /// **"Nothing to show yet" and "failed to show" must never look identical**, and
    /// neither may read as a bug. The distinction has come up in three unrelated
    /// subsystems in this project; here it is the difference between *wait a minute* and
    /// *there will never be one*.
    func testShouldSayDifferentThingsAboutARenderStillRunningAndOneThatFailed() {
        let rendering = project([SendingFixtures.sending(suffix: "e004", state: .pending)]).rows.first
        let failed = project([
            SendingFixtures.sending(suffix: "e005", state: .failed, reason: SendingFixtures.failureReason)
        ]).rows.first

        let waiting = rendering?.note
        let broken = failed?.note

        XCTAssertNotNil(waiting)
        XCTAssertNotNil(broken)
        XCTAssertNotEqual(waiting, broken)
    }

    /// Neither note may read as a fault report. No codes, no "error", no "failed to
    /// load" — this is her surface and a stack trace has no business on it.
    func testShouldExplainAMissingVideoInHerVoiceRatherThanAsAFault() {
        let notes = project([
            SendingFixtures.sending(suffix: "e006", state: .pending),
            SendingFixtures.sending(
                suffix: "e007", state: .failed, reason: SendingFixtures.failureReason),
        ]).rows.compactMap(\.note)

        XCTAssertEqual(notes.count, 2)
        for note in notes {
            for word in ["error", "null", "nil", "http", "unavailable", "retry"] {
                XCTAssertFalse(
                    note.lowercased().contains(word), "\"\(note)\" reads as a fault report")
            }
        }
    }

    /// Her reason for making it is on the row, and it is hers rather than a caption:
    /// the words are what she said, `because` is why. It is what makes *"show me the one
    /// about Ela"* answerable, and a row that dropped it would keep the picture and lose
    /// the reason — which is the failure a gallery of renders makes by construction.
    func testShouldKeepWhySheMadeItOnTheRow() {
        let row = project([SendingFixtures.sending(suffix: "e008", state: .ready, video: SendingFixtures.video())])
            .rows.first

        XCTAssertEqual(row?.because, SendingFixtures.sending(suffix: "e008").because)
    }

    // MARK: - The date, in his zone

    /// 02:30 UTC on the eleventh is half past nine the previous evening in Chicago. A
    /// row that said "Today" would be telling him it arrived on a day it did not.
    func testShouldWriteTheDateInHisZoneRatherThanUTC() {
        let lateEvening = SendingFixtures.instant("2026-08-11T02:30:00.000Z")

        let row = project([
            SendingFixtures.sending(suffix: "e009", state: .pending, createdAt: lateEvening)
        ]).rows.first

        XCTAssertEqual(row?.dateLine, "Yesterday")
    }

    func testShouldSayTodayForSomethingSheSentThisMorning() {
        let thisMorning = SendingFixtures.instant("2026-08-11T13:10:00.000Z")

        let row = project([
            SendingFixtures.sending(suffix: "e010", state: .pending, createdAt: thisMorning)
        ]).rows.first

        XCTAssertEqual(row?.dateLine, "Today")
    }

    /// Past the last couple of days a date is more useful than a countdown, and it
    /// carries the year only when the year is not this one — "11 August 2025" on
    /// everything would be noise on every row.
    func testShouldWriteAPlainDateOnceItIsOlderThanYesterday() {
        let lastWeek = SendingFixtures.instant("2026-08-02T15:00:00.000Z")
        let lastYear = SendingFixtures.instant("2025-12-24T15:00:00.000Z")

        let rows = project([
            SendingFixtures.sending(suffix: "e011", state: .pending, createdAt: lastWeek),
            SendingFixtures.sending(suffix: "e012", state: .pending, createdAt: lastYear),
        ]).rows

        XCTAssertEqual(rows.first?.dateLine, "2 August")
        XCTAssertEqual(rows.last?.dateLine, "24 December 2025")
    }

    // MARK: - Nothing yet

    /// An empty list is a statement about the world, not a report about the app — and
    /// the view model never shows it until a fetch has actually answered.
    func testShouldReportAnEmptyListWhenSheHasSentNothing() {
        XCTAssertTrue(project([]).isEmpty)
        XCTAssertFalse(SendingListSnapshot.emptyHeadline.isEmpty)
        XCTAssertFalse(SendingListSnapshot.emptyExplanation.isEmpty)
    }

    // MARK: - The view builds

    /// A pure function of values, with no object graph — the property that makes the
    /// render harness possible, and the reason `scrolls` exists at all.
    @MainActor
    func testShouldBuildTheListFromPlainValuesInEveryState() {
        XCTAssertNotNil(FromSylListView(snapshot: nil, scrolls: false).body)
        XCTAssertNotNil(FromSylListView(snapshot: SendingListSnapshot(), scrolls: false).body)
        XCTAssertNotNil(
            FromSylListView(snapshot: project(SendingFixtures.page().items), scrolls: false).body)
    }

    // MARK: - Helpers

    private func project(_ sendings: some Sequence<Sending>) -> SendingListSnapshot {
        SendingListSnapshot.project(Array(sendings), now: now, timeZone: zone, locale: Locale(identifier: "en_GB"))
    }
}

/// The screen's lifecycle (`syl-015.4.6`, T015).
///
/// The whole of this class is one distinction: **"I have not asked" is not "she has sent
/// you nothing".** A nil snapshot is the first; an empty one is the second; and the
/// difference is what stops a first launch with no network from making a confident false
/// statement about a surface whose entire content is things she gave him.
@MainActor
final class FromSylViewModelTests: XCTestCase {
    /// A store per case, built inside it.
    ///
    /// Not a property with a `setUp`: this class is `@MainActor` — the view model is —
    /// and XCTest's `setUpWithError` is not, so a shared property would have to be
    /// written from outside the actor that owns it. `LocalStore` holds the database, so
    /// the queue lives exactly as long as the case that made it.
    private func makeStore() throws -> LocalStore {
        LocalStore(database: try SylDatabase.inMemory())
    }

    func testShouldStartWithNoSnapshotAtAll() throws {
        let store = try makeStore()
        let model = FromSylViewModel(source: SendingSource(store: store, gateway: .unreachable))

        XCTAssertNil(model.snapshot, "nil is 'not asked yet' and renders as the bare veil")
    }

    func testShouldPublishASnapshotWhenTheFetchAnswers() async throws {
        let store = try makeStore()
        let model = FromSylViewModel(
            source: SendingSource(store: store, gateway: .stub(page: SendingFixtures.page())))

        await model.refresh()

        XCTAssertEqual(model.snapshot?.rows.map(\.id), SendingFixtures.newestFirstIDs)
    }

    /// **The one it must not get wrong.** A first launch that cannot reach the Mac has
    /// not learned that she has sent him nothing — it has learned nothing at all, and an
    /// empty list would be the app inventing an answer out of its own failure to ask.
    func testShouldStayUnaskedWhenTheFirstFetchFails() async throws {
        let store = try makeStore()
        let model = FromSylViewModel(source: SendingSource(store: store, gateway: .unreachable))

        await model.refresh()

        XCTAssertNil(model.snapshot)
    }

    /// She has genuinely sent nothing. That is a true thing to say, and it is only
    /// sayable because the fetch answered.
    func testShouldPublishAnEmptySnapshotWhenTheFetchAnswersWithNothing() async throws {
        let store = try makeStore()
        let model = FromSylViewModel(
            source: SendingSource(
                store: store,
                gateway: .stub(page: SendingPage(items: [], nextCursor: nil, hasMore: false))))

        await model.refresh()

        XCTAssertEqual(model.snapshot?.isEmpty, true)
    }

    /// A failed refresh leaves what he was looking at exactly where it was.
    func testShouldLeaveThePreviousSnapshotStandingWhenARefreshFails() async throws {
        let store = try makeStore()
        let model = FromSylViewModel(
            source: SendingSource(store: store, gateway: .stub(page: SendingFixtures.page())))
        await model.refresh()

        let broken = FromSylViewModel(source: SendingSource(store: store, gateway: .unreachable))
        await broken.refresh()

        XCTAssertEqual(
            broken.snapshot?.rows.count, 3,
            "the rows are on disk, so a dead network costs the refresh and not the screen")
    }

    /// Local-first: what is on disk is drawn before anything is asked of the network.
    func testShouldShowTheStoredSendingsBeforeTheNetworkAnswers() async throws {
        let store = try makeStore()
        try store.replaceSendings(SendingFixtures.page())
        let model = FromSylViewModel(source: SendingSource(store: store, gateway: .unreachable))

        await model.refresh()

        XCTAssertEqual(model.snapshot?.rows.count, 3)
    }

    func testShouldBuildTheScreenWithoutBootingTheObjectGraph() throws {
        let store = try makeStore()
        XCTAssertNotNil(FromSylScreen(source: SendingSource(store: store, gateway: .unreachable)).body)
    }
}
