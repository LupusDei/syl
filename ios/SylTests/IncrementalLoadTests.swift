import Foundation
import SylKit
import XCTest

@testable import Syl

/// The delta path must be indistinguishable from the full read (`syl-025.2.6`).
///
/// **These are correctness tests, and that is the point.** The speed is measured
/// elsewhere; what is dangerous here is a transcript that is fast and stale. Every test
/// below builds the same state twice — once incrementally, once with a full read — and
/// asserts the two snapshots are equal. A delta that drifts from the full read is the
/// only failure mode that matters, and comparing against the thing being replaced is the
/// only assertion that cannot be satisfied by an agreeable bug.
///
/// Fixtures are larger than the window wherever the window is the point, because a delta
/// tested only on data that fits never exercises the trim.
final class IncrementalLoadTests: XCTestCase {
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

    // MARK: - The delta agrees with the full read

    func testShouldMatchAFullReadWhenOneMessageArrives() throws {
        try seed(1...60)
        let loader = ChatSnapshotLoader(
            store: store, conversationId: SylIDs.interactiveConversation, limit: 50
        )
        let before = try loader.load()

        try seed(61...61)

        XCTAssertEqual(try loader.load(reusing: before), try loader.load())
    }

    func testShouldMatchAFullReadWhenSeveralArriveAtOnce() throws {
        // A reconnect replays a burst; the delta must handle more than one.
        try seed(1...60)
        let loader = ChatSnapshotLoader(
            store: store, conversationId: SylIDs.interactiveConversation, limit: 50
        )
        let before = try loader.load()

        try seed(61...75)

        XCTAssertEqual(try loader.load(reusing: before), try loader.load())
    }

    func testShouldMatchAFullReadWhenNothingHasChangedAtAll() throws {
        try seed(1...60)
        let loader = ChatSnapshotLoader(
            store: store, conversationId: SylIDs.interactiveConversation, limit: 50
        )
        let before = try loader.load()

        XCTAssertEqual(try loader.load(reusing: before), before)
    }

    func testShouldMatchAFullReadWhenTheWindowIsNotEvenFull() throws {
        try seed(1...10)
        let loader = ChatSnapshotLoader(
            store: store, conversationId: SylIDs.interactiveConversation, limit: 50
        )
        let before = try loader.load()

        try seed(11...12)

        let delta = try loader.load(reusing: before)
        XCTAssertEqual(delta, try loader.load())
        XCTAssertFalse(delta.mayHaveEarlier, "twelve messages in a window of fifty")
    }

    func testShouldStartSayingThereIsMoreOnceArrivalsPushThePrefixOutOfTheWindow() throws {
        // The trim is the one thing that can newly become true without a full read: a
        // window that held everything stops holding everything the moment it overflows.
        try seed(1...50)
        let loader = ChatSnapshotLoader(
            store: store, conversationId: SylIDs.interactiveConversation, limit: 50
        )
        let before = try loader.load()
        XCTAssertFalse(before.mayHaveEarlier, "exactly a window, nothing behind it")

        try seed(51...55)

        let delta = try loader.load(reusing: before)
        XCTAssertTrue(delta.mayHaveEarlier, "five arrived, so five fell off the back")
        XCTAssertEqual(delta, try loader.load())
    }

    // MARK: - The optimistic row, which is the one that changes identity

    func testShouldMatchAFullReadWhileASendIsStillPending() throws {
        try seed(1...60)
        let loader = ChatSnapshotLoader(
            store: store, conversationId: SylIDs.interactiveConversation, limit: 50
        )
        let before = try loader.load()

        _ = try store.enqueueSend(
            conversationId: SylIDs.interactiveConversation,
            clientId: "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44",
            idempotencyKey: "9f2c41d8-b7e0-4a6f-8c1d-3e5a7b9c0d2e",
            text: "Remind me to call the pharmacy at 4 today.",
            now: instant(3_600)
        )

        let delta = try loader.load(reusing: before)
        XCTAssertEqual(delta, try loader.load())
        XCTAssertEqual(delta.pendingCount, 1)
    }

    func testShouldMatchAFullReadWhenAPendingRowReconcilesToARealOne() throws {
        // The case a seq-keyed delta has to be told about rather than deduce: the row
        // changes ID and SEQ together. It leaves through the pending set and returns
        // through the arrivals read, and if those two halves disagreed the message would
        // either double or vanish — both silent, both in his own words.
        try seed(1...60)
        let loader = ChatSnapshotLoader(
            store: store, conversationId: SylIDs.interactiveConversation, limit: 50
        )
        let clientId = "c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44"
        _ = try store.enqueueSend(
            conversationId: SylIDs.interactiveConversation,
            clientId: clientId,
            idempotencyKey: "9f2c41d8-b7e0-4a6f-8c1d-3e5a7b9c0d2e",
            text: "Remind me to call the pharmacy at 4 today.",
            now: instant(3_600)
        )
        let before = try loader.load(reusing: try loader.load())
        XCTAssertEqual(before.pendingCount, 1)

        _ = try store.reconcile(
            DeliveryConfirmation(
                clientId: clientId,
                serverId: id(61),
                conversationId: SylIDs.interactiveConversation,
                seq: 61,
                acceptedAt: instant(3_600)
            )
        )

        let delta = try loader.load(reusing: before)
        XCTAssertEqual(delta, try loader.load())
        XCTAssertEqual(delta.pendingCount, 0, "it is a real message now")
        XCTAssertEqual(
            delta.groups.flatMap(\.messages).filter { $0.text.contains("pharmacy") }.count,
            1,
            "once — not doubled by arriving before its optimistic self left"
        )
    }

    // MARK: - Declining to answer is not an error

    func testShouldFallBackToAFullReadWhenMoreThanAWindowHasArrived() throws {
        // Past a whole window there is no prefix left worth reusing, and reasoning about
        // one anyway is how a delta protocol starts inventing history.
        try seed(1...60)
        let loader = ChatSnapshotLoader(
            store: store, conversationId: SylIDs.interactiveConversation, limit: 50
        )
        let before = try loader.load()

        try seed(61...200)

        XCTAssertEqual(try loader.load(reusing: before), try loader.load())
    }

    func testShouldIgnoreASnapshotFromADifferentWindowRatherThanTrustIt() throws {
        // `refresh()` is the only caller that may reuse, because it is the only one whose
        // window has not moved. This proves the wider loader still produces the right
        // answer even if a narrower snapshot reaches it.
        try seed(1...200)
        let narrow = ChatSnapshotLoader(
            store: store, conversationId: SylIDs.interactiveConversation, limit: 50
        )
        let wide = ChatSnapshotLoader(
            store: store, conversationId: SylIDs.interactiveConversation, limit: 150
        )

        let fromNarrow = try narrow.load()

        XCTAssertEqual(try wide.load(reusing: fromNarrow), try wide.load())
    }

    func testShouldMatchAFullReadOnAnEmptyConversation() throws {
        let loader = ChatSnapshotLoader(
            store: store, conversationId: SylIDs.interactiveConversation, limit: 50
        )
        let before = try loader.load()

        XCTAssertEqual(try loader.load(reusing: before), try loader.load())
        XCTAssertTrue(before.groups.isEmpty)
    }

    // MARK: - Fixtures

    private func seed(_ range: ClosedRange<Int>) throws {
        try store.upsert(
            range.map { seq in
                Message(
                    id: id(seq),
                    conversationId: SylIDs.interactiveConversation,
                    clientId: nil,
                    role: seq.isMultiple(of: 2) ? .assistant : .user,
                    text: "Message \(seq).",
                    createdAt: instant(Double(seq) * (MessageGrouping.maximumGap + 1)),
                    seq: seq
                )
            }
        )
    }

    private func id(_ index: Int) -> SylID {
        "syl:message:0198f2c0-0001-7000-8000-\(String(format: "%012d", index))"
    }

    private func instant(_ offset: TimeInterval) -> Date {
        // swiftlint:disable:next force_try
        try! Instant.parse("2026-08-09T07:00:03.114Z").addingTimeInterval(offset)
    }
}
