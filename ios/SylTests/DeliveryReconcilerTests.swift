import SylKit
import XCTest

@testable import Syl

/// `syl-u9e`. Three places in the codebase justified closing a delivery the moment
/// APNs returned 200 by pointing at "the app's foreground reconcile", and the
/// reconcile did not exist. These are the tests that make it exist.
///
/// The presenter and the fetch are closures, so none of this needs a notification
/// centre, an authorization prompt, a simulator or a server. What is under test is the
/// judgement — which rows to answer for, which to leave alone, and what happens when
/// the device cannot be shown anything.
final class DeliveryReconcilerTests: XCTestCase {
    private var database: SylDatabase!
    private var outbox: Outbox!

    override func setUpWithError() throws {
        try super.setUpWithError()
        database = try SylDatabase.inMemory()
        outbox = Outbox(database: database)
    }

    override func tearDown() {
        outbox = nil
        database = nil
        super.tearDown()
    }

    // MARK: - The failure this exists for

    func testShouldSurfaceADeliveryApnsAcceptedButNeverShowed() async throws {
        // The overnight case, exactly. Apple accepted the push and retains only the
        // most recent notification per app while the phone is off, so this one was
        // accepted and never shown. Nothing on the server will look at the row again.
        let delivery = delivery(id: id(1), state: .delivered, body: "Take the medication.")
        let shown = Recorder()

        let report = await makeReconciler(
            page: page([delivery]),
            present: { await shown.record($0.payload.body) }
        ).reconcile()

        XCTAssertEqual(report.presented, 1)
        let presented = await shown.values
        XCTAssertEqual(presented, ["Take the medication."])
        XCTAssertEqual(report.acknowledged, 1)
        XCTAssertEqual(try outbox.count(), 1, "and the ack is queued, not fired and forgotten")
    }

    func testShouldRecoverEveryRowInACollapsedNightRatherThanOne() async throws {
        // Four reminders pushed overnight are four accepted requests and, for Apple,
        // one notification. The one that arrived is held by the system; the other
        // three exist nowhere the Commander can see them.
        let held = delivery(id: id(1), state: .delivered)
        let lost = (2...4).map { delivery(id: id($0), state: .delivered) }
        let shown = Recorder()

        let report = await makeReconciler(
            page: page([held] + lost),
            alreadyOnDevice: [SylIDs.canonical(held.id)],
            present: { await shown.record($0.id) }
        ).reconcile()

        XCTAssertEqual(report.presented, 3)
        XCTAssertEqual(report.alreadyOnDevice, 1)
        let presented = await shown.values
        XCTAssertEqual(
            presented.map(SylIDs.canonical), lost.map { SylIDs.canonical($0.id) })
        XCTAssertEqual(report.acknowledged, 4, "all four are answered for")
    }

    // MARK: - What it must not do

    func testShouldNotAcknowledgeADeliveryTheServerIsStillTryingToSend() async throws {
        // Acknowledging a row queued for its first push would mark it seen before it
        // was sent — the collapse of `deliveredAt` into `ackedAt` that the two fields
        // exist to prevent.
        let shown = Recorder()

        let report = await makeReconciler(
            page: page([
                delivery(id: id(1), state: .pending),
                delivery(id: id(2), state: .sending),
            ]),
            present: { await shown.record($0.id) }
        ).reconcile()

        XCTAssertEqual(report.stillInFlight, 2)
        XCTAssertEqual(report.acknowledged, 0)
        let presented = await shown.values
        XCTAssertEqual(presented, [])
        XCTAssertEqual(try outbox.count(), 0)
    }

    func testShouldNotAcknowledgeWhatItCouldNotShow() async throws {
        // Notifications denied, or the centre refused the request. Nothing reached
        // him, so nothing is acknowledged: a reminder that arrives late is a nuisance,
        // one marked seen without being seen is the failure this mechanism prevents.
        let report = await makeReconciler(
            page: page([delivery(id: id(1), state: .delivered)]),
            present: { _ in throw PresentationRefused() }
        ).reconcile()

        XCTAssertEqual(report.presented, 0)
        XCTAssertEqual(report.acknowledged, 0)
        XCTAssertEqual(report.failures.count, 1)
        XCTAssertEqual(try outbox.count(), 0, "the row stays outstanding on the server")
    }

    func testShouldNotShowHimTheSameReminderOnEveryForeground() async throws {
        // The queued ack is the local memory. Between surfacing a delivery and the ack
        // reaching the server, the server still reports it unacknowledged — and a
        // reconcile that trusted only the server would re-present it every time.
        let delivery = delivery(id: id(1), state: .delivered)
        let shown = Recorder()
        let reconciler = makeReconciler(
            page: page([delivery]),
            present: { await shown.record($0.id) }
        )

        _ = await reconciler.reconcile()
        let second = await reconciler.reconcile()

        let presented = await shown.values
        XCTAssertEqual(presented.count, 1)
        XCTAssertEqual(second.awaitingPush, 1)
        XCTAssertEqual(second.presented, 0)
        XCTAssertEqual(try outbox.count(), 1)
    }

    func testShouldNotShowASecondCopyOfSomethingTheDeviceAlreadyHolds() async throws {
        // The push did arrive and is sitting unread in Notification Center. The device
        // has the content, which is what an acknowledgement asserts — so answer for it
        // without showing him a duplicate.
        let delivery = delivery(id: id(1), state: .delivered)
        let shown = Recorder()

        let report = await makeReconciler(
            page: page([delivery]),
            alreadyOnDevice: [SylIDs.canonical(delivery.id)],
            present: { await shown.record($0.id) }
        ).reconcile()

        XCTAssertEqual(report.presented, 0)
        XCTAssertEqual(report.alreadyOnDevice, 1)
        XCTAssertEqual(report.acknowledged, 1)
        let presented = await shown.values
        XCTAssertEqual(presented, [])
    }

    func testShouldIgnoreARowThatIsAlreadyAcknowledged() async throws {
        // The server's filter should exclude these. A reconcile that trusts the filter
        // and nothing else acks twice the day the filter changes.
        let report = await makeReconciler(
            page: page([
                delivery(id: id(1), state: .acknowledged, ackedAt: instant("2026-08-09T06:00:00.000Z"))
            ])
        ).reconcile()

        XCTAssertEqual(report.alreadyAcknowledged, 1)
        XCTAssertEqual(report.acknowledged, 0)
    }

    // MARK: - The acknowledgement it writes

    func testShouldUseTheSameKeyAsATapSoOneDeliveryIsOneOperation() async throws {
        // If the push arrives late and he taps it after the reconcile has answered,
        // both calls must carry the same key — or the server records two.
        let delivery = delivery(id: id(1), state: .delivered)

        _ = await makeReconciler(page: page([delivery])).reconcile()

        let queued = try XCTUnwrap(try outbox.pending().first)
        XCTAssertEqual(queued.idempotencyKey, "ack-\(SylIDs.canonical(delivery.id))")
        XCTAssertEqual(queued.kind, .acknowledgeDelivery)
        XCTAssertEqual(queued.targetId, delivery.id)
    }

    func testShouldReportEngagementAsDeliveredRatherThanOpened() async throws {
        // The interruption ledger demotes a message class that is consistently
        // ignored. Recording this as `opened` would teach it that a reminder he never
        // saw was a reminder that worked.
        _ = await makeReconciler(page: page([delivery(id: id(1), state: .delivered)])).reconcile()

        let queued = try XCTUnwrap(try outbox.pending().first)
        let body = try queued.decodePayload(as: AcknowledgeDeliveryRequest.self)
        XCTAssertEqual(body.engagement, .delivered)
    }

    func testShouldRecoverDeliveriesPushCouldNotCarryAtAll() async throws {
        // `failed` and `abandoned` are rows push never landed. The content still has
        // to reach him and the app is the only remaining route.
        let shown = Recorder()

        let report = await makeReconciler(
            page: page([
                delivery(id: id(1), state: .failed),
                delivery(id: id(2), state: .abandoned),
            ]),
            present: { await shown.record($0.id) }
        ).reconcile()

        XCTAssertEqual(report.presented, 2)
        XCTAssertEqual(report.acknowledged, 2)
    }

    // MARK: - Paging and failure

    func testShouldKeepPagingWhileTheServerSaysThereIsMore() async throws {
        let pages = PageSource(pages: [
            DeliveryPage(items: [delivery(id: id(1), state: .delivered)], nextCursor: "c1", hasMore: true),
            DeliveryPage(items: [delivery(id: id(2), state: .delivered)], nextCursor: "c2", hasMore: true),
            DeliveryPage(items: [delivery(id: id(3), state: .delivered)], nextCursor: nil, hasMore: false),
        ])

        let report = await makeReconciler(fetch: { await pages.next(cursor: $0) }).reconcile()

        XCTAssertEqual(report.pagesPulled, 3)
        XCTAssertEqual(report.acknowledged, 3)
        XCTAssertFalse(report.hasMore)
        let cursors = await pages.cursorsSeen
        XCTAssertEqual(cursors, [nil, "c1", "c2"])
    }

    func testShouldStopAtThePageCeilingAndSayThereIsMore() async throws {
        // A week away must not block the first frame after launch. The next run
        // continues; nothing is lost by stopping.
        let pages = PageSource(
            pages: Array(
                repeating: DeliveryPage(items: [], nextCursor: "c", hasMore: true), count: 20)
        )

        let report = await makeReconciler(
            fetch: { await pages.next(cursor: $0) },
            maxPagesPerRun: 3
        ).reconcile()

        XCTAssertEqual(report.pagesPulled, 3)
        XCTAssertTrue(report.hasMore)
    }

    func testShouldReportAFetchFailureRatherThanFailingSilently() async throws {
        let report = await makeReconciler(
            fetch: { _ in throw APIError.transport(code: .timedOut, description: "timed out") }
        ).reconcile()

        XCTAssertEqual(report.pagesPulled, 0)
        XCTAssertEqual(report.failures.count, 1)
        XCTAssertEqual(report.acknowledged, 0)
    }

    func testShouldPushTheAcknowledgementsItWroteWithoutWaitingForTheNextSync() async throws {
        // He is holding the phone. The server should stop believing these are
        // outstanding while he is still looking at them.
        let flushed = Recorder()

        _ = await makeReconciler(
            page: page([delivery(id: id(1), state: .delivered)]),
            flush: { await flushed.record("flush") }
        ).reconcile()

        let calls = await flushed.values
        XCTAssertEqual(calls, ["flush"])
    }

    func testShouldNotFlushWhenItHadNothingToAnswerFor() async throws {
        let flushed = Recorder()

        _ = await makeReconciler(
            page: page([delivery(id: id(1), state: .pending)]),
            flush: { await flushed.record("flush") }
        ).reconcile()

        let calls = await flushed.values
        XCTAssertEqual(calls, [], "a quiet reconcile is a quiet network")
    }

    // MARK: - The outbox lookup the reconcile remembers with

    func testShouldFindAQueuedIntentByItsKey() throws {
        let record = OutboxRecord(
            idempotencyKey: "ack-syl:delivery:1",
            kind: .acknowledgeDelivery,
            targetId: "syl:delivery:1",
            createdAt: Date(timeIntervalSince1970: 1_786_000_000)
        )
        try outbox.enqueue(record)

        let found = try outbox.queued(idempotencyKey: "ack-syl:delivery:1")

        XCTAssertEqual(found?.idempotencyKey, "ack-syl:delivery:1")
        XCTAssertEqual(found?.targetId, "syl:delivery:1")
    }

    func testShouldFindNothingForAKeyItHasNeverSeen() throws {
        XCTAssertNil(try outbox.queued(idempotencyKey: "ack-syl:delivery:nothing"))
    }

    func testShouldStopFindingAQueuedIntentOnceItReachesTheServer() throws {
        // The lookup is the reconcile's memory, so it has to forget at the same moment
        // the server starts answering for the row — or a delivery whose ack landed
        // would be treated as still awaiting push forever.
        let record = try outbox.enqueue(
            OutboxRecord(
                idempotencyKey: "ack-syl:delivery:1",
                kind: .acknowledgeDelivery,
                targetId: "syl:delivery:1",
                createdAt: Date(timeIntervalSince1970: 1_786_000_000)
            )
        )

        try outbox.complete(record)

        XCTAssertNil(try outbox.queued(idempotencyKey: "ack-syl:delivery:1"))
    }

    func testShouldKnowWhichStatesTheDeviceHasToAnswerFor() {
        XCTAssertTrue(DeliveryReconciler.needsDeviceRecovery(.delivered))
        XCTAssertTrue(DeliveryReconciler.needsDeviceRecovery(.failed))
        XCTAssertTrue(DeliveryReconciler.needsDeviceRecovery(.abandoned))
        XCTAssertFalse(DeliveryReconciler.needsDeviceRecovery(.pending))
        XCTAssertFalse(DeliveryReconciler.needsDeviceRecovery(.sending))
        XCTAssertFalse(DeliveryReconciler.needsDeviceRecovery(.acknowledged))
    }

    // MARK: - Harness

    private struct PresentationRefused: Error {}

    private func makeReconciler(
        page: DeliveryPage? = nil,
        fetch: (@Sendable (String?) async throws -> DeliveryPage)? = nil,
        alreadyOnDevice: Set<SylID> = [],
        present: @escaping @Sendable (Delivery) async throws -> Void = { _ in },
        flush: (@Sendable () async -> Void)? = nil,
        maxPagesPerRun: Int = 10
    ) -> DeliveryReconciler {
        let empty = DeliveryPage(items: [], nextCursor: nil, hasMore: false)
        let single = page ?? empty
        return DeliveryReconciler(
            outbox: outbox,
            fetch: fetch ?? { _ in single },
            presenter: DeliveryPresenter(
                alreadyOnDevice: { alreadyOnDevice },
                present: present
            ),
            flush: flush,
            now: { Date(timeIntervalSince1970: 1_786_000_000) },
            maxPagesPerRun: maxPagesPerRun
        )
    }

    private func page(_ items: [Delivery]) -> DeliveryPage {
        DeliveryPage(items: items, nextCursor: nil, hasMore: false)
    }

    private func id(_ n: Int) -> SylID {
        "syl:delivery:0198f2c3-000\(n)-7000-8000-00000000d00\(n)"
    }

    private func instant(_ text: String) -> Date {
        // Force-unwrapped: a malformed literal in a test fixture is a bug in the test.
        try! Instant.parse(text)
    }

    private func delivery(
        id: SylID,
        state: DeliveryState,
        body: String = "Take the medication.",
        ackedAt: Date? = nil
    ) -> Delivery {
        Delivery(
            id: id,
            channel: .apns,
            messageClass: "reminder_delivery",
            reminderId: "syl:reminder:0198f2c1-0001-7d21-9f00-1a2b3c4d5e01",
            payload: DeliveryPayload(
                title: "Syl",
                body: body,
                interruptionLevel: .timeSensitive,
                categoryIdentifier: ReminderNotification.categoryIdentifier,
                threadIdentifier: nil
            ),
            idempotencyKey: "reminder-\(id)",
            state: state,
            attempts: 1,
            nextAttemptAt: nil,
            deliveredAt: state == .delivered ? instant("2026-08-09T03:00:00.000Z") : nil,
            ackedAt: ackedAt,
            engagement: nil,
            late: false,
            scheduledFor: instant("2026-08-09T03:00:00.000Z"),
            coalescedReminderIds: [],
            apnsUniqueId: nil,
            lastError: nil,
            createdAt: instant("2026-08-09T02:59:00.000Z")
        )
    }

    /// Records what happened, in order, from whatever task the closure ran on.
    private actor Recorder {
        private(set) var values: [String] = []

        func record(_ value: String) {
            values.append(value)
        }
    }

    /// Hands out prepared pages and remembers what it was asked for.
    private actor PageSource {
        private var pages: [DeliveryPage]
        private(set) var cursorsSeen: [String?] = []

        init(pages: [DeliveryPage]) {
            self.pages = pages
        }

        func next(cursor: String?) -> DeliveryPage {
            cursorsSeen.append(cursor)
            guard !pages.isEmpty else {
                return DeliveryPage(items: [], nextCursor: nil, hasMore: false)
            }
            return pages.removeFirst()
        }
    }
}
